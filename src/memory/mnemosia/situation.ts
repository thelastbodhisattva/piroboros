// Ported from mnemosia/situation.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Phase B stage 1 — situation-aware analysis (spec "Stage 2: Situation-Aware Retrieval").
 *
 * The task text is the *objective*, not the *situation*. "Continue implementing Phase 5" names an
 * objective; the situation it lives in — which project, which branch, what the phase definition
 * says, how the previous phase ended — is inferred, and every inference can be wrong in a way that
 * changes what gets retrieved. So this module does one thing: it separates what the task *states*
 * from what it *implies*, from what it merely *suggests*, from what is genuinely *unknown*, and from
 * what should go back to the caller as a clarification — and for everything beyond `explicit` it
 * records the four fields spec requires: confidence, supporting signals, the retrieval consequence of
 * believing it, and the fallback if it is wrong.
 *
 * Classification is **deterministic**: a fixed rule table over the task text and the caller-supplied
 * project context. Model-assisted enrichment is a future seam (`SituationEnricher`, interface only —
 * no LLM call exists anywhere in this file), and when it arrives its output passes through the same
 * validator and the same bounds, treated as proposals rather than decisions (spec §21).
 *
 * The guardrail at the bottom of the spec section is structural here: this module *never rewrites*
 * the task. It only produces candidate context with named consequences; whether retrieval acts on a
 * consequence is decided downstream, where the token budget lives.
 */

import { SCHEMA_VERSION, type SituationContextSchema } from "./types.ts";
import { extractEntities, type TaskEntity } from "./task.ts";

/* ------------------------------------------------------------------------------------------------
 * Taxonomy
 * ---------------------------------------------------------------------------------------------- */

/** Spec's five-way distinction, in descending order of belief. */
export const CONTEXT_TIERS = ["explicit", "implied", "inferred", "unknown", "needs_clarification"] as const;
export type ContextTier = (typeof CONTEXT_TIERS)[number];

/**
 * One classified context item.
 *
 * `confidence` is tier-anchored (see CONFIDENCE_BY_TIER) and means "how likely is this inference to
 * hold", not "how important is it". `retrievalConsequence` says what retrieval does differently if
 * the item is believed; `fallbackIfWrong` says what happens if it was not — the pair that makes an
 * inference auditable instead of silently load-bearing.
 */
export interface ContextInference {
	id: string;
	/** Prose statement of the believed context, e.g. "the work continues unfinished phase state". */
	inference: string;
	tier: ContextTier;
	confidence: number;
	supportingSignals: string[];
	retrievalConsequence: string;
	fallbackIfWrong: string;
}

/** Hard bound on items per analysis; the tail beyond this is noise by construction. */
export const MAX_SITUATION_ITEMS = 24;

/** Tier anchor points. A rule may refine within ±0.1 but never cross a neighbouring tier's band. */
export const CONFIDENCE_BY_TIER: Readonly<Record<ContextTier, number>> = {
	explicit: 1,
	implied: 0.8,
	inferred: 0.45,
	unknown: 0.1,
	needs_clarification: 0.25,
};

export interface SituationContext {
	schemaVersion: SituationContextSchema;
	task: string;
	requestingAgent: string;
	/** The session project exactly as supplied (`null` when the session has none). */
	project: string | null;
	items: ContextInference[];
	counts: Record<ContextTier, number>;
}

/** What the caller knows about where it is running. All optional; absence is itself a signal. */
export interface ProjectContext {
	project?: string | null;
	branch?: string | null;
	requestedProjects?: readonly string[];
}

/**
 * The model-assisted seam (spec §21). A future implementation proposes additional items; they are
 * validated, bounded and merged like any other item. No implementation ships in Phase B.
 */
export interface SituationEnricher {
	propose(task: string, base: SituationContext): ContextInference[];
}

/* ------------------------------------------------------------------------------------------------
 * Rule table
 * ---------------------------------------------------------------------------------------------- */

interface SituationRule {
	id: string;
	inference: string;
	tier: ContextTier;
	pattern: RegExp;
	signal: string;
	retrievalConsequence: string;
	fallbackIfWrong: string;
}

/**
 * Deterministic rules over lowercased task text. Order matters only for stability of output order —
 * ids are unique and every match emits exactly one item, so no precedence logic exists to get wrong.
 */
const SITUATION_RULES: readonly SituationRule[] = [
	{
		id: "resume-open-work",
		inference: "there is unfinished work in the current project whose state must be recovered before continuing",
		tier: "implied",
		pattern: /\b(continue|resume|pick ?up|carry ?on|finish|complete|unfinished)\b/iu,
		signal: "continuation verb",
		retrievalConsequence: "read project-scoped memories for open TODOs and last observed state",
		fallbackIfWrong: "treat the task as fresh work; the cost is some redundant retrieval, not a wrong edit",
	},
	{
		id: "active-milestone-definition",
		inference: "the task names a milestone or phase whose definition governs what the work includes",
		tier: "implied",
		pattern: /\b(phase|milestone|stage)\b/iu,
		signal: "milestone noun",
		retrievalConsequence: "retrieve the milestone/phase definition and its acceptance criteria before planning",
		fallbackIfWrong: "fall back to the objective's literal wording as the scope boundary",
	},
	{
		id: "previous-phase-outcome",
		inference: "a prior milestone or phase reached an outcome that conditions this one",
		tier: "implied",
		pattern: /\b(phase|milestone|stage)\b/iu,
		signal: "milestone noun with continuation framing",
		retrievalConsequence: "check curated memory for the previous milestone's recorded outcome or release decision",
		fallbackIfWrong: "proceed without predecessor context; scope checks lose one corroborating signal",
	},
	{
		id: "known-failures",
		inference: "known failures or recorded blockers about this subject exist in memory",
		tier: "inferred",
		pattern: /\b(fix|repair|correct|bug|broken|failing|failure|crash|error)\b/iu,
		signal: "defect vocabulary",
		retrievalConsequence: "query curated memory for known failures before diagnosing from scratch",
		fallbackIfWrong: "an empty result costs one query; diagnosis proceeds normally",
	},
	{
		id: "coding-conventions",
		inference: "the work should follow conventions already recorded for this codebase",
		tier: "inferred",
		pattern: /\b(implement|build|write|create|add|extend|refactor)\b/iu,
		signal: "authoring verb",
		retrievalConsequence: "include convention/preference memories in the candidate pool",
		fallbackIfWrong: "conventions are advisory; their absence degrades style consistency, not correctness",
	},
	{
		id: "recency-sensitivity",
		inference: "the answer depends on current state rather than historical narrative",
		tier: "inferred",
		pattern: /\b(latest|current|now|today|recent|still)\b/iu,
		signal: "present-tense marker",
		retrievalConsequence: "prefer freshness-weighted sources and tighten the temporal window",
		fallbackIfWrong: "older evidence is still usable; ranking demotes rather than drops it",
	},
];

/* ------------------------------------------------------------------------------------------------
 * Analysis
 * ---------------------------------------------------------------------------------------------- */

function entityItems(entities: readonly TaskEntity[]): ContextInference[] {
	return entities.slice(0, 6).map((entity) => ({
		id: `explicit-entity-${entity.kind}-${entity.text.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").slice(0, 40)}`,
		inference: `the task explicitly names the ${entity.kind} "${entity.text}"`,
		tier: "explicit" as const,
		confidence: CONFIDENCE_BY_TIER.explicit,
		supportingSignals: [`literal ${entity.kind} in task text`],
		retrievalConsequence: "the entity's own tokens join the query vocabulary",
		fallbackIfWrong: "an entity that retrieves nothing simply contributes zero results",
	}));
}

function vagueReferentItem(task: string, entities: readonly TaskEntity[]): ContextInference | null {
	const hasSubjectEntity = entities.some((entity) => entity.kind !== "identifier");
	if (!/\b(it|that|this|them|those|the issue|the problem)\b/iu.test(task) || hasSubjectEntity) return null;
	return {
		id: "vague-referent",
		inference: "the task's subject may be under-specified (a pronoun stands where a named subject would)",
		tier: "needs_clarification",
		confidence: CONFIDENCE_BY_TIER.needs_clarification,
		supportingSignals: ["unresolved pronoun or bare referent"],
		retrievalConsequence: "retrieval would guess the subject; the intent layer decides whether to clarify instead",
		fallbackIfWrong: "if the referent is clear from session context, retrieval on the surrounding terms still applies",
	};
}

/**
 * Analyses the operational situation behind a task. Pure and deterministic: same inputs, same
 * output, byte for byte (spec §16's determinism gate applies here like everywhere else).
 */
export function analyseSituation(task: string, requestingAgent: string, projectContext?: ProjectContext): SituationContext {
	const trimmed = task.trim();
	const entities = extractEntities(trimmed).value;

	const items: ContextInference[] = [];

	if (projectContext?.project != null && projectContext.project !== "") {
		items.push({
			id: "explicit-project",
			inference: `the task runs in the project ${projectContext.project}`,
			tier: "explicit",
			confidence: CONFIDENCE_BY_TIER.explicit,
			supportingSignals: ["caller-supplied project context"],
			retrievalConsequence: "scope retrieval to this project (plus global)",
			fallbackIfWrong: "the caller asked for this project; mis-scoping would be a caller error, not an inference",
		});
	}
	if (projectContext?.requestedProjects && projectContext.requestedProjects.length > 0) {
		items.push({
			id: "explicit-requested-projects",
			inference: `the caller explicitly asked to read ${projectContext.requestedProjects.length} additional project(s)`,
			tier: "explicit",
			confidence: CONFIDENCE_BY_TIER.explicit,
			supportingSignals: ["requestedProjects supplied by caller"],
			retrievalConsequence: "those projects become authorized scopes",
			fallbackIfWrong: "not an inference; nothing to fall back from",
		});
	}
	if (projectContext?.project != null && projectContext.project !== "") {
		items.push({
			id: "current-repository-state",
			inference: `there is a working repository${projectContext.branch ? ` on branch ${projectContext.branch}` : ""} whose current state matters`,
			tier: "implied",
			confidence: CONFIDENCE_BY_TIER.implied - 0.05,
			supportingSignals: ["a live project implies a repository and worktree"],
			retrievalConsequence: "recent project memories enter the candidate pool",
			fallbackIfWrong: "global-only retrieval; project filter dropped",
		});
	}
	for (const rule of SITUATION_RULES) {
		if (!rule.pattern.test(trimmed)) continue;
		items.push({
			id: rule.id,
			inference: rule.inference,
			tier: rule.tier,
			confidence: CONFIDENCE_BY_TIER[rule.tier],
			supportingSignals: [rule.signal],
			retrievalConsequence: rule.retrievalConsequence,
			fallbackIfWrong: rule.fallbackIfWrong,
		});
	}
	// Cross-rule strengthening: "continue implementing Phase 5" makes the predecessor-outcome
	// inference stronger than the milestone noun alone would. One bump, capped inside the tier band.
	if (/resume-open-work/u.test(items.map((item) => item.id).join(",")) && items.some((item) => item.id === "previous-phase-outcome")) {
		const outcome = items.find((item) => item.id === "previous-phase-outcome");
		if (outcome) {
			outcome.confidence = Math.min(CONFIDENCE_BY_TIER.implied + 0.1, outcome.confidence + 0.1);
			outcome.supportingSignals = [...outcome.supportingSignals, "continuation verb present"];
		}
	}

	const vague = vagueReferentItem(trimmed, entities);
	if (vague) items.push(vague);
	items.push(...entityItems(entities));

	// Unknowns are recorded honestly rather than omitted: they name what this analysis could not
	// establish, so a reader of the trace sees the holes and not just the hits.
	for (const unknown of [
		{ id: "prior-discussions", inference: "whether prior conversations already cover this subject is unknown", consequence: "would justify a broad recall query only if stronger signals fail", fallback: "proceed without them" },
		{ id: "outstanding-validation", inference: "what validation remains outstanding for this work is unknown", consequence: "none until a source establishes it", fallback: "the caller's own validation loop governs" },
	]) {
		items.push({ id: unknown.id, inference: unknown.inference, tier: "unknown", confidence: CONFIDENCE_BY_TIER.unknown, supportingSignals: [], retrievalConsequence: unknown.consequence, fallbackIfWrong: unknown.fallback });
	}

	return validateSituationContext({
		schemaVersion: SCHEMA_VERSION.situationContext,
		task: trimmed,
		requestingAgent,
		project: projectContext?.project ?? null,
		items,
		counts: { explicit: 0, implied: 0, inferred: 0, unknown: 0, needs_clarification: 0 },
	});
}

/* ------------------------------------------------------------------------------------------------
 * Validation (deterministic policy over any item set, including future model-assisted proposals)
 * ---------------------------------------------------------------------------------------------- */

const ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,79}$/u;

/**
 * Schema-validates and bounds a situation context. Invalid items are *dropped* (with the count
 * recomputed) rather than thrown: a bad proposal must degrade the analysis, never crash the run.
 */
export function validateSituationContext(value: SituationContext): SituationContext {
	const seen = new Set<string>();
	const items: ContextInference[] = [];
	for (const item of value.items) {
		if (items.length >= MAX_SITUATION_ITEMS) break;
		if (!CONTEXT_TIERS.includes(item.tier)) continue;
		if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)) continue;
		if (typeof item.inference !== "string" || item.inference.length === 0) continue;
		if (typeof item.id !== "string" || !ID_PATTERN.test(item.id) || seen.has(item.id)) continue;
		if (!Array.isArray(item.supportingSignals)) continue;
		if (typeof item.retrievalConsequence !== "string" || typeof item.fallbackIfWrong !== "string") continue;
		seen.add(item.id);
		items.push({
			...item,
			confidence: Math.min(1, Math.max(0, item.confidence)),
			supportingSignals: item.supportingSignals.filter((signal): signal is string => typeof signal === "string").slice(0, 8),
			retrievalConsequence: String(item.retrievalConsequence ?? ""),
			fallbackIfWrong: String(item.fallbackIfWrong ?? ""),
		});
	}
	const counts = { explicit: 0, implied: 0, inferred: 0, unknown: 0, needs_clarification: 0 };
	for (const item of items) counts[item.tier] += 1;
	return { ...value, items, counts };
}

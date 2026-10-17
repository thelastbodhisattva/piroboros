// Ported from mnemosia/intent.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Phase B stage 2 — intent hypothesis sets (spec "Stage 3: Intent-Aware Retrieval").
 *
 * A task verb under-determines the task. "Fix Phase 5" could mean correct a bug, repair a
 * regression, resolve an architectural flaw, or finish an unfinished migration — and each reading
 * retrieves different evidence. This module turns that ambiguity into a **bounded, explicit,
 * competing** set of hypotheses with probabilities over them, plus a clarification policy that asks
 * the caller only when getting it wrong is expensive.
 *
 * Three properties carry the spec's fine print:
 *
 * - **Not calibrated truth.** `calibrated` is hard-coded `false`; no calibration evaluation has run
 *   (spec: "must not be presented as calibrated truth unless calibration has been evaluated").
 * - **Guardrail against over-investigation.** Clarification fires only when the top two hypotheses
 *   are within 0.15 *and* the ambiguity is consequential — a mutation verb is present. Exploratory
 *   tasks (research/review/recall) proceed with the leading hypothesis even when it is a close call:
 *   there, wrong retrieval costs one wasted query, while clarification costs a round trip.
 * - **Model-assisted seam, interface only.** `IntentProposalSource` is where future model-generated
 *   hypotheses plug in; they would flow through the same validator and bounds. No LLM call here.
 */

import { SCHEMA_VERSION, type IntentHypothesisSetSchema } from "./types.ts";
import type { SituationContext } from "./situation.ts";

/* ------------------------------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------------------------- */

export const MAX_INTENT_HYPOTHESES = 5;
/** Spec's threshold: below this margin between the top two, ambiguity *may* be worth a question. */
export const CLARIFICATION_MARGIN = 0.15;

/** `selected` — the run proceeds on this hypothesis; `uncertain` — leading but clarify recommended; `alternative` — recorded competitor. */
export const INTENT_STATUSES = ["selected", "uncertain", "alternative"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export interface IntentHypothesis {
	hypothesisId: string;
	description: string;
	probability: number;
	evidenceFor: string[];
	evidenceAgainst: string[];
	/** What evidence, if retrieved, would confirm or kill this hypothesis (feeds requirement generation). */
	discriminatingEvidence: string[];
	status: IntentStatus;
}

export interface ClarificationRecommendation {
	action: "proceed" | "clarify";
	margin: number;
	consequential: boolean;
	rationale: string;
}

export interface IntentHypothesisSet {
	schemaVersion: IntentHypothesisSetSchema;
	task: string;
	hypotheses: IntentHypothesis[];
	/** Sum of probabilities after deterministic rounding; ≤ 1 by construction. */
	probabilitiesSum: number;
	calibrated: false;
	recommendation: ClarificationRecommendation;
}

interface IntentHypothesisDraft {
	hypothesisId: string;
	description: string;
	patterns: readonly RegExp[];
	discriminatingEvidence: readonly string[];
}

/**
 * The hypothesis catalog, phrased from the spec's own example list for "Fix Phase 5". Patterns are
 * stem-anchored (`\bimplement`, not `\bimplement\b`) so "implementing" matches.
 */
const HYPOTHESIS_CATALOG: readonly IntentHypothesisDraft[] = [
	{
		hypothesisId: "incomplete-implementation",
		description: "complete an unfinished implementation",
		patterns: [/\bimplement/iu, /\b(continue|resume|finish|complete|unfinished|pick ?up)\b/iu],
		discriminatingEvidence: ["project state records showing the milestone partially done", "open TODOs naming exactly this work"],
	},
	{
		hypothesisId: "bug-correction",
		description: "correct a bug in existing behaviour",
		patterns: [/\b(fix|repair|correct)\b/iu, /\b(bug|crash|error|broken|incorrect|wrong)\b/iu],
		discriminatingEvidence: ["a failure report describing reproducible misbehaviour"],
	},
	{
		hypothesisId: "regression-repair",
		description: "repair a regression something used to work and now does not",
		patterns: [/\b(fix|repair|correct)\b/iu, /\b(regression|used to work|worked before|broke)\b/iu],
		discriminatingEvidence: ["a record of the behaviour holding at an earlier commit or phase"],
	},
	{
		hypothesisId: "test-failure",
		description: "resolve failing tests rather than product behaviour",
		patterns: [/\b(test|suite|spec)\b/iu, /\bfail/iu],
		discriminatingEvidence: ["a recent test-run record or failing test names"],
	},
	{
		hypothesisId: "architecture-correction",
		description: "resolve a flaw in design or structure rather than a local defect",
		patterns: [/\b(fix|repair|restructur|refactor)/iu, /\b(architect|design|approach|structure)\b/iu],
		discriminatingEvidence: ["an architecture decision record covering the affected boundary"],
	},
	{
		hypothesisId: "performance-improvement",
		description: "improve performance rather than correctness",
		patterns: [/\b(slow|latency|faster|speed ?up|optimiz|performance)\b/iu],
		discriminatingEvidence: ["a measured latency or throughput baseline"],
	},
	{
		hypothesisId: "documentation-correction",
		description: "correct documentation rather than behaviour",
		patterns: [/\b(doc|readme|comment|guide|changelog)/iu],
		discriminatingEvidence: ["the stale passage itself, in docs the corpus indexes"],
	},
];

/** Situation items that corroborate specific hypotheses — situation shapes intent, never replaces it. */
const SITUATION_BOOSTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	"known-failures": { "bug-correction": 0.5, "test-failure": 1 },
	"resume-open-work": { "incomplete-implementation": 1 },
	"active-milestone-definition": { "incomplete-implementation": 0.5 },
};

/** Verbs whose wrong reading costs a real write or a real diagnosis — the consequential class. */
const CONSEQUENTIAL_VERBS = /\b(fix|repair|correct|implement|migrate|refactor|deploy|delete|remove|change|modify|write|build|ship)\b/iu;

/* ------------------------------------------------------------------------------------------------
 * Inference
 * ---------------------------------------------------------------------------------------------- */

/**
 * Infers the bounded hypothesis set for a task in its situation. Pure and deterministic.
 */
export function inferIntentHypotheses(task: string, situation: SituationContext): IntentHypothesisSet {
	const trimmed = task.trim();

	const scored = HYPOTHESIS_CATALOG.map((entry) => {
		let score = 0;
		const evidenceFor: string[] = [];
		for (const pattern of entry.patterns) {
			if (!pattern.test(trimmed)) continue;
			score += 1;
			evidenceFor.push(`task matches /${pattern.source}/${pattern.flags}`);
		}
		for (const item of situation.items) {
			const boost = SITUATION_BOOSTS[item.id]?.[entry.hypothesisId];
			if (boost === undefined) continue;
			if (item.tier === "unknown") continue;
			score += boost;
			evidenceFor.push(`situation item "${item.id}" (${item.tier})`);
		}
		return { entry, score, evidenceFor };
	});

	const positive = scored.filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score || a.entry.hypothesisId.localeCompare(b.entry.hypothesisId));
	// Nothing matched: the honest set is one weak hypothesis — execute the objective literally —
	// rather than five invented competitors amplifying noise into fake ambiguity.
	const pool = positive.length > 0 ? positive : [{ entry: HYPOTHESIS_CATALOG[0], score: 1, evidenceFor: ["no intent signal matched; defaulting to literal execution"] }];
	const chosen = pool.slice(0, MAX_INTENT_HYPOTHESES);

	const total = chosen.reduce((sum, candidate) => sum + candidate.score, 0);
	// Round to 2dp, then give any rounding residue to the leader so the sum lands on ≤ 1 exactly.
	const rounded = chosen.map((candidate) => ({ ...candidate, probability: Math.round((candidate.score / total) * 100) / 100 }));
	const sumBeforeFix = rounded.reduce((sum, candidate) => sum + candidate.probability, 0);
	const residue = Math.round((1 - sumBeforeFix) * 100) / 100;
	if (rounded.length > 0 && residue !== 0) rounded[0].probability = Math.max(0, Math.min(1, rounded[0].probability + residue));

	const sorted = [...rounded].sort((a, b) => b.probability - a.probability || a.entry.hypothesisId.localeCompare(b.entry.hypothesisId));
	const margin = sorted.length >= 2 ? Math.round((sorted[0].probability - sorted[1].probability) * 100) / 100 : sorted[0].probability;
	const consequential = CONSEQUENTIAL_VERBS.test(trimmed);
	const recommendClarify = sorted.length >= 2 && margin < CLARIFICATION_MARGIN && consequential;
	const rationale = recommendClarify
		? `top two hypotheses are within ${CLARIFICATION_MARGIN} (margin ${margin}) and the task carries a mutation verb, so retrieving for the wrong reading costs a wrong edit; ask before retrieving`
		: sorted.length < 2
			? "a single hypothesis dominates; nothing to disambiguate"
			: consequential
				? `leading hypothesis leads by ${margin} ≥ ${CLARIFICATION_MARGIN}; proceed and let discriminating evidence update the assessment`
				: `ambiguity is harmless here: no mutation verb, so wrong retrieval costs one query while clarification costs a round trip`;

	const hypotheses: IntentHypothesis[] = sorted.map((candidate, index) => ({
		hypothesisId: candidate.entry.hypothesisId,
		description: candidate.entry.description,
		probability: candidate.probability,
		evidenceFor: candidate.evidenceFor,
		evidenceAgainst: index === 0 && sorted.length > 1 ? [`alternative "${sorted[1].entry.hypothesisId}" scored ${sorted[1].score}`] : [],
		discriminatingEvidence: [...candidate.entry.discriminatingEvidence],
		status: index === 0 ? (recommendClarify ? "uncertain" : "selected") : "alternative",
	}));

	return validateIntentHypothesisSet({
		schemaVersion: SCHEMA_VERSION.intentHypothesisSet,
		task: trimmed,
		hypotheses,
		probabilitiesSum: Math.round(hypotheses.reduce((sum, hypothesis) => sum + hypothesis.probability, 0) * 100) / 100,
		calibrated: false,
		recommendation: { action: recommendClarify ? "clarify" : "proceed", margin, consequential, rationale },
	});
}

/**
 * Query-vocabulary hints for the leading hypothesis — the terms retrieval would add for the reading
 * it currently believes in. Deterministic; empty when the leading hypothesis has none to offer.
 */
const LEADING_QUERY_TERMS: Readonly<Record<string, readonly string[]>> = {
	"incomplete-implementation": ["implementation"],
	"regression-repair": ["regression"],
	"test-failure": ["fail"],
	"performance-improvement": ["performance"],
};
export function leadingQueryTerms(intent: IntentHypothesisSet): string[] {
	const leading = intent.hypotheses.find((hypothesis) => hypothesis.status === "selected");
	return leading ? [...(LEADING_QUERY_TERMS[leading.hypothesisId] ?? [])] : [];
}

/**
 * Model-assisted seam (spec §21). A future implementation proposes extra hypotheses with raw scores;
 * they are merged, normalized and bounded through `inferIntentHypotheses`' validator path. No
 * implementation ships in Phase B.
 */
export interface IntentProposalSource {
	propose(task: string, situation: SituationContext): Array<{ hypothesisId: string; description: string; score: number; evidenceFor?: string[] }>;
}

/* ------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Schema-validates and bounds a hypothesis set. Drops malformed hypotheses, caps at
 * MAX_INTENT_HYPOTHESES, clamps probabilities to [0,1] and re-scales down if the sum exceeds 1.
 */
export function validateIntentHypothesisSet(value: IntentHypothesisSet): IntentHypothesisSet {
	const seen = new Set<string>();
	const hypotheses: IntentHypothesis[] = [];
	for (const hypothesis of value.hypotheses) {
		if (hypotheses.length >= MAX_INTENT_HYPOTHESES) break;
		if (typeof hypothesis.hypothesisId !== "string" || hypothesis.hypothesisId.length === 0 || seen.has(hypothesis.hypothesisId)) continue;
		if (typeof hypothesis.probability !== "number" || !Number.isFinite(hypothesis.probability)) continue;
		if (typeof hypothesis.description !== "string" || hypothesis.description.length === 0) continue;
		if (!INTENT_STATUSES.includes(hypothesis.status)) continue;
		seen.add(hypothesis.hypothesisId);
		hypotheses.push({
			...hypothesis,
			probability: Math.min(1, Math.max(0, hypothesis.probability)),
			evidenceFor: strings(hypothesis.evidenceFor),
			evidenceAgainst: strings(hypothesis.evidenceAgainst),
			discriminatingEvidence: strings(hypothesis.discriminatingEvidence).slice(0, 4),
		});
	}
	const total = hypotheses.reduce((sum, hypothesis) => sum + hypothesis.probability, 0);
	if (total > 1) {
		for (const hypothesis of hypotheses) hypothesis.probability = Math.round((hypothesis.probability / total) * 100) / 100;
		// Rounding can leave the rescaled sum just above or below 1; give the residue to the leader
		// exactly as inferIntentHypotheses does, so probabilitiesSum lands on ≤ 1 exactly.
		const sumAfterRescale = hypotheses.reduce((sum, hypothesis) => sum + hypothesis.probability, 0);
		const residue = Math.round((1 - sumAfterRescale) * 100) / 100;
		if (hypotheses.length > 0 && residue !== 0) {
			const leader = hypotheses.reduce((a, b) => (b.probability > a.probability ? b : a));
			leader.probability = Math.max(0, Math.min(1, leader.probability + residue));
		}
	}
	return {
		...value,
		hypotheses,
		probabilitiesSum: Math.round(hypotheses.reduce((sum, hypothesis) => sum + hypothesis.probability, 0) * 100) / 100,
	};
}

function strings(values: unknown): string[] {
	return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

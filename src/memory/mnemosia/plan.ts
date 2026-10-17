// Ported from mnemosia/plan.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Retrieval planning (spec §9, design §6, build-order step 8).
 *
 * Spec §9's demand is unambiguous and is the reason this module exists as more than a query
 * builder: "It must query only the sources justified by the retrieval plan. It must not query extra
 * sources merely to satisfy a quota." Spec §23 repeats it from the other side — "do not require
 * every task to query three sources."
 *
 * So the plan records a decision for **every** source, selected or not, each with a rule id and a
 * sentence of justification, and `EXECUTE_SOURCE_QUERIES` is given only the queries. A rejected
 * source becomes a named `RetrievalGap` rather than a silence. A source with nothing to say is reported
 * as a gap.
 *
 * **Why the planner narrows the term set.** AkashicForge builds its FTS5 tables with the default
 * operator, which is AND (`toSafeMatchQuery`, store.ts:480-484, quotes each token and joins with a
 * space). A twenty-term query therefore asks for documents containing all twenty words, and on this
 * corpus that returns nothing. `TaskAnalysis.terms` stays wide because design §9's relevance signal
 * measures coverage against it; `PlannedQuery.terms` is the narrow high-signal prefix that the
 * store can actually answer. Conflating the two would make recall look like a ranking problem when
 * it was a query-construction problem.
 */

import type { AdapterProbe } from "./adapters/contract.ts";
import { MODE_CONFIGS } from "./policy.ts";
import type { OperationalMode, ScopeAuthorization, TaskAnalysis, TaskType } from "./task.ts";
import { SCHEMA_VERSION, SOURCE_ID, type PlannedQuery, type RetrievalGap, type RetrievalPlanSchema, type Scope, type SourceId } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Mode configuration
 * ---------------------------------------------------------------------------------------------- */

/**
 * Design §4 assigns "ranking policies, mode configs, authority table" to `policy.ts`. In chunk B the
 * table lived here because step 8 needed it and step 10 did not exist yet, with a note saying the
 * move would be a re-export rather than a rewrite. Step 10 has landed and this is that re-export:
 * the table is defined once, in `policy.ts`, and every existing importer of `plan.ts` is unaffected.
 */
export { MODE_CONFIGS } from "./policy.ts";
export type { ModeConfig } from "./policy.ts";

/**
 * How many terms reach a query.
 *
 * Three, and the number is measured rather than chosen. Under FTS5's default AND operator every
 * query term is a **hard filter**: a term the corpus does not contain zeroes the result set no
 * matter how well the remaining terms match. Against a live corpus scoped to one project:
 *
 * ```
 * ["store"]                                                          -> 100 events
 * ["store","akashic-forge"]                                          -> 100 events
 * ["store","akashic-forge","under-reads"]                            ->   0 events
 * ["akashic-forge","adapter"]                                        ->  66 events
 * ["akashic-forge","adapter","ledger"]                               ->   0 events
 * ["review","akashic-forge","memory"]                                ->  54 events
 * ```
 *
 * Design §12 says a hard-filter rejection is unrecoverable by relevance, and that is exactly the
 * status a query term has here — so a *speculative* term must not be allowed to act as one. The
 * seven ranking signals exist to do the fine discrimination; doing it in the query instead does it
 * bluntly and irreversibly. Hence: few terms, and let ranking sort the wide result.
 *
 * The recall-preserving answer to a query that still comes back empty is a term ladder driven by
 * spec §9's retry policy, which belongs to the orchestrator (step 15) and is measured by the §16
 * gold set. It is not built here, and this constant is not tuned to hide its absence.
 */
export const MAX_QUERY_TERMS = 3;

/**
 * Share of the candidate budget each source may spend, before normalization over the selected set.
 *
 * Curated memory is the only source that ships, so its share is the whole budget after normalization.
 */
export const SOURCE_CANDIDATE_SHARE: Readonly<Record<string, number>> = {
	[SOURCE_ID.akashicMemories]: 0.1,
};

/** Priority when a mode's `maxSources` cap forces a source to be dropped. Highest authority first. */
const SOURCE_PRIORITY: readonly SourceId[] = [SOURCE_ID.akashicMemories];

/* ------------------------------------------------------------------------------------------------
 * Plan
 * ---------------------------------------------------------------------------------------------- */

export const PLAN_RULES = [
	"curated_relevance",
	"source_available",
	"no_retrievable_signal",
	"probe_unavailable",
	"circuit_open",
	"mode_source_cap",
	"not_registered",
] as const;
export type PlanRuleId = (typeof PLAN_RULES)[number];

export interface SourceDecision {
	sourceId: SourceId;
	selected: boolean;
	ruleId: PlanRuleId;
	/** Prose, for the trace and for `explainDecision`. Never empty, selected or not. */
	justification: string;
	/** The probe that informed the decision, when one ran. */
	probe: AdapterProbe | null;
}

/**
 * Spec §9's typed RetrievalPlan. Every field §9 enumerates has a home here or a recorded reason for
 * not having one:
 *
 * - *graph-traversal policy* is `"none"` because neither foundation exposes a claim graph to
 *   traverse. Reporting a policy over an absent graph would be a field that reads as capability.
 * - *maximum retrieval cost budget* collapses into `tokenBudget`: every source is local synchronous
 *   SQLite, so there is no monetary cost to bound (design §13).
 */
export interface RetrievalPlan {
	schemaVersion: RetrievalPlanSchema;
	runId: string;
	requestingAgent: string;
	taskType: TaskType;
	mode: OperationalMode;
	/** Spec §9's "security authorization result", carried in the plan rather than beside it. */
	authorization: ScopeAuthorization;
	considered: SourceId[];
	selected: SourceId[];
	rejected: SourceId[];
	decisions: SourceDecision[];
	queries: PlannedQuery[];
	/** Absolute epoch-ms instants, one per selected source. */
	deadlines: Record<SourceId, number>;
	/** Gaps known *before* any query runs: a rejected source is already a hole in the briefing. */
	gaps: RetrievalGap[];
	maxCandidates: number;
	tokenBudget: number;
	secondPassPermitted: boolean;
	retryPolicy: { attempts: number; backoffMs: number };
	graphTraversal: "none";
	stopConditions: string[];
	failClosedOnUnverified: boolean;
	plannedAt: number;
}

export interface PlanRetrievalInput {
	analysis: TaskAnalysis;
	authorization: ScopeAuthorization;
	/**
	 * Probes from `PLAN_RETRIEVAL`, keyed by source. A source with no probe entry is treated as
	 * unregistered and rejected — a planner that assumed an unprobed source was healthy would defeat
	 * the circuit breaker design §13 puts in front of it.
	 */
	probes: ReadonlyArray<AdapterProbe>;
	/** Sources the breaker has already opened this session (design §13). */
	circuitOpen?: readonly SourceId[];
	now?: number;
	/**
	 * Phase B: situation/intent-derived vocabulary appended to the **curated** (any-match) term set
	 * only. The narrow AND-joined terms are untouched — a situation-derived term that the corpus
	 * does not contain would zero a conjunction, while a disjunction merely fails to widen. Absent
	 * or empty, planning is byte-identical to Phase A.
	 */
	extraCuratedTerms?: readonly string[];
}

/**
 * Ranks the analysis's terms for the narrow AND-joined query.
 *
 * Two keys, in order: **entity-derived first**, because a path or a backticked identifier is what
 * the author deliberately typed and is therefore vocabulary the corpus is likely to share; then
 * **first appearance**, because the order an author writes in is their own emphasis and it is a
 * total order, which is what the §16 determinism gate needs.
 *
 * There is deliberately no "prefer the longer/rarer token" key. It is the obvious heuristic and the
 * measurement in `MAX_QUERY_TERMS` above falsifies it: `under-reads` and `millisecond` are among the
 * longest tokens in that task and each on its own returns zero events, so promoting them would turn
 * a good query into an empty one.
 */
export function selectQueryTerms(analysis: TaskAnalysis, limit: number = MAX_QUERY_TERMS): string[] {
	const entityTokens = new Set<string>();
	for (const entity of analysis.entities.value) {
		for (const token of entity.text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
			if (token.length >= 3) entityTokens.add(token);
		}
	}
	const positions = new Map<string, number>();
	analysis.terms.value.forEach((term, index) => {
		if (!positions.has(term.toLowerCase())) positions.set(term.toLowerCase(), index);
	});

	return [...analysis.terms.value]
		.sort((a, b) => {
			const entityA = entityTokens.has(a.toLowerCase()) ? 0 : 1;
			const entityB = entityTokens.has(b.toLowerCase()) ? 0 : 1;
			if (entityA !== entityB) return entityA - entityB;
			return (positions.get(a.toLowerCase()) ?? 0) - (positions.get(b.toLowerCase()) ?? 0);
		})
		.slice(0, limit);
}

/**
 * The scopes to actually issue queries against.
 *
 * AkashicForge reads a project filter as "global ∪ this project" (store.ts:661, and the note on
 * `scopeFilterFor` in adapters/contract.ts), so issuing both a project query and a global query
 * would read every global row twice and double its weight in every count downstream. When any
 * project scope is authorized, the project queries alone cover global; the bare global query is
 * issued only when nothing project-scoped was granted.
 */
export function queryScopes(authorization: ScopeAuthorization): Scope[] {
	const projects = authorization.granted.filter((grant) => grant.scope.level === "project").map((grant) => grant.scope);
	if (projects.length > 0) return projects;
	return authorization.granted.filter((grant) => grant.scope.level === "global").map((grant) => grant.scope);
}

function decide(analysis: TaskAnalysis, sourceId: SourceId, probe: AdapterProbe | undefined, circuitOpen: ReadonlySet<SourceId>): SourceDecision {
	if (probe === undefined) return { sourceId, selected: false, ruleId: "not_registered", justification: `${sourceId} was not probed at PLAN_RETRIEVAL, so it is treated as unavailable rather than assumed healthy`, probe: null };
	if (circuitOpen.has(sourceId)) return { sourceId, selected: false, ruleId: "circuit_open", justification: `${sourceId} failed twice this session; the breaker stays open until session_start (design §13)`, probe };
	if (!probe.available) return { sourceId, selected: false, ruleId: "probe_unavailable", justification: `probe reported unavailable (${probe.code ?? "no code"}): ${probe.detail}`, probe };

	switch (sourceId) {
		case SOURCE_ID.akashicMemories: {
			// **CORRECTED IN PHASE 1E.** This rule was `curated_authority`, and it selected the source
			// unconditionally with an empty term list — a recency scan that returned every in-scope
			// curated row on every task. Authority is a statement about a source's right to be
			// believed *once it is relevant*; it is not a licence to be retrieved. Measured, the old
			// rule put a mean 6.11 curated rows into every candidate pool regardless of subject, and
			// with the low-amplitude relevance signal (design §10) they could not be pushed back out
			// again — 0.529 irrelevant against a ≤ 0.20 gate.
			//
			// So curated memory is now retrieved on the same two grounds as everything else: scope,
			// and sharing vocabulary with the task. What stays different is *how* the terms combine,
			// and that difference is a measurement rather than a preference — see `matchMode` below
			// and `QueryMatchMode` in types.ts. The authority advantage is untouched: it lives at 0.9
			// in the policy table and is applied in ranking, which is where a claim about
			// believability belongs.
			if (analysis.terms.value.length === 0) {
				return { sourceId, selected: false, ruleId: "no_retrievable_signal", justification: "the task yielded no searchable term, so there is no relevance ground on which to read curated memory; an unfiltered read would return the corpus rather than an answer", probe };
			}
			return { sourceId, selected: true, ruleId: "curated_relevance", justification: `the curated corpus is governed, scope-bounded and the only source reaching verified integrity; read on ${analysis.terms.value.length} task term(s) under any-match, with authority applied in ranking rather than in retrieval`, probe };
		}

		default:
			return { sourceId, selected: true, ruleId: "source_available", justification: `${sourceId} is registered and available`, probe };
	}
}

export function planRetrieval(input: PlanRetrievalInput): RetrievalPlan {
	const { analysis, authorization } = input;
	const now = input.now ?? Date.now();
	const mode = analysis.mode.value;
	const config = MODE_CONFIGS[mode];
	const circuitOpen = new Set(input.circuitOpen ?? []);
	const probeIndex = new Map(input.probes.map((probe) => [probe.sourceId, probe]));

	const terms = selectQueryTerms(analysis);
	const extraCuratedTerms = (input.extraCuratedTerms ?? []).map((term) => term.toLowerCase()).filter((term) => term.length >= 3 && !analysis.terms.value.some((existing) => existing.toLowerCase() === term));
	const curatedTerms = extraCuratedTerms.length > 0 ? [...analysis.terms.value, ...extraCuratedTerms] : analysis.terms.value;
	const considered = [...SOURCE_PRIORITY, ...input.probes.map((probe) => probe.sourceId).filter((sourceId) => !SOURCE_PRIORITY.includes(sourceId))];
	let decisions = considered.map((sourceId) => decide(analysis, sourceId, probeIndex.get(sourceId), circuitOpen));

	// The mode cap is applied last, so a source that was rejected on its merits keeps the rule id
	// that explains why rather than being relabelled as a casualty of the cap.
	const selectedNow = decisions.filter((decision) => decision.selected);
	if (selectedNow.length > config.maxSources) {
		const keep = new Set(selectedNow.slice(0, config.maxSources).map((decision) => decision.sourceId));
		decisions = decisions.map((decision) =>
			decision.selected && !keep.has(decision.sourceId) ? { ...decision, selected: false, ruleId: "mode_source_cap" as PlanRuleId, justification: `${mode} mode allows ${config.maxSources} source(s); ${decision.sourceId} was the lowest-authority selection and was dropped` } : decision,
		);
	}

	const selected = decisions.filter((decision) => decision.selected).map((decision) => decision.sourceId);
	const rejected = decisions.filter((decision) => !decision.selected).map((decision) => decision.sourceId);

	const scopes = queryScopes(authorization);
	const shareTotal = selected.reduce((sum, sourceId) => sum + (SOURCE_CANDIDATE_SHARE[sourceId] ?? 0.1), 0);

	const queries: PlannedQuery[] = [];
	const deadlines: Record<SourceId, number> = {};
	for (const sourceId of selected) {
		deadlines[sourceId] = now + config.deadlineMsPerSource;
		const sourceScopes = scopes;
		const share = (SOURCE_CANDIDATE_SHARE[sourceId] ?? 0.1) / (shareTotal === 0 ? 1 : shareTotal);
		const perQuery = Math.max(1, Math.floor((config.maxCandidates * share) / Math.max(1, sourceScopes.length)));
		const decision = decisions.find((candidate) => candidate.sourceId === sourceId);
		for (const scope of sourceScopes) {
			const curated = sourceId === SOURCE_ID.akashicMemories;
			queries.push({
				schemaVersion: SCHEMA_VERSION.plannedQuery,
				runId: analysis.runId,
				sourceId,
				/**
				 * Curated memory gets the **wide** term set under `any`; every other source gets the
				 * narrow three under `all`. Both halves are measured, not assumed.
				 *
				 * Conjunction is the filter that makes a result set readable for a large corpus and three terms is where it stops zeroing out (`MAX_QUERY_TERMS`). The
				 * curated corpus is ten dense rows, where the same conjunction is not a filter but an
				 * off switch: over the nineteen labelled retrieval tasks, three ANDed terms returned a
				 * curated row on six and found 6 of 23 labelled memories. Disjunction over the wide set
				 * finds **23 of 23** while cutting the mean rows read per task from 6.11 to 2.37.
				 *
				 * The wide set rather than the narrow one because it is already the set design §9's
				 * relevance signal scores coverage against (rank.ts:182); using the same vocabulary for
				 * "may this row be considered" and "how well does it match" keeps retrieval and ranking
				 * from disagreeing about what the task was about.
				 */
				terms: curated ? curatedTerms : terms,
				matchMode: curated ? "any" : "all",
				scope,
				taskScope: null,
				since: curated ? null : analysis.since,
				until: analysis.until,
				maxArtifacts: perQuery,
				justification: decision?.justification ?? `${sourceId} selected`,
			});
		}
	}

	const gaps: RetrievalGap[] = decisions
		.filter((decision) => !decision.selected)
		.map((decision) => ({
			sourceId: decision.sourceId,
			reason: decision.ruleId === "circuit_open" ? "circuit_open" : decision.ruleId === "probe_unavailable" ? "adapter_error" : "not_planned",
			detail: decision.justification,
			code: decision.ruleId === "probe_unavailable" ? (decision.probe?.code ?? null) : null,
		}));

	return {
		schemaVersion: SCHEMA_VERSION.retrievalPlan satisfies RetrievalPlanSchema,
		runId: analysis.runId,
		requestingAgent: analysis.requestingAgent,
		taskType: analysis.taskType.value,
		mode,
		authorization,
		considered,
		selected,
		rejected,
		decisions,
		queries,
		deadlines,
		gaps,
		maxCandidates: config.maxCandidates,
		// The caller's budget is a hard ceiling; the mode may only lower it further.
		tokenBudget: Math.min(config.tokenBudget, analysis.contextBudget.value),
		secondPassPermitted: config.secondPassPermitted,
		retryPolicy: { attempts: config.retryAttempts, backoffMs: 0 },
		graphTraversal: "none",
		stopConditions: [
			`candidate cap ${config.maxCandidates} reached`,
			`per-source deadline ${config.deadlineMsPerSource} ms elapsed`,
			`token budget ${Math.min(config.tokenBudget, analysis.contextBudget.value)} exhausted at selection`,
			"every selected source returned or failed",
		],
		failClosedOnUnverified: config.failClosedOnUnverified,
		plannedAt: now,
	};
}

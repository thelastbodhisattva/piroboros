// Ported from mnemosia/orchestrator.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * The retrieval state machine (spec §7, design §6 and §13, build-order step 15).
 *
 * Chunks A–C built eleven modules that each do one thing correctly. This is the one that owns the
 * *order* between them, and therefore the one that owns every property that is not local to a single
 * module: the transitions, the six early exits, the audit trail, the deadlines, the circuit breaker,
 * and graceful degradation.
 *
 * ```
 * RECEIVE_REQUEST → ANALYZE_TASK → AUTHORIZE_SCOPE → PLAN_RETRIEVAL → EXECUTE_SOURCE_QUERIES
 * → NORMALIZE_ARTIFACTS → EXTRACT_OR_RESOLVE_CLAIMS → DEDUPLICATE → APPLY_HARD_FILTERS
 * → SCORE_CANDIDATES → DETECT_CONFLICTS → RESOLVE_OR_ESCALATE → SELECT_CONTEXT_SET
 * → REQUEST_COMPRESSION → ASSEMBLE_BRIEFING → VALIDATE_BRIEFING → DELIVER → COLLECT_FEEDBACK
 * ```
 *
 * **One failing source never fails the run.** Design §20 and §23 both require it, and it is the
 * property most easily claimed and least often true. Here it is structural: every adapter call is
 * wrapped, every failure becomes a named `RetrievalGap` with the source's own id and a standard error
 * code, and the pipeline continues with whatever came back. The run only ends as
 * `RETRIEVAL_UNAVAILABLE` when *every* selected source failed — i.e. when there is genuinely nothing
 * to brief from, as opposed to less than expected.
 *
 * **The term ladder is the recall half of spec §9's retry policy.** `plan.ts:42-66` explains why a
 * query carries at most three terms — FTS5 ANDs them, so a fourth term the corpus does not contain
 * zeroes the result set — and explicitly leaves the recall-preserving answer to this module. An empty
 * lexical result is retried with a shorter term prefix, down to one term, and every rung is recorded.
 * The ladder never widens to an unbounded recency scan: `plan.ts`'s `no_retrievable_signal` rule
 * exists precisely to stop that, and re-introducing it here through the back door would retrieve
 * volume in exactly the case where relevance already failed.
 *
 * **Nothing here writes.** The orchestrator's only side effects are the JSONL trace under
 * the caller-supplied trace root and, on `submitFeedback`, one line of `feedback.jsonl`. Both are
 * derived, rebuildable data (design §3). `writes.ts` produces recommendations; no code path in this
 * file reaches `mutateMemory`, and the dependency it takes cannot express one.
 */

import type { AdapterProbe, AdapterResult, SourceAdapter } from "./adapters/contract.ts";
import { isStandardAdapterError } from "./adapters/contract.ts";
import { assembleBriefing, renderMarkdown, validateBriefing, type Briefing, type BriefingValidation, type Redactor } from "./brief.ts";
import { dedupeClaims, extractClaims, type ExtractionStats } from "./claims.ts";
import { applyConflictPresentation, detectConflicts, type ConflictResolution } from "./conflicts.ts";
import { applyHardFilters, scanArtifacts, type HardFilterResult, type MemorySafetyScanner } from "./filters.ts";
import { planRetrieval, type RetrievalPlan } from "./plan.ts";
import { effectiveAddendumReserve, profileFor, resolveAgent, type AgentBriefingProfile } from "./agents.ts";
import { applyEscalationOutcomes, routeEscalations, type EscalationRequest } from "./escalation.ts";
import { FEEDBACK_SCHEMA_VERSION, validateFeedback, type FeedbackEntry } from "./feedback.ts";
import { MODE_CONFIGS, resolvePolicy, withAgentSelection, type RankingPolicy } from "./policy.ts";
import { BRIEFING_SCAFFOLDING_TOKENS, minimumConformingBudgetForSeat } from "./select.ts";
import { buildProvenanceGraph, type ProvenanceGraph } from "./provenance.ts";
import { QUALIFIER_RANKING } from "./qualifiers.ts";
import { rankCandidates, type RankedCandidate } from "./rank.ts";import { applyReranking } from "./rerank.ts";
import { appliesAgentSelection, resolvePolicyAt, type PolicyPin } from "./rollback.ts";
import { selectContext, type SelectionResult } from "./select.ts";
import { analyzeTask, authorizeScope, type BriefingRequest, type ScopeAuthorization, type SearchTokenizer, type TaskAnalysis } from "./task.ts";
import { analyseSituation, validateSituationContext, type SituationContext } from "./situation.ts";
import { inferIntentHypotheses, leadingQueryTerms, type IntentHypothesisSet } from "./intent.ts";
import { deriveKnowledgeRequirements, type KnowledgeRequirement } from "./requirements.ts";
import { openTrace, readTrace, buildAgentLineage, type TraceWriter } from "./trace.ts";
import { runProgressiveRetrieval, type ProgressiveRetrievalResult, type ProgressiveConfig } from "./progressive.ts";
import { EARLY_EXITS, SCHEMA_VERSION, type ArtifactEnvelope, type Claim, type EarlyExit, type PlannedQuery, type RetrievalGap, type RetrievalState, type SourceId, type TraceEvent } from "./types.ts";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redactSensitive } from "../../redact.ts";

/* ------------------------------------------------------------------------------------------------
 * Session state — the circuit breaker (design §13)
 * ---------------------------------------------------------------------------------------------- */

/**
 * "A source failing twice in one session is skipped as `circuit_open` until `session_start`."
 *
 * The state is per-session rather than per-run because that is what design §13 says and because a
 * per-run breaker would never trip: a run queries each source once or twice. It is an explicit object
 * the caller owns rather than module-level mutable state, so two sessions in one process (the eval
 * harness runs thirty) cannot contaminate each other's breaker — which would silently change what the
 * gold set measures.
 */
export interface SessionState {
	failures: Map<SourceId, number>;
	openedAt: Map<SourceId, number>;
	startedAt: number;
	runs: number;
}

/** Design §13's threshold, named so a change is a diff to a constant rather than to a condition. */
export const CIRCUIT_FAILURE_THRESHOLD = 2;

export function newSession(now: number = Date.now()): SessionState {
	return { failures: new Map(), openedAt: new Map(), startedAt: now, runs: 0 };
}

export function circuitOpenSources(session: SessionState): SourceId[] {
	return [...session.openedAt.keys()].sort();
}

function recordSourceFailure(session: SessionState, sourceId: SourceId, now: number): boolean {
	const count = (session.failures.get(sourceId) ?? 0) + 1;
	session.failures.set(sourceId, count);
	if (count >= CIRCUIT_FAILURE_THRESHOLD && !session.openedAt.has(sourceId)) {
		session.openedAt.set(sourceId, now);
		return true;
	}
	return false;
}

/* ------------------------------------------------------------------------------------------------
 * Result
 * ---------------------------------------------------------------------------------------------- */

/**
 * `DELIVERED` plus spec §7's six early terminations. Every run ends as exactly one of these.
 *
 * Built from `EARLY_EXITS` rather than retyped, so a seventh termination added to the domain model
 * becomes a compile error here instead of an outcome the orchestrator can never produce.
 */
export const RUN_OUTCOMES = ["DELIVERED", ...EARLY_EXITS] as const;
export type RunOutcome = "DELIVERED" | EarlyExit;

export interface SourceOutcome {
	sourceId: SourceId;
	/** Rungs of the term ladder actually issued, in order. `[]` when the source was never queried. */
	attempts: Array<{ terms: string[]; envelopes: number; elapsedMs: number; pagesRead: number; truncated: boolean; error: string | null; code: string | null }>;
	envelopes: number;
	failed: boolean;
	circuitOpened: boolean;
}

export interface RunStats {
	envelopes: number;
	uniqueEnvelopes: number;
	claimsExtracted: number;
	claimsDeduped: number;
	claimsAccepted: number;
	candidatesScored: number;
	candidatesCapped: number;
	itemsSelected: number;
	conflicts: number;
	quarantined: number;
	/** Design §18 risk 3: the fraction of summary headings the grammar did not recognize. */
	unknownHeadingRate: number;
	extraction: ExtractionStats;
	elapsedMs: number;
	/** Wall-clock spent inside adapter calls, so latency can be attributed to I/O or to Mnemosia. */
	retrievalMs: number;
}

export interface OrchestrationResult {
	runId: string;
	outcome: RunOutcome;
	/** The state the run stopped in. `COLLECT_FEEDBACK` for a completed run. */
	finalState: RetrievalState;
	/** `true` only when VALIDATE_BRIEFING certified the briefing. Nothing else may be handed on. */
	delivered: boolean;
	briefing: Briefing | null;
	/** Withheld when `delivered` is false: an uncertified briefing must not reach another agent. */
	markdown: string | null;
	validation: BriefingValidation | null;
	analysis: TaskAnalysis;
	authorization: ScopeAuthorization | null;
	plan: RetrievalPlan | null;
	policy: RankingPolicy;
	gaps: RetrievalGap[];
	sources: SourceOutcome[];
	claims: Claim[];
	envelopes: ArtifactEnvelope[];
	candidates: RankedCandidate[];
	/** Phase 2: the claim/artifact graph the run scored and classified against. `null` before it is built. */
	graph: ProvenanceGraph | null;
	conflicts: ConflictResolution | null;
	selection: SelectionResult | null;
	filters: HardFilterResult | null;
	/** Phase B — situation analysis. `null` only when the run ended before ANALYZE_TASK produced one. */
	situation: SituationContext | null;
	/** Phase B — bounded intent hypothesis set with its clarification recommendation. */
	intent: IntentHypothesisSet | null;
	/** Phase B — knowledge requirements derived from situation + intent. */
	requirements: KnowledgeRequirement[];
	/** Phase C — present only when the caller requested progressive retrieval; `null` otherwise. */
	progressive?: ProgressiveRetrievalResult | null;
	stats: RunStats;
	tracePath: string;
	/** Why the run ended where it did. Always at least one entry. */
	reasons: string[];
}

export interface OrchestratorDeps {
	adapters: readonly SourceAdapter[];
	scan: MemorySafetyScanner;
	tokenize: SearchTokenizer;
	redact: Redactor;
	/** Injectable clock. The §16 determinism gate needs the scoring clock to be fixable. */
	now?: () => number;
	/**
	 * Injectable WALL clock for the retrieval deadlines (startedAt, the run ceiling, the per-source
	 * windows). Defaults to `Date.now`. Deadlines are wall-clock quantities by definition — the
	 * Phase 4 note at EXECUTE_SOURCE_QUERIES — so this seam must never be fed the logical `now`;
	 * that conflation was the Phase 4 defect. It exists so tests can simulate elapsed time
	 * deterministically instead of sleeping.
	 */
	wallNow?: () => number;
	/** Where traces land. Required unless `persistTrace` is false. */
	traceRoot?: string;
	/** Shared across a Pi session, so the breaker survives between runs. One is created if absent. */
	session?: SessionState;
	/** Set false to skip the JSONL trace entirely (the eval harness writes thirty runs × 3). */
	persistTrace?: boolean;
	/**
	 * Design §16 / spec §24 name "Mnemosia without conflict resolution" as one of the four systems the
	 * gold set compares. This is that ablation, and it is a knob in production code rather than a fork
	 * of the pipeline in the harness for one reason: an ablation implemented twice measures the copy.
	 *
	 * `"off"` skips DETECT_CONFLICTS entirely — no record, no demotion, no mandatory conflict item —
	 * which is exactly what a retrieval system without conflict handling does with a superseded pair.
	 * The state is still recorded in the trace, marked disabled, so a replay cannot mistake an ablated
	 * run for a run that found nothing.
	 */
	conflictDetection?: "on" | "off";
	/**
	 * **PHASE 5 — bind this run to a named policy-registry version instead of the current one.**
	 *
	 * Absent in production: `extension.ts:registerMnemosia` passes no pin, so a deployed Mnemosia
	 * always resolves through `policy.ts`'s head chain. Supplied, the run resolves through
	 * `rollback.ts:resolvePolicyAt` instead, and the pin — its version, who set it, and why — is
	 * written into the `ANALYZE_TASK` trace payload. Without that record a rollback would be
	 * indistinguishable in the log from a resolver bug, which is the one thing a rollback must never
	 * look like.
	 *
	 * It exists for two Phase 5 items at once. `rollback.ts` needs it to make a revert executable;
	 * `replay.ts` needs it to re-run a recorded set of envelopes under a different registry version,
	 * which is how the revert is *proved* rather than asserted.
	 */
	policyPin?: PolicyPin;
	/**
	 * **PHASE C — bounded multi-round retrieval.**
	 *
	 * Present: the pass becomes round 0 of a bounded loop that re-queries with gap terms derived from
	 * uncovered Phase B knowledge requirements, stopping on sufficiency, information gain, budget,
	 * deadline or the round bound (`progressive.ts` owns the policy).
	 *
	 * Absent: the locked Phase C production policy still applies on its own — when round 0 leaves
	 * Phase B knowledge requirements uncovered and the requesting seat's governance requires verified
	 * evidence (`agents.ts` `verification: "required"`), the run escalates under
	 * `DEFAULT_ESCALATION_CONFIG`. Callers outside that gate (no requirements, optional verification,
	 * or an early exit before selection) get exactly one pass, byte-identical to the pre-Phase-C build.
	 */
	progressive?: ProgressiveConfig;
}

/* ------------------------------------------------------------------------------------------------
 * Deadlines
 * ---------------------------------------------------------------------------------------------- */

/**
 * The whole-run safety valve, derived from the mode table rather than invented.
 *
 * `deadlineMsPerSource × (maxSources + 1)`: every selected source may take its full deadline, plus
 * one source's worth of headroom for everything Mnemosia does between them. Fast → 1,500 ms,
 * Standard → 8,000 ms, Deep → 40,000 ms.
 *
 * This is **not** design §16's latency gate (Fast p95 ≤ 500 ms, Standard ≤ 2 s, Deep ≤ 10 s). The
 * gate is a *measurement* the eval harness reports; this is a *bound* that stops a pathological read
 * running forever. Setting the bound equal to the gate would have made the gate self-fulfilling —
 * every run would come in under it by truncating its own work — which is precisely the kind of
 * measurement that passes while meaning nothing.
 */
export function runDeadlineFor(mode: TaskAnalysis["mode"]["value"], startedAt: number): number {
	const config = MODE_CONFIGS[mode];
	return startedAt + config.deadlineMsPerSource * (config.maxSources + 1);
}

/* ------------------------------------------------------------------------------------------------
 * The term ladder (spec §9 retry policy)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The sequence of term sets to try for one query, longest first.
 *
 * `["store", "adapter", "paging"]` → `[["store","adapter","paging"], ["store","adapter"], ["store"]]`.
 * Each rung drops the *lowest-priority* term, i.e. the last one `plan.ts:selectQueryTerms` ranked, so
 * what survives longest is the entity-derived vocabulary the author typed deliberately.
 *
 * It stops at one term and never reaches zero. A zero-term query is a recency scan, and `plan.ts`
 * rejects a source outright when there is no term and no temporal bound (`no_retrievable_signal`)
 * because an unbounded scan returns the most recent rows rather than an answer. The ladder must not smuggle that back in.
 */
export function termLadder(terms: readonly string[]): string[][] {
	if (terms.length === 0) return [[]];
	const rungs: string[][] = [];
	for (let width = terms.length; width >= 1; width -= 1) rungs.push(terms.slice(0, width));
	return rungs;
}

/**
 * The curated any-match set's width bound. Eight terms over a disjunctive query cost nothing on the
 * ten-row curated corpus (see PLAN_RETRIEVAL below); a ninth would exceed what the cap was set for.
 */
export const CURATED_TERM_CAP = 8;

/**
 * Merges the three sources of curated any-match vocabulary, in fixed priority order:
 *
 * 1. Phase B's own high-priority requirement hints and leading intent terms (`phaseBTerms`);
 * 2. a progressive round's derived gap terms (`gapTerms`), exact-deduplicated against 1;
 * 3. Phase D's graph-traversal terms (`traversalTerms`), appended **after** the derived terms and
 *    deduplicated case-insensitively against everything already in the list, filling only the slots
 *    the first two sources left open — never exceeding `CURATED_TERM_CAP`.
 *
 * Without traversal terms this is exactly the pre-Phase-D formula
 * (`[...new Set([...phaseB, ...gap])].slice(0, CAP)`), so single-pass runs and rounds whose walk
 * found nothing are byte-identical to the earlier build.
 */
export function mergeCuratedTerms(phaseBTerms: readonly string[], gapTerms: readonly string[], traversalTerms?: readonly string[]): string[] {
	const merged = [...new Set([...phaseBTerms, ...gapTerms])];
	if (traversalTerms === undefined || traversalTerms.length === 0) return merged.slice(0, CURATED_TERM_CAP);
	const seen = new Set(merged.map((term) => term.toLowerCase()));
	for (const term of traversalTerms) {
		if (merged.length >= CURATED_TERM_CAP) break;
		const key = term.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(term);
	}
	return merged.slice(0, CURATED_TERM_CAP);
}

/* ------------------------------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------------------------------- */

interface Context {
	trace: TraceWriter;
	transition(state: RetrievalState, payload: Record<string, unknown>): void;
}

function requireTraceRoot(root: string | undefined): string {
	if (!root) throw new Error("traceRoot is required unless persistTrace is false");
	return root;
}

function noopTrace(runId: string): TraceWriter {
	let seq = 0;
	return {
		runId,
		path: "(not persisted)",
		get seq() {
			return seq;
		},
		append(input) {
			const event: TraceEvent = { schemaVersion: SCHEMA_VERSION.traceEvent, runId, seq, at: input.at ?? 0, state: input.state, event: input.event, policyId: input.policyId ?? null, policyVersion: input.policyVersion ?? null, payload: input.payload ?? {} };
			seq += 1;
			return event;
		},
	};
}

/**
 * One standard pass of the state machine — what `runBriefing` did before Phase C gave it a second
 * mode. `runBriefing` is this function plus, when the caller asked for it, the bounded multi-round
 * loop around it; keeping the pass as its own function is what makes the two modes share one
 * implementation instead of measuring a copy.
 *
 * `extraCuratedTerms` carries a progressive round's gap terms into PLAN_RETRIEVAL's curated
 * any-match set, alongside Phase B's own vocabulary; the narrow ANDed terms are untouched for the
 * same reason `plan.ts` gives. `runId` names a non-zero round's own trace file — every round is a
 * full auditable run, not an unlogged side query. Both parameters are absent in production's
 * single-pass mode, where the behavior is byte-identical to the pre-Phase-C build.
 *
 * Never throws for a data reason. Every condition that would end a run early is one of spec §7's six
 * terminations, each carrying the briefing shell it managed to build and the gaps that explain it —
 * because design §20 requires that "failure must produce an explicit status and uncertainty report",
 * and an exception is neither.
 */
function runSinglePass(request: BriefingRequest, deps: OrchestratorDeps, extraCuratedTerms?: readonly string[], extraTraversalTerms?: readonly string[], runId?: string): OrchestrationResult {
	const effectiveRunId = runId ?? request.runId;
	const clock = deps.now ?? Date.now;
	const wall = deps.wallNow ?? Date.now;
	const startedAt = wall();
	const now = request.now ?? clock();
	const session = deps.session ?? newSession(now);
	session.runs += 1;

	const trace = deps.persistTrace === false ? noopTrace(effectiveRunId) : openTrace(effectiveRunId, { root: requireTraceRoot(deps.traceRoot), now: () => clock() });
	const ctx: Context = {
		trace,
		transition(state, payload) {
			trace.append({ state, event: "transition", payload, at: clock() });
		},
	};

	const gaps: RetrievalGap[] = [];
	const sources: SourceOutcome[] = [];
	const reasons: string[] = [];
	let retrievalMs = 0;
	// Phase B outputs. Declared here because `finish` closes over them; assigned right after
	// ANALYZE_TASK's outcome gates, so every exit past that point carries them.
	let situation: SituationContext | null = null;
	let intent: IntentHypothesisSet | null = null;
	let requirements: KnowledgeRequirement[] = [];

	/* --- RECEIVE_REQUEST ------------------------------------------------------------------------ */
	ctx.transition("RECEIVE_REQUEST", { requestingAgent: request.requestingAgent, project: request.project, mode: request.mode ?? "standard", contextBudget: request.contextBudget, taskChars: request.task.length, requestedProjects: request.requestedProjects ?? [], session: { runs: session.runs, circuitOpen: circuitOpenSources(session) } });

	/* --- ANALYZE_TASK --------------------------------------------------------------------------- */
	// Traces keep terms and entity text from the task, so the analysis and situation stages read the redacted text.
	const safeTask = deps.redact(request.task);
	const analysis = analyzeTask({ ...request, task: safeTask }, { tokenize: deps.tokenize });

	// **PHASE 4 — the requesting seat is resolved here, once, and everything downstream reads it.**
	//
	// Two things come out of it and they are deliberately separate. `resolution` decides the *ranking
	// policy* through `policy.ts`'s new agent link; `profile` decides the *composition* — section
	// shares, lead order, conflict presentation, the addendum and its token reserve. Keeping them
	// apart is what lets six of the eight seats share a ranking policy while still receiving visibly
	// different briefings, and it is why a change to one is reviewable without re-reading the other.
	const agent = resolveAgent(analysis.requestingAgent);
	const profile: AgentBriefingProfile = profileFor(agent.agent);
	// **PHASE 5 — the pin, when a caller supplied one.** Production supplies none, so this is
	// `resolvePolicy` exactly as Phases 1–4 ran it. A pinned run resolves through the chain that was
	// in force at the pinned registry version, which for `@2` is the four-link chain without the
	// agent binding — the very difference design §21.4 item 1 records Phase 4 as having introduced.
	const pin = deps.policyPin;
	const resolution = pin === undefined ? resolvePolicy(analysis.requestingAgent, analysis.taskType.value, analysis.mode.value) : resolvePolicyAt(pin.registryVersion, analysis.requestingAgent, analysis.taskType.value, analysis.mode.value);
	// `withAgentSelection` returns the identical object when this seat uses design §10's shares, so
	// three of the eight (Avaritia, Vaelia, and any unrecognised caller) are scored and selected
	// against the byte-identical policy object Phases 1–3 measured.
	//
	// Per-seat section shares are themselves a `@3` registry change (design §19 item 3's `@2 → @3`
	// packet lists them), so a pin below `@3` puts design §10's shares back for every seat. The rest
	// of the briefing profile is the `agents.ts` layer and a *policy*-registry pin does not move it —
	// see `rollback.ts`'s header for why rolling both back under one request would be two changes.
	const policy = pin !== undefined && !appliesAgentSelection(pin.registryVersion) ? resolution.policy : withAgentSelection(resolution.policy, profile);
	trace.append({
		state: "ANALYZE_TASK",
		event: "transition",
		policyId: policy.policyId,
		policyVersion: policy.version,
		at: clock(),
		payload: {
			outcome: analysis.outcome,
			taskType: analysis.taskType,
			terms: analysis.terms.value,
			entities: analysis.entities.value,
			temporalNeed: analysis.temporalNeed,
			since: analysis.since,
			reasons: analysis.reasons,
			agent: { requested: agent.requested, resolved: agent.agent, how: agent.how, detail: agent.detail },
			policyResolution: { policyId: resolution.policy.policyId, matchedBy: resolution.matchedBy, attempted: resolution.attempted },
			policyPin: pin === undefined ? null : { registryVersion: pin.registryVersion, pinnedBy: pin.pinnedBy, reason: pin.reason, agentSelection: pin.agentSelection },
			profile: { leadSections: profile.leadSections, conflictPresentation: profile.conflictPresentation, blocks: profile.blocks, addendumCeiling: profile.addendumReserve, sharesAreDefault: policy.selection.sectionShares === resolution.policy.selection.sectionShares },
		},
	});

	const finish = (outcome: RunOutcome, finalState: RetrievalState, extra: Partial<OrchestrationResult> = {}): OrchestrationResult => {
		const elapsedMs = Date.now() - startedAt;
		trace.append({ state: finalState, event: "outcome", at: clock(), payload: { outcome, elapsedMs, reasons, gaps } });
		return {
			runId: request.runId,
			outcome,
			finalState,
			delivered: false,
			briefing: null,
			markdown: null,
			validation: null,
			analysis,
			authorization: null,
			plan: null,
			policy,
			gaps,
			sources,
			claims: [],
			envelopes: [],
			candidates: [],
			graph: null,
			conflicts: null,
			selection: null,
			filters: null,
			stats: { envelopes: 0, uniqueEnvelopes: 0, claimsExtracted: 0, claimsDeduped: 0, claimsAccepted: 0, candidatesScored: 0, candidatesCapped: 0, itemsSelected: 0, conflicts: 0, quarantined: 0, unknownHeadingRate: 0, extraction: extractClaims([]).stats, elapsedMs, retrievalMs },
			tracePath: trace.path,
			reasons,
			situation,
			intent,
			requirements,
			...extra,
		};
	};

	if (analysis.outcome === "NO_MEMORY_REQUIRED") {
		reasons.push(...analysis.reasons);
		return finish("NO_MEMORY_REQUIRED", "ANALYZE_TASK");
	}
	if (analysis.outcome === "CLARIFICATION_REQUIRED") {
		reasons.push(...analysis.reasons);
		return finish("CLARIFICATION_REQUIRED", "ANALYZE_TASK");
	}

	/* --- PHASE B: SITUATION AND INTENT ---------------------------------------------------------- */
	// Three stages between task analysis and retrieval planning (build spec Phase B). Deterministic,
	// bounded and non-gating: a clarification *recommendation* is recorded and traced but never ends
	// the run here — ending runs on inferred ambiguity would let a heuristic override the caller, the
	// exact failure the spec's guardrail against redefining the user's task warns about.
	situation = validateSituationContext(analyseSituation(safeTask, request.requestingAgent, { project: request.project, requestedProjects: request.requestedProjects }));
	intent = inferIntentHypotheses(safeTask, situation);
	requirements = deriveKnowledgeRequirements(safeTask, situation, intent, request.requestingAgent);
	// The planning feed: high-priority requirement vocabulary plus the leading hypothesis's terms,
	// appended to the curated any-match set only (see `plan.ts` for why not the narrow conjunction).
	const phaseBExtraTerms = [...new Set([...requirements.filter((requirement) => requirement.priority === "high").flatMap((requirement) => requirement.queryHints ?? []), ...leadingQueryTerms(intent)])].slice(0, 4);
	// A progressive round's gap terms join the same curated set. They are appended *after* Phase B's
	// vocabulary so round 0's set is unchanged, and capped at eight because the set feeds a
	// disjunctive query over a ten-row curated corpus — width costs nothing there, unlike the
	// narrow conjunction (`plan.ts:MAX_QUERY_TERMS`). Undefined parameters ⇒ byte-identical set.
	// Phase D adds traversal vocabulary as the lowest-priority source (see mergeCuratedTerms).
	const plannedExtraCuratedTerms = mergeCuratedTerms(phaseBExtraTerms, extraCuratedTerms ?? [], extraTraversalTerms);
	trace.append({ state: "ANALYZE_TASK", event: "situation_analysis", at: clock(), payload: { schemaVersion: situation.schemaVersion, counts: situation.counts, items: situation.items.map((item) => ({ id: item.id, tier: item.tier, confidence: item.confidence, signals: item.supportingSignals.length })) } });
	trace.append({ state: "ANALYZE_TASK", event: "intent_hypotheses", at: clock(), payload: { schemaVersion: intent.schemaVersion, calibrated: intent.calibrated, probabilitiesSum: intent.probabilitiesSum, hypotheses: intent.hypotheses.map((hypothesis) => ({ id: hypothesis.hypothesisId, probability: hypothesis.probability, status: hypothesis.status })), recommendation: intent.recommendation } });
	trace.append({ state: "ANALYZE_TASK", event: "knowledge_requirements", at: clock(), payload: { count: requirements.length, requirements: requirements.map((requirement) => ({ id: requirement.requirementId, priority: requirement.priority, sourcePreference: requirement.sourcePreference })) } });

	// Chunk C's leftover, now a decision rather than a validator failure. See
	// `select.ts:minimumConformingBudget` for the arithmetic. Checked here, before AUTHORIZE_SCOPE,
	// because the answer does not depend on anything a query could return.
	//
	// **PHASE 4 — the seat's addendum reserve is part of the frame, so it is part of the floor.**
	// `select.ts` step 0 charges `scaffolding + reserve` before a claim is placed, so a seat whose
	// addendum needs 380 tokens genuinely cannot produce a conforming briefing at the budget that
	// suffices for a seat whose addendum needs none. Computing the floor from the shared constant and
	// then charging the larger overhead would put the whole reserve on the wrong side of the check,
	// and the run would exit `PARTIAL_BRIEFING` for a budget it should have refused up front.
	const addendumReserve = effectiveAddendumReserve(profile, analysis.contextBudget.value);
	const scaffolding = BRIEFING_SCAFFOLDING_TOKENS + addendumReserve;
	const floor = minimumConformingBudgetForSeat(analysis.objective, policy, BRIEFING_SCAFFOLDING_TOKENS, profile.addendumReserve);
	if (analysis.contextBudget.value < floor) {
		reasons.push(`the ${analysis.contextBudget.value}-token budget is below the ${floor}-token floor for a conforming briefing (a ${policy.selection.reserveRatio * 100}% reserve plus the objective echo plus the briefing frame${addendumReserve === 0 ? "" : ` plus this seat's ${addendumReserve}-token agent addendum`}); no selection of evidence can fix that, so the request needs a larger budget`);
		ctx.transition("ANALYZE_TASK", { earlyExit: "CLARIFICATION_REQUIRED", minimumConformingBudget: floor, contextBudget: analysis.contextBudget.value, scaffolding, addendumReserve });
		gaps.push({ sourceId: "mnemosia/selection", reason: "budget", detail: `contextBudget ${analysis.contextBudget.value} < ${floor}, the minimum that holds the objective echo and the briefing frame`, code: null });
		return finish("CLARIFICATION_REQUIRED", "ANALYZE_TASK");
	}

	/* --- AUTHORIZE_SCOPE ------------------------------------------------------------------------ */
	const authorization = authorizeScope(analysis);
	ctx.transition("AUTHORIZE_SCOPE", { outcome: authorization.outcome, granted: authorization.granted.map((grant) => ({ scope: `${grant.scope.level}:${grant.scope.project ?? "-"}`, ruleId: grant.ruleId })), refused: authorization.refused.map((refusal) => ({ scope: `${refusal.scope.level}:${refusal.scope.project ?? "-"}`, ruleId: refusal.ruleId })), reasons: authorization.reasons });
	if (authorization.outcome === "INSUFFICIENT_AUTHORIZATION") {
		reasons.push(...authorization.reasons);
		for (const refusal of authorization.refused) gaps.push({ sourceId: "mnemosia/authorization", reason: "not_planned", detail: refusal.detail, code: null });
		return finish("INSUFFICIENT_AUTHORIZATION", "AUTHORIZE_SCOPE", { authorization });
	}

	/* --- PLAN_RETRIEVAL ------------------------------------------------------------------------- */
	const probes: AdapterProbe[] = deps.adapters.map((adapter) => {
		const probe = adapter.probe();
		trace.append({ state: "PLAN_RETRIEVAL", event: "adapter_result", at: clock(), payload: { phase: "probe", ...probe } });
		// A probe that reports unavailable is a failure for breaker purposes: two of them in a session
		// is exactly the "failing twice" design §13 opens the circuit on.
		if (!probe.available) recordSourceFailure(session, probe.sourceId, clock());
		return probe;
	});
	const plan = planRetrieval({ analysis, authorization, probes, circuitOpen: circuitOpenSources(session), now, extraCuratedTerms: plannedExtraCuratedTerms });
	gaps.push(...plan.gaps);
	trace.append({ state: "PLAN_RETRIEVAL", event: "transition", policyId: policy.policyId, policyVersion: policy.version, at: clock(), payload: { selected: plan.selected, rejected: plan.rejected, decisions: plan.decisions.map((decision) => ({ sourceId: decision.sourceId, selected: decision.selected, ruleId: decision.ruleId, justification: decision.justification })), queries: plan.queries.length, tokenBudget: plan.tokenBudget, maxCandidates: plan.maxCandidates, deadlines: plan.deadlines, retryPolicy: plan.retryPolicy, stopConditions: plan.stopConditions } });

	const everyProbeDown = probes.length > 0 && probes.every((probe) => !probe.available);
	const everySourceUnreachable = plan.decisions.length > 0 && plan.decisions.every((decision) => !decision.selected && (decision.ruleId === "probe_unavailable" || decision.ruleId === "circuit_open" || decision.ruleId === "not_registered"));
	if (everyProbeDown || everySourceUnreachable) {
		reasons.push(`every registered source is unavailable: ${plan.decisions.map((decision) => `${decision.sourceId} (${decision.ruleId})`).join(", ")}`);
		return finish("RETRIEVAL_UNAVAILABLE", "PLAN_RETRIEVAL", { authorization, plan });
	}
	if (plan.selected.length === 0) {
		// Every source was rejected *on its merits* — a healthy corpus the planner declined to read.
		// That is not an availability failure and reporting it as one would make an honest planning
		// decision look like an outage.
		reasons.push(`the planner selected no source: ${plan.decisions.map((decision) => `${decision.sourceId} (${decision.ruleId})`).join(", ")}`);
		return finish("INSUFFICIENT_INFORMATION", "PLAN_RETRIEVAL", { authorization, plan });
	}

	/* --- EXECUTE_SOURCE_QUERIES ----------------------------------------------------------------- */
	const runDeadline = runDeadlineFor(analysis.mode.value, startedAt);
	const rawEnvelopes: ArtifactEnvelope[] = [];
	const outcomeBySource = new Map<SourceId, SourceOutcome>();
	const adapterIndex = new Map(deps.adapters.map((adapter) => [adapter.sourceId, adapter]));
	// The run's excerpt-window anchor (claims.ts:402-420) is taken from a **conjunctive** query only.
	// An `any`-match query carries the wide term set precisely because it is not trying to be precise,
	// so anchoring raw-event excerpts on it would centre them on whichever task word happened to occur
	// first rather than on the subject the narrow query actually matched.
	let queryTerms: string[] = plan.queries.find((query) => query.matchMode === "all" && query.terms.length > 0)?.terms ?? [];

	for (const query of plan.queries) {
		const adapter = adapterIndex.get(query.sourceId);
		let outcome = outcomeBySource.get(query.sourceId);
		if (outcome === undefined) {
			outcome = { sourceId: query.sourceId, attempts: [], envelopes: 0, failed: false, circuitOpened: false };
			outcomeBySource.set(query.sourceId, outcome);
			sources.push(outcome);
		}
		if (adapter === undefined) {
			gaps.push({ sourceId: query.sourceId, reason: "not_planned", detail: "the plan selected this source but no adapter with that id is registered", code: null });
			continue;
		}
		if (wall() >= runDeadline) {
			gaps.push({ sourceId: query.sourceId, reason: "deadline", detail: `the ${runDeadline - startedAt} ms run deadline elapsed before ${query.sourceId} was queried`, code: null });
			continue;
		}

		// **CORRECTED IN PHASE 4 — the per-source deadline was read off the wrong clock.**
		// **CORRECTED 2026-10-05 — the window was anchored at the wrong instant.**
		//
		// Deadlines remain wall-clock quantities (the Phase 4 rule below still holds), but anchoring
		// every source's window at the RUN's start made the per-source window a shared resource:
		// sources execute sequentially, so the pre-EXECUTE preamble (source probes) plus the first
		// source's work routinely consumed later sources' windows before their first query ran. On
		// the live corpus, 60 recorded runs show every source breaking at rung 0 with zero adapter
		// queries — paired "deadline ... after 0 term-ladder rung(s)" + "empty_result after 0
		// term-ladder rung(s)" gaps and INSUFFICIENT_INFORMATION over sources that were healthy.
		// The documented intent — "every selected source may take its full deadline" — is restored by
		// anchoring the window at THIS source's arrival (wall clock), still clamped by the run
		// ceiling: the ceiling, not source ordering, is what bounds total retrieval time.
		//
		// (Phase 4, preserved:) `plan.ts` computes `deadlines[sourceId]` from the *logical* clock —
		// `deps.now()` — while the checks here are wall-clock. In production the two coincide; a
		// caller pinning the logical clock (scripts/phase4-live.ts, the eval harness's fixed NOW)
		// must not have that pin interpreted as elapsed time. The window is therefore derived from
		// `deps.wallNow` — never `deps.now`. `plan.deadlines` stays on the plan for the trace, as the
		// budget the plan declared.
		const perSourceMs = MODE_CONFIGS[analysis.mode.value].deadlineMsPerSource;
		const deadline = Math.min(wall() + perSourceMs, runDeadline);
		// The ladder. A query that carries no term has exactly one rung and no retry: there is nothing
		// to broaden, and `plan.ts` already justified reading that source without one.
		//
		// An `any`-match query has one rung for a different reason: its rungs would be *subsets* of a
		// disjunction, so every retry can only return fewer rows than the one that just came back
		// empty. The ladder broadens a conjunction; there is nothing for it to broaden here, and
		// running it anyway would spend a query per rung to re-derive the same empty answer.
		const rungs = query.matchMode === "any" ? [query.terms] : termLadder(query.terms);
		let produced = 0;
		for (const [index, terms] of rungs.entries()) {
			if (wall() >= deadline) {
				gaps.push({ sourceId: query.sourceId, reason: "deadline", detail: `the per-source deadline elapsed after ${index} term-ladder rung(s)`, code: null });
				break;
			}
			const attempt: PlannedQuery = terms.length === query.terms.length ? query : { ...query, terms, justification: `${query.justification} — term-ladder rung ${index + 1}: retried with ${terms.length} of ${query.terms.length} term(s) after an empty result` };
			const startedQuery = Date.now();
			let result: AdapterResult | null = null;
			let errorMessage: string | null = null;
			let errorCode: string | null = null;
			try {
				result = adapter.query(attempt, deadline);
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				errorCode = isStandardAdapterError(error) ? error.code : null;
			}
			const elapsed = Date.now() - startedQuery;
			retrievalMs += elapsed;
			outcome.attempts.push({ terms: [...terms], envelopes: result?.envelopes.length ?? 0, elapsedMs: elapsed, pagesRead: result?.pagesRead ?? 0, truncated: result?.truncated ?? false, error: errorMessage, code: errorCode });
			trace.append({ state: "EXECUTE_SOURCE_QUERIES", event: "adapter_result", at: clock(), payload: { sourceId: query.sourceId, scope: `${query.scope.level}:${query.scope.project ?? "-"}`, rung: index + 1, terms, envelopes: result?.envelopes.length ?? 0, pagesRead: result?.pagesRead ?? 0, truncated: result?.truncated ?? false, elapsedMs: elapsed, error: errorMessage, code: errorCode } });

			if (errorMessage !== null) {
				// Design §13: adapter isolation. The failure is named, the breaker is told, and the loop
				// moves on — the run continues with whatever the other sources returned.
				outcome.failed = true;
				gaps.push({ sourceId: query.sourceId, reason: "adapter_error", detail: errorMessage, code: (errorCode as RetrievalGap["code"]) ?? "internal" });
				if (recordSourceFailure(session, query.sourceId, clock())) {
					outcome.circuitOpened = true;
					trace.append({ state: "EXECUTE_SOURCE_QUERIES", event: "adapter_result", at: clock(), payload: { sourceId: query.sourceId, circuit: "opened", threshold: CIRCUIT_FAILURE_THRESHOLD, detail: "the breaker stays open until session_start (design §13)" } });
				}
				break;
			}
			if (result !== null && result.envelopes.length > 0) {
				rawEnvelopes.push(...result.envelopes);
				produced = result.envelopes.length;
				outcome.envelopes += result.envelopes.length;
				// The rung that succeeded becomes the run's query terms, so claim extraction anchors
				// its excerpt windows on the terms that actually matched (claims.ts:402-420). Rung 0
				// included — otherwise a later source's envelopes are excerpt-anchored on an earlier
				// source's reduced terms.
				queryTerms = [...terms];
				if (index > 0) {
					trace.append({ state: "EXECUTE_SOURCE_QUERIES", event: "transition", at: clock(), payload: { sourceId: query.sourceId, termLadder: "recovered", rung: index + 1, from: query.terms, to: terms, envelopes: result.envelopes.length } });
				}
				break;
			}
		}
		if (produced === 0 && !outcome.failed) {
			gaps.push({ sourceId: query.sourceId, reason: "empty_result", detail: `the query returned no artifacts after ${outcome.attempts.length} term-ladder rung(s) (${rungs.map((rung) => `[${rung.join(" ")}]`).join(" → ")})`, code: null });
		}
	}

	const queriedSources = [...outcomeBySource.values()];
	if (queriedSources.length > 0 && queriedSources.every((entry) => entry.failed)) {
		reasons.push(`every selected source failed: ${queriedSources.map((entry) => entry.sourceId).join(", ")}`);
		ctx.transition("EXECUTE_SOURCE_QUERIES", { earlyExit: "RETRIEVAL_UNAVAILABLE", failed: queriedSources.map((entry) => entry.sourceId) });
		return finish("RETRIEVAL_UNAVAILABLE", "EXECUTE_SOURCE_QUERIES", { authorization, plan });
	}
	ctx.transition("EXECUTE_SOURCE_QUERIES", { envelopes: rawEnvelopes.length, bySource: Object.fromEntries(queriedSources.map((entry) => [entry.sourceId, entry.envelopes])), failed: queriedSources.filter((entry) => entry.failed).map((entry) => entry.sourceId), retrievalMs });

	/* --- NORMALIZE_ARTIFACTS -------------------------------------------------------------------- */
	//
	// The trust boundary (design §5). Content is hashed and channel-tagged by the adapters on the way
	// out of the provider; here it is deduplicated by identity and safety-scanned, and after this
	// point it is only ever data.
	//
	// Deduplication is not cosmetic: `queryScopes` issues one query per authorized project scope and
	// AkashicForge reads a project filter as "global ∪ this project" (store.ts:661), so a global row
	// legitimately comes back from every scope query. Counting it twice would double its weight in
	// `evidence_strength`, which prices *distinct artifacts* (rank.ts:338).
	const envelopeIndex = new Map<string, ArtifactEnvelope>();
	for (const envelope of rawEnvelopes) if (!envelopeIndex.has(envelope.artifactId)) envelopeIndex.set(envelope.artifactId, envelope);
	const envelopes = [...envelopeIndex.values()];
	const artifactScan = scanArtifacts(envelopes, deps.scan);
	ctx.transition("NORMALIZE_ARTIFACTS", { received: rawEnvelopes.length, unique: envelopes.length, duplicatesDropped: rawEnvelopes.length - envelopes.length, scanned: artifactScan.scanned, quarantined: artifactScan.quarantined.size, unscannable: artifactScan.unscannable, bySourceType: tally(envelopes.map((envelope) => envelope.sourceType)), byIntegrity: tally(envelopes.map((envelope) => envelope.integrityStatus)) });
	for (const entry of artifactScan.quarantined.values()) trace.append({ state: "NORMALIZE_ARTIFACTS", event: "filter_reject", at: clock(), payload: { rule: "quarantine", ...entry } });

	/* --- EXTRACT_OR_RESOLVE_CLAIMS -------------------------------------------------------------- */
	const extraction = extractClaims(envelopes, { terms: queryTerms });
	const knownSections = extraction.stats.knownSections + extraction.stats.unknownSections;
	const unknownHeadingRate = knownSections === 0 ? 0 : extraction.stats.unknownSections / knownSections;
	ctx.transition("EXTRACT_OR_RESOLVE_CLAIMS", { claims: extraction.stats.claims, byPath: extraction.stats.byPath, knownSections: extraction.stats.knownSections, unknownSections: extraction.stats.unknownSections, unknownHeadingRate, unknownHeadings: extraction.stats.unknownHeadings, droppedTrailingBlocks: extraction.stats.droppedTrailingBlocks, unhandledEnvelopes: extraction.stats.unhandledEnvelopes });
	if (unknownHeadingRate > SUMMARY_DRIFT_WARNING) {
		// Design §18 risk 3. Recorded, not raised: a grammar that drifted still extracts whole-section
		// OBSERVATIONs, so the run is degraded rather than broken, and `/mnemosia status` is where an
		// operator is told.
		trace.append({ state: "EXTRACT_OR_RESOLVE_CLAIMS", event: "validation", at: clock(), payload: { warning: "summary_grammar_drift", rate: unknownHeadingRate, threshold: SUMMARY_DRIFT_WARNING, headings: extraction.stats.unknownHeadings } });
	}

	/* --- DEDUPLICATE ---------------------------------------------------------------------------- */
	const deduped = dedupeClaims(extraction.claims);
	ctx.transition("DEDUPLICATE", { before: deduped.before, after: deduped.after, merged: deduped.merged, multiSourced: deduped.multiSourced });

	/* --- APPLY_HARD_FILTERS --------------------------------------------------------------------- */
	const filters = applyHardFilters({ claims: deduped.claims, envelopes, authorization, scan: deps.scan, artifactScan, now, failClosedOnUnverified: plan.failClosedOnUnverified });
	for (const rejection of filters.rejections) trace.append({ state: "APPLY_HARD_FILTERS", event: "filter_reject", at: clock(), payload: { ...rejection } });
	ctx.transition("APPLY_HARD_FILTERS", { in: filters.stats.claimsIn, out: filters.stats.claimsOut, rejected: filters.stats.rejected, byRule: filters.stats.byRule, quarantined: filters.stats.artifactsQuarantined, evidencePruned: filters.stats.evidencePruned, failClosedOnUnverified: plan.failClosedOnUnverified });

	const partialStats = (): RunStats => ({
		envelopes: rawEnvelopes.length,
		uniqueEnvelopes: envelopes.length,
		claimsExtracted: extraction.stats.claims,
		claimsDeduped: deduped.after,
		claimsAccepted: filters.stats.claimsOut,
		candidatesScored: 0,
		candidatesCapped: 0,
		itemsSelected: 0,
		conflicts: 0,
		quarantined: filters.stats.artifactsQuarantined,
		unknownHeadingRate,
		extraction: extraction.stats,
		elapsedMs: Date.now() - startedAt,
		retrievalMs,
	});

	if (filters.accepted.length === 0) {
		reasons.push(`no claim survived hard filtering: ${extraction.stats.claims} extracted, ${deduped.after} after deduplication, ${filters.stats.rejected} rejected (${Object.entries(filters.stats.byRule).filter(([, count]) => count > 0).map(([rule, count]) => `${rule}=${count}`).join(", ") || "none"})`);
		gaps.push({ sourceId: "mnemosia/filters", reason: "empty_result", detail: reasons[reasons.length - 1] ?? "nothing survived hard filtering", code: null });
		return finish("INSUFFICIENT_INFORMATION", "APPLY_HARD_FILTERS", { authorization, plan, envelopes, claims: deduped.claims, filters, stats: partialStats() });
	}

	/* --- SCORE_CANDIDATES ----------------------------------------------------------------------- */
	// **PHASE 2 — the provenance graph.**
	//
	// Built here, between hard filtering and scoring, because both of the states that follow read it:
	// `SCORE_CANDIDATES` prices evidence strength off graph distance, corroboration and contradiction,
	// and `DETECT_CONFLICTS` classifies the very edges that were priced. Building it twice would let
	// the number a reader sees and the conflict they are shown disagree about what the run holds. It
	// covers the **accepted** claims only — a rejected claim must not appear in the graph any more
	// than it may appear in the briefing.
	const graph = buildProvenanceGraph({ claims: filters.accepted, envelopes, now, shingleSize: policy.selection.shingleSize, neighbourhoodThreshold: policy.conflict.neighbourhoodThreshold });
	trace.append({
		state: "APPLY_HARD_FILTERS",
		event: "provenance",
		at: clock(),
		policyId: policy.policyId,
		policyVersion: policy.version,
		payload: { ...graph.stats, qualifierRanking: QUALIFIER_RANKING },
	});

	// **PHASE D — cross-agent lineage over the accepted claim set.** One event per run, recorded after
	// hard filtering fixed what "accepted" means and never read by anything downstream of it: which
	// seat produced each accepted claim (via `specialist-finding:<seat>` tags on its evidence) and
	// which seat requested the run. `joinCoverage` is always numeric; consumers apply
	// MIN_LINEAGE_COVERAGE themselves so the shortfall stays observable even where lineage is absent.
	const lineage = buildAgentLineage({ claims: filters.accepted, envelopes, requestingAgent: analysis.requestingAgent, effectiveRunId, requestRunId: request.runId });
	trace.append({ state: "APPLY_HARD_FILTERS", event: "agent_lineage", at: clock(), payload: { ...lineage } });

	const ranked = rankCandidates({ claims: filters.accepted, envelopes, analysis, tokenize: deps.tokenize, policy, graph, now, trace });
	let candidates = ranked.candidates;
	let candidatesCapped = 0;
	if (candidates.length > plan.maxCandidates) {
		// The mode's candidate cap, applied after ranking so what survives is the highest-utility
		// prefix rather than whatever the adapters happened to return first. Disclosed as a gap: the
		// reader is told the corpus held more than the mode was willing to weigh.
		candidatesCapped = candidates.length - plan.maxCandidates;
		candidates = candidates.slice(0, plan.maxCandidates);
		gaps.push({ sourceId: "mnemosia/ranking", reason: "budget", detail: `${analysis.mode.value} mode weighs at most ${plan.maxCandidates} candidates; ${candidatesCapped} lower-utility claim(s) were not considered for selection`, code: null });
	}
	// **PHASE 5 — model-assisted reranking, and it is off (spec §12, design §3).**
	//
	// Placed *here*, after the mode's candidate cap, and the position is the argument. §12 admits
	// LLM-assisted reranking "only after deterministic filtering"; the cap is the last deterministic
	// narrowing a candidate faces, so a reranker in front of it would be deciding what gets weighed
	// rather than reordering what already was. Behind it, the reranker's whole reachable universe is
	// the set the deterministic pipeline already admitted — which is why `rerank.ts` can guarantee
	// structurally that no hard-filtered claim is ever resurrected.
	//
	// It is called with no gate and no model, so the `rerank` trace event exists on every run and a replay
	// can tell "the gate was closed" from "the stage was never wired". The default gate returns `candidates`
	// **by identity**. There is no option to open it: selectContext re-sorts by utility, so a reranked
	// order would be ignored, and reranking stays off until that selection part is built.
	const reranked = applyReranking(candidates, { runId: effectiveRunId, objective: analysis.objective, policyId: policy.policyId, trace, now: clock });
	candidates = reranked.candidates;
	ctx.transition("SCORE_CANDIDATES", { scored: ranked.stats.scored, capped: candidatesCapped, meanUtility: ranked.stats.meanUtility, maxUtility: ranked.stats.maxUtility, minUtility: ranked.stats.minUtility, byAuthorityClass: ranked.stats.byAuthorityClass, policyResolvedBy: ranked.resolution.matchedBy, rerank: { status: reranked.status, rerankerVersion: reranked.rerankerVersion, moved: reranked.moved, dropped: reranked.dropped.length } });

	/* --- DETECT_CONFLICTS / RESOLVE_OR_ESCALATE ------------------------------------------------- */
	const conflictsEnabled = deps.conflictDetection !== "off";
	// Authority for `AUTHORITY_DISAGREEMENT` comes from the scores that were just computed, so the
	// classifier and the ranker cannot disagree about a source's standing. A claim that was capped out
	// of the candidate set has no score and therefore no authority — the class simply does not fire
	// for it, which is correct: it is not in the briefing to disagree with anything.
	const authorityByClaim = new Map(candidates.map((candidate) => [candidate.claim.claimId, candidate.score.authority]));
	let conflicts = conflictsEnabled
		? detectConflicts({ claims: candidates.map((candidate) => candidate.claim), graph, policy, authorityOf: (claimId) => authorityByClaim.get(claimId), now, trace })
		: detectConflicts({ claims: [], graph, policy, now });
	ctx.transition("DETECT_CONFLICTS", { enabled: conflictsEnabled, conflicts: conflicts.stats.conflicts, byClass: conflicts.stats.byClass, byDetector: conflicts.stats.byDetector, dangling: conflicts.stats.danglingReferences, unresolved: conflicts.stats.unresolved, pairsExamined: conflicts.stats.pairsExamined, pairsUnexplained: conflicts.stats.pairsUnexplained, ungroundedSummaries: conflicts.stats.ungroundedSummaries, ...(conflictsEnabled ? {} : { ablation: "conflictDetection=off (design §16 / spec §24 comparison system); no conflict was looked for, which is not the same as none existing" }) });
	/* --- RESOLVE_OR_ESCALATE -------------------------------------------------------------------- */
	//
	// **PHASE 4 — the state finally does the second half of its own name.** Through Phases 1–3 it
	// recorded resolution and reported `escalated: 0`, because `detectConflicts` does not know who is
	// asking and a routing label whose recipient might be its own author is not a routing decision.
	// `routeEscalations` is handed the requesting seat and the authorization, and produces an
	// addressed `EscalationRequest` for every label it writes — `escalation.ts` has the two rules and
	// why they divide the way they do.
	//
	// Integrity comes from the envelopes behind each claim rather than from a second read: the
	// `authority_over_unverified` rule compares the standing table's pick against what the *content
	// hash check* concluded, and the two must be looking at the same artifact for the comparison to
	// mean anything.
	const envelopeIntegrity = new Map(envelopes.map((envelope) => [envelope.artifactId, envelope.integrityStatus]));
	const integrityOf = (claimId: string): "verified" | "unverified" | "failed" | undefined => {
		const claim = filters.accepted.find((entry) => entry.claimId === claimId);
		if (claim === undefined) return undefined;
		const states = claim.evidence.map((entry) => envelopeIntegrity.get(entry.artifactId)).filter((state): state is "verified" | "unverified" | "failed" => state !== undefined);
		if (states.length === 0) return undefined;
		// The weakest link, not the best: a claim standing on one verified and one unverified artifact
		// is a claim part of whose support was never checked, and reporting it as verified would let a
		// single unchecked co-citation ride in on a verified one.
		return states.includes("failed") ? "failed" : states.includes("unverified") ? "unverified" : "verified";
	};

	const routed = routeEscalations({ conflicts, authorization, requestingAgent: analysis.requestingAgent, integrityOf, now, trace });
	const escalations: EscalationRequest[] = routed.escalations;
	// The outcome rewrite is applied to a *copy*; the `conflict` trace events already recorded what the
	// detector concluded, and both facts stay in the log (see `applyEscalationOutcomes`).
	//
	// Order matters and is not arbitrary: escalation runs **before** presentation, so that a conflict
	// routed to a seat keeps its routing label rather than having it overwritten by
	// `INCLUDE_BOTH_WITH_QUALIFICATION` — and `applyConflictPresentation` skips escalated records for
	// the same reason from the other side. Reversing the two would silently un-route every escalation
	// raised in an Elaria or Nytheria run, i.e. in exactly the two runs most likely to raise one.
	conflicts = applyConflictPresentation(applyEscalationOutcomes(conflicts, routed.outcomeOverrides), profile.conflictPresentation);
	ctx.transition("RESOLVE_OR_ESCALATE", {
		byOutcome: conflicts.stats.byOutcome,
		demoted: conflicts.stats.demoted,
		unresolved: conflicts.stats.unresolved,
		mandatory: conflicts.mandatory.size,
		escalated: routed.stats.total,
		byTarget: routed.stats.byTarget,
		byRule: routed.stats.byRule,
		selfDelivered: routed.stats.selfDelivered,
		note: "conflict outcomes remain briefing-level: no resolution and no escalation mutates a store (design §11). ESCALATE_TO_ELARIA and ESCALATE_TO_RASKREIA are written by escalation.ts, which routes; detectConflicts still emits only DETERMINISTIC_CONFLICT_OUTCOMES. REQUEST_HUMAN_APPROVAL stays with approvals.ts, where a named human actually decides.",
	});

	/* --- SELECT_CONTEXT_SET --------------------------------------------------------------------- */
	// `selection.gaps` are not appended here: `assembleBriefing` merges them itself (brief.ts:278), and
	// adding them twice would double every budget gap in the delivered briefing.
	const selection = selectContext({ candidates, conflicts, budget: plan.tokenBudget, policy, objective: analysis.objective, scaffoldingTokens: scaffolding, trace });
	ctx.transition("SELECT_CONTEXT_SET", { selected: selection.stats.selected, excluded: selection.stats.excluded, byReason: selection.stats.byReason, budget: selection.budget, partial: selection.partial, stopReason: selection.stats.stopReason, iterations: selection.stats.iterations });

	/* --- REQUEST_COMPRESSION -------------------------------------------------------------------- */
	//
	// Design §6 records this state as a no-op and spec §7 marks it "when needed". It is not needed and
	// could not be honoured: §15's compression path is "request compression for eligible
	// material", and no compaction source exists here, so there is no compressor to ask.
	// Recording the state with the reason keeps the trace a faithful copy of the machine rather than a
	// log of the states that happened to do work.
	ctx.transition("REQUEST_COMPRESSION", { requested: false, reason: selection.partial ? "the briefing is partial, but no compaction source exists, so there is no compressor to request material from (design §1); the shortfall is disclosed as a retrieval gap instead" : "the selected context set fits the budget; no compression is needed", eligibleItems: 0 });

	/* --- ASSEMBLE_BRIEFING ---------------------------------------------------------------------- */
	const briefing = assembleBriefing({ runId: effectiveRunId, analysis, authorization, selection, conflicts, claims: deduped.claims, envelopes, graph, gaps, filterStats: filters.stats, quarantined: filters.quarantined, policy, redact: deps.redact, now, profile, policyMatchedBy: resolution.matchedBy, escalations });
	const markdown = renderMarkdown(briefing, { selection });
	ctx.transition("ASSEMBLE_BRIEFING", { status: briefing.status, items: selection.items.length, provenanceEntries: briefing.provenance.length, tokenUsage: briefing.token_usage, gaps: briefing.retrieval_gaps.length, renderedTokens: Math.ceil(markdown.length / 4) });

	/* --- VALIDATE_BRIEFING ---------------------------------------------------------------------- */
	const validation = validateBriefing(briefing, { claims: deduped.claims, rendered: markdown });
	// Two events, deliberately. The `transition` keeps design §6's promise that *every* state appends
	// one — a replay that indexes by transition must not find a hole here of all places — and the
	// `validation` carries the violations, which is a different kind of record and a different consumer.
	ctx.transition("VALIDATE_BRIEFING", { valid: validation.valid, checked: validation.checked, violations: validation.violations.length });
	trace.append({ state: "VALIDATE_BRIEFING", event: "validation", at: clock(), payload: { valid: validation.valid, checked: validation.checked, violations: validation.violations } });

	const stats: RunStats = {
		...partialStats(),
		candidatesScored: ranked.stats.scored,
		candidatesCapped,
		itemsSelected: selection.items.length,
		conflicts: conflicts.stats.conflicts,
		elapsedMs: Date.now() - startedAt,
	};
	const complete: OrchestrationResult = {
		runId: request.runId,
		outcome: "DELIVERED",
		finalState: "COLLECT_FEEDBACK",
		delivered: true,
		briefing,
		markdown,
		validation,
		analysis,
		authorization,
		plan,
		policy,
		gaps: briefing.retrieval_gaps,
		sources,
		claims: deduped.claims,
		envelopes,
		candidates,
		graph,
		conflicts,
		selection,
		filters,
		situation,
		intent,
		requirements,
		stats,
		tracePath: trace.path,
		reasons,
	};

	if (!validation.valid) {
		// Fails closed (brief.ts:509-516). An uncertified briefing is not delivered and its rendering
		// is withheld, because the whole point of the provenance gate is that unsourced text must not
		// reach another agent's context. The briefing object is still returned, for the operator.
		reasons.push(`VALIDATE_BRIEFING refused to certify the briefing: ${validation.violations.map((violation) => violation.code).join(", ")}`);
		trace.append({ state: "VALIDATE_BRIEFING", event: "outcome", at: clock(), payload: { outcome: "INSUFFICIENT_INFORMATION", delivered: false, violations: validation.violations } });
		return { ...complete, outcome: "INSUFFICIENT_INFORMATION", finalState: "VALIDATE_BRIEFING", delivered: false, markdown: null };
	}

	/* --- DELIVER / COLLECT_FEEDBACK ------------------------------------------------------------- */
	const partial = briefing.status === "partial";
	if (partial) reasons.push(`the briefing is partial: ${briefing.retrieval_gaps.map((gap) => `${gap.sourceId}/${gap.reason}`).join(", ") || "selection dropped material"}`);
	else reasons.push(`complete briefing: ${selection.items.length} item(s) over ${briefing.provenance.length} claim(s), ${briefing.token_usage.used}/${briefing.token_usage.budget} tokens`);

	ctx.transition("DELIVER", { status: briefing.status, delivered: true, items: selection.items.length, tokens: briefing.token_usage.used, gaps: briefing.retrieval_gaps.map((gap) => `${gap.sourceId}/${gap.reason}`) });
	ctx.transition("COLLECT_FEEDBACK", { collected: false, reason: "feedback is submitted out of band by the consuming agent via submitFeedback(); design §22 forbids updating a production policy from it online" });
	trace.append({ state: "COLLECT_FEEDBACK", event: "outcome", at: clock(), payload: { outcome: partial ? "PARTIAL_BRIEFING" : "DELIVERED", elapsedMs: stats.elapsedMs, retrievalMs, reasons } });

	return { ...complete, outcome: partial ? "PARTIAL_BRIEFING" : "DELIVERED" };
}

/**
 * Runs the state machine end to end — one standard pass, or a bounded progressive loop around it.
 *
 * Without `deps.progressive` this is exactly `runSinglePass` and nothing else: Phase A and Phase B
 * behavior is byte-identical to the pre-Phase-C build, and no field the older callers read changes.
 *
 * With `deps.progressive`, the pass becomes round 0 of `progressive.ts`'s bounded loop. Round 0 runs
 * first *outside* the loop because its Phase B knowledge requirements are an input to the loop
 * policy (`evaluateCoverage` needs requirements and evidence to compare), not an output of it; the
 * already-computed result is handed back in as round 0 so it is never computed twice. A run that
 * ended before selection produced evidence cannot be helped by another round — every early exit up
 * to that point is derived from the request alone and will recur identically — so it is returned
 * as-is rather than fed through coverage evaluation it cannot meaningfully enter.
 *
 * Each further round is a full `runSinglePass` under its own trace file
 * (``<runId>-r<n>`` — trace.ts's runId pattern allows the suffix), with the previous round's gap
 * terms appended to the curated any-match set. The delivered answer is the best round's own
 * `OrchestrationResult`, carrying the sufficiency report on `.progressive`; the report describes
 * what that round delivered, not the cumulative merge (see `runProgressiveRetrieval`).
 */
/**
 * The escalation bound the locked Phase C production policy names (operator decision, 2026-08-22):
 * selective escalation with a two-round hard cap. `budgetPerRoundRatio` is carried because
 * `ProgressiveConfig` requires it; `runProgressiveRetrieval` reads only `maxRounds`, and 1 — every
 * round gets the caller's full budget — is the neutral value an explicit config would have meant.
 */
export const DEFAULT_ESCALATION_CONFIG: ProgressiveConfig = { maxRounds: 2, budgetPerRoundRatio: 1 };

export function runBriefing(request: BriefingRequest, deps: OrchestratorDeps): OrchestrationResult {
	const round0 = runSinglePass(request, deps);
	// **The default escalation gate (locked Phase C production policy).** Without an explicit config,
	// a Conclave seat whose governance block says `verification: "required"` escalates when round 0
	// left knowledge requirements uncovered; everyone else keeps the single pass. The invariant that
	// makes this free where it does not help: round 0 covering every requirement stops the loop on
	// `SUFFICIENT_EVIDENCE` (or the round bound) without issuing a second query, and an early exit
	// before selection never enters the loop at all.
	let progressiveConfig = deps.progressive;
	if (progressiveConfig === undefined) {
		const verificationRequired = profileFor(resolveAgent(round0.analysis.requestingAgent).agent).verification === "required";
		if (!(round0.requirements.length > 0 && verificationRequired)) return round0;
		progressiveConfig = DEFAULT_ESCALATION_CONFIG;
	}
	const canProgress = round0.requirements.length > 0 && round0.selection !== null;
	if (!canProgress) return round0;

	// Rounds are memoized by number: runProgressiveRetrieval re-requests round 0, which is the pass
	// already computed above, and each later round must be built exactly once so its trace file has
	// one writer and the memoized result is the one whose briefing gets selected.
	const roundsByNumber = new Map<number, OrchestrationResult>([[0, round0]]);
	const orchestrateFn = (round: number, gapTerms?: string[], traversalTerms?: string[]): OrchestrationResult => {
		const memoized = roundsByNumber.get(round);
		if (memoized !== undefined) return memoized;
		// Keep the suffixed id inside trace.ts's 128-char pattern even for a maximal caller runId.
		const suffix = `-r${round}`;
		const base = request.runId.length + suffix.length > 128 ? request.runId.slice(0, 128 - suffix.length) : request.runId;
		const result = runSinglePass(request, deps, gapTerms ?? [], traversalTerms ?? [], `${base}${suffix}`);
		roundsByNumber.set(round, result);
		return result;
	};

	const progressive = runProgressiveRetrieval(orchestrateFn, round0.requirements, progressiveConfig);
	let best = round0;
	for (const result of roundsByNumber.values()) if (result.briefing !== null && result.briefing === progressive.finalBriefing) best = result;
	return { ...best, progressive };
}

/** Design §18 risk 3: above this share of unrecognized summary headings, the grammar has drifted. */
export const SUMMARY_DRIFT_WARNING = 0.2;

function tally(values: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

/* ------------------------------------------------------------------------------------------------
 * explain_decision (spec §21, design §14)
 * ---------------------------------------------------------------------------------------------- */

export interface DecisionExplanation {
	runId: string;
	claimId: string | null;
	found: boolean;
	/** The run's shape: one line per state transition, in order. */
	timeline: Array<{ seq: number; state: RetrievalState; event: string; summary: string }>;
	/** Everything the trace recorded about this claim, in the order it was recorded. */
	events: TraceEvent[];
	outcome: string | null;
	policyId: string | null;
	truncated: boolean;
	skippedLines: number;
}

/**
 * Reconstructs the inclusion or exclusion story for one claim from the run's JSONL alone.
 *
 * Reads only the trace file — not the databases — which is what makes design §14's claim that the
 * audit is replayable true rather than aspirational: a run whose corpus has since changed still
 * explains itself. A trace that a crash truncated is read as far as it goes (`trace.ts:139-163`) and
 * the shortfall is reported rather than thrown.
 */
export function explainDecision(runId: string, claimId: string | null, root: string): DecisionExplanation {
	const read = readTrace(runId, root);
	const matches = (event: TraceEvent): boolean => {
		if (claimId === null) return false;
		const payload = event.payload;
		if (payload.claimId === claimId) return true;
		if (Array.isArray(payload.claimIds) && (payload.claimIds as unknown[]).includes(claimId)) return true;
		if (Array.isArray(payload.supersededClaimIds) && (payload.supersededClaimIds as unknown[]).includes(claimId)) return true;
		return false;
	};

	const events = claimId === null ? [] : read.events.filter(matches);
	const outcomeEvent = [...read.events].reverse().find((event) => event.event === "outcome");
	return {
		runId,
		claimId,
		found: read.events.length > 0,
		timeline: read.events
			.filter((event) => event.event === "transition" || event.event === "outcome")
			.map((event) => ({ seq: event.seq, state: event.state, event: event.event, summary: summarize(event) })),
		events,
		outcome: outcomeEvent === undefined ? null : String(outcomeEvent.payload.outcome ?? "(none recorded)"),
		policyId: read.events.find((event) => event.policyId !== null)?.policyId ?? null,
		truncated: read.truncated,
		skippedLines: read.skippedLines,
	};
}

function summarize(event: TraceEvent): string {
	const payload = event.payload;
	const parts: string[] = [];
	for (const key of ["outcome", "earlyExit", "selected", "rejected", "envelopes", "claims", "in", "out", "scored", "conflicts", "status", "reason", "requested", "delivered"]) {
		const value = payload[key];
		if (value === undefined) continue;
		parts.push(`${key}=${Array.isArray(value) ? `[${value.length}]` : typeof value === "object" ? JSON.stringify(value).slice(0, 80) : String(value)}`);
	}
	return parts.join(" ") || "(no summary fields)";
}

/* ------------------------------------------------------------------------------------------------
 * submit_feedback (spec §21, §22, design §14)
 * ---------------------------------------------------------------------------------------------- */

/**
 * **PHASE 4 — `mnemosia/feedback@1` → `@2`, and the entry gains structure without gaining teeth.**
 *
 * The shape moved to `src/feedback.ts` (spec §22's ten signals, the per-seat expectation set, the
 * validator). What did **not** change is the only property that matters here: nothing in the
 * retrieval path reads this file. Spec §22 is explicit — "Do not update production ranking policies
 * online from individual interactions" — and `test/feedback.test.ts` asserts it structurally, by
 * reading every source file and checking that no ranking, selection or planning module imports this
 * module or opens `feedback.jsonl`.
 *
 * `@1` entries remain readable: every field it had is still present with the same name, and the two
 * additions (`resolvedAgent`, `validation`) are derived rather than required from the caller.
 */
export type { FeedbackEntry } from "./feedback.ts";

/** Past this size the oldest lines are dropped on the next write, down to half of it. */
export const FEEDBACK_MAX_BYTES = 2 * 1024 * 1024;

export function submitFeedback(entry: Omit<FeedbackEntry, "schemaVersion" | "at" | "resolvedAgent" | "validation"> & { at?: number }, path: string): FeedbackEntry {
	const { agent, ...raw } = entry;
	// The free-text fields come from a model and go to disk, so they pass through the same credential scrub as memories.
	const rest = {
		...raw,
		...(raw.missingEvidence === undefined ? {} : { missingEvidence: redactSensitive(raw.missingEvidence) }),
		...(raw.validatorDisagreement === undefined ? {} : { validatorDisagreement: redactSensitive(raw.validatorDisagreement) }),
		...(raw.comment === undefined ? {} : { comment: redactSensitive(raw.comment) }),
		...(raw.externalFindings === undefined ? {} : { externalFindings: raw.externalFindings.map((item) => ({ ...item, source: redactSensitive(item.source), finding: redactSensitive(item.finding), ...(item.version === undefined ? {} : { version: redactSensitive(item.version) }) })) }),
		...(raw.costObservations === undefined ? {} : { costObservations: raw.costObservations.map((item) => ({ ...item, metric: redactSensitive(item.metric), unit: redactSensitive(item.unit) })) }),
	};
	const full: FeedbackEntry = {
		schemaVersion: FEEDBACK_SCHEMA_VERSION,
		at: entry.at ?? Date.now(),
		agent,
		resolvedAgent: resolveAgent(agent).agent,
		...rest,
		// Computed here rather than by the caller: a validation verdict a caller could supply is a
		// verdict a caller could supply falsely, and the whole value of the field is that an offline
		// pass can trust it without re-deriving the expectation set for every historical seat version.
		validation: validateFeedback(agent, rest as Parameters<typeof validateFeedback>[1]),
	};
	mkdirSync(dirname(path), { recursive: true });
	try {
		const size = statSync(path).size;
		if (size > FEEDBACK_MAX_BYTES) {
			// Drop whole oldest lines until about half the bytes remain, then swap the file in so a crash never loses the log.
			const lines = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
			let kept = 0;
			let from = lines.length;
			while (from > 0 && kept + Buffer.byteLength(lines[from - 1]!) + 1 <= size / 2) kept += Buffer.byteLength(lines[--from]!) + 1;
			const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
			writeFileSync(tmp, lines.slice(from).map((line) => `${line}\n`).join(""), "utf8");
			renameSync(tmp, path);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	appendFileSync(path, `${JSON.stringify(full)}\n`, "utf8");
	return full;
}

// Ported from mnemosia/policy.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Ranking policies, mode configs and the authority table (design §4, §9, build-order step 10).
 *
 * Spec §12 opens with a prohibition: "Do not implement a universal static scoring formula." So this
 * file holds **data**, not code. Every number a ranking decision depends on — weights, the authority
 * table, half-lives, the certainty map, the selection constants — lives in a frozen policy object
 * with an id, a version and a written rationale, and `rank.ts` / `select.ts` contain only the
 * arithmetic that reads them. A policy change is therefore a diff to a table, reviewable on its own,
 * which is what design §19 item 3 means when it makes a `policy.ts` bump a decision requiring human
 * approval: there has to be something small enough to approve.
 *
 * **The lookup chain is four links** (design §9):
 * `(agent, taskType, mode)` → `(agent, *, mode)` → `(*, taskType, *)` → `default@1`.
 * Spec §12 lists more configurable dimensions than that — project, memory type, source, security
 * level, context budget, freshness requirements. Phase 1 keys on three of them and leaves the rest
 * *reachable* rather than pretending to support them: memory type, source and freshness are already
 * per-policy tables (`authority`, `halfLifeDays`), so specialising them means adding a named policy,
 * not changing the resolver. Security level is expressed by mode (`high_assurance`), and context
 * budget is a selection constraint rather than a ranking input. Adding an unused `project` key to
 * the resolver would be a field that reads as a capability, which design §7 forbids elsewhere and
 * would be no less dishonest here.
 *
 * **`utility` is not in `RANK_SIGNALS`.** It is the composed output `Σ wᵢ·signalᵢ`. Design §9 is
 * explicit about why: give utility a weight and it becomes a circular eighth input, and the six
 * concepts spec §12 requires be kept separate start collapsing into it.
 */

import { AGENT_POLICY, resolveAgent } from "./agents.ts";
import type { AgentBriefingProfile } from "./agents.ts";
import type { OperationalMode, TaskType } from "./task.ts";
import type { BriefingSection, Certainty, ClaimType, IntegrityStatus } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Mode configuration (moved here from plan.ts, as plan.ts:45-52 said it would be)
 * ---------------------------------------------------------------------------------------------- */

export interface ModeConfig {
	maxSources: number;
	maxCandidates: number;
	/** Hard ceiling on the briefing, design §16. The caller's own budget still wins if it is smaller. */
	tokenBudget: number;
	/** Per-source wall clock. Design §16's latency gate is p95 over the whole run, not per source. */
	deadlineMsPerSource: number;
	secondPassPermitted: boolean;
	/** High-assurance mode fails closed on any `unverified` integrity (design §16). */
	failClosedOnUnverified: boolean;
	retryAttempts: number;
}

/**
 * Design §16's mode table. `plan.ts` re-exports it so step 8's consumers are unaffected by the move.
 */
export const MODE_CONFIGS: Readonly<Record<OperationalMode, ModeConfig>> = Object.freeze({
	fast: { maxSources: 2, maxCandidates: 100, tokenBudget: 2_000, deadlineMsPerSource: 500, secondPassPermitted: false, failClosedOnUnverified: false, retryAttempts: 0 },
	standard: { maxSources: 3, maxCandidates: 400, tokenBudget: 6_000, deadlineMsPerSource: 2_000, secondPassPermitted: false, failClosedOnUnverified: false, retryAttempts: 1 },
	deep: { maxSources: 3, maxCandidates: 1_500, tokenBudget: 12_000, deadlineMsPerSource: 10_000, secondPassPermitted: true, failClosedOnUnverified: false, retryAttempts: 1 },
	high_assurance: { maxSources: 3, maxCandidates: 400, tokenBudget: 6_000, deadlineMsPerSource: 2_000, secondPassPermitted: false, failClosedOnUnverified: true, retryAttempts: 1 },
});

/* ------------------------------------------------------------------------------------------------
 * Signals
 * ---------------------------------------------------------------------------------------------- */

/**
 * The six **inputs**. Spec §12: "Keep these concepts separate" — authority, evidence_strength,
 * confidence, integrity, freshness, relevance. `utility` is the seventh concept and the composed
 * output; it appears in `ScoreVector` because the trace must record it, never in this list.
 */
export const RANK_SIGNALS = ["authority", "evidenceStrength", "confidence", "integrity", "freshness", "relevance"] as const;
export type RankSignal = (typeof RANK_SIGNALS)[number];
export type SignalWeights = Readonly<Record<RankSignal, number>>;

/**
 * The standing of a *source*, at the granularity the design's table actually distinguishes.
 *
 * Design §9's authority row reads "curated 0.9 · summary 0.7 · user 0.6 · tool 0.5 ·
 * assistant 0.35", which mixes two vocabularies: three of those are `SourceType` values and three
 * are conversation *event kinds* living inside the single `conversation_message` source type. Keying the
 * table on `SourceType` alone would give a user turn and an assistant turn the same standing and
 * silently delete the 0.25 gap the design put between them — the single largest spread in the table.
 * So the class is derived from both fields, in `rank.ts:authorityClassOf`.
 */
export const AUTHORITY_CLASSES = ["curated_memory", "compaction_summary", "user_message", "tool_output", "assistant_message", "unknown"] as const;
export type AuthorityClass = (typeof AUTHORITY_CLASSES)[number];

/* ------------------------------------------------------------------------------------------------
 * Policy shape
 * ---------------------------------------------------------------------------------------------- */

/** `"*"` is the wildcard the lookup chain matches against. */
export interface PolicyMatch {
	agent: string;
	taskType: TaskType | "*";
	mode: OperationalMode | "*";
}

/** Design §10's selection constants, per policy because §10 is a policy question, not a constant. */
export interface SelectionPolicy {
	/** λ in `m(c) = utility·quota − λ·max jaccard₃`. Design §10 fixes 0.5. */
	lambda: number;
	/** Stop once the best marginal value falls below this. Design §10 fixes 0.15. */
	marginalFloor: number;
	/** `reserve = ceil(reserveRatio · budget)`. Design §10 fixes 0.10. */
	reserveRatio: number;
	/** Design §10's soft shares. Sum to 1.00; they are shares of the selectable pool, not caps. */
	sectionShares: Readonly<Record<BriefingSection, number>>;
	/** Multiple of the soft share at which the quota multiplier bottoms out. Design §10 fixes 1.5. */
	quotaOverFactor: number;
	/** The multiplier at and above `quotaOverFactor · share`. Design §10 fixes 0.5. */
	quotaFloor: number;
	/** n-gram width for the redundancy Jaccard. Design §10 fixes 3. */
	shingleSize: number;
}

/**
 * Design §9's evidence-strength constants, extended in Phase 2.
 *
 * Phase 1 computed `min(1, 0.4·direct + 0.2·log2(1+supports))` with a 0.4 ceiling on anything purely
 * derived. That formula reads a **list**: it counts artifacts and asks whether any of them was
 * reached directly. Phase 2 has a provenance graph, and the three things the graph knows that the
 * list did not are exactly the three terms added here.
 *
 * 1. **Corroboration across *independent* artifacts.** `supports` already counted distinct artifacts
 *    rather than evidence rows, which stops one artifact cited three times looking like three
 *    witnesses. It does not stop *one session* cited three times looking like three witnesses, and on
 *    a corpus that is 11,182 events over 253 sessions that is the common case. `independentGroups`
 *    (provenance.ts) groups by `sourceId | taskScope`, and `corroborationBonus` prices agreement
 *    *between* groups — a curated row and a tool transcript — rather than volume within one.
 * 2. **Contradiction.** A claim something else in the same run contradicts is weaker evidence for
 *    its own content than an uncontested one, and Phase 1 had no way to express that because it had
 *    no `CONTRADICTS` edge. The penalty is subtracted *after* the depth ceiling — see the note in
 *    `rank.ts:evidenceStrengthSignal`, which records why the other order silenced it entirely for
 *    derived claims and how the test caught that.
 * 3. **Derived-vs-direct depth.** Design §9's single 0.4 ceiling covered both "reached through a
 *    summary whose events are here" and "reached through a summary whose events are nowhere", and
 *    rank.ts:107-119 recorded that Phase 1 could not tell them apart. It can now, and they are
 *    priced apart: `derivedCeiling` for graph distance 2, `ungroundedCeiling` for distance 3.
 *
 * On a claim with one independent group, no contradiction and distance ≤ 2, the formula reduces
 * **exactly** to Phase 1's — which is the property that keeps the Phase 1 threshold table comparable
 * across the two phases rather than re-baselined by a formula change.
 */
export interface EvidencePolicy {
	/** The `0.4·direct` term of design §9's `min(1, 0.4·direct + 0.2·log2(1+supports))`. */
	directBase: number;
	/** The `0.2·log2(...)` coefficient. */
	supportCoefficient: number;
	/** "summaries without reachable raw events cap at 0.4" (design §9) — graph distance 2. */
	derivedCeiling: number;
	/** Graph distance 3: derived, and the summary's own sources are not reachable from this run. */
	ungroundedCeiling: number;
	/** Added per independent evidence group beyond the first. */
	corroborationBonus: number;
	/** Ceiling on the corroboration term, so a wide but shallow claim cannot buy a perfect score. */
	corroborationCap: number;
	/** Subtracted per contradicting claim, after the depth ceiling is applied. */
	contradictionPenalty: number;
}

export interface RelevanceBonusPolicy {
	tag: number;
	entity: number;
	exactScope: number;
}

/**
 * Design §11's two conflict constants, in the policy table rather than as module constants for the
 * same reason every other number is: spec §12 forbids a universal static formula, and a threshold
 * that decides whether the reader is told about a disagreement is at least as policy-shaped as a
 * ranking weight.
 */
export interface ConflictPolicy {
	/** jaccard₃ at or above which two claims are "about the same thing". Design §11 fixes 0.6. */
	neighbourhoodThreshold: number;
	/** Authority difference at or above which a contradiction is an AUTHORITY_DISAGREEMENT. Design §11 fixes 0.2. */
	authorityGap: number;
}

export interface RankingPolicy {
	/** `<name>@<version>`. This string is what lands in every trace event and in `policy_version`. */
	policyId: string;
	name: string;
	version: string;
	match: PolicyMatch;
	weights: SignalWeights;
	authority: Readonly<Record<AuthorityClass, number>>;
	/** `exp(-ln2 · ageDays / halfLife[claimType])` (design §9). */
	halfLifeDays: Readonly<Record<ClaimType, number>>;
	/**
	 * Design §9 gives "project-state/plans 14d" a half-life of its own, but `project-state` is an
	 * AkashicForge memory *kind* that claims.ts maps to `FACT` (90d). Keying half-lives on claimType
	 * alone would therefore silently give a project-state row six times the shelf life the design
	 * assigned it — on this corpus that is 4 of the 10 curated memories, the ones most likely to be
	 * stale. This override restores the design's intent without giving project-state a claimType of
	 * its own, which would have meant a ninth `ClaimType` and a schema bump.
	 */
	halfLifeDaysByMemoryKind: Readonly<Record<string, number>>;
	certaintyConfidence: Readonly<Record<Certainty, number>>;
	/**
	 * How much of a curated claim's confidence comes from the row's `importance` column.
	 *
	 * Design §9 writes this as "Certainty map (1.0/0.7/0.4/0.2) × `importance/10` blend for curated".
	 * Read as a literal product it inverts the corpus: the live vault holds importance 5..10
	 * (measured, 10/10 rows), so the importance-5 preference row would score `1.0 × 0.5 = 0.50` and
	 * land *below* every PROBABLE compaction-summary claim at 0.70 — a human-curated, verified,
	 * hash-checked memory outranked on **confidence** by a model's paraphrase of a chat log. That is
	 * the exact inversion design §8's summary cap exists to prevent. So the blend is a weighted mean
	 * rather than a product: `(1−w)·certainty + w·(importance/10)`, w = 0.3, which keeps the measured
	 * importance range mapping to 0.85..1.00 — still ordered by importance, still above the summary
	 * band.
	 */
	curatedImportanceWeight: number;
	/** `failed` is present and 0 only so the map is total; a failed artifact is hard-filtered (§12). */
	integrityScore: Readonly<Record<IntegrityStatus, number>>;
	evidence: EvidencePolicy;
	relevanceBonus: RelevanceBonusPolicy;
	selection: SelectionPolicy;
	conflict: ConflictPolicy;
	/** Why this policy differs from the default. Prose, for the trace and for a reviewer. */
	rationale: string;
}

/* ------------------------------------------------------------------------------------------------
 * The shared tables
 * ---------------------------------------------------------------------------------------------- */

/** Design §9's authority row. `unknown` sits below `assistant_message` on purpose: an event kind */
/** nobody has classified must not inherit the standing of one that was (claims.ts:499-515). */
export const AUTHORITY_TABLE: Readonly<Record<AuthorityClass, number>> = Object.freeze({
	curated_memory: 0.9,
	compaction_summary: 0.7,
	user_message: 0.6,
	tool_output: 0.5,
	assistant_message: 0.35,
	unknown: 0.3,
});

/**
 * Design §9's half-lives, in days. Two of the eight claim types are not in the design's list and are
 * filled in here with the reason rather than defaulted:
 *
 * - `CONSTRAINT` → 365, matching `PREFERENCE`. A constraint is a standing rule; decaying it on a
 *   90-day fact clock would push it out of the mandatory reservation design §10 gives it, which is
 *   the one place freshness must never be able to reach.
 * - `HYPOTHESIS` → 14, matching `PLAN`. A working guess ages exactly like a plan: it is about what
 *   might be done next, and next moves stale fastest.
 */
export const HALF_LIFE_DAYS: Readonly<Record<ClaimType, number>> = Object.freeze({
	PREFERENCE: 365,
	CONSTRAINT: 365,
	DECISION: 180,
	PROCEDURE: 180,
	FACT: 90,
	PLAN: 14,
	HYPOTHESIS: 14,
	OBSERVATION: 7,
});

/** Design §9's "project-state/plans 14d". See `halfLifeDaysByMemoryKind`. */
export const HALF_LIFE_DAYS_BY_MEMORY_KIND: Readonly<Record<string, number>> = Object.freeze({
	"project-state": 14,
	"open-loops": 14,
});

/** Design §9's certainty map. */
export const CERTAINTY_CONFIDENCE: Readonly<Record<Certainty, number>> = Object.freeze({
	CONFIRMED: 1.0,
	PROBABLE: 0.7,
	SPECULATIVE: 0.4,
	UNKNOWN: 0.2,
});

export const INTEGRITY_SCORE: Readonly<Record<IntegrityStatus, number>> = Object.freeze({
	verified: 1.0,
	unverified: 0.6,
	// Unreachable by construction: filters.ts rejects a failed artifact before ranking runs. Present
	// so the map is total and a future caller that skips filtering does not silently get `undefined`.
	failed: 0.0,
});

/**
 * The Phase 2 constants.
 *
 * `directBase`, `supportCoefficient` and `derivedCeiling` are design §9's, unchanged. The three new
 * numbers are set from the shape of the corpus rather than from a sweep, and each is stated with the
 * reasoning so a reviewer can disagree with the reasoning rather than with the number:
 *
 * - `ungroundedCeiling` **0.25**. Design §9 gives an assistant turn 0.35 authority as the floor of
 *   the standing table. A confident sentence in a summary whose underlying events nobody can reach
 *   is a weaker evidentiary object than an assistant turn — the turn at least *is* the thing that
 *   was said — so its evidence ceiling sits below that floor. It is not zero, because the summary
 *   is a real artifact that really says this.
 * - `corroborationBonus` **0.1**, `corroborationCap` **0.2**. One extra independent group is worth
 *   about half of what the first `log2` step is worth (`0.2·log2(2) = 0.2`), and the cap stops the
 *   term at two extra groups. Beyond three independent witnesses the marginal information is small
 *   and the risk — one statement echoed across many sessions — is not.
 * - `contradictionPenalty` **0.15**. Enough that a contradicted direct claim (0.4 + 0.2 − 0.15 =
 *   0.45) falls below an uncontradicted one (0.6) without falling below the derived band, because a
 *   contradicted first-hand observation is still first-hand.
 *
 * None of these was chosen after seeing a metric. `eval/harness.ts` re-runs the full Phase 1 table
 * with them in place and the result is reported whatever it is.
 */
export const EVIDENCE_POLICY: EvidencePolicy = Object.freeze({
	directBase: 0.4,
	supportCoefficient: 0.2,
	derivedCeiling: 0.4,
	ungroundedCeiling: 0.25,
	corroborationBonus: 0.1,
	corroborationCap: 0.2,
	contradictionPenalty: 0.15,
});

export const RELEVANCE_BONUS: RelevanceBonusPolicy = Object.freeze({ tag: 0.1, entity: 0.1, exactScope: 0.05 });

/** Design §10's soft shares. They sum to 1.00; `assertSharesSumToOne` below proves it at load. */
export const SECTION_SHARES: Readonly<Record<BriefingSection, number>> = Object.freeze({
	confirmed_facts: 0.3,
	previous_decisions: 0.15,
	current_state: 0.15,
	constraints: 0.1,
	known_failures_or_rejected: 0.1,
	preferences: 0.05,
	conflicts: 0.05,
	open_tasks: 0.05,
	uncertainties_or_gaps: 0.05,
});

/** Design §11's neighbourhood and authority-gap thresholds, verbatim. */
export const CONFLICT_POLICY: ConflictPolicy = Object.freeze({ neighbourhoodThreshold: 0.6, authorityGap: 0.2 });

export const SELECTION_POLICY: SelectionPolicy = Object.freeze({
	lambda: 0.5,
	marginalFloor: 0.15,
	reserveRatio: 0.1,
	sectionShares: SECTION_SHARES,
	quotaOverFactor: 1.5,
	quotaFloor: 0.5,
	shingleSize: 3,
});

/* ------------------------------------------------------------------------------------------------
 * The registry
 * ---------------------------------------------------------------------------------------------- */

export const DEFAULT_POLICY_ID = "default@2";

/**
 * Bumped whenever any policy in the registry changes. Design §19 item 3 gates that on approval.
 *
 * **@1 → @2 in Phase 2, and this is an approval item, declared as one.** Design §19 item 3 makes a
 * `policy.ts` bump a decision requiring human approval, with the §22 change packet. What changed and
 * what did not:
 *
 * - **The six ranking weights are byte-identical in all five policies.** They were measured in Phase
 *   1 and the Phase 2 brief forbids tuning them; nothing here re-balances relevance against
 *   authority.
 * - **`evidence` gained three terms** (`ungroundedCeiling`, `corroborationBonus`/`corroborationCap`,
 *   `contradictionPenalty`) because Phase 2's remit is evidence-strength scoring over the real
 *   provenance graph. On a claim with one independent group and no contradiction at distance ≤ 2 the
 *   formula reduces exactly to Phase 1's, so the change is additive rather than a re-baseline.
 * - **`conflict` is new**, holding design §11's two already-fixed thresholds (0.6, 0.2). No number
 *   in it is new; it moves them out of code and into the reviewable table.
 *
 * The version string lands in every trace event and in the briefing's `policy_version`, so a replay
 * can tell a Phase 1 score from a Phase 2 one rather than having to infer it.
 */
export const POLICY_REGISTRY_VERSION = "mnemosia/policy-registry@3";

/**
 * **@2 → @3 in Phase 4, and this is an approval item, declared as one** (design §19 item 3, with the
 * spec §22 change packet). What changed:
 *
 * - **Two policies added**, `samaela@3` and `astrelia@3`, reached through the new agent link. Six of
 *   the eight Conclave seats are bound to policies that already existed and are byte-identical to
 *   what Phase 2 measured (`agents.ts:AGENT_POLICY`).
 * - **One authority table added**, `ASTRELIA_AUTHORITY_TABLE`. `AUTHORITY_TABLE` itself is untouched
 *   and still backs the other six policies.
 * - **The resolution chain gained a link.** `(agent)` now sits between `(agent, *, mode)` and
 *   `(*, taskType, *)`. This is the only change with a blast radius beyond the two new policies: a
 *   caller naming a Conclave seat can now resolve to a different policy than it did under @2, on
 *   every task where the inferred task type previously won.
 * - **`SelectionPolicy.sectionShares` became per-agent** through `withAgentSelection`. The nine
 *   shares still sum to 1.00 for every seat, checked at load in `agents.ts`.
 *
 * What did **not** change: the six ranking weights of `default@2`, `debug@2`, `review@2`, `recall@2`
 * and `vesperia-fast@2`; `EVIDENCE_POLICY`; `CONFLICT_POLICY`; `HALF_LIFE_DAYS`; the certainty map;
 * and every `@2` policy id, so a replay can still tell a Phase 2 score from a Phase 4 one.
 */
export const PRIOR_POLICY_REGISTRY_VERSION = "mnemosia/policy-registry@2";

/**
 * Astrelia's authority table (Phase 4).
 *
 * The only table in the registry that is not `AUTHORITY_TABLE`, and the deviation is confined to
 * one field's worth of reasoning. Design §9's shared ordering — curated 0.9 above summary 0.7 above
 * tool 0.5 — encodes "a human wrote this down on purpose, so believe it". That is right for seven
 * seats. It is wrong for the one whose question is *where is the implementation*: a tool transcript
 * that read the file is a direct observation of the code, while a curated decision memo is a claim
 * about intent that the code may since have diverged from. So `tool_output` rises to 0.80 and
 * `curated_memory` falls to 0.60 — they swap sides of `compaction_summary` — and nothing else moves.
 *
 * `assistant_message` (0.35) and `unknown` (0.30) are untouched: a model's paraphrase of a file is
 * not an observation of it however useful the file listing was, and design §9's reason for putting
 * `unknown` at the bottom (an unclassified event kind must not inherit a classified one's standing)
 * is a statement about classification rather than about this seat.
 */
export const ASTRELIA_AUTHORITY_TABLE: Readonly<Record<AuthorityClass, number>> = Object.freeze({
	curated_memory: 0.6,
	compaction_summary: 0.55,
	user_message: 0.6,
	tool_output: 0.8,
	assistant_message: 0.35,
	unknown: 0.3,
});

/** Everything a policy shares with `default@1`, so a named policy is a weight diff and nothing else. */
function policy(name: string, version: string, match: PolicyMatch, weights: SignalWeights, rationale: string, overrides: { authority?: Readonly<Record<AuthorityClass, number>> } = {}): RankingPolicy {
	return Object.freeze({
		policyId: `${name}@${version}`,
		name,
		version,
		match,
		weights: Object.freeze(weights),
		authority: overrides.authority ?? AUTHORITY_TABLE,
		halfLifeDays: HALF_LIFE_DAYS,
		halfLifeDaysByMemoryKind: HALF_LIFE_DAYS_BY_MEMORY_KIND,
		certaintyConfidence: CERTAINTY_CONFIDENCE,
		curatedImportanceWeight: 0.3,
		integrityScore: INTEGRITY_SCORE,
		evidence: EVIDENCE_POLICY,
		relevanceBonus: RELEVANCE_BONUS,
		selection: SELECTION_POLICY,
		conflict: CONFLICT_POLICY,
		rationale,
	});
}

/**
 * The Phase 1 registry.
 *
 * Five policies, and each one exists because a *measurable* task type wants different evidence, not
 * to populate a table. They differ in weights only: the tables above are shared, so a change to the
 * authority of a source is one edit rather than five.
 *
 * Every weight vector sums to 1.0 — checked at module load by `assertWeightsSumToOne`, because a
 * vector that sums to 0.95 would silently shrink every utility in that policy and make cross-policy
 * comparison of `utility` meaningless.
 */
export const POLICIES: readonly RankingPolicy[] = Object.freeze([
	policy(
		"default",
		"2",
		{ agent: "*", taskType: "*", mode: "*" },
		{ relevance: 0.3, authority: 0.18, freshness: 0.16, confidence: 0.14, evidenceStrength: 0.12, integrity: 0.1 },
		"relevance leads because an unrelated memory is worse than a missing one; authority and freshness follow because this corpus is a week of dense sessions in which the same subject was revisited under changing conclusions",
	),
	policy(
		"debug",
		"2",
		{ agent: "*", taskType: "debug", mode: "*" },
		{ relevance: 0.32, freshness: 0.24, evidenceStrength: 0.12, confidence: 0.12, authority: 0.12, integrity: 0.08 },
		"a debugger needs what broke most recently and what was actually observed; freshness is nearly doubled and authority halved, because a tool transcript from an hour ago beats a curated decision from last month for this task and only for this task",
	),
	policy(
		"review",
		"2",
		{ agent: "*", taskType: "review", mode: "*" },
		{ relevance: 0.22, authority: 0.22, integrity: 0.2, evidenceStrength: 0.18, confidence: 0.12, freshness: 0.06 },
		"a reviewer is judging whether something is right, so provenance quality outranks recency; integrity doubles and freshness drops to the floor",
	),
	policy(
		"recall",
		"2",
		{ agent: "*", taskType: "recall", mode: "*" },
		{ relevance: 0.3, authority: 0.2, evidenceStrength: 0.16, confidence: 0.14, integrity: 0.12, freshness: 0.08 },
		"an explicit recall request is usually about older material by definition; freshness is halved so that asking about history does not return this morning",
	),
	policy(
		"vesperia-fast",
		"2",
		{ agent: "vesperia", taskType: "*", mode: "fast" },
		{ relevance: 0.4, freshness: 0.2, authority: 0.14, confidence: 0.1, evidenceStrength: 0.09, integrity: 0.07 },
		"fast mode gives Vesperia a 2,000-token budget and ≤2 sources; with that little room the only signal that reliably pays for a token is topical fit, so relevance takes 0.40 and the corroboration signals give way",
	),
	/* --- Phase 4: the two agent-keyed policies, and only two ------------------------------------ */
	//
	// `match` on both is `{agent, *, *}` so they are reached through the new agent link rather than
	// through links 1 or 2. Six of the eight Conclave seats are *not* here, because they share an
	// existing policy — `agents.ts:AGENT_POLICY` records which and why. Eight near-identical weight
	// vectors would have been the placeholder abstraction design §26 forbids; the finding that six
	// roles imply no distinct ordering is worth more than six tables a reader would have to diff.
	policy(
		"samaela",
		"3",
		{ agent: "samaela", taskType: "*", mode: "*" },
		{ relevance: 0.28, authority: 0.24, confidence: 0.14, evidenceStrength: 0.14, freshness: 0.1, integrity: 0.1 },
		"a planner reconstructs what was settled and why. Authority takes 0.24 — the highest in the registry — because a recorded decision's standing is exactly what makes it binding on a new plan, and freshness falls to 0.10 because a decision does not stop being the decision by ageing: supersession retires it, and supersession is a conflict class rather than a decay curve. Relevance still leads, at 0.28, because an unrelated decision is worse than a missing one",
	),
	policy(
		"astrelia",
		"3",
		{ agent: "astrelia", taskType: "*", mode: "*" },
		{ relevance: 0.3, authority: 0.18, freshness: 0.16, confidence: 0.14, evidenceStrength: 0.12, integrity: 0.1 },
		"**the six weights are byte-identical to default@2 and that is deliberate** — nothing about how the code scout trades relevance against authority differs. What differs is the authority *table*: for the question 'where is the implementation', a tool transcript that read the file is direct evidence and a curated memo is a claim about intent, so tool_output rises to 0.80 and curated_memory falls to 0.60 (see ASTRELIA_AUTHORITY_TABLE). Recording the difference where source standing is configured, rather than as a re-weighting, keeps the two kinds of change separable in a diff",
		{ authority: ASTRELIA_AUTHORITY_TABLE },
	),
]);

/* ------------------------------------------------------------------------------------------------
 * Load-time invariants
 * ---------------------------------------------------------------------------------------------- */

function assertWeightsSumToOne(candidate: RankingPolicy): void {
	let total = 0;
	for (const signal of RANK_SIGNALS) total += candidate.weights[signal];
	if (Math.abs(total - 1) > 1e-9) throw new Error(`policy ${candidate.policyId}: weights sum to ${total}, expected 1`);
}

function assertSharesSumToOne(): void {
	let total = 0;
	for (const share of Object.values(SECTION_SHARES)) total += share;
	if (Math.abs(total - 1) > 1e-9) throw new Error(`section shares sum to ${total}, expected 1`);
}

/**
 * Every `AGENT_POLICY` binding names a policy the registry actually holds.
 *
 * Without this, a typo in a binding would demote that seat to the task link at runtime — the
 * per-agent layer reading as configured while doing nothing — and the symptom would be a subtly
 * different briefing rather than an error. Checked at load, so the failure is a startup crash with
 * the offending name in it.
 */
function assertAgentBindingsResolve(): void {
	const known = new Set(POLICIES.map((entry) => entry.policyId));
	for (const [agent, binding] of Object.entries(AGENT_POLICY)) {
		if (!known.has(binding.policyId)) throw new Error(`agent ${agent} is bound to ${binding.policyId}, which the registry does not hold`);
	}
}

for (const candidate of POLICIES) assertWeightsSumToOne(candidate);
assertSharesSumToOne();
assertAgentBindingsResolve();

/* ------------------------------------------------------------------------------------------------
 * Lookup
 * ---------------------------------------------------------------------------------------------- */

function matchKey(agent: string, taskType: string, mode: string): string {
	return `${agent.toLowerCase()}${taskType}${mode}`;
}

const POLICY_INDEX: ReadonlyMap<string, RankingPolicy> = new Map(POLICIES.map((entry) => [matchKey(entry.match.agent, entry.match.taskType, entry.match.mode), entry]));

export const DEFAULT_POLICY: RankingPolicy = (() => {
	const found = POLICIES.find((entry) => entry.policyId === DEFAULT_POLICY_ID);
	if (found === undefined) throw new Error(`the registry has no ${DEFAULT_POLICY_ID}`);
	return found;
})();

export interface PolicyResolution {
	policy: RankingPolicy;
	/** Which link of the chain matched. Recorded so a replay can see *why* this policy was in force. */
	matchedBy: "agent_task_mode" | "agent_mode" | "agent" | "task" | "default";
	/** The keys tried, in order. `explainDecision` prints this when a caller expected another policy. */
	attempted: string[];
	/** The canonical Conclave seat the caller's name resolved to, or `null` (agents.ts:resolveAgent). */
	resolvedAgent: string | null;
}

/**
 * The chain, **five links after Phase 4**:
 * `(agent, taskType, mode)` → `(agent, *, mode)` → **agent binding** → `(*, taskType, *)` → `default@2`.
 *
 * **The third link is new, and it is the link design §9's chain was missing.** Spec §12 lists
 * "Requesting agent" first among the dimensions ranking policy must be configurable by, but the
 * four-link chain could only express an agent policy *jointly with a mode*: the only agent-keyed
 * entry in the Phase 1 registry, `vesperia-fast@2`, is pinned to `fast`, and there was no key at
 * which "this is how Samaela reads memory, in every mode" could be written down. Adding the link is
 * therefore a correction to the chain rather than a new feature on top of it.
 *
 * **Why it sits above `(*, taskType, *)` rather than below.** Both links bind exactly one dimension,
 * so specificity does not order them and something else has to. Two things do, and they agree. The
 * existing chain already prefers the agent dimension at the two-dimension level — `(agent, *, mode)`
 * is tried before `(*, taskType, *)` — so putting the agent binding below the task link would make
 * the chain prefer agent over task at two dimensions and task over agent at one. And the requesting
 * agent is **declared by the caller** while the task type is **inferred by `analyzeTask` from the
 * text**; a resolver that let an inference override a declaration would be backwards on exactly the
 * dimension Phase 4 exists to make real.
 *
 * The consequence is stated rather than discovered: this changes which policy resolves for a caller
 * that names a Conclave seat, on every task where the inferred task type would previously have won.
 * The full Phase 1, 2 and 3 threshold tables are re-run under it and reported whatever they say.
 *
 * It terminates: the last link is a constant that the load-time check above proves exists. There is
 * deliberately no "closest match" scoring — a resolver that could return a policy nobody wrote down
 * would make `policy_version` in the briefing a guess rather than a fact.
 */
export function resolvePolicy(agent: string, taskType: TaskType, mode: OperationalMode): PolicyResolution {
	const resolved = resolveAgent(agent);
	const attempts: Array<{ key: string; matchedBy: PolicyResolution["matchedBy"] }> = [
		{ key: matchKey(agent, taskType, mode), matchedBy: "agent_task_mode" },
		{ key: matchKey(agent, "*", mode), matchedBy: "agent_mode" },
	];
	const attempted: string[] = [];
	for (const attempt of attempts) {
		attempted.push(attempt.key);
		const found = POLICY_INDEX.get(attempt.key);
		if (found !== undefined) return { policy: found, matchedBy: attempt.matchedBy, attempted, resolvedAgent: resolved.agent };
	}

	// Link 3. The binding names a policyId rather than a match key, so two seats can share one policy
	// visibly (`agents.ts:AGENT_POLICY`) instead of each carrying a private copy of the same weights.
	if (resolved.agent !== null) {
		const binding = AGENT_POLICY[resolved.agent];
		attempted.push(`agent:${resolved.agent}${binding.policyId}`);
		const bound = POLICIES.find((entry) => entry.policyId === binding.policyId);
		// A binding naming a policy the registry does not hold is a programming error, not a runtime
		// condition to absorb: it would silently demote the seat to the task link and make the
		// per-agent layer look configured when it was not. The load-time check below makes it
		// unreachable, and this branch simply never runs.
		if (bound !== undefined) return { policy: bound, matchedBy: "agent", attempted, resolvedAgent: resolved.agent };
	}

	attempted.push(matchKey("*", taskType, "*"));
	const byTask = POLICY_INDEX.get(matchKey("*", taskType, "*"));
	if (byTask !== undefined) return { policy: byTask, matchedBy: "task", attempted, resolvedAgent: resolved.agent };

	attempted.push(matchKey("*", "*", "*"));
	return { policy: DEFAULT_POLICY, matchedBy: "default", attempted, resolvedAgent: resolved.agent };
}

/**
 * The resolved policy with this agent's section shares in place of design §10's.
 *
 * Section shares live on `SelectionPolicy`, which lives on `RankingPolicy`, so they are already part
 * of the surface design §19 item 3 gates on approval — this does not open a new one. What it does is
 * let the *composition* layer vary without touching the six ranking weights: `astrelia@3` and
 * `samaela@3` are the only weight changes Phase 4 makes, and every other per-agent difference in the
 * delivered briefing comes through this function.
 *
 * The returned object is a fresh frozen clone. Mutating the registry entry in place would make the
 * policy a caller sees depend on which agent asked last, and the §16 determinism gate compares
 * briefings across three runs.
 */
export function withAgentSelection(base: RankingPolicy, profile: AgentBriefingProfile): RankingPolicy {
	// Compared **by value**, not by reference. `agents.ts` cannot import `SECTION_SHARES` from here
	// without a module cycle (this file imports `AGENT_POLICY` from there), so the three seats that
	// keep design §10's shares hold an equal-but-distinct object. A reference check would have cloned
	// the policy for them anyway and quietly broken the property this function exists to guarantee:
	// that a seat with no composition requirement is scored against the object Phases 1–3 measured.
	let identical = true;
	for (const section of Object.keys(base.selection.sectionShares) as BriefingSection[]) {
		if (base.selection.sectionShares[section] !== profile.sectionShares[section]) {
			identical = false;
			break;
		}
	}
	if (identical) return base;
	return Object.freeze({ ...base, selection: Object.freeze({ ...base.selection, sectionShares: profile.sectionShares }) });
}

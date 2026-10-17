// Ported from mnemosia/select.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Context-set selection (design §10, spec §13 and §15, build-order step 12).
 *
 * Spec §13 opens with the same shape of prohibition spec §12 did: "Do not select context by taking
 * the highest-scoring N candidates." Top-N is what a ranker gives you for free, and it is wrong here
 * for a reason the corpus makes concrete — the twenty highest-utility claims about "the memory
 * adapter" are twenty overlapping excerpts of the same three conversations, and a briefing built
 * from them spends its whole budget saying one thing. So selection is a greedy maximal-marginal-
 * relevance loop with a redundancy penalty and section quotas, exactly design §10:
 *
 * ```
 * m(c) = utility(c)·quota(section(c)) − λ·max_{s∈selected} jaccard₃(c, s)        λ = 0.5
 * ```
 *
 * **The budget is hard.** Design §16 gates token-budget compliance at 100%, and this module is where
 * that is either true or not. Nothing is ever placed without first asking the `Budget` whether it
 * fits, `Budget.spend` throws rather than clamps when it would overflow (tokens.ts:77-82), and the
 * failure mode when the mandatory set alone does not fit is a **PARTIAL_BRIEFING with a named gap**,
 * never an overrun. Spec §15's last resort — "Return a partial briefing if required evidence still
 * cannot fit" — is the design's answer too, and it is implemented as the highest-utility prefix so
 * that what survives truncation is the most useful part of it rather than the first part.
 *
 * **Exclusion is explained.** Spec §23 requires Mnemosia to "explain inclusion and exclusion
 * decisions", and the second half of that is the one systems skip. Every candidate that is not
 * selected gets an `ExclusionRecord` naming which of the four design §10 reasons applied, with the
 * numbers behind it. There is no "did not make the cut" bucket.
 *
 * **Knapsack is the documented future path** (design §10): the greedy loop can leave utility on the
 * table when a large high-utility item blocks two medium ones. That is `LATER_RECOMMENDED`, gated on
 * the §16 eval showing a measurable gap, and it is not pre-empted here by a half-built optimizer.
 */

import { normalizeClaimText } from "./claims.ts";
import type { ConflictRecord, ConflictResolution } from "./conflicts.ts";
import type { RankingPolicy } from "./policy.ts";
import { compareCandidates, type RankedCandidate } from "./rank.ts";
import { jaccard, shingleSet } from "./similarity.ts";
import { createBudget, estimateTokens, selectableRemaining, spend, type Budget } from "./tokens.ts";
import type { TraceWriter } from "./trace.ts";
import { ADDENDUM_BUDGET_SHARE } from "./agents.ts";
import { SCHEMA_VERSION, type BriefingSection, type Channel, type ContextItem, type ContextItemKind, type RetrievalGap } from "./types.ts";
import { createHash } from "node:crypto";

/* ------------------------------------------------------------------------------------------------
 * Classification
 * ---------------------------------------------------------------------------------------------- */

/**
 * Markers that route a claim into `known_failures_or_rejected`.
 *
 * Design §10 gives that section a 0.10 share, which makes it reachable only if something can be
 * routed there, and Phase 1 has no classifier that could do it semantically. These two tables are
 * the deterministic stand-in, and they are kept deliberately narrow: a false positive here moves a
 * fact out of `confirmed_facts`, which is worse than leaving the section thin. They are keyword
 * rules and this comment is the only place they are described as anything more.
 */
export const FAILURE_MARKERS = /\b(?:fail(?:s|ed|ing|ure|ures)?|errors?|broke|broken|crash(?:ed|es|ing)?|regressions?|does\s?n[o']?t work|did\s?n[o']?t work|timed out|timeout|blocked|blocker)\b/iu;
export const REJECTED_MARKERS = /\b(?:rejected|reject|instead of|decided against|ruled out|abandoned|discarded|prohibited|do not use|don'?t use|won'?t|will not|not going to|dropped in favou?r)\b/iu;

/**
 * Claim → the internal section whose soft share it draws against.
 *
 * The nine sections here are design §10's budget sections; brief.ts fans them out onto spec §16's
 * larger field list. First match wins, and the order matters: a DISPUTED or superseded claim is a
 * conflict *before* it is a fact, which is the mechanism behind design §16's "stale inclusion = 0"
 * gate — a demoted claim cannot reach `confirmed_facts` because it never gets asked.
 */
export function sectionForClaim(candidate: RankedCandidate, conflicted: boolean): BriefingSection {
	if (conflicted) return "conflicts";
	const claim = candidate.claim;
	switch (claim.claimType) {
		case "CONSTRAINT":
			return "constraints";
		case "PREFERENCE":
			return "preferences";
		case "HYPOTHESIS":
			return "uncertainties_or_gaps";
		case "PLAN":
			return "open_tasks";
		case "DECISION":
			return REJECTED_MARKERS.test(claim.text) ? "known_failures_or_rejected" : "previous_decisions";
		case "OBSERVATION":
			// An UNKNOWN-certainty observation is claims.ts's honest label for a summary section whose
			// heading it did not recognize (claims.ts:582-597). It is not current state; it is a thing
			// Mnemosia read and could not classify, which is what `uncertainties_or_gaps` is for.
			if (claim.certainty === "UNKNOWN") return "uncertainties_or_gaps";
			return FAILURE_MARKERS.test(claim.text) ? "known_failures_or_rejected" : "current_state";
		default:
			return FAILURE_MARKERS.test(claim.text) ? "known_failures_or_rejected" : "confirmed_facts";
	}
}

/**
 * Claim → one of spec §5.5's ten kinds.
 *
 * This is the field the human rendering groups by, so spec §16's "must clearly distinguish facts,
 * observations, inferences, plans, preferences, and unresolved claims" is decided here rather than
 * in the renderer. The interesting case is `inference`: an observation that reached us only through
 * a summary is a model's account of what happened, not the thing that happened, and labelling it
 * `tool_observation` would launder derivation into observation.
 */
export function kindForClaim(candidate: RankedCandidate, conflicted: boolean): ContextItemKind {
	if (conflicted) return "conflict";
	const claim = candidate.claim;
	switch (claim.claimType) {
		case "CONSTRAINT":
			return "constraint";
		case "PREFERENCE":
			return "preference";
		case "HYPOTHESIS":
			return "hypothesis";
		case "PLAN":
			return "plan";
		case "OBSERVATION": {
			if (!candidate.basis.directness.includes("direct")) return "inference";
			const classes = candidate.basis.authorityClasses;
			if (classes.includes("tool_output")) return "tool_observation";
			if (classes.includes("user_message")) return "user_claim";
			return "inference";
		}
		default:
			return "confirmed_fact";
	}
}

/**
 * The item's channel, taken from the artifacts that produced it.
 *
 * Never a privileged channel. `AdapterChannel` excludes `SYSTEM_POLICY` and `AGENT_POLICY` by
 * construction (types.ts:84-85) and `RankBasis.channels` is typed as `AdapterChannel[]`, so a
 * retrieved claim cannot acquire instruction authority by passing through selection. When a merged
 * claim's artifacts disagree, `RETRIEVED_EVIDENCE` wins: it is the reading with the least authority
 * of the three, and a tie between channels is not the moment to grant the stronger one.
 */
export function channelForCandidate(candidate: RankedCandidate): Channel {
	const channels = candidate.basis.channels;
	if (channels.length === 1 && channels[0] !== undefined) return channels[0];
	return "RETRIEVED_EVIDENCE";
}

/* ------------------------------------------------------------------------------------------------
 * Items
 * ---------------------------------------------------------------------------------------------- */

/** A ContextItem plus everything the renderer and the trace need that the §7 schema does not carry. */
export interface SelectedItem {
	item: ContextItem;
	candidate: RankedCandidate;
	/** Conflict qualifications attached to this claim, in detection order. Empty when unconflicted. */
	qualifications: string[];
	/** True when a conflict demoted it out of the factual sections (conflicts.ts). */
	superseded: boolean;
	conflicts: ConflictRecord[];
}

function itemIdFor(claimId: string, section: BriefingSection): string {
	return `mnemosia-item:${createHash("sha256").update(`${claimId}${section}`, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * The exact line a ContextItem occupies in the Markdown briefing.
 *
 * `tokenCost` is `estimateTokens` of **this string**, not of the claim text, and that is the whole
 * point: the budget is a promise about the briefing that is delivered, so it has to be measured
 * against the bytes that are delivered. Charging only for the claim text would under-count the
 * provenance footer on every item and quietly overrun by a few percent per line — a 100%-compliance
 * gate lost to bookkeeping rather than to a decision.
 *
 * It lives here rather than in brief.ts so that the renderer and the meter cannot drift apart.
 */
export function renderContextItemLine(selected: SelectedItem): string {
	const { item, candidate } = selected;
	const label = `${candidate.claim.claimType} · ${candidate.claim.certainty} · ${candidate.basis.authorityClasses.join("/") || "unknown"}`;
	const scope = item.scope.level === "global" ? "global" : `project ${item.scope.project ?? "-"}`;
	const claims = item.claimIds.map((id) => id.slice(0, 12)).join(", ");
	const evidence = item.evidenceIds.map((id) => id.slice(0, 12)).join(", ");
	const lines = [
		`- [${label}] ${item.text.replace(/\s+/gu, " ").trim()}`,
		`  ↳ claim ${claims} · evidence ${evidence} · ${scope} · effective ${new Date(item.effectiveAt).toISOString().slice(0, 10)} · utility ${candidate.score.utility.toFixed(3)}`,
	];
	for (const qualification of selected.qualifications) lines.push(`  ⚠ ${qualification}`);
	return lines.join("\n");
}

/**
 * Whether a claim belongs in the `conflicts` section rather than in a factual one.
 *
 * **Narrowed in Phase 2, toward the design rather than away from it.** Phase 1 routed *every*
 * participant in *any* conflict here, because its two classes were both cases where nobody had won.
 * Phase 2's taxonomy resolves most of what it detects — `SELECT_NEWER_VALID` names a winner,
 * `KEEP_SCOPE_SPECIFIC_VARIANTS` says both sides are correct where they were recorded — and filing
 * the *winner* of a settled supersession under "unresolved conflicts" would tell the reader there is
 * an open question when the whole point of the record is that there is not.
 *
 * So the section is for the two populations that genuinely belong there: claims a conflict **demoted**
 * (they may not stand as facts, and their absence from the factual sections has to be explained), and
 * parties to a conflict nothing **resolved**.
 */
function conflictedFor(resolution: ConflictResolution, claimId: string): boolean {
	if (resolution.demoted.has(claimId)) return true;
	// Phase 4: the third population. A seat on `both_with_qualification` receives the *winning* side of
	// a resolved conflict here too, beside the side it beat, so the reader gets the disagreement rather
	// than Mnemosia's answer to it (`conflicts.ts:applyConflictPresentation`). Empty for six of eight.
	if (resolution.presented.has(claimId)) return true;
	return (resolution.byClaimId.get(claimId) ?? []).some((entry) => entry.unresolved);
}

function buildItem(candidate: RankedCandidate, resolution: ConflictResolution, mandatory: boolean): SelectedItem {
	const conflicts = resolution.byClaimId.get(candidate.claim.claimId) ?? [];
	const conflicted = conflictedFor(resolution, candidate.claim.claimId);
	const section = sectionForClaim(candidate, conflicted);
	const item: ContextItem = {
		schemaVersion: SCHEMA_VERSION.contextItem,
		itemId: itemIdFor(candidate.claim.claimId, section),
		kind: kindForClaim(candidate, conflicted),
		channel: channelForCandidate(candidate),
		text: candidate.claim.text,
		claimIds: [candidate.claim.claimId],
		evidenceIds: candidate.claim.evidence.map((entry) => entry.evidenceId).sort(),
		scope: candidate.claim.scope,
		effectiveAt: candidate.claim.effectiveAt,
		// Filled in immediately below: the cost is the cost of the rendered line, which needs the item.
		tokenCost: 0,
		section,
		score: candidate.score,
		mandatory,
	};
	const selected: SelectedItem = { item, candidate, qualifications: conflicts.map((entry) => entry.qualification), superseded: resolution.demoted.has(candidate.claim.claimId), conflicts };
	item.tokenCost = estimateTokens(renderContextItemLine(selected));
	return selected;
}

/* ------------------------------------------------------------------------------------------------
 * Redundancy
 * ---------------------------------------------------------------------------------------------- */

/**
 * The 3-token shingle set of a claim, over its **normalized** text.
 *
 * Normalizing first (claims.ts:102-114) means two renderings of the same sentence — one bulleted,
 * one bare, one with a trailing ellipsis from an excerpt window — produce identical shingles, which
 * is exactly the redundancy the penalty is supposed to catch. A text shorter than the window yields
 * one shingle of its whole token list rather than none, so a two-word claim is still comparable
 * instead of being scored as maximally novel against everything.
 */
export function shingles(text: string, size: number): Set<string> {
	return shingleSet(normalizeClaimText(text), size);
}

/**
 * Re-exported from `similarity.ts`, where Phase 2 moved the implementation so that `conflicts.ts`
 * could use it without an import cycle (this module already imports `conflicts.ts`). The signature
 * and behaviour are unchanged; `test/select.test.ts` still pins both from here.
 */
export { jaccard } from "./similarity.ts";

/**
 * Design §10: "quota(sec) = 1 below soft share, 0.5 once at 1.5× share".
 *
 * The design fixes the two endpoints and leaves the interval between them open. A step function
 * would make the multiplier — and therefore the selection order — hinge on a single token crossing
 * a threshold, so the interval is a straight line between the stated endpoints: monotone, exactly
 * 1.0 at the share, exactly 0.5 at 1.5× it, and nothing invented outside what the design fixed.
 */
export function quotaMultiplier(usedInSection: number, share: number, policy: RankingPolicy): number {
	if (share <= 0) return policy.selection.quotaFloor;
	if (usedInSection <= share) return 1;
	const ceiling = share * policy.selection.quotaOverFactor;
	if (usedInSection >= ceiling) return policy.selection.quotaFloor;
	return 1 - (1 - policy.selection.quotaFloor) * ((usedInSection - share) / (ceiling - share));
}

/* ------------------------------------------------------------------------------------------------
 * Selection
 * ---------------------------------------------------------------------------------------------- */

/** Design §10's four reasons, plus the one the mandatory-overflow path needs. */
export const EXCLUSION_REASONS = ["budget", "redundant", "below_floor", "quota", "mandatory_overflow"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ExclusionRecord {
	claimId: string;
	itemId: string;
	section: BriefingSection;
	reason: ExclusionReason;
	/** The numbers behind the reason, so the explanation is checkable rather than a category. */
	detail: string;
	utility: number;
	tokenCost: number;
	/** Highest Jaccard against anything that *was* selected. The redundancy the penalty measured. */
	maxSimilarity: number;
}

export interface SelectionStats {
	candidates: number;
	mandatoryCandidates: number;
	selected: number;
	excluded: number;
	byReason: Record<ExclusionReason, number>;
	bySection: Record<BriefingSection, { items: number; tokens: number }>;
	iterations: number;
	/** Why the loop ended. One of these is always true when candidates remain unselected. */
	stopReason: "pool_exhausted" | "below_floor" | "budget";
	objectiveTokens: number;
	/** What the briefing's own frame was charged. See `BRIEFING_SCAFFOLDING_TOKENS`. */
	scaffoldingTokens: number;
}

export interface SelectionResult {
	items: SelectedItem[];
	excluded: ExclusionRecord[];
	budget: Budget;
	/** True when the hard budget forced something out. Drives spec §16's `status: "partial"`. */
	partial: boolean;
	/** Named holes selection itself created. Adapter-level gaps come from the plan and the run. */
	gaps: RetrievalGap[];
	stats: SelectionStats;
}

export interface SelectContextInput {
	candidates: readonly RankedCandidate[];
	conflicts: ConflictResolution;
	/** The caller's hard ceiling, in tokens. Never exceeded. */
	budget: number;
	policy: RankingPolicy;
	/** Echoed into the briefing and charged against the mandatory reservation (spec §15). */
	objective: string;
	/** Overridden only by a caller with its own renderer. See `BRIEFING_SCAFFOLDING_TOKENS`. */
	scaffoldingTokens?: number;
	trace?: TraceWriter;
}

function emptyByReason(): Record<ExclusionReason, number> {
	return { budget: 0, redundant: 0, below_floor: 0, quota: 0, mandatory_overflow: 0 };
}

function emptyBySection(): Record<BriefingSection, { items: number; tokens: number }> {
	return {
		confirmed_facts: { items: 0, tokens: 0 },
		previous_decisions: { items: 0, tokens: 0 },
		current_state: { items: 0, tokens: 0 },
		constraints: { items: 0, tokens: 0 },
		known_failures_or_rejected: { items: 0, tokens: 0 },
		preferences: { items: 0, tokens: 0 },
		conflicts: { items: 0, tokens: 0 },
		open_tasks: { items: 0, tokens: 0 },
		uncertainties_or_gaps: { items: 0, tokens: 0 },
	};
}

/**
 * Is this candidate mandatory (design §10)?
 *
 * "Active CONSTRAINTs in scope + security restrictions + unresolved conflicts + objective echo."
 * Three of those four are here; the objective echo is a budget reservation rather than a retrieved
 * claim and is charged separately below. *Security restrictions* has no retrieved half in Phase 1 —
 * there is no per-record ACL anywhere in the corpus (types.ts:139-158), so the security material a
 * briefing must carry is the authorization refusals and the quarantine count, which brief.ts
 * assembles from the run rather than selecting from candidates. Inventing a "security claim" type to
 * fill the slot would be the placeholder abstraction §26 forbids.
 */
function isMandatory(candidate: RankedCandidate, resolution: ConflictResolution): boolean {
	// Phase 2: `resolution.mandatory` is the *unresolved* conflicts plus every demoted claim, which is
	// design §10's wording read literally. Phase 1 reserved capacity for every conflict participant,
	// a superset that was harmless when there were two classes and would now spend the whole
	// reservation on settled questions — pushing the open ones out of the budget.
	if (resolution.mandatory.has(candidate.claim.claimId)) return true;
	if (candidate.claim.claimType !== "CONSTRAINT") return false;
	// Phase 2: a constraint that is not yet in force is not a standing rule *yet*. It reaches the
	// briefing through its temporal-validity conflict record instead of through the mandatory
	// reservation, so the reader is told it is scheduled rather than told to obey it.
	if (!candidate.basis.temporal.inForce) return false;
	// "Active" in the governance sense. An ungoverned claim (lifecycle null) is active by default —
	// nothing has said otherwise — and a DISPUTED constraint is mandatory too, via the conflict test
	// above, so it reaches the briefing as a conflict rather than as a standing rule.
	return candidate.claim.lifecycle === null || candidate.claim.lifecycle === "ACTIVE";
}

/** Spec §15's "Reserve guaranteed capacity for: Current objective". Rendered as brief.ts renders it. */
export function objectiveEchoTokens(objective: string): number {
	return estimateTokens(`## Objective\n\n${objective.replace(/\s+/gu, " ").trim()}\n`);
}

/**
 * What the briefing's own frame costs, in tokens, before a single claim is placed.
 *
 * **This constant exists because the first live run overran.** The item ledger said 5,386 of 6,000
 * and the briefing that was actually delivered measured 8,331 — the scaffolding (header, scope, the
 * untrusted-reference fence, ten section headings, the gap list, the exclusion summary, the
 * provenance block) was never charged to anything. Design §16 gates token-budget compliance at 100%,
 * and the thing that has to comply is the artifact the caller receives, not the subtotal Mnemosia
 * kept for itself. Charging it here is what makes the budget a promise about the delivered bytes.
 *
 * `tokens.ts:15` describes the 10% reserve as being held back "for the briefing's own scaffolding",
 * and that turned out to be measurably too small: 600 tokens against a measured 740. So the reserve
 * stays what it is — a margin — and the scaffolding is charged explicitly, like the objective echo.
 *
 * Measured, not guessed. Against the live corpus and `brief.ts`'s renderer:
 *
 * ```
 * a briefing with no items at all (the pure frame)                    653 tokens
 * the standard-mode task-A briefing below (5 exclusion examples,
 *   2 gaps, 1 follow-up, 4 unpopulated sections, 60-claim provenance)  917 tokens
 * a synthetic worst case (4 long gaps, 6 long follow-ups)            1,395 tokens
 * ```
 *
 * 1,000 covers the frame plus the parts that vary with the run, and the 10% reserve is the second
 * margin behind it. The frame cannot grow with the *corpus*: brief.ts caps the rendered exclusion
 * examples at five, renders `unpopulated_sections` as a list of names rather than a paragraph each,
 * and summarizes provenance instead of listing it — so the only things that scale are the gap and
 * follow-up lists, which are bounded by the number of sources and detected conflicts.
 *
 * `test/brief.test.ts` measures a real rendering against this number, which is what keeps the two
 * from drifting, and `validateBriefing`'s `rendered_over_budget` is the backstop if they ever do.
 */
export const BRIEFING_SCAFFOLDING_TOKENS = 1_000;

/**
 * The smallest budget that can hold a *conforming* briefing, derived rather than guessed.
 *
 * Chunk C measured the floor at "roughly 1,150 tokens" and left the consequence to step 15. This is
 * the arithmetic behind that number, so it moves when the scaffolding constant or the reserve ratio
 * moves instead of drifting away from them:
 *
 * ```
 * overhead        = objectiveEchoTokens(objective) + scaffoldingTokens
 * selectable pool = budget − ceil(reserveRatio · budget)
 * conforming      ⟺ overhead ≤ selectable pool
 *                 ⟺ budget ≥ ceil(overhead / (1 − reserveRatio))
 * ```
 *
 * At the shipped constants (1,000 scaffolding, 0.10 reserve) that is 1,112 tokens for an empty
 * objective and about 1,130–1,160 for a real one — the design's "~1,150", now computed.
 *
 * Below it, `selectContext` still produces a briefing and marks it structurally partial
 * (`selectContext` step 0), and `validateBriefing` refuses to certify it. The orchestrator turns the
 * same condition into a clean `CLARIFICATION_REQUIRED` exit *before* any source is queried, because
 * the caller has to change the request either way and reading 11,000 events first would only make
 * the refusal slower.
 */
export function minimumConformingBudget(objective: string, policy: RankingPolicy, scaffoldingTokens: number = BRIEFING_SCAFFOLDING_TOKENS): number {
	const overhead = objectiveEchoTokens(objective) + scaffoldingTokens;
	return Math.ceil(overhead / (1 - policy.selection.reserveRatio));
}

/**
 * The same floor for a Conclave seat, where the overhead **depends on the budget being solved for**.
 *
 * Phase 4 charges the seat's agent addendum alongside the frame, and `effectiveAddendumReserve` caps
 * that charge at `ADDENDUM_BUDGET_SHARE` of the budget. So the conforming condition
 *
 * ```
 * echo + frame + min(ceiling, share·B)  ≤  (1 − reserveRatio)·B
 * ```
 *
 * has `B` on both sides, and calling `minimumConformingBudget` with the seat's *ceiling* — which is
 * what the first version of this wiring did — computes the floor for a briefing the run would never
 * produce: at a budget near the floor the share cap binds long before the ceiling does, so the floor
 * came out several hundred tokens too high and `CLARIFICATION_REQUIRED` was returned for budgets that
 * could in fact have held a conforming briefing.
 *
 * It is solved rather than iterated, because `min` splits it into two linear cases:
 *
 * - **the share cap binds** (`share·B ≤ ceiling`) → `B ≥ overhead / (1 − reserveRatio − share)`;
 * - **the seat's ceiling binds** → `B ≥ (overhead + ceiling) / (1 − reserveRatio)`.
 *
 * The first is tried first and accepted only if its own premise holds at the answer, which is what
 * makes the case split total rather than a guess. `1 − 0.10 − 0.08 = 0.82 > 0`, so the first case is
 * never a division by a non-positive number; the guard states that rather than relying on it.
 */
export function minimumConformingBudgetForSeat(objective: string, policy: RankingPolicy, baseScaffolding: number, addendumCeiling: number): number {
	const overhead = objectiveEchoTokens(objective) + baseScaffolding;
	const usable = 1 - policy.selection.reserveRatio;
	if (addendumCeiling <= 0) return Math.ceil(overhead / usable);
	const slope = usable - ADDENDUM_BUDGET_SHARE;
	if (slope > 0) {
		const shareBound = Math.ceil(overhead / slope);
		if (Math.floor(ADDENDUM_BUDGET_SHARE * shareBound) <= addendumCeiling) return shareBound;
	}
	return Math.ceil((overhead + addendumCeiling) / usable);
}

export function selectContext(input: SelectContextInput): SelectionResult {
	const policy = input.policy;
	const { lambda, marginalFloor, shingleSize, sectionShares } = policy.selection;

	let budget = createBudget(input.budget, policy.selection.reserveRatio);
	const selectablePool = Math.max(0, budget.total - budget.reserve);

	const all = [...input.candidates].sort(compareCandidates).map((candidate) => buildItem(candidate, input.conflicts, isMandatory(candidate, input.conflicts)));
	const shingleIndex = new Map<string, Set<string>>(all.map((entry) => [entry.item.itemId, shingles(entry.item.text, shingleSize)]));

	const selected: SelectedItem[] = [];
	const excluded: ExclusionRecord[] = [];
	const bySection = emptyBySection();
	const byReason = emptyByReason();
	const gaps: RetrievalGap[] = [];
	let partial = false;

	const place = (entry: SelectedItem): void => {
		budget = spend(budget, entry.item.tokenCost);
		selected.push(entry);
		bySection[entry.item.section].items += 1;
		bySection[entry.item.section].tokens += entry.item.tokenCost;
		input.trace?.append({ state: "SELECT_CONTEXT_SET", event: "selection", payload: { itemId: entry.item.itemId, claimId: entry.candidate.claim.claimId, section: entry.item.section, mandatory: entry.item.mandatory, tokenCost: entry.item.tokenCost, utility: entry.candidate.score.utility } });
	};

	/* --- step 0: the objective echo and the briefing frame -------------------------------------- */
	//
	// Charged before anything is selected, because spec §15 lists the current objective first among
	// the things that get *guaranteed* capacity. A briefing that dropped the objective to fit one
	// more fact would have lost the one line that tells the reader what the rest of it is for. The
	// frame is charged in the same breath: see `BRIEFING_SCAFFOLDING_TOKENS` for what it costs and
	// why leaving it uncharged made the first live run overrun by 39%.
	const objectiveTokens = objectiveEchoTokens(input.objective);
	// Each conflict that has a participant in the conflicts section renders a heading, its rationale,
	// its qualification and a follow-up line. That grows with the number of conflicts, so it is
	// charged here with the frame rather than hidden inside the fixed frame constant.
	const sectioned = new Set(all.filter((entry) => entry.item.section === "conflicts").map((entry) => entry.candidate.claim.claimId));
	const conflictChrome = input.conflicts.conflicts.filter((record) => record.claimIds.some((id) => sectioned.has(id))).reduce((sum, record) => sum + estimateTokens(`### ${record.conflictClass} → ${record.outcome} (${record.detector})\n_${record.rationale}_\n> ${record.qualification}\nResolve conflict ${record.conflictId.slice(0, 12)} (${record.conflictClass}/${record.outcome}) before relying on the affected statements.`), 0);
	const scaffoldingTokens = (input.scaffoldingTokens ?? BRIEFING_SCAFFOLDING_TOKENS) + conflictChrome;
	const overhead = objectiveTokens + scaffoldingTokens;
	if (overhead <= selectablePool) budget = spend(budget, overhead);
	else {
		// A budget too small to hold its own objective and frame is not a briefing. Recorded, not
		// clamped: the run still produces a briefing, and it says out loud that it is structurally
		// partial rather than quietly rendering past the ceiling.
		partial = true;
		gaps.push({ sourceId: "mnemosia/selection", reason: "budget", detail: `the ${budget.total}-token budget cannot hold the ${objectiveTokens}-token objective echo plus the ${scaffoldingTokens}-token briefing frame; the briefing is structurally partial`, code: null });
	}

	/* --- step 1: mandatory reservation --------------------------------------------------------- */
	const mandatory = all.filter((entry) => entry.item.mandatory);
	const mandatoryTotal = mandatory.reduce((sum, entry) => sum + entry.item.tokenCost, 0);
	const mandatoryOverflowed = mandatoryTotal > selectableRemaining(budget);

	for (const entry of mandatory) {
		if (entry.item.tokenCost <= selectableRemaining(budget)) {
			place(entry);
			continue;
		}
		// Design §10: "If Σ > budget − reserve → PARTIAL_BRIEFING with highest-utility prefix +
		// explicit retrieval_gap". `mandatory` is already in utility order, so what has been placed by
		// the time this fires *is* the highest-utility prefix.
		partial = true;
		excluded.push({
			claimId: entry.candidate.claim.claimId,
			itemId: entry.item.itemId,
			section: entry.item.section,
			reason: "mandatory_overflow",
			detail: `mandatory item costs ${entry.item.tokenCost} tokens; ${selectableRemaining(budget)} of the ${selectablePool}-token selectable pool remained after the higher-utility mandatory prefix`,
			utility: entry.candidate.score.utility,
			tokenCost: entry.item.tokenCost,
			maxSimilarity: 0,
		});
		byReason.mandatory_overflow += 1;
	}

	if (mandatoryOverflowed) {
		gaps.push({
			sourceId: "mnemosia/selection",
			reason: "budget",
			detail: `the mandatory set (${mandatory.length} item(s), ${mandatoryTotal} tokens) exceeds the ${selectablePool}-token selectable pool; ${byReason.mandatory_overflow} mandatory item(s) were dropped and this briefing is PARTIAL`,
			code: null,
		});
	}

	/* --- step 2: the MMR loop ------------------------------------------------------------------ */
	const pool = all.filter((entry) => !entry.item.mandatory);
	const chosen = new Set(selected.map((entry) => entry.item.itemId));
	let iterations = 0;
	let stopReason: SelectionStats["stopReason"] = "pool_exhausted";

	const similarityTo = (entry: SelectedItem): number => {
		const own = shingleIndex.get(entry.item.itemId) ?? new Set<string>();
		let best = 0;
		for (const other of selected) {
			const compare = shingleIndex.get(other.item.itemId);
			if (compare === undefined) continue;
			best = Math.max(best, jaccard(own, compare));
		}
		return best;
	};

	while (true) {
		iterations += 1;
		const remaining = selectableRemaining(budget);
		let best: { entry: SelectedItem; marginal: number } | null = null;
		let anyFits = false;

		for (const entry of pool) {
			if (chosen.has(entry.item.itemId)) continue;
			if (entry.item.tokenCost > remaining) continue;
			anyFits = true;
			const quota = quotaMultiplier(bySection[entry.item.section].tokens, sectionShares[entry.item.section] * selectablePool, policy);
			const marginal = entry.candidate.score.utility * quota - lambda * similarityTo(entry);
			if (best === null || marginal > best.marginal + 1e-9) {
				best = { entry, marginal };
				continue;
			}
			// Design §10's tie-break: (utility desc, effectiveAt desc, claimId asc). `all` was sorted
			// into exactly that order, so an earlier candidate already holds the tie and nothing needs
			// to change — but the comparison is written out rather than relied on implicitly, because
			// "the array happened to be sorted" is not something the §16 determinism gate can read.
			if (Math.abs(marginal - best.marginal) <= 1e-9 && compareCandidates(entry.candidate, best.entry.candidate) < 0) best = { entry, marginal };
		}

		if (best === null) {
			stopReason = anyFits ? "pool_exhausted" : pool.some((entry) => !chosen.has(entry.item.itemId)) ? "budget" : "pool_exhausted";
			break;
		}
		if (best.marginal < marginalFloor) {
			stopReason = "below_floor";
			break;
		}
		place(best.entry);
		chosen.add(best.entry.item.itemId);
	}

	/* --- step 3: exclusion records ------------------------------------------------------------- */
	//
	// Attributed against the *final* selected set, so the reason a reader is given is the reason that
	// was true when the loop stopped, not a snapshot from some intermediate iteration.
	const finalRemaining = selectableRemaining(budget);
	for (const entry of pool) {
		if (chosen.has(entry.item.itemId)) continue;
		const similarity = similarityTo(entry);
		const share = sectionShares[entry.item.section] * selectablePool;
		const quota = quotaMultiplier(bySection[entry.item.section].tokens, share, policy);
		const marginal = entry.candidate.score.utility * quota - lambda * similarity;

		// Which of the three terms was *decisive*, not merely present.
		//
		// The loop only ever stops for two reasons — nothing fits, or the best marginal fell below the
		// floor — so for anything that fits, `marginal < marginalFloor` is guaranteed here. What a
		// reader needs to know is which term took it there. Reporting "below_floor" for a claim that
		// would have cleared the floor on its own but was cancelled by a near-duplicate would be
		// technically true and useless: design §10 names `redundant(λ·sim)` and `quota` as distinct
		// reasons precisely because they suggest different fixes (drop the duplicate; raise the share).
		const base = entry.candidate.score.utility;
		const afterQuota = base * quota;
		let reason: ExclusionReason;
		let detail: string;
		if (entry.item.tokenCost > finalRemaining) {
			reason = "budget";
			detail = `costs ${entry.item.tokenCost} tokens, ${finalRemaining} remained in the selectable pool`;
		} else if (afterQuota >= marginalFloor) {
			reason = "redundant";
			detail = `utility·quota = ${afterQuota.toFixed(3)} cleared the ${marginalFloor} floor, but λ·jaccard₃ = ${(lambda * similarity).toFixed(3)} against the selected set took its marginal value to ${marginal.toFixed(3)}`;
		} else if (base >= marginalFloor) {
			reason = "quota";
			detail = `section ${entry.item.section} held ${bySection[entry.item.section].tokens} tokens against a ${Math.round(share)}-token soft share, so its quota multiplier fell to ${quota.toFixed(2)} and utility ${base.toFixed(3)} became ${afterQuota.toFixed(3)}`;
		} else {
			reason = "below_floor";
			detail = `utility ${base.toFixed(3)} is below the ${marginalFloor} floor before any penalty applies`;
		}

		if (reason === "budget") partial = true;
		byReason[reason] += 1;
		excluded.push({ claimId: entry.candidate.claim.claimId, itemId: entry.item.itemId, section: entry.item.section, reason, detail, utility: entry.candidate.score.utility, tokenCost: entry.item.tokenCost, maxSimilarity: similarity });
		input.trace?.append({ state: "SELECT_CONTEXT_SET", event: "exclusion", payload: { itemId: entry.item.itemId, claimId: entry.candidate.claim.claimId, section: entry.item.section, reason, detail, utility: entry.candidate.score.utility, tokenCost: entry.item.tokenCost, maxSimilarity: similarity } });
	}

	if (byReason.budget > 0) {
		gaps.push({ sourceId: "mnemosia/selection", reason: "budget", detail: `${byReason.budget} candidate(s) did not fit the ${budget.total}-token budget and were excluded; the briefing is PARTIAL`, code: null });
	}

	// Selection order is stable, but the sections are rendered in design §10's order and a reader
	// expects the strongest item first inside each of them.
	selected.sort((a, b) => compareCandidates(a.candidate, b.candidate));
	excluded.sort((a, b) => b.utility - a.utility || (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));

	return {
		items: selected,
		excluded,
		budget,
		partial,
		gaps,
		stats: {
			candidates: all.length,
			mandatoryCandidates: mandatory.length,
			selected: selected.length,
			excluded: excluded.length,
			byReason,
			bySection,
			iterations,
			stopReason,
			objectiveTokens,
			scaffoldingTokens,
		},
	};
}

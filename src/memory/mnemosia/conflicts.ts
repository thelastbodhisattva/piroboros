// Ported from mnemosia/conflicts.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Conflict detection, classification and resolution (spec §14, design §11; Phase 2).
 *
 * Phase 1 shipped two of spec §14's ten classes — `TEMPORAL_SUCCESSION` and `UNRESOLVED` — and said
 * so rather than stubbing the other eight. Phase 2 builds the whole **deterministic** taxonomy:
 *
 * | class | detector | phase |
 * |---|---|---|
 * | `TEMPORAL_SUCCESSION` | explicit `supersedes`; transitive chains; same statement, one scope | 1 → extended |
 * | `UNRESOLVED` | anything detected and not classifiable into the other nine | 1 |
 * | `SUMMARY_SOURCE_MISMATCH` | a summary claim whose declared source events resolve to nothing | **2** |
 * | `SCOPE_DIFFERENCE` | the same statement under two `scope.project`s | **2** |
 * | `BRANCH_DIFFERENCE` | a neighbourhood pair whose extracted branch qualifiers are disjoint | **2** |
 * | `ENVIRONMENT_DIFFERENCE` | the same, for environment | **2** |
 * | `PLAN_VERSUS_FACT` | a `{PLAN, FACT/OBSERVATION}` neighbourhood pair | **2** |
 * | `PREFERENCE_CHANGE` | two PREFERENCE claims in a neighbourhood, different identities | **2** |
 * | `DIRECT_CONTRADICTION` | a neighbourhood pair with one-sided negation or a differing `key: value` | **2** (deterministic subset) |
 * | `AUTHORITY_DISAGREEMENT` | any contradiction whose sides differ ≥ 0.2 in authority | **2** |
 *
 * **There is no LLM anywhere in this file, and the general semantic case is still deferred.** Design
 * §11 splits `DIRECT_CONTRADICTION` deliberately: the deterministic subset is a syntactic asymmetry
 * — exactly one side negated, or a named setting given two values — and the general case ("we should
 * cache aggressively" vs "the cache is the bottleneck") needs semantics. A neighbourhood pair that
 * no predicate here explains is *not* reported as a contradiction. It is either explained by a
 * qualifier, or it is redundancy that `select.ts`'s MMR penalty already handles, or — when something
 * about it is genuinely undecidable — it is `UNRESOLVED` with `MARK_DISPUTED`, which is spec §14's
 * documented fallback and a smaller claim than a guess.
 *
 * **Does a superseded claim's evidence still support its successor? No, and that is a decision.**
 * The Phase 2 brief poses it directly. A `SUPERSEDES` edge says "this statement replaces that one";
 * it does not say "the artifact that carried the old statement asserts the new one". Letting the
 * retired artifact count toward the successor's `evidence_strength` would mean a claim could
 * strengthen itself by retiring things — an incentive exactly backwards from what evidence is for,
 * and one a poisoned artifact could exploit with a single `supersedes` field. So `rank.ts` counts
 * only `SUPPORTS` edges (rank.ts:338 and `provenance.ts`'s `supportingArtifacts`), `SUPERSEDES`
 * edges are recorded in the graph for traversal and for this file's classification, and the
 * successor's strength is whatever its own evidence earns. The retired claim keeps its own evidence
 * and stays in the briefing under `conflicts[]`.
 *
 * **Nothing here mutates the store**, unchanged from Phase 1: the outcomes are briefing-level.
 * **Resolution demotes; it never deletes** — spec §14's closing line, "never silently erase a
 * meaningful conflict", is the property every branch below is written to preserve.
 */

import { createHash } from "node:crypto";
import type { RankingPolicy } from "./policy.ts";
import { buildProvenanceGraph, type ProvenanceGraph } from "./provenance.ts";
import { keyValueDivergence, negationDivergence, planVersusFact, preferenceChange, scopeDifference } from "./relations.ts";
import { qualifiersDiverge } from "./qualifiers.ts";
import { temporallyDisjoint } from "./temporal.ts";
import type { ArtifactEnvelope, Claim } from "./types.ts";
import type { TraceWriter } from "./trace.ts";

/* ------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** Spec §14's ten classes, verbatim and in the spec's own order. */
export const CONFLICT_CLASSES = [
	"DIRECT_CONTRADICTION",
	"TEMPORAL_SUCCESSION",
	"SCOPE_DIFFERENCE",
	"BRANCH_DIFFERENCE",
	"ENVIRONMENT_DIFFERENCE",
	"PLAN_VERSUS_FACT",
	"PREFERENCE_CHANGE",
	"SUMMARY_SOURCE_MISMATCH",
	"AUTHORITY_DISAGREEMENT",
	"UNRESOLVED",
] as const;
export type ConflictClass = (typeof CONFLICT_CLASSES)[number];

/**
 * The outcomes a `ConflictRecord` may carry, after Phase 4.
 *
 * Still absent, with reasons: `SELECT_PRIMARY` needs a notion of a primary source Mnemosia does not
 * have; `REQUEST_HUMAN_APPROVAL` belongs to `approvals.ts`, where a named human actually decides,
 * and a conflict record is not a queue entry. `EXCLUDE_UNSAFE` is reached through `filters.ts`'s
 * quarantine rather than through a conflict record.
 *
 * **`ESCALATE_TO_ELARIA` and `ESCALATE_TO_RASKREIA` become reachable in Phase 4, and the Phase 2
 * rule that made them unreachable is preserved rather than repealed.** That rule was: a module that
 * cannot route must not emit a routing label. `detectConflicts` still cannot route — it does not
 * know who is asking, and a target that is also the requester is a loop it has no way to see — so it
 * still emits only `DETERMINISTIC_CONFLICT_OUTCOMES` below, and `test/escalation.test.ts` asserts
 * that. The two escalation labels are applied by `escalation.ts:routeEscalations`, which *is* handed
 * the requesting agent and which produces an addressed `EscalationRequest` alongside every label it
 * writes. The label and the thing behind it are produced by the same function or not at all.
 */
export const CONFLICT_OUTCOMES = ["SELECT_NEWER_VALID", "SELECT_HIGHER_AUTHORITY", "KEEP_SCOPE_SPECIFIC_VARIANTS", "INCLUDE_BOTH_WITH_QUALIFICATION", "MARK_DISPUTED", "REQUEST_VERIFICATION", "ESCALATE_TO_ELARIA", "ESCALATE_TO_RASKREIA"] as const;
export type ConflictOutcome = (typeof CONFLICT_OUTCOMES)[number];

/**
 * The subset `detectConflicts` itself may emit — every outcome that is a conclusion about the claims
 * rather than a decision about who should look at them. Kept as its own constant so that "the
 * detector never routes" is a machine-checked property rather than a comment.
 */
export const DETERMINISTIC_CONFLICT_OUTCOMES = ["SELECT_NEWER_VALID", "SELECT_HIGHER_AUTHORITY", "KEEP_SCOPE_SPECIFIC_VARIANTS", "INCLUDE_BOTH_WITH_QUALIFICATION", "MARK_DISPUTED", "REQUEST_VERIFICATION"] as const;

/** The two Phase 4 routing labels. A record carrying one of these has an `EscalationRequest`. */
export const ESCALATION_OUTCOMES = ["ESCALATE_TO_ELARIA", "ESCALATE_TO_RASKREIA"] as const;
export type EscalationOutcome = (typeof ESCALATION_OUTCOMES)[number];

export const CONFLICT_DETECTORS = [
	"explicit_supersession",
	"transitive_supersession",
	"dangling_supersession",
	"summary_source_mismatch",
	"dedup_key_divergence",
	"branch_qualifier",
	"environment_qualifier",
	"scope_qualifier",
	"negation_divergence",
	"key_value_divergence",
	"preference_change",
	"plan_versus_fact",
	"temporal_validity",
	"disputed_lifecycle",
] as const;
export type ConflictDetectorId = (typeof CONFLICT_DETECTORS)[number];

export interface ConflictRecord {
	/** sha256 over the detector and the sorted participant ids: the same conflict never gets two ids. */
	conflictId: string;
	conflictClass: ConflictClass;
	outcome: ConflictOutcome;
	detector: ConflictDetectorId;
	/** Every claim involved, sorted, so the record serializes identically across runs (§16). */
	claimIds: string[];
	/** The claim the outcome favours, or `null` when the outcome favours neither. */
	winnerClaimId: string | null;
	/** Claims demoted out of the factual sections by this conflict. Never removed from the briefing. */
	supersededClaimIds: string[];
	/**
	 * `true` when nothing decided the conflict — the sides are both still standing and the reader has
	 * to. Design §10 reserves mandatory briefing capacity for exactly these, and only these: a
	 * resolved supersession has an answer, and spending the mandatory reservation on answers rather
	 * than on open questions is what would push a genuine open question out of the budget.
	 */
	unresolved: boolean;
	/** jaccard₃ between the two sides, for a neighbourhood detector. `null` otherwise. */
	similarity: number | null;
	/** Authority difference between the sides, when authority was consulted. */
	authorityGap: number | null;
	/** Supersession chain length, for the transitive detector. */
	chainDepth: number | null;
	/** Why, in prose, for the trace and `explainDecision`. */
	rationale: string;
	/** The sentence the briefing attaches to the affected claims. This is the "with qualification". */
	qualification: string;
	detectedAt: number;
}

export interface ConflictStats {
	claimsIn: number;
	conflicts: number;
	byClass: Record<ConflictClass, number>;
	byOutcome: Record<ConflictOutcome, number>;
	byDetector: Record<ConflictDetectorId, number>;
	/** Claims demoted out of the factual sections. Design §16 gates stale factual inclusion at 0. */
	demoted: number;
	/** `supersedes` references that named nothing this run retrieved. Each becomes an UNRESOLVED. */
	danglingReferences: number;
	/** Conflicts with no decided side. These are the ones that take mandatory briefing capacity. */
	unresolved: number;
	/** Neighbourhood pairs examined by the Phase 2 pairwise detectors. */
	pairsExamined: number;
	/** Pairs in the neighbourhood that no predicate explained — near-duplicates, not disagreements. */
	pairsUnexplained: number;
	/** Summary artifacts whose own sources this run could not reach. A coverage fact, not a conflict. */
	ungroundedSummaries: number;
}

export interface ConflictResolution {
	conflicts: ConflictRecord[];
	/** claimId → the conflicts it participates in. */
	byClaimId: Map<string, ConflictRecord[]>;
	/** claimId → the record that demoted it. A member of this map may not enter a factual section. */
	demoted: Map<string, ConflictRecord>;
	/**
	 * Claims selection must reserve capacity for: parties to an unresolved conflict, plus every
	 * demoted claim. The second half is not generosity — a claim kept out of `confirmed_facts` with
	 * no visible record of why has been silently erased, which is the one thing spec §14 forbids.
	 */
	mandatory: Set<string>;
	/**
	 * Phase 4. Claims routed into `conflicts[]` by a seat's **presentation** policy rather than by
	 * demotion — the winning side of a conflict that Mnemosia did resolve, shown next to the side it
	 * beat because this reader asked to see the disagreement rather than the answer.
	 *
	 * A separate set from `demoted` on purpose. `demoted` means *this claim may not stand as a fact*,
	 * and `SelectedItem.superseded` is read straight off it; putting a winner in there would flag it
	 * superseded in the rendered line and in `BriefingItem.superseded`, which is a false statement
	 * about the claim rather than a change to where it is filed. Empty for six of the eight seats.
	 */
	presented: Set<string>;
	graph: ProvenanceGraph;
	stats: ConflictStats;
}

export interface DetectConflictsInput {
	/** The **accepted** claims. Rejected ones are already gone and must not resurface as conflicts. */
	claims: readonly Claim[];
	/** The run's normalized artifacts. Only needed when `graph` is not supplied. */
	envelopes?: readonly ArtifactEnvelope[];
	/** The graph `rank.ts` scored against. Built here when absent, from `claims` and `envelopes`. */
	graph?: ProvenanceGraph;
	/** Supplies the neighbourhood and authority-gap thresholds. Design §11's defaults when absent. */
	policy?: RankingPolicy;
	/** Authority of a claim's best source, for `AUTHORITY_DISAGREEMENT`. Absent ⇒ the class cannot fire. */
	authorityOf?: (claimId: string) => number | undefined;
	now?: number;
	trace?: TraceWriter;
}

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

function conflictIdFor(detector: ConflictDetectorId, claimIds: readonly string[], subject: string): string {
	return createHash("sha256").update(`${detector}${[...claimIds].sort().join("")}${subject}`, "utf8").digest("hex").slice(0, 32);
}

function shortText(text: string, width = 90): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function isoDay(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

function short(claimId: string): string {
	return claimId.slice(0, 12);
}

/**
 * `(effectiveAt desc, claimId asc)` — the newest claim, with a total tie-break.
 *
 * The tie-break is not decoration. Two claims extracted from the same artifact share its
 * `createdAt`, so "newer wins" is genuinely undecided for them, and without a deterministic second
 * key the winner would depend on the order the adapters happened to return rows in — which the §16
 * determinism gate measures across three runs.
 */
function newerFirst(a: Claim, b: Claim): number {
	if (a.effectiveAt !== b.effectiveAt) return b.effectiveAt - a.effectiveAt;
	return a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0;
}

const DEFAULT_NEIGHBOURHOOD = 0.6;
const DEFAULT_AUTHORITY_GAP = 0.2;

/* ------------------------------------------------------------------------------------------------
 * Detection
 * ---------------------------------------------------------------------------------------------- */

/**
 * Detects, classifies and resolves conflicts over the accepted claim set.
 *
 * Detectors run in the order below, and a claim already explained by a stronger detector is not
 * re-reported by a weaker one. The order is by *strength of the evidence for the conflict*, not by
 * severity: an explicit `supersedes` link is a governance fact recorded by a human, a shared
 * `dedupKey` is an identity fact computed by the pipeline, and a neighbourhood predicate is an
 * inference from text — so they are tried in exactly that order and the first one that fires owns
 * the explanation the reader is given.
 */
export function detectConflicts(input: DetectConflictsInput): ConflictResolution {
	const now = input.now ?? Date.now();
	const claims = input.claims;
	const policy = input.policy;
	const neighbourhood = policy?.conflict.neighbourhoodThreshold ?? DEFAULT_NEIGHBOURHOOD;
	const authorityGap = policy?.conflict.authorityGap ?? DEFAULT_AUTHORITY_GAP;
	const graph = input.graph ?? buildProvenanceGraph({ claims, envelopes: input.envelopes ?? [], now, shingleSize: policy?.selection.shingleSize ?? 3, neighbourhoodThreshold: neighbourhood });

	const byClaimId = new Map<string, Claim>(claims.map((claim) => [claim.claimId, claim]));

	const conflicts: ConflictRecord[] = [];
	const demoted = new Map<string, ConflictRecord>();
	const explained = new Set<string>();
	/** Pairs already owned by a detector, keyed `ab` with a < b. */
	const explainedPairs = new Set<string>();
	let danglingReferences = 0;

	const pairKey = (a: string, b: string): string => (a < b ? `${a}${b}` : `${b}${a}`);

	const record = (entry: ConflictRecord): void => {
		conflicts.push(entry);
		for (const claimId of entry.claimIds) explained.add(claimId);
		if (entry.claimIds.length === 2) {
			const [first, second] = entry.claimIds;
			if (first !== undefined && second !== undefined) explainedPairs.add(pairKey(first, second));
		}
		for (const claimId of entry.supersededClaimIds) {
			// First demotion wins, matching the first-match-wins rule filters.ts uses for rejections:
			// a claim is attributed to the *first* reason it was demoted, not the last.
			if (!demoted.has(claimId)) demoted.set(claimId, entry);
		}
		input.trace?.append({ state: "DETECT_CONFLICTS", event: "conflict", payload: { ...entry } });
	};

	const authority = (claimId: string): number | undefined => input.authorityOf?.(claimId);

	/* --- 1 & 2: explicit supersession, direct then transitive ----------------------------------- */
	//
	// The graph resolved `claim.supersedes` (which names artifacts) into claim-to-claim edges and
	// closed them transitively, so "A supersedes B supersedes C" reaches C here without this loop
	// having to walk anything.
	for (const claim of [...claims].sort((a, b) => (a.claimId < b.claimId ? -1 : 1))) {
		const provenance = graph.byClaim.get(claim.claimId);
		if (provenance === undefined) continue;

		for (const targetId of provenance.supersedes) {
			const target = byClaimId.get(targetId);
			if (target === undefined) continue;
			record({
				conflictId: conflictIdFor("explicit_supersession", [claim.claimId, targetId], "direct"),
				conflictClass: "TEMPORAL_SUCCESSION",
				outcome: "SELECT_NEWER_VALID",
				detector: "explicit_supersession",
				claimIds: [claim.claimId, targetId].sort(),
				winnerClaimId: claim.claimId,
				supersededClaimIds: [targetId],
				unresolved: false,
				similarity: null,
				authorityGap: null,
				chainDepth: 1,
				rationale: `${short(claim.claimId)} carries an explicit supersedes link reaching ${short(targetId)}; explicit supersession is a governance fact, not an inference, so it settles the pair outright`,
				qualification: `Superseded on ${isoDay(claim.effectiveAt)} by: "${shortText(claim.text)}"`,
				detectedAt: now,
			});
		}

		// **PHASE 2 — transitive chains.** Everything reachable through more than one link. Reported
		// separately from the direct pair because the reader's question differs: "this was replaced"
		// versus "this was replaced by something that has itself since been replaced", and collapsing
		// the two would hide the middle of the chain entirely.
		const indirect = provenance.supersedesTransitive.filter((targetId) => !provenance.supersedes.includes(targetId) && byClaimId.has(targetId));
		for (const targetId of indirect) {
			record({
				conflictId: conflictIdFor("transitive_supersession", [claim.claimId, targetId], "transitive"),
				conflictClass: "TEMPORAL_SUCCESSION",
				outcome: "SELECT_NEWER_VALID",
				detector: "transitive_supersession",
				claimIds: [claim.claimId, targetId].sort(),
				winnerClaimId: claim.claimId,
				supersededClaimIds: [targetId],
				unresolved: false,
				similarity: null,
				authorityGap: null,
				chainDepth: provenance.supersessionDepth,
				rationale: `${short(targetId)} is retired through a supersession chain of ${provenance.supersessionDepth} link(s) ending at ${short(claim.claimId)}; every intermediate statement in the chain is itself superseded`,
				qualification: `Superseded indirectly: a chain of ${provenance.supersessionDepth} replacements ends at "${shortText(claim.text)}" (${isoDay(claim.effectiveAt)}).`,
				detectedAt: now,
			});
		}

		// Dangling: a `supersedes` reference that resolved to no claim in this run. Worth reporting
		// rather than dropping — it tells the reader that the statement in front of them replaced one
		// they cannot see, which is exactly the kind of thing a briefing exists to say out loud.
		for (const reference of [...claim.supersedes].sort()) {
			const resolved = graph.claimsByArtifact.get(reference) ?? graph.claimsByArtifact.get(`akashic-memory:${reference}`) ?? [];
			if (resolved.some((claimId) => claimId !== claim.claimId && byClaimId.has(claimId))) continue;
			danglingReferences += 1;
			record({
				conflictId: conflictIdFor("dangling_supersession", [claim.claimId], reference),
				conflictClass: "UNRESOLVED",
				outcome: "MARK_DISPUTED",
				detector: "dangling_supersession",
				claimIds: [claim.claimId],
				winnerClaimId: null,
				// Nothing is demoted: the claim doing the superseding is not itself in doubt, and the
				// thing it retired is not here to demote.
				supersededClaimIds: [],
				unresolved: true,
				similarity: null,
				authorityGap: null,
				chainDepth: null,
				rationale: `claim ${short(claim.claimId)} declares it supersedes ${reference}, which this run did not retrieve, so the superseded statement could not be inspected`,
				qualification: `This statement explicitly supersedes ${reference}, which was not retrieved in this run — the replaced statement could not be checked.`,
				detectedAt: now,
			});
		}
	}

	/* --- 3: SUMMARY_SOURCE_MISMATCH (design §11, Phase 2) --------------------------------------- */
	//
	// Design §11's trigger is "a summary claim whose `sourceEventIds` are absent/hash-mismatched",
	// and `provenance.ts` computes exactly those two states:
	//
	//   refs_unresolved  every declared source event names something this run did not normalize
	//   refs_absent      the summary declares no source events at all, though its schema requires them
	//   integrity_failed the artifact's own hash check failed (unreachable post-filter, kept total)
	//
	// It deliberately does **not** fire on `session_absent` — an AkashicForge compaction summary whose
	// session contributed no primary event to *this* run. That is a fact about a retrieval that reads
	// a few hundred of 11,182 events, not a fact about the summary, and classifying it as a conflict
	// would report every summary in the corpus as poisoned. It is counted, it caps the claim's
	// evidence strength through graph distance 3, and it is disclosed as a grounding gap — the same
	// distinction design §16's Phase 1E note draws between a corpus fact and an availability fact.
	for (const claim of [...claims].sort((a, b) => (a.claimId < b.claimId ? -1 : 1))) {
		const provenance = graph.byClaim.get(claim.claimId);
		if (provenance === undefined) continue;
		if (provenance.grounding !== "refs_unresolved" && provenance.grounding !== "refs_absent" && provenance.grounding !== "integrity_failed") continue;
		const detail =
			provenance.grounding === "refs_absent"
				? "the summary cites no source events at all"
				: provenance.grounding === "integrity_failed"
					? "the summary artifact failed its integrity check"
					: `the summary cites ${provenance.unresolvedRefs.length} source event(s) — ${provenance.unresolvedRefs.slice(0, 4).join(", ")}${provenance.unresolvedRefs.length > 4 ? ", …" : ""} — none of which names anything this run holds`;
		record({
			conflictId: conflictIdFor("summary_source_mismatch", [claim.claimId], provenance.grounding),
			conflictClass: "SUMMARY_SOURCE_MISMATCH",
			outcome: "REQUEST_VERIFICATION",
			detector: "summary_source_mismatch",
			claimIds: [claim.claimId],
			winnerClaimId: null,
			// Demoted, not dropped. An unsourceable summary claim may not stand as a confirmed fact,
			// and deleting it would hide that the summary asserts it at all.
			supersededClaimIds: [claim.claimId],
			unresolved: true,
			similarity: null,
			authorityGap: null,
			chainDepth: null,
			rationale: `${short(claim.claimId)} reaches this run only through a summary whose own evidence cannot be located: ${detail}`,
			qualification: `This statement comes from a summary that cannot account for its own sources (${detail}). Verify it against the underlying events before relying on it.`,
			detectedAt: now,
		});
	}

	/* --- 4: same dedupKey, different identity --------------------------------------------------- */
	//
	// Two cases, and Phase 2 finally has the right label for the second one:
	//
	//   * **Same dedupKey, same scope.** Unreachable after `dedupeClaims`, because Phase 1B made
	//     `claimId = sha256(dedupKey ␟ scopeKey)`. Reachable only when a caller skips deduplication —
	//     a replayed trace, a replaced adapter — and handled as genuine TEMPORAL_SUCCESSION.
	//   * **Same dedupKey, different scope.** This is what actually survives. Phase 1 reported it as
	//     UNRESOLVED because it had no scope classifier; design §11 always assigned it
	//     `SCOPE_DIFFERENCE`, and Phase 2 delivers that, with spec §14's own
	//     `KEEP_SCOPE_SPECIFIC_VARIANTS` outcome. Neither side is demoted: they are two scoped
	//     statements, both true where they were recorded.
	const byDedupKey = new Map<string, Claim[]>();
	for (const claim of claims) {
		const bucket = byDedupKey.get(claim.dedupKey);
		if (bucket === undefined) byDedupKey.set(claim.dedupKey, [claim]);
		else bucket.push(claim);
	}
	for (const dedupKey of [...byDedupKey.keys()].sort()) {
		const group = (byDedupKey.get(dedupKey) ?? []).slice().sort(newerFirst);
		if (group.length < 2) continue;
		// **CORRECTED AFTER THE FIRST SEEDED MEASUREMENT.** Two entries sharing a `claimId` are the
		// same claim handed in twice, not two versions of a statement, and reporting one as having
		// superseded the other is a claim superseding itself. `dedupeClaims` collapses them in the
		// live pipeline, so this is only reachable when a caller skips deduplication — which is exactly
		// the path this detector exists to cover, and seed `N13` (a preference and a decision carrying
		// identical text in one scope) is where it fired.
		if (new Set(group.map((entry) => entry.claimId)).size < 2) continue;
		const [winner, ...losers] = group;
		if (winner === undefined) continue;
		const scopesDiffer = new Set(group.map((claim) => `${claim.scope.level}:${claim.scope.project ?? "-"}`)).size > 1;
		const ids = group.map((claim) => claim.claimId).sort();
		for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) explainedPairs.add(pairKey(ids[i] ?? "", ids[j] ?? ""));

		if (scopesDiffer) {
			record({
				conflictId: conflictIdFor("dedup_key_divergence", ids, "scope"),
				conflictClass: "SCOPE_DIFFERENCE",
				outcome: "KEEP_SCOPE_SPECIFIC_VARIANTS",
				detector: "dedup_key_divergence",
				claimIds: ids,
				winnerClaimId: null,
				supersededClaimIds: [],
				// Resolved: spec §14's KEEP_SCOPE_SPECIFIC_VARIANTS *is* the answer for a scoped pair.
				// Phase 1 marked it unresolved only because it had no class to put it in.
				unresolved: false,
				similarity: 1,
				authorityGap: null,
				chainDepth: null,
				rationale: `${group.length} claims share the normalized statement "${shortText(dedupKey, 60)}" across ${new Set(group.map((claim) => claim.scope.project ?? "global")).size} scopes; they are scope-specific variants of one statement, not competing versions of it`,
				qualification: `The same statement is recorded in ${group.map((claim) => claim.scope.project ?? "global scope").join(" and ")}; each is valid in its own scope and both are kept.`,
				detectedAt: now,
			});
			continue;
		}

		record({
			conflictId: conflictIdFor("dedup_key_divergence", ids, "temporal"),
			conflictClass: "TEMPORAL_SUCCESSION",
			outcome: "SELECT_NEWER_VALID",
			detector: "dedup_key_divergence",
			claimIds: ids,
			winnerClaimId: winner.claimId,
			supersededClaimIds: losers.map((claim) => claim.claimId),
			unresolved: false,
			similarity: 1,
			authorityGap: null,
			chainDepth: null,
			rationale: `${group.length} claims share the normalized statement "${shortText(dedupKey, 60)}" in one scope with distinct identities; the one effective at ${isoDay(winner.effectiveAt)} is the newest and wins`,
			qualification: `An older recording of the same statement (effective ${losers.map((claim) => isoDay(claim.effectiveAt)).join(", ")}) was superseded by the version effective ${isoDay(winner.effectiveAt)}.`,
			detectedAt: now,
		});
	}

	/* --- 5: the neighbourhood detectors (design §11's Phase 2 block) ---------------------------- */
	//
	// One pass over the near-duplicate pairs the graph already computed. Per pair the predicates are
	// tried in a fixed order and the first that fires owns the pair, because a difference with an
	// ordinary explanation must not also be reported as a contradiction: two statements about two
	// branches disagree about nothing, and telling the reader they contradict would be false.
	let pairsUnexplained = 0;
	for (const pair of graph.neighbours) {
		const a = pair.a;
		const b = pair.b;
		if (pair.similarity < neighbourhood) continue;
		if (explainedPairs.has(pairKey(a.claimId, b.claimId))) continue;
		if (!byClaimId.has(a.claimId) || !byClaimId.has(b.claimId)) continue;

		const qa = graph.byClaim.get(a.claimId)?.qualifiers ?? [];
		const qb = graph.byClaim.get(b.claimId)?.qualifiers ?? [];
		const ids = [a.claimId, b.claimId].sort();

		const branch = qualifiersDiverge(qa, qb, "branch");
		if (branch.diverges) {
			record(qualifierRecord("branch_qualifier", "BRANCH_DIFFERENCE", ids, pair.similarity, branch.left, branch.right, "branch", now));
			continue;
		}
		const environment = qualifiersDiverge(qa, qb, "environment");
		if (environment.diverges) {
			record(qualifierRecord("environment_qualifier", "ENVIRONMENT_DIFFERENCE", ids, pair.similarity, environment.left, environment.right, "environment", now));
			continue;
		}
		if (scopeDifference(a, b)) {
			record({
				conflictId: conflictIdFor("scope_qualifier", ids, "scope"),
				conflictClass: "SCOPE_DIFFERENCE",
				outcome: "KEEP_SCOPE_SPECIFIC_VARIANTS",
				detector: "scope_qualifier",
				claimIds: ids,
				winnerClaimId: null,
				supersededClaimIds: [],
				unresolved: false,
				similarity: pair.similarity,
				authorityGap: null,
				chainDepth: null,
				rationale: `two near-identical statements (jaccard₃ ${pair.shingleSimilarity.toFixed(3)} / jaccard₁ ${pair.tokenSimilarity.toFixed(3)}) are recorded under different scopes — ${a.scope.project ?? "global"} and ${b.scope.project ?? "global"} — so they are scope-specific variants rather than competing claims`,
				qualification: `Recorded separately for ${a.scope.project ?? "global scope"} and ${b.scope.project ?? "global scope"}; each holds in its own scope.`,
				detectedAt: now,
			});
			continue;
		}

		// The deterministic DIRECT_CONTRADICTION subset.
		const negation = negationDivergence(a.text, b.text);
		const keyValues = keyValueDivergence(a.text, b.text);
		if (negation.diverges || keyValues.length > 0) {
			const detector: ConflictDetectorId = negation.diverges ? "negation_divergence" : "key_value_divergence";
			const basis = negation.diverges
				? `exactly one side carries a negation marker (${negation.negatedSide === "a" ? short(a.claimId) : short(b.claimId)})`
				: keyValues.map((entry) => `\`${entry.key}\` is ${entry.left} on one side and ${entry.right} on the other`).join("; ");

			// Spec §14's first consideration is effective time. Two statements whose validity intervals
			// never met are a sequence, not a disagreement, and calling that a contradiction would put a
			// resolved history in front of the reader as an open question.
			if (temporallyDisjoint(a, b)) {
				const [newer, older] = [a, b].sort(newerFirst) as [Claim, Claim];
				record({
					conflictId: conflictIdFor(detector, ids, "temporal"),
					conflictClass: "TEMPORAL_SUCCESSION",
					outcome: "SELECT_NEWER_VALID",
					detector,
					claimIds: ids,
					winnerClaimId: newer.claimId,
					supersededClaimIds: [older.claimId],
					unresolved: false,
					similarity: pair.similarity,
					authorityGap: null,
					chainDepth: null,
					rationale: `${basis}, but the two validity intervals are disjoint — ${short(older.claimId)} was in force before ${short(newer.claimId)} took effect — so this is succession rather than contradiction (spec §14: consider effective time)`,
					qualification: `Superseded in time: this held until ${isoDay(newer.effectiveAt)}, when "${shortText(newer.text)}" took effect.`,
					detectedAt: now,
				});
				continue;
			}

			// AUTHORITY_DISAGREEMENT is design §11's classifier *over* the other detectors' output:
			// "any contradiction whose sides differ ≥ 0.2 in authority". It is applied here rather than
			// in a second pass so that the record carries one class rather than being emitted and then
			// relabelled, which a replay could not tell from two different conflicts.
			const authorityA = authority(a.claimId);
			const authorityB = authority(b.claimId);
			const gap = authorityA === undefined || authorityB === undefined ? null : Math.abs(authorityA - authorityB);
			if (gap !== null && gap >= authorityGap && authorityA !== undefined && authorityB !== undefined) {
				const winner = authorityA > authorityB ? a : b;
				const loser = authorityA > authorityB ? b : a;
				record({
					conflictId: conflictIdFor(detector, ids, "authority"),
					conflictClass: "AUTHORITY_DISAGREEMENT",
					outcome: "SELECT_HIGHER_AUTHORITY",
					detector,
					claimIds: ids,
					winnerClaimId: winner.claimId,
					supersededClaimIds: [loser.claimId],
					unresolved: false,
					similarity: pair.similarity,
					authorityGap: gap,
					chainDepth: null,
					rationale: `${basis}; the two sides differ by ${gap.toFixed(2)} in source authority (≥ ${authorityGap}), so the higher-standing source is preferred and the other is kept as context`,
					qualification: `A lower-authority source states this differently; the higher-authority record is preferred. Both are shown.`,
					detectedAt: now,
				});
				continue;
			}

			record({
				conflictId: conflictIdFor(detector, ids, "contradiction"),
				conflictClass: "DIRECT_CONTRADICTION",
				outcome: "MARK_DISPUTED",
				detector,
				claimIds: ids,
				winnerClaimId: null,
				// Both sides are demoted: neither may stand as a confirmed fact while the other exists.
				supersededClaimIds: ids,
				unresolved: true,
				similarity: pair.similarity,
				authorityGap: gap,
				chainDepth: null,
				rationale: `two statements about the same subject (jaccard₃ ${pair.shingleSimilarity.toFixed(3)} / jaccard₁ ${pair.tokenSimilarity.toFixed(3)}) disagree and nothing settles it: ${basis}. Their validity intervals overlap and their sources are of comparable standing, so Mnemosia states the disagreement rather than picking a side`,
				qualification: `Disputed: another retrieved statement contradicts this one (${basis}). Neither has been treated as established.`,
				detectedAt: now,
			});
			continue;
		}

		if (preferenceChange(a, b)) {
			const [newer, older] = [a, b].sort(newerFirst) as [Claim, Claim];
			record({
				conflictId: conflictIdFor("preference_change", ids, "preference"),
				conflictClass: "PREFERENCE_CHANGE",
				outcome: "SELECT_NEWER_VALID",
				detector: "preference_change",
				claimIds: ids,
				winnerClaimId: newer.claimId,
				supersededClaimIds: [older.claimId],
				unresolved: false,
				similarity: pair.similarity,
				authorityGap: null,
				chainDepth: null,
				rationale: `two PREFERENCE claims about the same subject (jaccard₃ ${pair.shingleSimilarity.toFixed(3)} / jaccard₁ ${pair.tokenSimilarity.toFixed(3)}) were recorded at different times with different content; a preference is a standing instruction and the most recent statement of it is the one in force`,
				qualification: `Superseded preference: the user restated this on ${isoDay(newer.effectiveAt)} as "${shortText(newer.text)}". The earlier wording is kept for context.`,
				detectedAt: now,
			});
			continue;
		}

		const plan = planVersusFact(a, b);
		if (plan.matches) {
			const planClaim = plan.planSide === "a" ? a : b;
			const factClaim = plan.planSide === "a" ? b : a;
			record({
				conflictId: conflictIdFor("plan_versus_fact", ids, "plan"),
				conflictClass: "PLAN_VERSUS_FACT",
				outcome: "INCLUDE_BOTH_WITH_QUALIFICATION",
				detector: "plan_versus_fact",
				claimIds: ids,
				winnerClaimId: null,
				// Neither is demoted. A plan and an observation about the same subject are both true
				// statements of different kinds; the reader needs to know which is which, not to lose one.
				supersededClaimIds: [],
				unresolved: true,
				similarity: pair.similarity,
				authorityGap: null,
				chainDepth: null,
				rationale: `${short(planClaim.claimId)} is a PLAN and ${short(factClaim.claimId)} is a ${factClaim.claimType} about the same subject (jaccard₃ ${pair.shingleSimilarity.toFixed(3)} / jaccard₁ ${pair.tokenSimilarity.toFixed(3)}); an intention and an observation are not interchangeable and a briefing that presented the plan as the state of the world would be wrong`,
				qualification: `One of these is an intention and the other is what was observed; they are shown together so the plan is not read as the outcome.`,
				detectedAt: now,
			});
			continue;
		}

		// A near-duplicate that no predicate explains is not a conflict. It is redundancy, and
		// `select.ts`'s λ·jaccard₃ penalty is what handles redundancy. Counted so the taxonomy's
		// coverage is measurable rather than assumed.
		pairsUnexplained += 1;
	}

	/* --- 6: temporal validity (Phase 2) --------------------------------------------------------- */
	//
	// A claim whose `effectiveAt` is in the future is maximally *fresh* and not yet *true*. Design §9
	// clamps age at 0, so freshness cannot express this and would in fact reward it. There is no class
	// in spec §14's closed ten for "a validity-window state", so it takes `UNRESOLVED`, which design
	// §11 defines as the bucket for anything detected and not classifiable into the other nine.
	for (const claim of [...claims].sort((a, b) => (a.claimId < b.claimId ? -1 : 1))) {
		const provenance = graph.byClaim.get(claim.claimId);
		if (provenance === undefined) continue;
		if (provenance.temporal.status !== "not_yet_effective") continue;
		if (explained.has(claim.claimId)) continue;
		record({
			conflictId: conflictIdFor("temporal_validity", [claim.claimId], "not_yet_effective"),
			conflictClass: "UNRESOLVED",
			outcome: "REQUEST_VERIFICATION",
			detector: "temporal_validity",
			claimIds: [claim.claimId],
			winnerClaimId: null,
			supersededClaimIds: [claim.claimId],
			unresolved: true,
			similarity: null,
			authorityGap: null,
			chainDepth: null,
			rationale: `${short(claim.claimId)} does not take effect until ${isoDay(claim.effectiveAt)}; it is temporally valid in the future and is not a statement about the present, which freshness alone cannot express because a future effectiveAt clamps to age 0`,
			qualification: `Not yet in force: this takes effect on ${isoDay(claim.effectiveAt)}. It is shown because it is scheduled, not because it is true now.`,
			detectedAt: now,
		});
	}

	/* --- 7: DISPUTED lifecycle ------------------------------------------------------------------ */
	//
	// Design §12: DISPUTED is retrievable but "admitted only into `conflicts[]`, never
	// `confirmed_facts[]`". Without a record here it would be admitted and then have nowhere to go.
	for (const claim of [...claims].sort((a, b) => (a.claimId < b.claimId ? -1 : 1))) {
		if (claim.lifecycle !== "DISPUTED") continue;
		if (explained.has(claim.claimId)) continue;
		record({
			conflictId: conflictIdFor("disputed_lifecycle", [claim.claimId], "lifecycle"),
			conflictClass: "UNRESOLVED",
			outcome: "MARK_DISPUTED",
			detector: "disputed_lifecycle",
			claimIds: [claim.claimId],
			winnerClaimId: null,
			supersededClaimIds: [claim.claimId],
			unresolved: true,
			similarity: null,
			authorityGap: null,
			chainDepth: null,
			rationale: "the source marked this claim DISPUTED; design §12 admits DISPUTED into conflicts[] and nowhere else, and no counterpart was retrieved to weigh it against",
			qualification: "The source marked this statement disputed. It is shown for context and must not be treated as an established fact.",
			detectedAt: now,
		});
	}

	/* --- assembly ------------------------------------------------------------------------------- */
	const index = new Map<string, ConflictRecord[]>();
	const mandatory = new Set<string>();
	for (const entry of conflicts) {
		for (const claimId of entry.claimIds) {
			if (!byClaimId.has(claimId)) continue;
			const bucket = index.get(claimId);
			if (bucket === undefined) index.set(claimId, [entry]);
			else bucket.push(entry);
			if (entry.unresolved) mandatory.add(claimId);
		}
	}
	for (const claimId of demoted.keys()) if (byClaimId.has(claimId)) mandatory.add(claimId);

	const byClass = Object.fromEntries(CONFLICT_CLASSES.map((entry) => [entry, 0])) as Record<ConflictClass, number>;
	const byOutcome = Object.fromEntries(CONFLICT_OUTCOMES.map((entry) => [entry, 0])) as Record<ConflictOutcome, number>;
	const byDetector = Object.fromEntries(CONFLICT_DETECTORS.map((entry) => [entry, 0])) as Record<ConflictDetectorId, number>;
	for (const entry of conflicts) {
		byClass[entry.conflictClass] += 1;
		byOutcome[entry.outcome] += 1;
		byDetector[entry.detector] += 1;
	}

	return {
		conflicts,
		byClaimId: index,
		demoted,
		mandatory,
		// Empty here, always. `detectConflicts` does not know who is reading, and presentation is a
		// property of the reader. `applyConflictPresentation` fills it.
		presented: new Set<string>(),
		graph,
		stats: {
			claimsIn: claims.length,
			conflicts: conflicts.length,
			byClass,
			byOutcome,
			byDetector,
			demoted: demoted.size,
			danglingReferences,
			unresolved: conflicts.filter((entry) => entry.unresolved).length,
			pairsExamined: graph.neighbours.length,
			pairsUnexplained,
			ungroundedSummaries: graph.stats.byGrounding.session_absent,
		},
	};
}

function qualifierRecord(detector: ConflictDetectorId, conflictClass: ConflictClass, ids: string[], similarity: number, left: string[], right: string[], kind: string, now: number): ConflictRecord {
	return {
		conflictId: conflictIdFor(detector, ids, kind),
		conflictClass,
		outcome: "KEEP_SCOPE_SPECIFIC_VARIANTS",
		detector,
		claimIds: ids,
		winnerClaimId: null,
		// Neither side loses. Design §2 made branch and environment *qualifiers*: two statements about
		// two branches are both true, and demoting either would erase a distinction the reader needs.
		supersededClaimIds: [],
		unresolved: false,
		similarity,
		authorityGap: null,
		chainDepth: null,
		rationale: `two near-identical statements (similarity ${similarity.toFixed(3)}) carry disjoint ${kind} qualifiers — ${left.join("/")} versus ${right.join("/")} — so they describe different ${kind}es rather than disagreeing about one`,
		qualification: `These describe different ${kind}es (${left.join("/")} and ${right.join("/")}); both are kept and neither generalizes to the other.`,
		detectedAt: now,
	};
}

/** The qualification sentences attached to one claim, in record order. Empty when it is unconflicted. */
export function qualificationsFor(resolution: ConflictResolution, claimId: string): string[] {
	return (resolution.byClaimId.get(claimId) ?? []).map((entry) => entry.qualification);
}

/* ------------------------------------------------------------------------------------------------
 * Presentation (Phase 4)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Re-presents resolved conflicts as `INCLUDE_BOTH_WITH_QUALIFICATION` for a seat that asked for the
 * disagreement rather than for Mnemosia's answer to it (`agents.ts`: Elaria and Nytheria).
 *
 * **What it does not do, and why.** It does not promote a demoted claim back into a factual section.
 * Design §16 gates stale inclusion at **0** — a superseded or expired claim may appear only inside
 * `conflicts[]` — and that gate is not a presentation preference any seat can opt out of. So the
 * move is the other direction: the *winner* joins the loser inside `conflicts[]`, both carrying the
 * record's qualification, and neither is offered to the reader as settled fact. That is spec §14's
 * `INCLUDE_BOTH_WITH_QUALIFICATION` read exactly — include both, qualified — rather than
 * "un-supersede the loser", which §14 has no outcome for and §16 forbids.
 *
 * The cost is real and is not hidden: a validator who takes this option gives up the factual section
 * those winners would have occupied, and gets a conflicts block that shows the disagreement. That is
 * the trade Elaria's role wants and Raskreia's does not, which is why the two share a ranking policy
 * and differ here.
 *
 * Escalated conflicts are **not** re-presented: an `ESCALATE_TO_*` record is already unresolved by
 * construction, both sides are already in `conflicts[]`, and rewriting its outcome would erase the
 * routing label `escalation.ts` just applied.
 */
export function applyConflictPresentation(resolution: ConflictResolution, presentation: "resolved" | "both_with_qualification"): ConflictResolution {
	if (presentation === "resolved") return resolution;

	const presented = new Set<string>();
	const byOutcome = { ...resolution.stats.byOutcome };
	const conflicts = resolution.conflicts.map((record) => {
		// Only a conflict that *picked a side* has an answer to withhold. An unresolved or escalated
		// record already shows both sides, and `KEEP_SCOPE_SPECIFIC_VARIANTS` already says both are
		// correct where they were recorded — restating either as a qualified inclusion would replace a
		// precise outcome with a vaguer one and lose information rather than add it.
		if (record.unresolved || record.winnerClaimId === null) return record;
		if (record.outcome === "ESCALATE_TO_ELARIA" || record.outcome === "ESCALATE_TO_RASKREIA") return record;
		if (record.outcome === "INCLUDE_BOTH_WITH_QUALIFICATION" || record.outcome === "KEEP_SCOPE_SPECIFIC_VARIANTS") return record;

		presented.add(record.winnerClaimId);
		byOutcome[record.outcome] -= 1;
		byOutcome.INCLUDE_BOTH_WITH_QUALIFICATION += 1;
		return {
			...record,
			outcome: "INCLUDE_BOTH_WITH_QUALIFICATION" as ConflictOutcome,
			qualification: `${record.qualification} Both sides are shown because this seat receives disagreements rather than resolutions; Mnemosia's own reading was ${record.outcome}.`,
		};
	});

	if (presented.size === 0) return resolution;

	const mandatory = new Set(resolution.mandatory);
	// A claim moved into `conflicts[]` has to be *reserved* into it as well. Without this it competes
	// for the 5%–25% conflicts share on marginal value alone, and the winner of a supersession — which
	// by construction scored high enough to win — could be cut by quota, leaving the reader a demoted
	// loser with no visible counterpart. That is strictly worse than not re-presenting at all.
	for (const claimId of presented) mandatory.add(claimId);

	const byClaimId = new Map<string, ConflictRecord[]>();
	for (const record of conflicts) {
		for (const claimId of record.claimIds) {
			const list = byClaimId.get(claimId);
			if (list === undefined) byClaimId.set(claimId, [record]);
			else list.push(record);
		}
	}
	const byId = new Map(conflicts.map((record) => [record.conflictId, record]));
	const demoted = new Map<string, ConflictRecord>();
	for (const [claimId, record] of resolution.demoted) demoted.set(claimId, byId.get(record.conflictId) ?? record);

	return { ...resolution, conflicts, byClaimId, demoted, mandatory, presented, stats: { ...resolution.stats, byOutcome } };
}

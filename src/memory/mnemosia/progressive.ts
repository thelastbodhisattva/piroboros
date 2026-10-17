// Ported from mnemosia/progressive.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Phase C — progressive retrieval with bounded multi-round evaluation.
 *
 * Phase B derives knowledge requirements but never spends a second query on them; this module
 * consumes them. The shape is deliberately small: run the standard single-pass pipeline, ask what it
 * failed to cover, and — only while a bounded policy says it is worth it — re-run with gap terms
 * derived from the uncovered requirements, merging what comes back into what is already held.
 *
 * **Every number here is a deterministic approximation, and says so.** `estimateInformationGain` is
 * not information theory: it is shingle-overlap penalty plus token novelty, the same similarity
 * vocabulary `select.ts` already uses, so a round that re-retrieves what earlier rounds already hold
 * scores zero and stops the loop. Nothing here calls a model, reads a clock of its own, or mutates a
 * store — given identical orchestration results, every function returns an identical value, which is
 * what lets `runProgressiveRetrieval` sit inside the §16 determinism gate rather than beside it.
 *
 * **The loop is bounded by policy, not by hope.** It stops on the first of: sufficient evidence,
 * no additional information gain, budget exhausted in selection, a deadline gap reported by the
 * underlying run, a source returning nothing new, an authorization or clarification early exit — or
 * simply running out of rounds. A maxRounds cap reached without any named reason fires is recorded
 * as a stop with no reason at all rather than dressed up as one of the seven: "the caller's bound"
 * is honest, and inventing a diagnosis would not be.
 */

import type { Briefing } from "./brief.ts";
import type { ConflictResolution } from "./conflicts.ts";
import { normalizeClaimText } from "./claims.ts";
import type { KnowledgeRequirement } from "./requirements.ts";
import { shingleSet, tokenSet } from "./similarity.ts";
import type { SelectedItem } from "./select.ts";
import type { OrchestrationResult } from "./orchestrator.ts";
import { edgesFrom, type ProvenanceGraph } from "./provenance.ts";

/* ------------------------------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------------------------- */

export const RETRIEVAL_STOP_REASONS = ["SUFFICIENT_EVIDENCE", "SUFFICIENT_WITH_CAVEATS", "NO_ADDITIONAL_INFORMATION_GAIN", "BUDGET_EXHAUSTED", "DEADLINE_REACHED", "SOURCE_EXHAUSTED", "AUTHORIZATION_BLOCKED", "CLARIFICATION_REQUIRED"] as const;
export type RetrievalStopReason = (typeof RETRIEVAL_STOP_REASONS)[number];

export type EvidenceCoverageLevel = "sufficient" | "partial" | "insufficient" | "not_required";
export type EvidenceCoverage = Record<string, EvidenceCoverageLevel>;

export interface EvidenceSufficiencyReport {
	overall_status: "sufficient" | "sufficient_with_caveats" | "insufficient";
	coverage: EvidenceCoverage;
	strongest_evidence: string[];
	contradictions: string[];
	unresolved_gaps: string[];
	risk_of_proceeding: "low" | "medium" | "high";
	recommended_action: string;
	rounds_completed: number;
	total_tokens_spent: number;
}

export interface RetrievalRoundRecord {
	round: number;
	candidatesEvaluated: number;
	newClaims: number;
	infoGainScore: number;
	stopCheck: { shouldStop: boolean; reason?: RetrievalStopReason };
}

export interface ProgressiveRetrievalResult {
	finalBriefing: Briefing;
	sufficiency: EvidenceSufficiencyReport;
	rounds: RetrievalRoundRecord[];
	totalCandidates: number;
}

export interface ProgressiveConfig {
	maxRounds: number;
	budgetPerRoundRatio: number;
}

/* ------------------------------------------------------------------------------------------------
 * Coverage
 * ---------------------------------------------------------------------------------------------- */

/** Words too generic to count as category evidence on their own. */
const CATEGORY_STOP_WORDS = new Set(["the", "and", "for", "with", "evidence", "state"]);

/**
 * The significant words of a requirement category, normalized the way claims are.
 *
 * `"open-work-state"` → `["open", "work", "state"]`; `"discriminating-evidence:h1"` drops both the
 * hypothesis id fragment and the generic head noun. These are the weak-match vocabulary: a selected
 * item sharing one of them *may* be about the requirement, which is worth a `partial`, never a
 * `sufficient`.
 */
function categoryWords(category: string): string[] {
	return normalizeClaimText(category.replace(/:/gu, " "))
		.split(" ")
		.filter((word) => word.length >= 3 && !CATEGORY_STOP_WORDS.has(word));
}

function wordBoundaryPatterns(hints: readonly string[]): RegExp[] {
	// Word-boundary match, not substring: normalized text has punctuation replaced by spaces
	// (claims.ts normalizeClaimText), so `\b` is exact token equality for single-word hints and
	// phrase-with-boundaries for multi-word ones — "stated" must not match the hint "state".
	return hints.map((hint) => new RegExp(`\\b${hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
}

/**
 * Maps each requirement to how well the selected items address it.
 *
 * Three deterministic tiers, in order of strength:
 *
 * - **sufficient** — some item's text contains one of the requirement's own `queryHints`. The hints
 *   are the vocabulary Phase B chose for retrieving against this requirement; finding them in
 *   selected text is the strongest cheap signal that the requirement was addressed.
 * - **partial** — no hint matched, but some item shares a significant category word ("work" for
 *   `open-work-state`). Related material, not clearly the requirement.
 * - **insufficient** — nothing selected even shares vocabulary with it.
 *
 * This is keyword overlap, not semantics; it will under-credit an item that answers a requirement in
 * different words. That bias is the safe direction for a retrieval loop: it may spend one extra
 * round, but it will not declare victory on a mismatch.
 */
export function evaluateCoverage(requirements: readonly KnowledgeRequirement[], selectedItems: readonly SelectedItem[]): EvidenceCoverage {
	const coverage: EvidenceCoverage = {};
	const texts = selectedItems.map((entry) => normalizeClaimText(entry.item.text));
	for (const requirement of requirements) {
		let level: EvidenceCoverageLevel = "insufficient";
		const hints = (requirement.queryHints ?? []).map((hint) => hint.toLowerCase()).filter((hint) => hint.length > 0);
		const hintPatterns = wordBoundaryPatterns(hints);
		for (const text of texts) {
			if (hintPatterns.some((pattern) => pattern.test(text))) {
				level = "sufficient";
				break;
			}
		}
		if (level === "insufficient") {
			const words = categoryWords(requirement.category);
			for (const text of texts) {
				if (words.some((word) => text.split(" ").includes(word))) {
					level = "partial";
					break;
				}
			}
		}
		coverage[requirement.category] = level;
	}
	return coverage;
}

/* ------------------------------------------------------------------------------------------------
 * Information gain
 * ---------------------------------------------------------------------------------------------- */

/** Shingle width for gain estimation — the same 3-token window selection's redundancy penalty uses. */
export const INFO_GAIN_SHINGLE_SIZE = 3;

/** Weight of shingle novelty vs single-token novelty in the blended score. */
const SHINGLE_WEIGHT = 0.7;

/**
 * A deterministic *approximation* of the information `newText` adds beyond `existingTexts`, in [0, 1].
 *
 * Not information theory, and not claimed to be: true gain needs a semantic model of what the reader
 * already knows. What is computable cheaply and deterministically is lexical novelty:
 *
 * ```
 * gain ≈ 0.7 · |new shingles − seen shingles| / |new shingles|
 *      + 0.3 · |new tokens − seen tokens| / |new tokens|
 * ```
 *
 * over the same normalized text and 3-token shingles selection uses. The blend exists because
 * shingles alone under-credit genuinely new sentences built from known vocabulary (a new fact about
 * a familiar subject), while tokens alone over-credit paraphrase; the weighting is fixed here so a
 * change is a diff to two constants rather than to a formula. Text fully contained in the existing
 * set scores exactly 0 — which is the property the stop policy depends on. Empty input scores 0.
 */
export function estimateInformationGain(newText: string, existingTexts: readonly string[]): number {
	const normalizedNew = normalizeClaimText(newText);
	const newShingles = shingleSet(normalizedNew, INFO_GAIN_SHINGLE_SIZE);
	const newTokens = tokenSet(normalizedNew);
	if (newShingles.size === 0 && newTokens.size === 0) return 0;

	const seenShingles = new Set<string>();
	const seenTokens = new Set<string>();
	for (const existing of existingTexts) {
		const normalized = normalizeClaimText(existing);
		for (const shingle of shingleSet(normalized, INFO_GAIN_SHINGLE_SIZE)) seenShingles.add(shingle);
		for (const token of tokenSet(normalized)) seenTokens.add(token);
	}

	let novelShingles = 0;
	for (const shingle of newShingles) if (!seenShingles.has(shingle)) novelShingles += 1;
	let novelTokens = 0;
	for (const token of newTokens) if (!seenTokens.has(token)) novelTokens += 1;

	const shingleNovelty = newShingles.size === 0 ? 0 : novelShingles / newShingles.size;
	const tokenNovelty = newTokens.size === 0 ? 0 : novelTokens / newTokens.size;
	return Math.min(1, Math.max(0, SHINGLE_WEIGHT * shingleNovelty + (1 - SHINGLE_WEIGHT) * tokenNovelty));
}

/* ------------------------------------------------------------------------------------------------
 * Sufficiency
 * ---------------------------------------------------------------------------------------------- */

const STATUS_RANK: Record<EvidenceSufficiencyReport["overall_status"], number> = { insufficient: 0, sufficient_with_caveats: 1, sufficient: 2 };

/**
 * Turns coverage plus the run's conflicts into a sufficiency verdict.
 *
 * - all requirements `sufficient` → `sufficient`;
 * - any **high-priority** requirement `insufficient` → `insufficient` (risk high);
 * - otherwise → `sufficient_with_caveats` (partials remain, low-priority holes remain, or unresolved
 *   conflicts stand), risk medium.
 *
 * With no requirements there is nothing to be insufficient about: the report reads `sufficient`,
 * because a task that derived no knowledge requirements cannot fail coverage.
 */
export function evaluateSufficiency(requirements: readonly KnowledgeRequirement[], selectedItems: readonly SelectedItem[], conflicts: ConflictResolution | null): EvidenceSufficiencyReport {
	const coverage = evaluateCoverage(requirements, selectedItems);

	const strongest: string[] = [];
	const gaps: string[] = [];
	let anyPartial = false;
	let highInsufficient = false;
	for (const requirement of requirements) {
		const level = coverage[requirement.category] ?? "not_required";
		if (level === "sufficient") continue;
		gaps.push(requirement.requirementId);
		if (level === "partial") anyPartial = true;
		if (level === "insufficient" && requirement.priority === "high") highInsufficient = true;
	}
	// Strongest evidence: the claim ids behind items that carried a strong (hint) match, deduplicated
	// and sorted so the report serializes identically across runs (§16). Word-boundary matching, same
	// as evaluateCoverage — a coincidental substring ("state" inside "stated") must not credit evidence.
	const hintSet = new Set(requirements.flatMap((requirement) => (requirement.queryHints ?? []).map((hint) => hint.toLowerCase())));
	const patterns = wordBoundaryPatterns([...hintSet]);
	for (const item of selectedItems) {
		const text = normalizeClaimText(item.item.text);
		if (patterns.some((pattern) => pattern.test(text))) strongest.push(...item.item.claimIds);
	}
	strongest.sort();

	const contradictionIds = new Set<string>();
	if (conflicts !== null) {
		for (const record of conflicts.conflicts) if (record.unresolved) for (const claimId of record.claimIds) contradictionIds.add(claimId);
	}
	const contradictions = [...contradictionIds].sort();

	const overall_status: EvidenceSufficiencyReport["overall_status"] = requirements.length === 0 || gaps.length === 0 ? "sufficient" : highInsufficient ? "insufficient" : "sufficient_with_caveats";
	const caveats = anyPartial || contradictions.length > 0;
	const risk_of_proceeding: EvidenceSufficiencyReport["risk_of_proceeding"] = highInsufficient ? "high" : caveats || overall_status === "sufficient_with_caveats" ? "medium" : "low";

	let recommended_action: string;
	if (overall_status === "sufficient") recommended_action = "proceed: every derived knowledge requirement is covered by the selected context";
	else if (highInsufficient) recommended_action = `stop or clarify first: ${gaps.length} requirement(s) uncovered including high-priority ones (${gaps.join(", ")})`;
	else recommended_action = caveats ? `proceed with care: ${gaps.length} requirement(s) partially covered (${gaps.join(", ")})${contradictions.length > 0 ? ` and ${contradictions.length} unresolved conflict participant(s)` : ""}` : `consider another retrieval round for ${gaps.length} low-priority gap(s)`;

	return {
		overall_status,
		coverage,
		strongest_evidence: strongest,
		contradictions,
		unresolved_gaps: gaps.sort(),
		risk_of_proceeding,
		recommended_action,
		// Filled by the caller that knows how many rounds ran and what they cost; a bare evaluation
		// has neither number to report.
		rounds_completed: 0,
		total_tokens_spent: 0,
	};
}

/* ------------------------------------------------------------------------------------------------
 * Gap terms
 * ---------------------------------------------------------------------------------------------- */

/**
 * Query terms for the next round, derived from whatever coverage still lacks.
 *
 * **Why OR groups and not a flat AND-conjunction.** The original derivation returned at most four
 * terms that `plan.ts` would have ANDed inside a narrow query — under FTS5's default operator every
 * extra term is a hard filter, so a fourth term the corpus does not contain zeroes the result set
 * and the round structurally cannot find anything new. The fix is disjunction, in two places:
 *
 * 1. **OR groups of at most two terms** (`MAX_TERMS_PER_GAP_GROUP`). One group per uncovered
 *    requirement, pairing its own targeted `queryHints` with its category words — the two halves of
 *    one requirement's vocabulary, either of which matching is evidence about that requirement.
 *    Today every group lands flattened into the curated any-match set (already disjunctive), so the
 *    grouping is documentation plus a seam; when spec Stage 4's source sequencing arrives, each
 *    group maps onto one query against the requirement's own `sourcePreference` without changing
 *    this function's contract.
 * 2. **Corpus-vocabulary expansion** (`corpusTexts`). Hints are what Phase B guessed; the words the
 *    corpus actually uses are better recall material. Any sentence of an already-retrieved claim
 *    that contains one of an uncovered requirement's category words contributes its other
 *    significant tokens as related terms — co-occurrence is the cheapest deterministic proxy for
 *    relatedness, drawn from text this run has already paid to read.
 *
 * Bounded: at most `MAX_GAP_GROUPS` groups. Broader-match fallback is structural rather than coded:
 * single-term groups are already the broadest match available short of `plan.ts`'s rejected
 * unbounded recency scan, and a round whose narrow query returns empty still leaves the next
 * group's terms free to match alone inside the any-match set.
 */
export const MAX_TERMS_PER_GAP_GROUP = 2;
export const MAX_GAP_GROUPS = 4;

export function deriveGapTerms(requirements: readonly KnowledgeRequirement[], coverage: EvidenceCoverage, corpusTexts: readonly string[] = []): string[][] {
	const groups: string[][] = [];
	const seen = new Set<string>();
	const addTerm = (term: string): boolean => {
		const normalized = term.trim().toLowerCase();
		if (normalized.length < 3 || seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	};

	// 1. Direct vocabulary: hints first, then category words, grouped per uncovered requirement.
	const uncoveredWords = new Set<string>();
	for (const requirement of requirements) {
		if (groups.length >= MAX_GAP_GROUPS) break;
		if ((coverage[requirement.category] ?? "not_required") === "sufficient") continue;
		const words = categoryWords(requirement.category);
		for (const word of words) uncoveredWords.add(word);
		for (const hint of requirement.queryHints ?? []) if (hint.trim().toLowerCase().length >= 4) uncoveredWords.add(hint.trim().toLowerCase());
		const group: string[] = [];
		for (const term of [...(requirement.queryHints ?? []), ...words]) {
			if (group.length >= MAX_TERMS_PER_GAP_GROUP) break;
			if (addTerm(term)) group.push(term.trim().toLowerCase());
		}
		if (group.length > 0) groups.push(group);
	}

	// 2. Related terms from the corpus's own vocabulary: sentences that talk about an uncovered
	//    requirement contribute their other significant words as single-term (broadest) groups.
	//    Sentence qualification uses prefix matching in either direction so "failure" catches
	//    "failures" and vice versa — exact-token equality would miss morphological variants of the
	//    very vocabulary the requirement is phrased in.
	if (groups.length < MAX_GAP_GROUPS && uncoveredWords.size > 0) {
		const relates = (word: string) => [...uncoveredWords].some((mine) => word.startsWith(mine) || mine.startsWith(word));
		for (const text of corpusTexts) {
			if (groups.length >= MAX_GAP_GROUPS) break;
			for (const sentence of normalizeClaimText(text).split(/[.;\n]/)) {
				if (groups.length >= MAX_GAP_GROUPS) break;
				const words = sentence.split(" ").filter((word) => word.length >= 4);
				if (!words.some(relates)) continue;
				for (const word of words) {
					if (groups.length >= MAX_GAP_GROUPS) break;
					if (relates(word)) continue;
					// One related word per group: it stands alone, so a miss costs nothing.
					if (addTerm(word)) groups.push([word]);
				}
			}
		}
	}
	return groups;
}

/* ------------------------------------------------------------------------------------------------
 * Phase D — bounded graph traversal between rounds
 * ---------------------------------------------------------------------------------------------- */

/**
 * The relations a between-round walk may follow. `SUPERSEDES` is deliberately absent: a retired claim
 * is by definition not fresh evidence, and walking into it would re-retrieve exactly what the corpus
 * already moved past.
 */
export const TRAVERSAL_RELATIONS = ["SUPPORTS", "CONTRADICTS", "QUALIFIES", "TEMPORAL_BOUND"] as const;
const TRAVERSAL_RELATION_SET: ReadonlySet<string> = new Set<string>(TRAVERSAL_RELATIONS);

/** How many of the previous round's selected claims may act as traversal seeds, at most. */
export const TRAVERSAL_SEED_CAP = 8;

/** Grounding states whose targets must not be treated as evidence (`provenance.ts`'s own vocabulary). */
const UNGROUNDED_STATES: ReadonlySet<string> = new Set<string>(["refs_absent", "session_absent", "refs_unresolved", "integrity_failed"]);

/**
 * One-hop walk over the provenance graph from the round's selected claims.
 *
 * Seeds are the selection items ordered by utility descending then itemId ascending — the same total
 * order selection itself tie-breaks with — capped at `TRAVERSAL_SEED_CAP`. From each seed's claims,
 * every edge whose relation is in `TRAVERSAL_RELATIONS` and whose target is a *claim* contributes
 * that target once; artifact targets are terminal (a document is not a term source) and ungrounded
 * targets are skipped, because an unreachable summary is not evidence a next round can build on.
 * Targets already seen in earlier rounds are dropped, so the walk can only ever propose new material.
 * Deterministic throughout: same graph, same selection, same seen set → same list.
 */
export function collectTraversalTargets(graph: ProvenanceGraph | null | undefined, selectedItems: readonly SelectedItem[], seenClaimIds: ReadonlySet<string>): string[] {
	if (graph === null || graph === undefined || !Array.isArray((graph as Partial<ProvenanceGraph>).edges)) return [];
	const seeds = [...selectedItems]
		.sort((a, b) => b.candidate.score.utility - a.candidate.score.utility || (a.item.itemId < b.item.itemId ? -1 : a.item.itemId > b.item.itemId ? 1 : 0))
		.slice(0, TRAVERSAL_SEED_CAP);
	const collected = new Set<string>(seenClaimIds);
	const targets: string[] = [];
	for (const seed of seeds) {
		for (const claimId of seed.item.claimIds) {
			for (const edge of edgesFrom(graph, claimId)) {
				if (!TRAVERSAL_RELATION_SET.has(edge.relation)) continue; // SUPERSEDES excluded as stale
				if (edge.toKind !== "claim") continue; // artifact targets are terminal
				if (collected.has(edge.to)) continue;
				const grounding = graph.byClaim.get(edge.to)?.grounding;
				if (grounding === undefined || UNGROUNDED_STATES.has(grounding)) continue;
				collected.add(edge.to);
				targets.push(edge.to);
			}
		}
	}
	return targets;
}

/**
 * Traversal vocabulary for the next round's curated any-match set: significant words (normalized,
 * length ≥ 4, the same floor deriveGapTerms' related-term pass uses) of each grounded target claim,
 * in target order, deduplicated case-insensitively against the derived gap terms and against each
 * other. Empty on a zero-edge corpus, so a run that cannot traverse is byte-identical to one that
 * never heard of traversal.
 */
export function termsFromTargets(targets: readonly string[], textsByClaimId: ReadonlyMap<string, string>, priorTerms: readonly string[] = []): string[] {
	const seen = new Set(priorTerms.map((term) => term.trim().toLowerCase()));
	const terms: string[] = [];
	for (const target of targets) {
		const text = textsByClaimId.get(target);
		if (text === undefined) continue;
		for (const word of normalizeClaimText(text).split(" ")) {
			if (word.length < 4 || seen.has(word)) continue;
			seen.add(word);
			terms.push(word);
		}
	}
	return terms;
}

/* ------------------------------------------------------------------------------------------------
 * The bounded loop
 * ---------------------------------------------------------------------------------------------- */

/** Below this estimated gain a further round is judged unable to add anything worth its budget. */
export const INFO_GAIN_FLOOR = 0.02;

/**
 * Picks the round whose result becomes the final answer.
 *
 * Later rounds do not automatically win: a second round that came back *worse* (fewer sources, a
 * deadline gap) must not overwrite a delivered briefing from the first. The rule is: prefer
 * delivered results; among them prefer the better sufficiency status; ties go to the latest round,
 * since a later equal-status round saw strictly more of the corpus. Undelivered runs are eligible
 * only when nothing was ever delivered — the caller still gets the best shell available, with its
 * gaps intact.
 */
export function selectFinalRound(results: readonly OrchestrationResult[], statuses: readonly EvidenceSufficiencyReport["overall_status"][]): OrchestrationResult {
	let bestRank = -1;
	let index = -1;
	for (let i = 0; i < results.length; i += 1) {
		if (!results[i].delivered) continue;
		const rank = STATUS_RANK[statuses[i] ?? "insufficient"];
		if (rank >= bestRank) {
			bestRank = rank;
			index = i;
		}
	}
	// Nothing was ever delivered: the last shell, gaps intact, is still more useful than a throw.
	return results[index >= 0 ? index : results.length - 1];
}

/**
 * Runs bounded multi-round retrieval.
 *
 * Round 0 calls `orchestrateFn(0)` — the standard single pass, unchanged. Each subsequent round
 * passes the previous round's gap terms **and** its Phase D traversal terms (see
 * `collectTraversalTargets` and `termsFromTargets`: one hop through the provenance graph from the round's selected claims,
 * never after a stop decision — the traversal is computed only where the loop continues). Selection
 * items and candidate claims are merged across rounds, deduplicated by item id and claim id respectively, and sufficiency is evaluated against
 * the *cumulative* merge: a later round is credited for the whole picture, not just its own slice.
 *
 * Stop order per round (first match wins):
 *
 * 1. `CLARIFICATION_REQUIRED` / `AUTHORIZATION_BLOCKED` — the run ended before evidence could help;
 * 2. `SUFFICIENT_EVIDENCE` — cumulative coverage is sufficient;
 * 3. `SUFFICIENT_WITH_CAVEATS` — only low-priority gaps, partials, or unresolved conflicts remain
 *    (locked selective doctrine: escalation is reserved for a report whose **required** evidence is
 *    missing, i.e. `insufficient`; caveated coverage never earns another round);
 * 4. `DEADLINE_REACHED` — the underlying run reported a deadline gap;
 * 5. `NO_ADDITIONAL_INFORMATION_GAIN` — estimated gain ≤ `INFO_GAIN_FLOOR`;
 * 6. `SOURCE_EXHAUSTED` — a repeat round retrieved zero new claims;
 * 7. `BUDGET_EXHAUSTED` — selection stopped on budget with coverage still lacking;
 * 8. the round bound — loop ends, final record carries no reason.
 *
 * The loop decides on the cumulative merge but **reports on the delivery**: the returned
 * `sufficiency` is re-evaluated against the selected round's own selection items, because the
 * briefing a consumer receives is a single-round artifact and its report must not certify evidence
 * the merge held and the delivery dropped.
 */
export function runProgressiveRetrieval(orchestrateFn: (round: number, gapTerms?: string[], traversalTerms?: string[]) => OrchestrationResult, requirements: readonly KnowledgeRequirement[], config: ProgressiveConfig): ProgressiveRetrievalResult {
	const maxRounds = Math.max(1, Math.floor(config.maxRounds));
	const rounds: RetrievalRoundRecord[] = [];
	const results: OrchestrationResult[] = [];
	const statuses: EvidenceSufficiencyReport["overall_status"][] = [];

	const mergedItems = new Map<string, SelectedItem>();
	const seenClaims = new Map<string, string>(); // claimId → text, the corpus info gain is measured against
	let totalCandidates = 0;
	let totalTokensSpent = 0;
	let bestIndex = -1;
	let bestStatusRank = -1;
	let pendingGapTerms: string[][] | undefined;
	let pendingTraversalTerms: string[] = [];
	// Claim ids previous walks already proposed as targets. A same-round graph neighbour is by
	// construction already in the retrieval corpus (`seenClaims`), so deduping targets against that
	// would kill every hop; what must not repeat is re-proposing the same neighbour on later walks.
	const traversedTargets = new Set<string>();

	for (let round = 0; round < maxRounds; round += 1) {
		const result = orchestrateFn(round, round === 0 ? undefined : (pendingGapTerms ?? []).flat(), round === 0 ? undefined : pendingTraversalTerms);
		results.push(result);
		totalCandidates += result.candidates.length;
		totalTokensSpent += result.selection?.budget.used ?? 0;

		// Merge, dedup by id. Insertion-ordered maps keep the merge deterministic.
		for (const entry of result.selection?.items ?? []) if (!mergedItems.has(entry.item.itemId)) mergedItems.set(entry.item.itemId, entry);
		let newClaims = 0;
		const priorTexts = [...seenClaims.values()];
		const newTexts: string[] = [];
		for (const claim of result.candidates.map((candidate) => candidate.claim)) {
			if (seenClaims.has(claim.claimId)) continue;
			seenClaims.set(claim.claimId, claim.text);
			newClaims += 1;
			newTexts.push(claim.text);
		}

		const cumulativeItems = [...mergedItems.values()];
		const sufficiency = evaluateSufficiency(requirements, cumulativeItems, result.conflicts);
		statuses.push(sufficiency.overall_status);
		if (sufficiency.overall_status !== "insufficient") {
			const rank = STATUS_RANK[sufficiency.overall_status];
			if (result.delivered && rank >= bestStatusRank) {
				bestStatusRank = rank;
				bestIndex = results.length - 1;
			}
		}

		/* --- stop policy ---------------------------------------------------------------------------- */
		const roundInfoGain = round === 0 ? 1 : estimateInformationGain(newTexts.join("\n"), priorTexts);
		let shouldStop = true;
		let reason: RetrievalStopReason | undefined;
		if (result.outcome === "CLARIFICATION_REQUIRED") reason = "CLARIFICATION_REQUIRED";
		else if (result.outcome === "INSUFFICIENT_AUTHORIZATION") reason = "AUTHORIZATION_BLOCKED";
		else if (sufficiency.overall_status === "sufficient") reason = "SUFFICIENT_EVIDENCE";
		// Locked selective policy (decision 9db78664): escalate only on missing required evidence.
		// `sufficient_with_caveats` means every high-priority requirement is covered (only low-priority
		// gaps/partials/conflicts remain), so the loop stops here instead of buying another round.
		else if (sufficiency.overall_status === "sufficient_with_caveats") reason = "SUFFICIENT_WITH_CAVEATS";
		else if (result.gaps.some((gap) => gap.reason === "deadline")) reason = "DEADLINE_REACHED";
		else if (round > 0 && roundInfoGain <= INFO_GAIN_FLOOR) reason = "NO_ADDITIONAL_INFORMATION_GAIN";
		else if (round > 0 && newClaims === 0) reason = "SOURCE_EXHAUSTED";
		else if (result.selection?.stats.stopReason === "budget") reason = "BUDGET_EXHAUSTED";
		else if (round + 1 >= maxRounds) reason = undefined; // the caller's round bound, honestly unnamed
		else shouldStop = false;

		rounds.push({ round, candidatesEvaluated: result.candidates.length, newClaims, infoGainScore: Number(roundInfoGain.toFixed(6)), stopCheck: { shouldStop, ...(reason === undefined ? {} : { reason }) } });
		if (shouldStop) break;

		// Gap terms are OR groups; the consumer here is the curated any-match set, which is already a
		// disjunction, so flattening preserves the semantics while keeping the orchestrateFn boundary
		// a plain term list (see deriveGapTerms for why the grouping exists).
		pendingGapTerms = deriveGapTerms(requirements, sufficiency.coverage, [...seenClaims.values()]);
		// Phase D: one bounded hop through the round's own provenance graph, computed only because the
		// loop is continuing — a stopped run (early exit, sufficiency, budget, deadline, the round bound)
		// never traverses. Derived terms keep priority; these only fill what they leave open.
		const targets = collectTraversalTargets(result.graph ?? null, result.selection?.items ?? [], traversedTargets);
		pendingTraversalTerms = termsFromTargets(targets, seenClaims, pendingGapTerms.flat());
		for (const target of targets) traversedTargets.add(target);
	}

	const finalResult = bestIndex >= 0 ? results[bestIndex] : selectFinalRound(results, statuses);
	if (finalResult?.briefing == null) throw new Error("progressive retrieval produced no briefing in any round; nothing to return");
	// **The report describes what was delivered, not what was merged.** The loop's stop policy runs on
	// the cumulative merge (a later round is credited for the whole picture while deciding whether to
	// continue), but the caller receives a single round's briefing — and reporting cumulative
	// coverage against a one-round artifact would certify evidence the reader does not hold. So the
	// returned report re-evaluates coverage against exactly the items the selected round selected,
	// with that round's conflicts; only the run-level totals (rounds, tokens) stay cumulative.
	const deliveredItems = finalResult.selection?.items ?? [];
	const deliveredSufficiency = evaluateSufficiency(requirements, deliveredItems, finalResult.conflicts);
	const sufficiency: EvidenceSufficiencyReport = { ...deliveredSufficiency, rounds_completed: rounds.length, total_tokens_spent: totalTokensSpent };
	return { finalBriefing: finalResult.briefing, sufficiency, rounds, totalCandidates };
}

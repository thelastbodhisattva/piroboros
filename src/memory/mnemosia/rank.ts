// Ported from mnemosia/rank.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * The seven signals (design §9, spec §12, build-order step 10).
 *
 * Spec §12's central instruction is negative — "Keep these concepts separate" — and it names seven
 * things that are routinely collapsed into one number: authority, evidence_strength, confidence,
 * integrity, freshness, relevance and utility. This module computes the first six from disjoint
 * inputs and composes the seventh out of them. Nothing here reads a signal it is not computing, so
 * "separate" is a property of the call graph rather than of a comment:
 *
 * | signal          | reads                                              |
 * |-----------------|----------------------------------------------------|
 * | authority       | the source's class, via the policy table            |
 * | evidenceStrength| directness and how many distinct artifacts support  |
 * | confidence      | the claim's own certainty (+ curated importance)    |
 * | integrity       | whether a hash check ran and passed                 |
 * | freshness       | effectiveAt against the claim type's half-life      |
 * | relevance       | the task's terms, entities and scope                |
 * | utility         | **only** the six above, through the policy weights  |
 *
 * **Ranking never sees a hard-filter rejection.** `filters.ts` runs first and returns two disjoint
 * lists; this module is handed the accepted one. That is why there is no threshold here that could
 * readmit a rejected claim, and no code path that could: spec §11's "a candidate rejected by a hard
 * filter must not be restored by a high semantic-relevance score" is enforced by the pipeline's
 * shape, not by a check inside the ranker (see filters.ts's header for the other half of this).
 *
 * **Everything is recorded.** Spec §12: "All signal values and policy weights must be recorded in
 * the orchestration trace." `rankCandidates` therefore emits one `score` event per candidate
 * carrying every signal value, every weight, the resolved `policyId`, and the raw quantities each
 * signal was computed from — because a recorded 0.43 that cannot be re-derived is a number, not an
 * audit trail.
 */

import { resolveAgent } from "./agents.ts";
import { MODE_CONFIGS, RANK_SIGNALS, resolvePolicy, type AuthorityClass, type PolicyResolution, type RankingPolicy, type SignalWeights } from "./policy.ts";
import { buildProvenanceGraph, provenanceOf, type GroundingState, type ProvenanceGraph } from "./provenance.ts";
import type { QualifierHit } from "./qualifiers.ts";
import type { SearchTokenizer, TaskAnalysis } from "./task.ts";
import { temporalValidity, type TemporalValidity } from "./temporal.ts";
import type { TraceWriter } from "./trace.ts";
import { scopeKey, type AdapterChannel, type ConversationOrigin, type AkashicMemoryOrigin, type ArtifactEnvelope, type Claim, type IntegrityStatus, type ScoreVector } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Source classification
 * ---------------------------------------------------------------------------------------------- */

function originOf<T extends { kind: string }>(envelope: ArtifactEnvelope, kind: T["kind"]): T | null {
	for (const entry of envelope.provenance) {
		if (entry !== null && typeof entry === "object" && (entry as { kind?: unknown }).kind === kind) return entry as T;
	}
	return null;
}

/**
 * Envelope → the class design §9's authority table is keyed on.
 *
 * The `conversation_message` branch is the reason this function exists rather than being a map
 * lookup on `sourceType`: user, assistant and tool turns all arrive under that one source type and
 * the design separates them by 0.25 of authority. An event kind the adapter did not
 * recognize falls to `unknown` rather than to the nearest neighbour, matching how claims.ts assigns
 * its certainty (claims.ts:530-540) — the two must agree or a turn would be trusted by one module
 * and doubted by the other.
 */
export function authorityClassOf(envelope: ArtifactEnvelope): AuthorityClass {
	switch (envelope.sourceType) {
		case "curated_memory":
			return "curated_memory";
		case "compaction_summary":
			return "compaction_summary";
		case "tool_output":
			return "tool_output";
		case "conversation_message": {
			const origin = originOf<ConversationOrigin>(envelope, "mnemosia/origin/conversation");
			switch (origin?.eventKind) {
				case "user":
					return "user_message";
				case "assistant":
					return "assistant_message";
				case "tool":
					return "tool_output";
				default:
					return "unknown";
			}
		}
		default:
			return "unknown";
	}
}

/* ------------------------------------------------------------------------------------------------
 * The six input signals
 * ---------------------------------------------------------------------------------------------- */

/**
 * The standing of the best source that carried this claim.
 *
 * `max`, not `min` or a mean. Deduplication unions evidence across artifacts (claims.ts:746), so a
 * sentence that appears in both a curated memory and an assistant turn ends up on one claim; taking
 * the minimum would let the assistant turn *lower* the standing of a human-curated statement, i.e.
 * corroboration would become a penalty. Authority is a claim about the source's right to be
 * believed, and the strongest source that said it is the one that answers that.
 */
export function authoritySignal(classes: readonly AuthorityClass[], policy: RankingPolicy): number {
	let best = 0;
	for (const entry of classes) best = Math.max(best, policy.authority[entry]);
	return best;
}

export interface EvidenceStrengthInput {
	/** 1 direct · 2 via a grounded summary · 3 via a summary whose sources are unreachable. */
	graphDistance: number;
	/** Distinct artifacts carrying a `SUPPORTS` edge. */
	supportingArtifacts: number;
	/** Distinct independent evidence groups (`sourceId | taskScope`) among those artifacts. */
	independentGroups: number;
	/** Claims carrying a `CONTRADICTS` edge to this one. */
	contradictions: number;
}

/**
 * **PHASE 2 — the graph replaces the list.**
 *
 * Phase 1: `min(1, 0.4·direct + 0.2·log2(1+supports))`, ceiling 0.4 when nothing was direct. That
 * formula could ask two questions of a flat evidence array — how many artifacts, was any of them
 * first-hand — and design §9's own note (kept below) recorded that the second question was answered
 * the same way for every summary claim in the corpus, because Phase 1 had no way to tell a summary
 * whose events were reachable from one whose events were nowhere.
 *
 * Phase 2 computes it from `provenance.ts`'s graph:
 *
 * ```
 * raw     = directBase·[distance = 1] + supportCoefficient·log2(1 + supportingArtifacts)
 *         + min(corroborationCap, corroborationBonus·(independentGroups − 1))
 * ceiling = distance 1 → 1.0 · distance 2 → derivedCeiling · distance 3 → ungroundedCeiling
 * value   = clamp(min(raw, ceiling) − contradictionPenalty·contradictions, 0, 1)
 * ```
 *
 * Three properties worth stating because each was a decision:
 *
 * - **Independence, not volume.** `supportingArtifacts` counts distinct artifacts, which stops one
 *   artifact cited three times looking like three witnesses. `independentGroups` counts distinct
 *   `sourceId | taskScope` groups, which stops one *session* cited three times doing the same — the
 *   common case on a corpus of 253 sessions. Only the second term is a corroboration bonus.
 * - **The contradiction penalty applies *after* the ceiling.** This was written the other way round
 *   first and `test/rank.test.ts` caught it: subtracting before the cap means the penalty is
 *   swallowed whenever the uncapped value already exceeds the ceiling, which is the common case for a
 *   summary claim repeated across several artifacts — so a contradicted derived claim and an
 *   uncontradicted one both flattened onto exactly 0.4. The cap is a statement about *derivation*
 *   ("a summary may not outrank its evidence"); the penalty is a statement about *dispute*. They are
 *   different claims and composing them in the wrong order silences one of them.
 * - **It reduces exactly to Phase 1's formula** when `independentGroups ≤ 1`, `contradictions = 0`
 *   and `graphDistance ≤ 2`. That is what keeps design §16's threshold table comparable across the
 *   phase boundary rather than silently re-baselined by a scoring change.
 *
 * Design §9's original sentence — "summaries without reachable raw events cap at 0.4" — is now
 * literally implemented rather than approximated: *with* reachable events is 0.4, *without* is
 * `ungroundedCeiling`.
 */
export function evidenceStrengthSignal(input: EvidenceStrengthInput, policy: RankingPolicy): number {
	const { directBase, supportCoefficient, derivedCeiling, ungroundedCeiling, corroborationBonus, corroborationCap, contradictionPenalty } = policy.evidence;
	const direct = input.graphDistance === 1 ? 1 : 0;
	const corroboration = Math.min(corroborationCap, corroborationBonus * Math.max(0, input.independentGroups - 1));
	const raw = directBase * direct + supportCoefficient * Math.log2(1 + Math.max(0, input.supportingArtifacts)) + corroboration;
	const ceiling = input.graphDistance <= 1 ? 1 : input.graphDistance === 2 ? derivedCeiling : ungroundedCeiling;
	const capped = Math.min(raw, ceiling);
	return Math.max(0, Math.min(1, capped - contradictionPenalty * Math.max(0, input.contradictions)));
}

/**
 * The claim's own certainty, blended with the curator's importance for governed rows.
 *
 * Confidence is deliberately the only signal that reads `certainty`. It is "calibrated certainty in
 * the normalized claim" (spec §12) — a statement about the claim, not about who stored it — so the
 * source's standing stays in `authority` and the hash check stays in `integrity`.
 *
 * See `RankingPolicy.curatedImportanceWeight` for why the design's "× importance/10" is applied as a
 * weighted mean rather than a product; measured against the live vault, the product form ranks a
 * human-curated memory below a model's paraphrase.
 */
export function confidenceSignal(certainty: Claim["certainty"], importance: number | null, policy: RankingPolicy): number {
	const base = policy.certaintyConfidence[certainty];
	if (importance === null) return base;
	const normalized = Math.max(0, Math.min(1, importance / 10));
	const weight = policy.curatedImportanceWeight;
	return (1 - weight) * base + weight * normalized;
}

/**
 * Whether verification ran and passed.
 *
 * `max` over the claim's artifacts, for the same reason as `authority`: a claim standing on one
 * hash-verified curated row and one unverifiable conversation event *has* been verified by the first, and
 * the second cannot un-verify it. `failed` never appears here — filters.ts removed those artifacts,
 * and a claim with no surviving artifact was rejected outright.
 */
export function integritySignal(statuses: readonly IntegrityStatus[], policy: RankingPolicy): number {
	let best = 0;
	for (const status of statuses) best = Math.max(best, policy.integrityScore[status]);
	return best;
}

/** Design §9: `exp(-ln2 · ageDays / halfLife)`. A future `effectiveAt` is clamped to age 0, not -n. */
export function freshnessSignal(ageDays: number, halfLifeDays: number): number {
	if (halfLifeDays <= 0) return 0;
	return Math.exp((-Math.LN2 * Math.max(0, ageDays)) / halfLifeDays);
}

export interface RelevanceParts {
	coverage: number;
	matchedTerms: number;
	queryTerms: number;
	/**
	 * The best raw `bm25()` among the artifacts behind this claim, or `null` when none published one.
	 * Negative; more negative is better. Recorded so a replay can re-derive `rankNormalized`.
	 */
	rankRaw: number | null;
	/** `rankRaw` divided by the best magnitude its own source produced in this run. `[0,1]`, or null. */
	rankNormalized: number | null;
	/** Which of the two produced `base`. `term_coverage` is the deterministic fallback (spec §12). */
	basis: "bm25" | "term_coverage";
	/** `rankNormalized ?? coverage`, before the three bonuses. */
	base: number;
	tag: number;
	entity: number;
	exactScope: number;
	value: number;
}

/**
 * Design §9: relevance + 0.1 tag + 0.1 entity + 0.05 exact-scope, clamped.
 *
 * **PHASE 6 — the base term is FTS5's `bm25()`, with term coverage as the deterministic fallback.**
 * Design §3 pre-registered the foundation ask (*"the DB computes a better relevance signal than term
 * coverage and currently discards it"*), §18 risk 1 put it first in the fallback order and §19 item 5
 * made it an approval item; §16's Phase 1E note deferred it because the cheaper planner fix had
 * already cleared the absolute gate. It is exercised now because the *residual* 0.127 is ranking
 * work: six items over nineteen tasks, all of them reached by a **single common word** shared with
 * the task. That is the one distinction term coverage structurally cannot draw — `matched/|terms|`
 * prices every matched word identically, so a shared `role` and a shared `compaction` are the
 * same evidence to it. bm25 prices a word by its inverse document frequency, which is exactly the
 * missing quantity.
 *
 * Coverage is still computed on every claim and still recorded, for three reasons: it is the
 * fallback spec §12 requires whenever the read published no score (every recency scan); keeping it in the trace lets a replay see both numbers and judge the substitution; and
 * a signal that quietly stopped being computed is a signal nobody can audit.
 *
 * Coverage is measured against `TaskAnalysis.terms` — the **wide** set — and not against the three
 * terms `plan.ts` actually sent to FTS5. plan.ts:15-21 explains the split from the other side: the
 * query is narrow because the store ANDs its terms, but relevance is the fine discrimination that
 * narrowing gave up, so measuring it against the narrow set would score every retrieved artifact at
 * or near 1.0 and the signal would carry no information at all.
 *
 * The claim text is tokenized with the store's own tokenizer (injected, see task.ts:239) so that a
 * term and a claim word are compared on the same rules the index was built with.
 *
 * **The two are not on the same scale, and that is stated rather than smoothed over.** A run in
 * which some claims are priced by bm25 and others by coverage is mixing two orderings; the mixture
 * is confined to the *base* term, both numbers ride in the trace, and `basis` names which one was
 * used per candidate. The alternative — blending them — would produce a number that is neither, and
 * spec §12 asks for a fallback, not an average.
 */
export function relevanceSignal(
	claimText: string,
	tokenize: SearchTokenizer,
	terms: readonly string[],
	entities: readonly string[],
	claimScope: string,
	ownScopeKeys: ReadonlySet<string>,
	tags: ReadonlySet<string>,
	policy: RankingPolicy,
	rank: NormalizedRetrievalScore = { raw: null, normalized: null },
): RelevanceParts {
	const claimTokens = new Set(tokenize(claimText).map((token) => token.toLowerCase()));
	let matched = 0;
	for (const term of terms) {
		if (claimTokens.has(term.toLowerCase())) matched += 1;
	}
	const coverage = terms.length === 0 ? 0 : matched / terms.length;

	// A tag bonus asks whether the *curator* filed this row under a word the task used. Only curated
	// rows carry tags, so this is structurally a curated-memory bonus and is priced as one.
	let tagHit = false;
	for (const term of terms) {
		if (tags.has(term.toLowerCase())) {
			tagHit = true;
			break;
		}
	}

	// Entities are matched as substrings of the raw text rather than as tokens: `store.ts` and
	// `d:\mnemosia\src` do not survive tokenization intact, and they are exactly the spans the author
	// typed deliberately (task.ts:195-224).
	const haystack = claimText.toLowerCase();
	let entityHit = false;
	for (const entity of entities) {
		if (entity.length >= 3 && haystack.includes(entity)) {
			entityHit = true;
			break;
		}
	}

	const tag = tagHit ? policy.relevanceBonus.tag : 0;
	const entity = entityHit ? policy.relevanceBonus.entity : 0;
	const exactScope = ownScopeKeys.has(claimScope) ? policy.relevanceBonus.exactScope : 0;
	const basis: RelevanceParts["basis"] = rank.normalized === null ? "term_coverage" : "bm25";
	const base = rank.normalized ?? coverage;
	return {
		coverage,
		matchedTerms: matched,
		queryTerms: terms.length,
		rankRaw: rank.raw,
		rankNormalized: rank.normalized,
		basis,
		base,
		tag,
		entity,
		exactScope,
		value: Math.max(0, Math.min(1, base + tag + entity + exactScope)),
	};
}

/* ------------------------------------------------------------------------------------------------
 * Normalizing the store's bm25 (design §3's foundation change, consumed)
 * ---------------------------------------------------------------------------------------------- */

export interface NormalizedRetrievalScore {
	/** The raw `bm25()` carried on the envelope. Negative; more negative is better. */
	raw: number | null;
	/** `raw` rescaled into `[0,1]` against its own source, or `null` when the source published none. */
	normalized: number | null;
}

/** The divisor each source's raw scores are measured against, plus how many carried one at all. */
export interface RetrievalScoreScale {
	/** sourceId → the largest `|bm25|` that source produced in this run. `0` when every match was worthless. */
	best: Record<string, number>;
	scored: number;
	unscored: number;
}

/**
 * The scale each source's raw bm25 values are divided by, computed once per run.
 *
 * **bm25 is a per-query, per-index quantity and this is what makes it a signal.** Two things set its
 * magnitude, and only one of them is information:
 *
 * - *How surprising the matched words are* — `Σ idf(t)·tfNorm(t,d)`. This is the signal. A document
 *   that answered a rare word scores far below one that answered a common word, and on this corpus
 *   FTS5 clamps the IDF of a term occurring in half the index or more to `1e-6`, so a match on a
 *   genuinely common word scores ≈ 0. That is the discrimination §16's residual 0.127 needs.
 * - *How large the index is and how many terms the query carried* — an artifact. A large corpus holds
 *   11,182 documents and the curated vault holds ten, so the same rare word is worth `ln(11182/1.5)`
 *   ≈ 8.9 there and at most `ln(9.5/1.5)` ≈ 1.85 here. Comparing the two raw would demote every
 *   curated memory against every conversation event for a reason that has nothing to do with either.
 *
 * Dividing by the best magnitude **that same source produced in this run** removes the second
 * without touching the first: every element of a source's set was scored by one query specification
 * against one index, so the division is by a constant within the set and the within-source ordering
 * is preserved exactly. What survives across sources is each artifact's share of the discriminative
 * mass its own source found — which is a comparison that means something, where the raw numbers were
 * not.
 *
 * Three consequences, stated because each is a cost:
 *
 * 1. **The best artifact of every source scores 1.0**, however weak the match objectively was. That
 *    is the price of scale-freeness, and it is why relevance stays one weighted signal of six rather
 *    than a gate — nothing here can readmit a hard-filter rejection or outvote the other five.
 *    *Measured, and recorded here rather than fixed quietly:* on gold task G11 a source returned
 *    three documents, the best of them a generic "read this before every web-design task" guidance
 *    note, and this normalization gives it `relevance = 1.000` where term coverage gave it 0.111.
 *    The reading is literally true — of the three, it matched best — but a *relative* quantity
 *    summed with five absolute ones is a category error whenever a source's whole result set is
 *    weak. The absolute alternative (divide by the index's achievable maximum, `|query| · maxIdf(N)
 *    · (k1+1)`) needs the index size FTS5 does not expose and a saturation constant nobody has
 *    measured, and design §19 item 3 makes a number chosen after seeing the corpus a human decision.
 *    So the relative form ships, the counterexample is written down, and the absolute form is the
 *    next thing to measure. It changed no §16 number in either direction (see §16's Phase 6 note).
 * 2. **A source whose every match scored ≈ 0** (all query terms clamped) has `best = 0`, and every
 *    artifact from it takes `0`. That is the correct reading — the index says those words separate
 *    nothing — rather than a division that would amplify noise into 1.0.
 * 3. **An artifact's relevance depends on what else the same source returned.** Any per-query
 *    normalization has this property. It is deterministic given the run, it is recorded raw in the
 *    trace so a replay can re-derive it, and the alternative — an absolute scale — does not exist
 *    without the index statistics FTS5 does not expose.
 *
 * Grouping is by `sourceId` rather than by query string because a source issues exactly one query
 * specification per run: the term ladder retries only on an *empty* result, so at most one
 * rung contributes envelopes, and the curated disjunction is summed back into a single score per row
 * by the adapter (see `akashic-memories.ts`).
 */
export function normalizeRetrievalScores(envelopes: readonly ArtifactEnvelope[]): RetrievalScoreScale {
	const best: Record<string, number> = {};
	let scored = 0;
	let unscored = 0;
	for (const envelope of envelopes) {
		if (envelope.retrievalScore === null) {
			unscored += 1;
			continue;
		}
		scored += 1;
		const magnitude = Math.abs(envelope.retrievalScore);
		best[envelope.sourceId] = Math.max(best[envelope.sourceId] ?? 0, magnitude);
	}
	return { best, scored, unscored };
}

/**
 * The best normalized score among the artifacts behind one claim, or `null` when none published one.
 *
 * `max` of the normalized values, for the same reason `authority` and `integrity` take a max: a
 * claim that appears in both a strongly-matching artifact and a weakly-matching one *was* found by
 * the strong one, and letting the weak one drag it down would make corroboration a penalty. The raw
 * score reported alongside is the raw score of the artifact that won, not the raw maximum, so the
 * two fields in the trace describe the same artifact.
 */
export function claimRetrievalScore(envelopes: readonly ArtifactEnvelope[], scale: RetrievalScoreScale): NormalizedRetrievalScore {
	let bestNormalized: number | null = null;
	let bestRaw: number | null = null;
	for (const envelope of envelopes) {
		if (envelope.retrievalScore === null) continue;
		const divisor = scale.best[envelope.sourceId] ?? 0;
		const normalized = divisor === 0 ? 0 : Math.min(1, Math.abs(envelope.retrievalScore) / divisor);
		if (bestNormalized === null || normalized > bestNormalized) {
			bestNormalized = normalized;
			bestRaw = envelope.retrievalScore;
		}
	}
	return { raw: bestRaw, normalized: bestNormalized };
}

/* ------------------------------------------------------------------------------------------------
 * Composition
 * ---------------------------------------------------------------------------------------------- */

/**
 * `Σ wᵢ·signalᵢ` over the six inputs, and nothing else.
 *
 * Token cost and redundancy are *not* applied here even though design §9's utility row mentions
 * them, because they are properties of a candidate's position in a partially-built briefing rather
 * than of the candidate: the same claim is cheap when it is the first thing selected and redundant
 * when it is the fifth. Discounting them at scoring time would freeze one particular selection order
 * into the score. select.ts applies both, at selection time, exactly as design §10 writes it.
 */
export function composeUtility(signals: Omit<ScoreVector, "utility">, weights: SignalWeights): number {
	let total = 0;
	for (const signal of RANK_SIGNALS) total += weights[signal] * signals[signal];
	return total;
}

/* ------------------------------------------------------------------------------------------------
 * Candidates
 * ---------------------------------------------------------------------------------------------- */

/** The raw quantities behind each signal, so a recorded score can be re-derived rather than trusted. */
export interface RankBasis {
	authorityClasses: AuthorityClass[];
	/**
	 * The adapter channels of the artifacts behind this claim. Carried through scoring so that
	 * select.ts can label the ContextItem without re-opening the envelope index — and so that the
	 * six-way channel enum design §12 requires on every ContextItem is derived from the artifacts
	 * that actually produced it rather than assigned by whichever module happened to build the item.
	 */
	channels: AdapterChannel[];
	directness: Array<"direct" | "derived">;
	supportingArtifacts: number;
	certainty: Claim["certainty"];
	importance: number | null;
	integrityStatuses: IntegrityStatus[];
	ageDays: number;
	halfLifeDays: number;
	halfLifeSource: "claim_type" | "memory_kind";
	relevance: RelevanceParts;
	/** Artifacts named by the claim's evidence that this run did not normalize. Always 0 post-filter. */
	missingArtifacts: number;

	/* --- Phase 2: the provenance graph and temporal validity ---------------------------------- */

	/** 1 direct · 2 via a grounded summary · 3 via a summary whose sources this run could not reach. */
	graphDistance: number;
	distanceBasis: string;
	/** Distinct `sourceId | taskScope` groups behind the supporting artifacts. */
	independentGroups: number;
	/** How well the artifacts behind this claim can be traced to a primary observation. */
	grounding: GroundingState;
	/** Claims in this run that contradict it, by `relations.ts`'s deterministic predicates. */
	contradictions: number;
	/** Claims this one retires, through a chain of any length. */
	supersedesTransitive: number;
	/**
	 * Spec §12's `temporal_validity`, computed and recorded, **not weighted**.
	 *
	 * Design §19 item 3 makes a weight change a human decision, and adding an eighth weighted signal
	 * would silently re-tune the six that Phase 1 measured. So this is used categorically instead —
	 * as a gate on the factual sections (`select.ts`, `brief.ts`) and as an input to conflict
	 * resolution (`conflicts.ts`, spec §14's first consideration) — and recorded here so a replay can
	 * see the value even though no weight multiplied it. See `temporal.ts`'s header.
	 */
	temporal: TemporalValidity;
	/** Branch/environment qualifiers found in the claim text. Never a filter (design §2). */
	qualifiers: QualifierHit[];
}

export interface RankedCandidate {
	claim: Claim;
	score: ScoreVector;
	weights: SignalWeights;
	policyId: string;
	basis: RankBasis;
}

export interface RankStats {
	scored: number;
	/** Mean utility, for the trace. A run whose mean collapses is a retrieval problem, not a ranking one. */
	meanUtility: number;
	maxUtility: number;
	minUtility: number;
	byAuthorityClass: Record<string, number>;
}

export interface RankResult {
	candidates: RankedCandidate[];
	resolution: PolicyResolution;
	stats: RankStats;
	/**
	 * The graph the evidence-strength signal was computed against.
	 *
	 * Returned rather than rebuilt by the next stage: `conflicts.ts` classifies exactly the edges
	 * this scored, and two independently-built graphs would be two chances for the score a reader
	 * sees and the conflict they are shown to disagree about what the run actually holds.
	 */
	graph: ProvenanceGraph;
}

export interface RankInput {
	/** The **accepted** claims from `applyHardFilters`. Passing rejected claims is a caller bug. */
	claims: readonly Claim[];
	/** Every envelope the run normalized, for the authority/integrity/tag lookups. */
	envelopes: readonly ArtifactEnvelope[];
	analysis: TaskAnalysis;
	tokenize: SearchTokenizer;
	/** Resolved from the analysis when absent, via design §9's four-link chain. */
	policy?: RankingPolicy;
	/** Built from `claims` and `envelopes` when absent. Supplied by the orchestrator so it can trace it. */
	graph?: ProvenanceGraph;
	now?: number;
	/** When supplied, one `score` event per candidate is appended (spec §12's recording requirement). */
	trace?: TraceWriter;
}

const DAY_MS = 86_400_000;

/**
 * The total order design §10 tie-breaks with: `(utility desc, effectiveAt desc, claimId asc)`.
 *
 * Exported and used by both this module and select.ts, because two definitions of "the same order"
 * are two chances for the §16 determinism gate to fail on a machine with a different sort stability.
 */
export function compareCandidates(a: { score: ScoreVector; claim: Claim }, b: { score: ScoreVector; claim: Claim }): number {
	if (a.score.utility !== b.score.utility) return b.score.utility - a.score.utility;
	if (a.claim.effectiveAt !== b.claim.effectiveAt) return b.claim.effectiveAt - a.claim.effectiveAt;
	return a.claim.claimId < b.claim.claimId ? -1 : a.claim.claimId > b.claim.claimId ? 1 : 0;
}

export function scoreCandidate(
	claim: Claim,
	envelopes: ReadonlyMap<string, ArtifactEnvelope>,
	analysis: TaskAnalysis,
	policy: RankingPolicy,
	tokenize: SearchTokenizer,
	ownScopeKeys: ReadonlySet<string>,
	entities: readonly string[],
	now: number,
	graph: ProvenanceGraph,
	/** Absent means no source published a bm25 in this run; every candidate then falls back to coverage. */
	scale: RetrievalScoreScale = { best: {}, scored: 0, unscored: 0 },
): RankedCandidate {
	const artifactIds = [...new Set(claim.evidence.map((item) => item.artifactId))];
	const resolved = artifactIds.map((artifactId) => envelopes.get(artifactId)).filter((entry): entry is ArtifactEnvelope => entry !== undefined);
	const missingArtifacts = artifactIds.length - resolved.length;

	const authorityClasses = resolved.map(authorityClassOf);
	const integrityStatuses = resolved.map((envelope) => envelope.integrityStatus);
	const memoryOrigins = resolved.map((envelope) => originOf<AkashicMemoryOrigin>(envelope, "mnemosia/origin/akashic-memory")).filter((entry): entry is AkashicMemoryOrigin => entry !== null);

	// The highest importance among the curated rows backing this claim, or null when none is curated.
	const importance = memoryOrigins.length === 0 ? null : Math.max(...memoryOrigins.map((origin) => origin.importance));
	const tags = new Set<string>();
	for (const origin of memoryOrigins) for (const tag of origin.tags) tags.add(tag.toLowerCase());

	// `SUPPORTS` only. A SUPERSEDES link is a statement about another claim, not corroboration of
	// this one, and counting it would let a claim strengthen itself by retiring something.
	const supportingArtifacts = new Set(claim.evidence.filter((item) => item.relation === "SUPPORTS").map((item) => item.artifactId)).size;
	const directness = [...new Set(claim.evidence.map((item) => item.directness))];

	const memoryKind = memoryOrigins[0]?.memoryKind;
	const overriddenHalfLife = memoryKind === undefined ? undefined : policy.halfLifeDaysByMemoryKind[memoryKind];
	const halfLifeDays = overriddenHalfLife ?? policy.halfLifeDays[claim.claimType];
	const halfLifeSource: RankBasis["halfLifeSource"] = overriddenHalfLife === undefined ? "claim_type" : "memory_kind";
	const ageDays = (now - claim.effectiveAt) / DAY_MS;

	const relevance = relevanceSignal(claim.text, tokenize, analysis.terms.value, entities, scopeKey(claim.scope), ownScopeKeys, tags, policy, claimRetrievalScore(resolved, scale));
	const provenance = provenanceOf(graph, claim.claimId, temporalValidity(claim, now));

	const signals: Omit<ScoreVector, "utility"> = {
		authority: authoritySignal(authorityClasses, policy),
		evidenceStrength: evidenceStrengthSignal(
			{ graphDistance: provenance.graphDistance, supportingArtifacts, independentGroups: provenance.independentGroups, contradictions: provenance.contradictedBy.length },
			policy,
		),
		confidence: confidenceSignal(claim.certainty, importance, policy),
		integrity: integritySignal(integrityStatuses, policy),
		freshness: freshnessSignal(ageDays, halfLifeDays),
		relevance: relevance.value,
	};

	return {
		claim,
		score: { ...signals, utility: composeUtility(signals, policy.weights) },
		weights: policy.weights,
		policyId: policy.policyId,
		basis: {
			authorityClasses,
			channels: [...new Set(resolved.map((envelope) => envelope.channel))],
			directness,
			supportingArtifacts,
			certainty: claim.certainty,
			importance,
			integrityStatuses,
			ageDays,
			halfLifeDays,
			halfLifeSource,
			relevance,
			missingArtifacts,
			graphDistance: provenance.graphDistance,
			distanceBasis: provenance.distanceBasis,
			independentGroups: provenance.independentGroups,
			grounding: provenance.grounding,
			contradictions: provenance.contradictedBy.length,
			supersedesTransitive: provenance.supersedesTransitive.length,
			temporal: provenance.temporal,
			qualifiers: provenance.qualifiers,
		},
	};
}

/**
 * Scores every accepted claim and returns them in the canonical order.
 *
 * The `mode` fed to the policy chain is the analysis's mode. `MODE_CONFIGS` is consulted only to
 * record the candidate cap alongside the scores: a run whose candidate set was clipped by the mode
 * ranked a prefix of the corpus, and a replay that cannot see that would over-read the scores.
 */
export function rankCandidates(input: RankInput): RankResult {
	const now = input.now ?? Date.now();
	const analysis = input.analysis;
	const resolution = input.policy === undefined
		? resolvePolicy(analysis.requestingAgent, analysis.taskType.value, analysis.mode.value)
		: { policy: input.policy, matchedBy: "default" as const, attempted: ["(supplied by the caller)"], resolvedAgent: resolveAgent(analysis.requestingAgent).agent };
	const policy = resolution.policy;

	const graph = input.graph ?? buildProvenanceGraph({ claims: input.claims, envelopes: input.envelopes, now, shingleSize: policy.selection.shingleSize, neighbourhoodThreshold: policy.conflict.neighbourhoodThreshold });
	const envelopeIndex = new Map(input.envelopes.map((envelope) => [envelope.artifactId, envelope]));
	// Computed over **every** envelope the run normalized, not over the post-filter survivors: the
	// scale is a property of what the source found, and letting hard filtering move it would make an
	// artifact's relevance depend on whether an unrelated claim was quarantined.
	const scale = normalizeRetrievalScores(input.envelopes);
	const ownScopeKeys = new Set<string>();
	if (analysis.project.value !== null) ownScopeKeys.add(scopeKey({ level: "project", project: analysis.project.value }));
	const entities = analysis.entities.value.map((entity) => entity.text.toLowerCase());

	input.trace?.append({
		state: "SCORE_CANDIDATES",
		event: "transition",
		policyId: policy.policyId,
		policyVersion: policy.version,
		payload: {
			resolvedBy: resolution.matchedBy,
			attempted: resolution.attempted,
			weights: policy.weights,
			rationale: policy.rationale,
			candidates: input.claims.length,
			modeCandidateCap: MODE_CONFIGS[analysis.mode.value].maxCandidates,
			// Spec §12: every input to a ranking decision must be recoverable. The bm25 scale is an
			// input to `relevance` on every candidate, and it is one object rather than a repeated
			// field, so it belongs on the transition instead of inside each `score` payload.
			retrievalScoreScale: scale,
		},
	});

	const candidates = input.claims.map((claim) => scoreCandidate(claim, envelopeIndex, analysis, policy, input.tokenize, ownScopeKeys, entities, now, graph, scale));
	candidates.sort(compareCandidates);

	const byAuthorityClass: Record<string, number> = {};
	let total = 0;
	let max = 0;
	let min = candidates.length === 0 ? 0 : 1;
	for (const candidate of candidates) {
		total += candidate.score.utility;
		max = Math.max(max, candidate.score.utility);
		min = Math.min(min, candidate.score.utility);
		for (const entry of new Set(candidate.basis.authorityClasses)) byAuthorityClass[entry] = (byAuthorityClass[entry] ?? 0) + 1;
		// Spec §12: every signal value and every policy weight, per candidate, in the trace.
		input.trace?.append({
			state: "SCORE_CANDIDATES",
			event: "score",
			policyId: policy.policyId,
			policyVersion: policy.version,
			payload: { claimId: candidate.claim.claimId, claimType: candidate.claim.claimType, signals: candidate.score, weights: candidate.weights, basis: candidate.basis },
		});
	}

	return {
		candidates,
		resolution,
		graph,
		stats: { scored: candidates.length, meanUtility: candidates.length === 0 ? 0 : total / candidates.length, maxUtility: max, minUtility: min, byAuthorityClass },
	};
}

// Ported from mnemosia/similarity.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Shingle similarity, token similarity and blocked pair enumeration (design §10, §11; Phase 2).
 *
 * `shingles` and `jaccard` lived in `select.ts` through Phase 1 because selection was their only
 * consumer. Phase 2's conflict taxonomy needs a neighbourhood test — design §11 defines
 * `PLAN_VERSUS_FACT`, `PREFERENCE_CHANGE`, `BRANCH_DIFFERENCE` and the deterministic
 * `DIRECT_CONTRADICTION` subset over "near-duplicate" pairs — and `select.ts` already imports
 * `conflicts.ts`, so conflicts cannot import back from select without a cycle. They move here, once,
 * and `select.ts` re-exports them so nothing that already imported them has to change.
 *
 * ## CORRECTED IN PHASE 2 — jaccard₃ alone cannot express design §11's own canonical example.
 *
 * Design §11 writes the neighbourhood as `jaccard₃ ≥ 0.6` (stated for `PLAN_VERSUS_FACT`, and the
 * obvious reading for the "near-dup" and "neighborhood match" wording of the other three). Applied
 * to the deterministic `DIRECT_CONTRADICTION` detector the design specifies in the same table —
 * "exactly one side carries a negation marker" — that threshold is unsatisfiable, and the reason is
 * arithmetic rather than empirical:
 *
 * A one-token edit destroys **three** 3-grams on each side. For a claim of `n` tokens, negating it
 * leaves `jaccard₃ ≈ (n−5)/(n+1)`, which reaches 0.6 only at `n ≥ 14`. Measured on the exact pair
 * the design describes:
 *
 * ```
 * "The compaction hook writes a summary into the ledger on every turn."       J₃ 0.467   J₁ 0.714
 * "The compaction hook does not write a summary into the ledger on every turn."
 * "…retries: 3 for the pipeline."  /  "…retries: 5 for the pipeline."         J₃ 0.571   J₁ 0.846
 * "…runs on main…"                 /  "…runs on the release branch…"          J₃ 0.385   J₁ 0.750
 * "Deploy from main after the smoke test passes."                             J₃ 0.000   J₁ 0.364
 *   /  "Deploy from the release branch, never from main."   ← genuinely different statements
 * ```
 *
 * So a `jaccard₃ ≥ 0.6` neighbourhood makes the negation detector, the `key: value` detector and the
 * branch detector unreachable by construction, while the pairs that *should* be excluded sit far
 * below on both metrics. The two measures are answering different questions: 3-grams measure
 * **phrasing** overlap, which is what redundancy (design §10's MMR penalty) is about, and unigrams
 * measure **subject** overlap, which is what "same core" in design §11 is about.
 *
 * The correction adds the second leg and **introduces no new constant**: the neighbourhood is
 * `jaccard₃ ≥ 0.6 OR jaccard₁ ≥ 0.6`, reusing the number design §11 already fixed. The token leg is
 * not tuned to the examples above — it is set to the design's own threshold, which happens to sit in
 * the wide gap those numbers show (true near-duplicates 0.71–0.85, different statements ≤ 0.36).
 * Design §10's redundancy penalty is untouched and still uses 3-grams alone, because phrasing
 * overlap is the right question there.
 *
 * **The pair enumeration is blocked, not quadratic.** A detector that compares every claim to every
 * other is O(n²) on a set that `deep` mode caps at 1,500. `candidatePairs` builds an inverted index
 * from feature to claim and only proposes pairs that share at least one feature. That is exact, not
 * approximate: a positive Jaccard on either metric *means* a non-empty intersection, so every pair
 * either threshold would accept shares a feature and is proposed.
 */

/** The two views of a text a neighbourhood test needs. Built once per claim and reused. */
export interface SimilarityProfile {
	/** n-gram set over the normalized text. Phrasing overlap; design §10's redundancy measure. */
	shingles: Set<string>;
	/** Token set over the same text. Subject overlap; design §11's "same core". */
	tokens: Set<string>;
}

/**
 * The n-token shingle set of a text, over an already-normalized string.
 *
 * Callers pass `normalizeClaimText(text)` output — normalizing here would make this module import
 * `claims.ts` for one function and would hide from the caller that two differently-punctuated
 * renderings of one sentence are meant to shingle identically.
 *
 * A text shorter than the window yields one shingle of its whole token list rather than none, so a
 * two-word claim is still comparable instead of being scored as maximally novel against everything.
 */
export function shingleSet(normalized: string, size: number): Set<string> {
	const tokens = normalized.split(" ").filter((token) => token.length > 0);
	const result = new Set<string>();
	if (tokens.length === 0) return result;
	if (tokens.length < size) {
		result.add(tokens.join(" "));
		return result;
	}
	for (let index = 0; index + size <= tokens.length; index += 1) result.add(tokens.slice(index, index + size).join(" "));
	return result;
}

export function tokenSet(normalized: string): Set<string> {
	return new Set(normalized.split(" ").filter((token) => token.length > 0));
}

export function profileOf(normalized: string, shingleSize: number): SimilarityProfile {
	return { shingles: shingleSet(normalized, shingleSize), tokens: tokenSet(normalized) };
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const entry of small) {
		if (large.has(entry)) intersection += 1;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Design §11's threshold. One number, applied to both legs of the neighbourhood test. */
export const NEIGHBOURHOOD_THRESHOLD = 0.6;

export interface NeighbourhoodScore {
	/** jaccard₃ — design §11's stated measure, unchanged. */
	shingle: number;
	/** jaccard₁ over the token set — the leg added in Phase 2. See the header for why. */
	token: number;
	inNeighbourhood: boolean;
}

export function neighbourhoodScore(a: SimilarityProfile, b: SimilarityProfile, threshold: number = NEIGHBOURHOOD_THRESHOLD): NeighbourhoodScore {
	const shingle = jaccard(a.shingles, b.shingles);
	const token = jaccard(a.tokens, b.tokens);
	return { shingle, token, inNeighbourhood: shingle >= threshold || token >= threshold };
}

export interface SimilarPair<T> {
	a: T;
	b: T;
	/** The stronger of the two measures, for ordering and for the record's headline number. */
	similarity: number;
	shingleSimilarity: number;
	tokenSimilarity: number;
}

/**
 * Every pair of entries inside the neighbourhood, in a total order.
 *
 * `keyOf` supplies the stable identity used for ordering, so the returned pairs are always
 * `(lower key, higher key)` and the list is sorted `(similarity desc, a key asc, b key asc)`. The
 * §16 determinism gate reads conflict records byte for byte, and a pair order that depended on the
 * iteration order of a `Map` would fail it on a corpus where two pairs tie.
 *
 * A feature that occurs on more than `maxPostings` entries is skipped as a blocking key. That is not
 * a correctness compromise for the pairs it drops — every pair it drops is proposed by any *other*
 * feature the two share, and two texts inside the neighbourhood share a great many — it is a bound
 * on the pathological case where one boilerplate token appears on 400 claims and would alone propose
 * 80,000 pairs.
 */
export function candidatePairs<T>(entries: readonly T[], profile: (entry: T) => SimilarityProfile, keyOf: (entry: T) => string, threshold: number = NEIGHBOURHOOD_THRESHOLD, maxPostings = 64): Array<SimilarPair<T>> {
	const postings = new Map<string, number[]>();
	entries.forEach((entry, index) => {
		const own = profile(entry);
		for (const feature of own.shingles) push(postings, `3${feature}`, index);
		for (const feature of own.tokens) push(postings, `1${feature}`, index);
	});

	const seen = new Set<string>();
	const pairs: Array<SimilarPair<T>> = [];
	for (const bucket of postings.values()) {
		if (bucket.length < 2 || bucket.length > maxPostings) continue;
		for (let i = 0; i < bucket.length; i += 1) {
			for (let j = i + 1; j < bucket.length; j += 1) {
				const left = bucket[i];
				const right = bucket[j];
				if (left === undefined || right === undefined) continue;
				const key = `${left}:${right}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const a = entries[left];
				const b = entries[right];
				if (a === undefined || b === undefined) continue;
				const score = neighbourhoodScore(profile(a), profile(b), threshold);
				if (!score.inNeighbourhood) continue;
				const similarity = Math.max(score.shingle, score.token);
				pairs.push(
					keyOf(a) <= keyOf(b)
						? { a, b, similarity, shingleSimilarity: score.shingle, tokenSimilarity: score.token }
						: { a: b, b: a, similarity, shingleSimilarity: score.shingle, tokenSimilarity: score.token },
				);
			}
		}
	}

	pairs.sort((x, y) => y.similarity - x.similarity || compareKeys(keyOf(x.a), keyOf(y.a)) || compareKeys(keyOf(x.b), keyOf(y.b)));
	return pairs;
}

function push(index: Map<string, number[]>, key: string, value: number): void {
	const bucket = index.get(key);
	if (bucket === undefined) index.set(key, [value]);
	else bucket.push(value);
}

function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

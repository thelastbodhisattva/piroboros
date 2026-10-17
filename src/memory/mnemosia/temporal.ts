// Ported from mnemosia/temporal.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Temporal validity (spec §12 `temporal_validity`, spec §14 "Consider: Effective time"; Phase 2).
 *
 * Phase 1 carried `effectiveAt` and `expiresAt` on every claim and enforced exactly one of them:
 * `filters.ts` rejected a claim whose `expiresAt` had passed. That leaves the other half of the
 * interval unenforced, and the two halves are not the same question:
 *
 * - **Freshness** asks *how old* a claim is, and answers with a decay curve. A six-month-old
 *   preference is stale-ish and still perfectly valid.
 * - **Temporal validity** asks *whether the claim is in force at all*. A claim whose `effectiveAt`
 *   is next Tuesday is maximally fresh — age clamps to 0 in `freshnessSignal` — and is not yet true.
 *   A claim recorded a year ago with no expiry is unfresh and completely valid.
 *
 * Spec §12 lists them as two signals for that reason, and this module computes the second one.
 *
 * **It is deliberately not an eighth weighted signal.** Design §19 item 3 makes a `policy.ts` weight
 * change a decision requiring human approval, and the honest way to add temporal reasoning without
 * silently re-tuning six weights that were measured in Phase 1 is to use it where it is *categorical*
 * rather than where it would be *marginal*:
 *
 * 1. **A gate.** A claim that is not in force may not enter a factual briefing section
 *    (`select.ts` routes it, `brief.ts` validates it). That is stronger than any weight could be —
 *    no amount of authority or relevance readmits it — and it is the same shape as the
 *    `SUPERSEDED`-in-`confirmed_facts` rule design §16 already gates at zero.
 * 2. **A conflict input.** Spec §14's first consideration is effective time. `intervalRelation`
 *    below is what lets `conflicts.ts` say "these two never claimed to hold at the same moment", so
 *    a pair that merely *succeeded* one another is not reported as a contradiction.
 * 3. **A recorded quantity.** `TemporalValidity` lands in `RankBasis` and in the trace, so a replay
 *    can see the value that was computed even though no weight multiplied it.
 *
 * The alternative — folding it into `freshness` — is the exact collapse spec §12 opens by
 * prohibiting, and it would make a not-yet-effective claim indistinguishable from a very fresh one.
 */

/**
 * Where `now` sits relative to `[effectiveAt, expiresAt)`.
 *
 * `unbounded` and `valid` are separated because they are different epistemic states: a claim with a
 * stated expiry that has not yet arrived has been *given* a validity window by whoever recorded it,
 * and a claim with no expiry has simply never been bounded. The first is a promise about the future;
 * the second is an absence of one.
 */
export const TEMPORAL_STATUSES = ["not_yet_effective", "valid", "unbounded", "expired"] as const;
export type TemporalStatus = (typeof TEMPORAL_STATUSES)[number];

export interface TemporalValidity {
	status: TemporalStatus;
	effectiveAt: number;
	expiresAt: number | null;
	/** Milliseconds until `effectiveAt`. `0` once the claim is in force. */
	msUntilEffective: number;
	/** Milliseconds until `expiresAt`, or `null` when unbounded. Negative once expired. */
	msUntilExpiry: number | null;
	/** `true` for `valid` and `unbounded`. The single question every caller actually asks. */
	inForce: boolean;
	/** Prose for the trace and for the briefing qualification. */
	basis: string;
}

export interface TemporallyBounded {
	effectiveAt: number;
	expiresAt: number | null;
}

function isoDay(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

/**
 * The claim's validity state at `now`.
 *
 * An `expiresAt` at or before `effectiveAt` is a degenerate interval — a claim that was never in
 * force at any instant. It is reported as `expired` rather than as a schema error, because the two
 * timestamps come from different columns of a governed row and a curator setting an expiry in the
 * past is a real, recoverable data state; refusing to compute would turn it into a crash.
 */
export function temporalValidity(claim: TemporallyBounded, now: number): TemporalValidity {
	const { effectiveAt, expiresAt } = claim;
	const msUntilEffective = Math.max(0, effectiveAt - now);
	const msUntilExpiry = expiresAt === null ? null : expiresAt - now;

	if (expiresAt !== null && expiresAt <= now) {
		return {
			status: "expired",
			effectiveAt,
			expiresAt,
			msUntilEffective,
			msUntilExpiry,
			inForce: false,
			basis: `expired on ${isoDay(expiresAt)}`,
		};
	}
	if (effectiveAt > now) {
		return {
			status: "not_yet_effective",
			effectiveAt,
			expiresAt,
			msUntilEffective,
			msUntilExpiry,
			inForce: false,
			basis: `not in force until ${isoDay(effectiveAt)}`,
		};
	}
	if (expiresAt === null) {
		return { status: "unbounded", effectiveAt, expiresAt, msUntilEffective, msUntilExpiry, inForce: true, basis: `in force since ${isoDay(effectiveAt)}, with no stated expiry` };
	}
	return { status: "valid", effectiveAt, expiresAt, msUntilEffective, msUntilExpiry, inForce: true, basis: `in force from ${isoDay(effectiveAt)} until ${isoDay(expiresAt)}` };
}

/* ------------------------------------------------------------------------------------------------
 * Interval reasoning for conflict resolution (spec §14)
 * ---------------------------------------------------------------------------------------------- */

/**
 * How two validity intervals sit relative to one another.
 *
 * `disjoint` is the load-bearing case. Two statements that were each in force over intervals that
 * never met cannot contradict one another: they are a sequence, not a disagreement, and spec §14's
 * `TEMPORAL_SUCCESSION` is exactly the label for that. Reporting them as `DIRECT_CONTRADICTION`
 * would put a resolved history in front of the reader as an open question.
 */
export const INTERVAL_RELATIONS = ["disjoint_a_before_b", "disjoint_b_before_a", "overlapping", "a_contains_b", "b_contains_a", "identical"] as const;
export type IntervalRelation = (typeof INTERVAL_RELATIONS)[number];

const FOREVER = Number.POSITIVE_INFINITY;

export function intervalRelation(a: TemporallyBounded, b: TemporallyBounded): IntervalRelation {
	const aStart = a.effectiveAt;
	const aEnd = a.expiresAt ?? FOREVER;
	const bStart = b.effectiveAt;
	const bEnd = b.expiresAt ?? FOREVER;

	if (aStart === bStart && aEnd === bEnd) return "identical";
	// Half-open intervals: a claim that expires exactly when its successor takes effect is a clean
	// handover, not an overlap. Recording it as an overlap would manufacture a contradiction out of
	// two statements that were each true for their own stretch and never at the same instant.
	if (aEnd <= bStart) return "disjoint_a_before_b";
	if (bEnd <= aStart) return "disjoint_b_before_a";
	if (aStart <= bStart && aEnd >= bEnd) return "a_contains_b";
	if (bStart <= aStart && bEnd >= aEnd) return "b_contains_a";
	return "overlapping";
}

/** True when the two claims never asserted themselves over a shared instant. */
export function temporallyDisjoint(a: TemporallyBounded, b: TemporallyBounded): boolean {
	const relation = intervalRelation(a, b);
	return relation === "disjoint_a_before_b" || relation === "disjoint_b_before_a";
}

/**
 * Effective-time order with a total tie-break, for "which of these two is the newer statement".
 *
 * Returns a negative number when `a` is the newer one, so the array it sorts reads newest-first.
 * The tie-break on `id` is not decoration: two claims extracted from one artifact share its
 * `createdAt`, so "newer wins" is genuinely undecided for them, and without a second key the winner
 * would depend on adapter return order — which the §16 determinism gate measures across three runs.
 */
export function newerFirst<T extends TemporallyBounded & { id: string }>(a: T, b: T): number {
	if (a.effectiveAt !== b.effectiveAt) return b.effectiveAt - a.effectiveAt;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

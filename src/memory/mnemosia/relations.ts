// Ported from mnemosia/relations.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Deterministic pairwise relation predicates (design §11's Phase 2 detectors; spec §14).
 *
 * These are the tests that decide whether two near-duplicate claims are *related* and how. They live
 * apart from `conflicts.ts` because they are pure functions of two claims and nothing else — no
 * policy, no graph, no clock — which makes them the part of the taxonomy that can be unit-tested
 * exhaustively and, more importantly, the part whose false-positive behaviour can be inspected
 * without standing up a run.
 *
 * **Every predicate here is deterministic and none of them is semantic.** Design §11 splits
 * `DIRECT_CONTRADICTION` for exactly this reason: the deterministic subset is "a near-dup pair where
 * exactly one side carries a negation marker or a differing `key: value`", and the general case
 * "needs semantics → `OPTIONAL_EXPERIMENT` LLM (Phase 5) with MARK_DISPUTED fallback". Nothing in
 * this file attempts the general case. A pair that is in the neighbourhood, is not explained by any
 * predicate here, and is not otherwise resolvable stays `UNRESOLVED` with `MARK_DISPUTED` — which
 * spec §14's closing line requires and which is a smaller claim than a guess would be.
 */

import type { Claim } from "./types.ts";
import { qualifiersDiverge, type QualifierHit } from "./qualifiers.ts";

/* ------------------------------------------------------------------------------------------------
 * Negation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Design §11's negation markers, verbatim: `not | never | no longer | don't | stopped | instead of`.
 *
 * The apostrophe variants of `don't` and the inflections of `stopped` are the same marker written
 * differently, not extra markers — `doesn't` and `do not` are `don't`, and a rule that fired on one
 * spelling and not another would make the detector depend on the author's contractions. Nothing
 * beyond the design's six is added: each extra marker is a knob, and the Phase 2 brief forbids
 * tuning the detector to make the precision number come out.
 */
export const NEGATION_MARKERS = /\b(?:not|never|no longer|do\s?n[o']?t|does\s?n[o']?t|did\s?n[o']?t|stop(?:s|ped|ping)?|instead of)\b/iu;

export function hasNegationMarker(text: string): boolean {
	return NEGATION_MARKERS.test(text);
}

/**
 * True when exactly one of the two near-duplicate texts is negated.
 *
 * "Exactly one" is the whole test. Two texts that both say `not` are two statements of the same
 * restriction; two that both omit it are two statements of the same permission. The asymmetry is
 * what carries the information, and it is the only thing about negation a non-semantic detector can
 * honestly read.
 */
export function negationDivergence(a: string, b: string): { diverges: boolean; negatedSide: "a" | "b" | null } {
	const left = hasNegationMarker(a);
	const right = hasNegationMarker(b);
	if (left === right) return { diverges: false, negatedSide: null };
	return { diverges: true, negatedSide: left ? "a" : "b" };
}

/* ------------------------------------------------------------------------------------------------
 * `key: value` divergence
 * ---------------------------------------------------------------------------------------------- */

/**
 * `retries: 3`, `NODE_ENV=production`, `Pi 0.82.1`… no: only the first two shapes.
 *
 * The pattern requires an explicit `:` or `=` separator and a key made of word characters, because
 * those are the two shapes in which this corpus writes a *setting*. Admitting bare `name value`
 * juxtaposition would turn every noun-phrase pair into a key/value disagreement.
 *
 * The value is captured up to the first separator that ends a field — comma, semicolon, newline, or
 * a closing bracket — and trimmed of trailing sentence punctuation, so `retries: 3.` and
 * `retries: 3` are the same value.
 */
const KEY_VALUE = /(?:^|[\s(\[{,;])([A-Za-z][A-Za-z0-9_. -]{0,38}[A-Za-z0-9_])\s*[:=]\s*([^\n,;)\]}]{1,60})/gu;

export interface KeyValue {
	key: string;
	value: string;
}

export function extractKeyValues(text: string): KeyValue[] {
	const found = new Map<string, string>();
	KEY_VALUE.lastIndex = 0;
	for (const match of text.matchAll(KEY_VALUE)) {
		const key = (match[1] ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
		const value = (match[2] ?? "").trim().replace(/[.\s"'`]+$/u, "").toLowerCase();
		if (key.length === 0 || value.length === 0) continue;
		// First occurrence wins, matching the first-match-wins rule the rest of the pipeline uses:
		// a text that sets the same key twice is attributed to what it said first.
		if (!found.has(key)) found.set(key, value);
	}
	return [...found.entries()].map(([key, value]) => ({ key, value })).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/**
 * The part of a captured value that actually is the value.
 *
 * **CORRECTED AFTER THE FIRST SEEDED MEASUREMENT — the capture was greedy and it produced a false
 * positive.** `extractKeyValues` runs to the end of the clause, so `retries: 3 in the config` and
 * `retries: 3 in the configuration` captured `3 in the config` and `3 in the configuration`, which
 * are unequal strings and were reported as a `DIRECT_CONTRADICTION` between two statements that say
 * the same thing. Seed `N04` in `eval/conflict-seeds.ts` is that case, written as a labelled negative
 * before any measurement was run, and it is what caught it.
 *
 * A setting's value is the token immediately after the separator; the rest of the clause is prose
 * about it. Comparing only the leading token is a **narrowing** — it can only remove detections,
 * never add them — which is the right direction for a rule whose output is the sentence "these two
 * statements contradict each other" in front of a reader. The cost is real and is stated rather than
 * hidden: `strategy: exponential backoff` and `strategy: exponential decay` now agree on `exponential`
 * and the divergence is missed, which is the conservative failure for a deterministic subset that
 * design §11 already says does not cover the semantic case.
 */
function leadingToken(value: string): string {
	return value.split(/\s+/u)[0] ?? value;
}

/** Keys present in both texts with different values. Empty when the two agree or do not overlap. */
export function keyValueDivergence(a: string, b: string): Array<{ key: string; left: string; right: string }> {
	const left = new Map(extractKeyValues(a).map((entry) => [entry.key, entry.value]));
	const right = new Map(extractKeyValues(b).map((entry) => [entry.key, entry.value]));
	const diverging: Array<{ key: string; left: string; right: string }> = [];
	for (const [key, value] of [...left.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
		const other = right.get(key);
		if (other === undefined) continue;
		if (leadingToken(value) === leadingToken(other)) continue;
		diverging.push({ key, left: leadingToken(value), right: leadingToken(other) });
	}
	return diverging;
}

/* ------------------------------------------------------------------------------------------------
 * Claim-shape predicates
 * ---------------------------------------------------------------------------------------------- */

/** Claim types that assert something *happened or is true*, as opposed to something intended. */
const FACTUAL_TYPES: ReadonlySet<Claim["claimType"]> = new Set(["FACT", "OBSERVATION"]);

/**
 * Design §11: "`{PLAN, FACT/OBSERVATION}` pair within jaccard₃ ≥ 0.6 neighborhood".
 *
 * The neighbourhood test is the caller's; this decides only whether the *pair of types* is the one
 * §14's `PLAN_VERSUS_FACT` names. Note the direction is recorded rather than discarded: which side
 * is the plan decides the qualification sentence ("this was intended; that is what was observed"),
 * and a symmetric boolean would lose it.
 */
export function planVersusFact(a: Claim, b: Claim): { matches: boolean; planSide: "a" | "b" | null } {
	if (a.claimType === "PLAN" && FACTUAL_TYPES.has(b.claimType)) return { matches: true, planSide: "a" };
	if (b.claimType === "PLAN" && FACTUAL_TYPES.has(a.claimType)) return { matches: true, planSide: "b" };
	return { matches: false, planSide: null };
}

/**
 * Design §11: "two PREFERENCE claims, neighborhood match, different hashes".
 *
 * "Different hashes" is `claimId` inequality, which after the Phase 1B identity correction
 * (claims.ts:120-135) also means *not the same statement in the same scope* — two identical
 * preferences in one scope collapsed at deduplication and never reach here.
 */
export function preferenceChange(a: Claim, b: Claim): boolean {
	return a.claimType === "PREFERENCE" && b.claimType === "PREFERENCE" && a.claimId !== b.claimId;
}

/** Design §11: "same core, different `scope.project`." The scope *level* counts too: global ≠ project. */
export function scopeDifference(a: Claim, b: Claim): boolean {
	return a.scope.level !== b.scope.level || (a.scope.project ?? null) !== (b.scope.project ?? null);
}

export function branchDifference(a: readonly QualifierHit[], b: readonly QualifierHit[]): { diverges: boolean; left: string[]; right: string[] } {
	return qualifiersDiverge(a, b, "branch");
}

export function environmentDifference(a: readonly QualifierHit[], b: readonly QualifierHit[]): { diverges: boolean; left: string[]; right: string[] } {
	return qualifiersDiverge(a, b, "environment");
}

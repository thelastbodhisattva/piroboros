// Ported from mnemosia/rerank.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Versioned model-assisted reranking (spec §12, design §3 `OPTIONAL_EXPERIMENT`, Phase 5).
 *
 * **This is the only module in Mnemosia that can talk to a model, and it is off.** Design §3 lists
 * "any LLM call in the Phase 1 path" as `PROHIBITED` and marks LLM-assisted reranking
 * `OPTIONAL_EXPERIMENT` from Phase 5 onward; spec §25 admits Phase 5's items "only after strong
 * offline evaluation", and the evaluation has not passed (Phase 1 is 10/11, Phase 2 is 3/4). So the
 * capability is built, wired, tested and **disabled by default**, exactly as `mutate.ts` built the
 * write path in Phase 3 — and, as there, it refuses to enable itself.
 *
 * Spec §12's sentence is the whole specification of this file:
 *
 * > LLM-assisted reranking may be used only after deterministic filtering and must have a
 * > deterministic fallback.
 *
 * Six properties deliver it, each one structural rather than promised, and each one separately
 * asserted in `test/rerank.test.ts`:
 *
 * 1. **Off by default.** `deps.gate ?? DEFAULT_RERANK_GATE` and the default is frozen with
 *    `rerankEnabled: false`. A disabled call returns the input array *by identity* and never touches
 *    `deps.model` — measured by a model that counts its own calls. The only constructor of an
 *    enabled gate is `enableReranking(enabledBy, justification, rerankerVersion)`, all three
 *    required and non-empty, and `test/mutate.test.ts`'s source sweep asserts that nothing under
 *    `src/` calls it or builds the enabled literal by hand.
 * 2. **Strictly after deterministic filtering.** The input is `RankedCandidate[]`, which `rank.ts`
 *    produces from `filters.accepted` — a rejected claim is never scored, so it is never in the
 *    array this function receives. The orchestrator calls it *after* the mode's candidate cap for
 *    the same reason: the cap is the last deterministic narrowing, and a reranker placed before it
 *    would be choosing what gets weighed rather than reordering what was.
 * 3. **It cannot resurrect a hard-filtered candidate.** The output is assembled by looking every id
 *    the model returned up in an index built from the *input*; an id that is not there is discarded
 *    into `dropped` and recorded in the trace. There is no code path in this file that constructs a
 *    `RankedCandidate`, so an id the deterministic stage rejected has nothing to become.
 * 4. **The deterministic fallback is the current ranking, verbatim.** Every failure mode — a throw,
 *    a null, a wrong version, a non-array, an empty order, an order that is not a permutation of the
 *    input — returns the input array unchanged, with a status naming which one occurred.
 * 5. **Bounded retry.** `MAX_RERANK_ATTEMPTS = 2`, i.e. one retry, following `mutate.ts`'s
 *    rebase-and-retry-**once**: contention or flakiness past one retry is a fact about the
 *    dependency, and a loop replaces a visible failure with an invisible one.
 * 6. **Every invocation is versioned and traced.** One `rerank` trace event per call, including the
 *    calls that did nothing, carrying the gate, the reranker version, the attempt count, the status,
 *    the dropped ids and the resulting displacement.
 *
 * > **THE MODEL PATH IS UNTESTED AND IS DECLARED SO.** No model is reachable from this environment
 * > and Mnemosia has no HTTP client, no API key and no runtime dependency that could acquire one
 * > (`package.json` has zero dependencies, deliberately). `RerankModel` is therefore a *seam*: the
 * > fallback path, the permutation guard, the retry bound and the trace record are exercised against
 * > fakes, and the sentence "a real model was asked to reorder real candidates and the result was
 * > better" is **not** claimed anywhere. `REGISTERED_RERANKERS` holds exactly one entry, and its
 * > version string says what it is.
 */

import { compareCandidates, type RankedCandidate } from "./rank.ts";
import type { TraceWriter } from "./trace.ts";
import { SCHEMA_VERSION } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * The gate (design §19 — the same shape as the Phase 3 write gate)
 * ---------------------------------------------------------------------------------------------- */

/**
 * A plain frozen value with no methods, constructed by the caller.
 *
 * `mutate.ts:89-106` sets out why that shape *is* the safety argument: a value with no mutator
 * cannot be flipped by the code it governs, an object the caller constructs cannot be produced by a
 * default parameter, and a field read cannot consult an environment variable. The identical shape is
 * used here rather than a new one so that a reviewer who has audited one has audited both.
 */
export interface RerankGate {
	readonly schemaVersion: typeof SCHEMA_VERSION.rerankGate;
	/** `false` until the Phase 1 and Phase 2 gates pass and a human says so (spec §25's precondition). */
	readonly rerankEnabled: boolean;
	/** The named party who turned it on. `null` while off. */
	readonly enabledBy: string | null;
	/** Why. `null` while off. Non-empty whenever `rerankEnabled` is true, by construction. */
	readonly justification: string | null;
	/**
	 * Which reranker the enabler approved.
	 *
	 * On the gate rather than only on the model because spec §22 versions *policy changes*, and a
	 * reranker is a ranking policy that happens to be a model: an approval that did not name a
	 * version would authorize whatever the model provider shipped next.
	 */
	readonly rerankerVersion: string | null;
}

/** The gate every production wiring uses. `extension.ts` names no other. */
export const DEFAULT_RERANK_GATE: RerankGate = Object.freeze({
	schemaVersion: SCHEMA_VERSION.rerankGate,
	rerankEnabled: false,
	enabledBy: null,
	justification: null,
	rerankerVersion: null,
});

/**
 * The single constructor of an enabled gate. Nothing under `src/` calls it; `test/mutate.test.ts`
 * proves that by reading the source tree, and `test/rerank.test.ts` extends the same sweep here.
 */
export function enableReranking(enabledBy: string, justification: string, rerankerVersion: string): RerankGate {
	if (typeof enabledBy !== "string" || enabledBy.trim().length === 0) throw new Error("enableReranking requires a named enabler; spec §25 admits model-assisted reranking only after strong offline evaluation, and an anonymous activation is not an approval");
	if (typeof justification !== "string" || justification.trim().length === 0) throw new Error("enableReranking requires a justification; the Phase 1 gate is 10/11 and the Phase 2 gate is 3/4, so any activation has to say what it is for");
	if (typeof rerankerVersion !== "string" || rerankerVersion.trim().length === 0) throw new Error("enableReranking requires a reranker version; an approval that does not name one authorizes whatever the provider ships next");
	return Object.freeze({ schemaVersion: SCHEMA_VERSION.rerankGate, rerankEnabled: true, enabledBy: enabledBy.trim(), justification: justification.trim(), rerankerVersion: rerankerVersion.trim() });
}

/* ------------------------------------------------------------------------------------------------
 * The seam
 * ---------------------------------------------------------------------------------------------- */

/** One candidate, as the model sees it. Deliberately thin: no scores, no provenance, no envelopes. */
export interface RerankCandidateView {
	claimId: string;
	claimType: string;
	/** The claim's own text. It has already crossed the trust boundary and been safety-scanned. */
	text: string;
	/** The deterministic rank, 1-based. Given to the model so it can be asked for a *minimal* edit. */
	deterministicRank: number;
	/** The deterministic utility, so a model's disagreement can be priced rather than merely obeyed. */
	utility: number;
}

export interface RerankRequest {
	runId: string;
	/** The task objective. The only free text from the *requester* that reaches the model. */
	objective: string;
	/** The deterministic policy in force, so a reranker can be versioned against what it reranked. */
	policyId: string;
	candidates: readonly RerankCandidateView[];
}

export interface RerankResponse {
	/** Must equal the gate's `rerankerVersion`. A mismatch is a fallback, not a warning. */
	rerankerVersion: string;
	/** The reordered claim ids. Anything not in the request is discarded (property 3). */
	order: readonly string[];
}

/**
 * The model seam.
 *
 * Synchronous, because every other call in Mnemosia is (design §13: "all I/O is local synchronous
 * SQLite") and because an async reranker would make `runBriefing` async, which would change the
 * signature of the entire deterministic pipeline for a feature that is off. A real implementation
 * would be a thin adapter with its own deadline; none exists.
 */
export interface RerankModel {
	readonly version: string;
	rerank(request: RerankRequest, attempt: number): RerankResponse | null;
}

/**
 * The reranker registry. One entry, and its version string is the honest description of it.
 *
 * A registry with one unbuilt member looks like ceremony until you ask what the alternative is: the
 * gate names a version, `applyReranking` refuses a response whose version is not the gate's, and a
 * version nobody wrote down cannot be approved. An empty registry would make the version field
 * unverifiable; a registry with a plausible-looking `mnemosia/reranker@1` in it would be design §26's
 * placeholder abstraction, claiming a model that does not exist.
 */
export const REGISTERED_RERANKERS: readonly string[] = Object.freeze(["mnemosia/reranker@0-unbuilt"]);

/** One retry, following `mutate.ts`'s rebase-and-retry-once. See property 5 in the header. */
export const MAX_RERANK_ATTEMPTS = 2;

/* ------------------------------------------------------------------------------------------------
 * Application
 * ---------------------------------------------------------------------------------------------- */

export const RERANK_STATUSES = [
	/** The gate is closed. The model was not called. This is production. */
	"disabled",
	/** The gate is open but no model was supplied — an activation without an implementation. */
	"no_model",
	/** The model answered and its answer was applied. */
	"applied",
	/** Every attempt threw. Deterministic order returned. */
	"fallback_error",
	/** The model answered with something that is not a usable order. Deterministic order returned. */
	"fallback_invalid",
	/** The model's version is not the version the gate approved. Deterministic order returned. */
	"fallback_version_mismatch",
	/** There was nothing to rerank. */
	"empty",
] as const;
export type RerankStatus = (typeof RERANK_STATUSES)[number];

export interface RerankOutcome {
	status: RerankStatus;
	/**
	 * **Always a valid, complete ordering of the input, whatever happened.** On every status other
	 * than `applied` this is the input array itself, by identity — which is what makes "the
	 * deterministic fallback is the current ranking" checkable with `assert.equal` rather than a
	 * deep comparison that a subtly-rebuilt array would also satisfy.
	 */
	candidates: RankedCandidate[];
	rerankerVersion: string | null;
	/** How many times the model was called. 0 when the gate was closed. */
	attempts: number;
	/** Ids the model returned that the deterministic stage had not admitted. Never resurrected. */
	dropped: string[];
	/** Ids the model omitted, re-appended in deterministic order so nothing is silently lost. */
	restored: string[];
	/** Candidates whose position changed. 0 on every fallback path. */
	moved: number;
	/** The largest single displacement, in positions. A blast-radius number for a reviewer. */
	maxDisplacement: number;
	/** Why this status. Lands in the trace and, for a fallback, names the failure. */
	reason: string;
	/** Every error the attempts raised, in order. */
	errors: string[];
}

export interface RerankDeps {
	/** Defaults to `DEFAULT_RERANK_GATE`, i.e. off. Production passes nothing. */
	gate?: RerankGate;
	model?: RerankModel;
	runId: string;
	objective: string;
	policyId: string;
	trace?: TraceWriter;
	now?: () => number;
}

/**
 * Reorders `candidates` with the model, or returns them exactly as they arrived.
 *
 * The order of the checks is load-bearing and mirrors `executeMutation`: the **gate is read first**,
 * before the model is looked at and before a request is built, so a disabled run performs no work
 * that an enabled one would and the "0 model calls" measurement is about the code path rather than
 * about the fake.
 */
// Ported library surface: no caller under src/ uses the rerank model path yet; the ported suite covers it.
export function applyReranking(candidates: readonly RankedCandidate[], deps: RerankDeps): RerankOutcome {
	const gate = deps.gate ?? DEFAULT_RERANK_GATE;
	const at = deps.now?.() ?? Date.now();
	const input = candidates as RankedCandidate[];

	const emit = (outcome: RerankOutcome): RerankOutcome => {
		deps.trace?.append({
			state: "SCORE_CANDIDATES",
			event: "rerank",
			at,
			payload: {
				status: outcome.status,
				reason: outcome.reason,
				gate: { rerankEnabled: gate.rerankEnabled, enabledBy: gate.enabledBy, justification: gate.justification, approvedVersion: gate.rerankerVersion },
				rerankerVersion: outcome.rerankerVersion,
				attempts: outcome.attempts,
				candidatesIn: input.length,
				candidatesOut: outcome.candidates.length,
				dropped: outcome.dropped,
				restored: outcome.restored,
				moved: outcome.moved,
				maxDisplacement: outcome.maxDisplacement,
				errors: outcome.errors,
				deterministicFallback: outcome.status !== "applied",
				note: "spec §12: LLM-assisted reranking runs only after deterministic filtering and must have a deterministic fallback. No id outside the deterministically-ranked input can appear in the output; `dropped` lists every id the model returned that was not admitted.",
			},
		});
		return outcome;
	};

	const fallback = (status: RerankStatus, reason: string, extra: Partial<RerankOutcome> = {}): RerankOutcome =>
		emit({ status, candidates: input, rerankerVersion: gate.rerankerVersion, attempts: 0, dropped: [], restored: [], moved: 0, maxDisplacement: 0, reason, errors: [], ...extra });

	// 1. The gate, first.
	if (!gate.rerankEnabled) {
		return fallback("disabled", "spec §25 admits model-assisted reranking only after strong offline evaluation; the Phase 1 gate is 10/11 and the Phase 2 gate is 3/4, so DEFAULT_RERANK_GATE is in force and no model was called");
	}
	if (deps.model === undefined) {
		return fallback("no_model", "the rerank gate is open but no model was supplied; the deterministic ranking stands");
	}
	if (input.length === 0) {
		return fallback("empty", "no candidate survived deterministic ranking, so there is nothing to rerank");
	}

	const request: RerankRequest = {
		runId: deps.runId,
		objective: deps.objective,
		policyId: deps.policyId,
		candidates: input.map((candidate, index) => ({
			claimId: candidate.claim.claimId,
			claimType: candidate.claim.claimType,
			text: candidate.claim.text,
			deterministicRank: index + 1,
			utility: candidate.score.utility,
		})),
	};

	const errors: string[] = [];
	let attempts = 0;
	let response: RerankResponse | null = null;
	while (attempts < MAX_RERANK_ATTEMPTS) {
		attempts += 1;
		try {
			response = deps.model.rerank(request, attempts);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			response = null;
			continue;
		}
		if (response !== null && typeof response === "object") break;
		errors.push(`attempt ${attempts} returned no response`);
		response = null;
	}

	if (response === null) {
		return emit({ status: "fallback_error", candidates: input, rerankerVersion: gate.rerankerVersion, attempts, dropped: [], restored: [], moved: 0, maxDisplacement: 0, reason: `the reranker failed on all ${attempts} attempt(s); the deterministic ranking is returned unchanged`, errors });
	}
	if (response.rerankerVersion !== gate.rerankerVersion) {
		return emit({ status: "fallback_version_mismatch", candidates: input, rerankerVersion: gate.rerankerVersion, attempts, dropped: [], restored: [], moved: 0, maxDisplacement: 0, reason: `the reranker identified itself as ${String(response.rerankerVersion)} but the gate approved ${String(gate.rerankerVersion)}; an unapproved version is a fallback, not a warning`, errors });
	}
	if (!Array.isArray(response.order) || response.order.length === 0) {
		return emit({ status: "fallback_invalid", candidates: input, rerankerVersion: gate.rerankerVersion, attempts, dropped: [], restored: [], moved: 0, maxDisplacement: 0, reason: "the reranker returned no usable order; the deterministic ranking is returned unchanged", errors });
	}

	/* --- the permutation guard (properties 3 and 4) --------------------------------------------- */
	//
	// Everything below reads *only* from `byClaimId`, which is built from the input. That is what
	// makes "no hard-filtered candidate can be resurrected" a property of the code's shape rather
	// than of a validation step somebody could forget to run: there is no expression in this function
	// that produces a `RankedCandidate` from anything but the input array.
	const byClaimId = new Map(input.map((candidate) => [candidate.claim.claimId, candidate]));
	const positionByClaimId = new Map(input.map((candidate, index) => [candidate.claim.claimId, index]));
	const ordered: RankedCandidate[] = [];
	const placed = new Set<string>();
	const dropped: string[] = [];
	for (const claimId of response.order) {
		if (typeof claimId !== "string") {
			dropped.push(String(claimId));
			continue;
		}
		if (placed.has(claimId)) continue; // a duplicate is not a second placement
		const candidate = byClaimId.get(claimId);
		if (candidate === undefined) {
			dropped.push(claimId);
			continue;
		}
		ordered.push(candidate);
		placed.add(claimId);
	}

	// Anything the model omitted is re-appended in the deterministic total order. Dropping it would
	// let a model *remove* evidence, which is a filtering decision, and §12 puts reranking strictly
	// after filtering rather than partly inside it.
	const restoredCandidates = input.filter((candidate) => !placed.has(candidate.claim.claimId)).sort(compareCandidates);
	const restored = restoredCandidates.map((candidate) => candidate.claim.claimId);
	ordered.push(...restoredCandidates);

	if (ordered.length !== input.length) {
		// Unreachable: `ordered` holds each input exactly once by construction. Kept as a hard stop
		// rather than an assertion, because a reranker that silently changed the candidate count would
		// be the one defect that invalidates every downstream token and provenance guarantee.
		return emit({ status: "fallback_invalid", candidates: input, rerankerVersion: gate.rerankerVersion, attempts, dropped, restored, moved: 0, maxDisplacement: 0, reason: `the reranked order held ${ordered.length} candidates against ${input.length} in; the deterministic ranking is returned unchanged`, errors });
	}

	let moved = 0;
	let maxDisplacement = 0;
	for (const [index, candidate] of ordered.entries()) {
		const was = positionByClaimId.get(candidate.claim.claimId) ?? index;
		if (was !== index) {
			moved += 1;
			maxDisplacement = Math.max(maxDisplacement, Math.abs(was - index));
		}
	}

	return emit({
		status: "applied",
		candidates: ordered,
		rerankerVersion: gate.rerankerVersion,
		attempts,
		dropped,
		restored,
		moved,
		maxDisplacement,
		reason: `${gate.rerankerVersion} reordered ${moved} of ${input.length} candidate(s) after deterministic ranking; ${dropped.length} returned id(s) were not in the deterministic set and were discarded, ${restored.length} omitted id(s) were restored in deterministic order`,
		errors,
	});
}

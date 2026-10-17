// Ported from mnemosia/feedback.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Per-agent feedback structure (spec §22, design §21 — Phase 4).
 *
 * Phase 1 shipped `submitFeedback` as an accept-and-store stub: one flat optional-everything record,
 * appended to a file nothing in the retrieval path opens. Phase 4 gives it structure without giving
 * it teeth, and the second half of that sentence is the requirement rather than a caveat.
 *
 * **Spec §22 is explicit — "Do not update production ranking policies online from individual
 * interactions" — and this module is the place that prohibition would be violated if it were going
 * to be.** So the design is deliberately lopsided:
 *
 * - Feedback gains a **schema** (spec §22's eight signals, typed, with per-agent expectations),
 * - and a **validator** that returns a value rather than throwing, so a malformed report is recorded
 *   as malformed instead of being lost,
 * - and **no reader anywhere under `src/`**. `test/feedback.test.ts` reads every source file and
 *   asserts that nothing but this module opens `feedback.jsonl`, and that no ranking or selection
 *   module imports it at all — the same machine-checked shape `test/mutate.test.ts` uses to make
 *   "Mnemosia cannot turn her own writes on" a property rather than a promise.
 *
 * Offline evaluation and versioned policy proposals — spec §22's stated use — are Phase 5.
 *
 * **Why the structure is per-agent at all.** Spec §22 asks for eight signals and design §21 makes
 * Vesperia the execution-feedback seat. Those two facts together mean the signals do not come from
 * one place: only whoever *acted* on a briefing knows which items were used and which were stale,
 * only the validator knows about validator disagreement, and only Vaelia can report an external
 * finding, because spec §3 forbids Mnemosia going to look for one. A single flat schema records all
 * of that as "some optional fields were absent", which is indistinguishable from a lazy report. The
 * per-agent expectation set is what makes the difference legible offline.
 */

import { AGENT_PROFILES, resolveAgent, type ConclaveAgent } from "./agents.ts";

export const FEEDBACK_SCHEMA_VERSION = "mnemosia/feedback@2";

/**
 * Spec §22's list, one field each, in the spec's own order.
 *
 * `externalFindings` and `costObservations` are the two additions, and neither is an eighth signal
 * smuggled in: they are the shapes the spec's "additional retrieval requested" and "downstream
 * success" take for the two seats that produce evidence Mnemosia is structurally unable to obtain
 * herself — Vaelia (spec §3 forbids browsing) and Avaritia (cost is a property of the caller's run,
 * not of the corpus). A signal nobody can produce is not a signal.
 */
export const FEEDBACK_SIGNALS = ["usedItemIds", "ignoredItemIds", "staleClaimIds", "missingEvidence", "additionalRetrievalRequested", "downstreamSuccess", "validatorDisagreement", "sectionsThatMattered", "externalFindings", "costObservations"] as const;
export type FeedbackSignal = (typeof FEEDBACK_SIGNALS)[number];

export interface FeedbackEntry {
	schemaVersion: typeof FEEDBACK_SCHEMA_VERSION;
	runId: string;
	briefingId: string;
	/** Exactly the string the caller supplied. Never rewritten — `resolvedAgent` carries the mapping. */
	agent: string;
	/** The canonical seat, or `null` for a caller outside the eight. */
	resolvedAgent: ConclaveAgent | null;
	at: number;

	/* --- spec §22's eight ------------------------------------------------------------------------ */
	/** "Memories actually used." Item ids from the briefing, not claim ids. */
	usedItemIds?: string[];
	/** "Memories ignored." */
	ignoredItemIds?: string[];
	/** "Incorrect or stale memories." Claim ids, because staleness is a property of the claim. */
	staleClaimIds?: string[];
	/** "Missing evidence." */
	missingEvidence?: string;
	/** "Additional retrieval requested." */
	additionalRetrievalRequested?: boolean;
	/** "Downstream success." */
	downstreamSuccess?: boolean;
	/** "Validator disagreement." Elaria's channel. */
	validatorDisagreement?: string;
	/** "Context sections that affected the result." */
	sectionsThatMattered?: string[];

	/* --- the two producer channels --------------------------------------------------------------- */
	/** Vaelia. The only route by which external evidence enters without Mnemosia browsing (spec §3). */
	externalFindings?: Array<{ source: string; finding: string; version?: string }>;
	/** Avaritia. Cost observed by the caller, which Mnemosia's own trace cannot see. */
	costObservations?: Array<{ metric: string; value: number; unit: string }>;

	comment?: string;

	/** The validator's verdict, stored **on** the record so an offline pass need not re-derive it. */
	validation: FeedbackValidation;
}

export interface FeedbackValidation {
	/** `true` when every signal this seat is expected to report is present. Never gates acceptance. */
	complete: boolean;
	/** The seat's expected signals, from `AGENT_PROFILES[...].feedbackExpected`. */
	expected: string[];
	/** Expected signals the report omitted. */
	missing: string[];
	/** Signals present that this seat is not the producer of. Recorded, not refused. */
	unexpected: string[];
	/** `true` when this seat's principal feedback relationship is producing rather than consuming. */
	producer: boolean;
	detail: string;
}

function isPresent(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "string") return value.trim().length > 0;
	return true;
}

/**
 * The signals a seat is the natural *producer* of — used to populate `unexpected`.
 *
 * This is not an access-control list. A consumer seat that happens to notice a stale memory should
 * report it, and the report is stored exactly as sent; the field exists so that an offline pass can
 * tell "Vesperia reported execution feedback" from "Astrelia reported execution feedback", which are
 * different quality signals about the same bytes.
 */
const PRODUCER_SIGNALS: Readonly<Record<ConclaveAgent, readonly FeedbackSignal[]>> = Object.freeze({
	samaela: ["usedItemIds", "ignoredItemIds", "downstreamSuccess", "sectionsThatMattered"] as const,
	vesperia: ["usedItemIds", "ignoredItemIds", "staleClaimIds", "missingEvidence", "additionalRetrievalRequested", "downstreamSuccess", "sectionsThatMattered"] as const,
	nytheria: ["missingEvidence", "additionalRetrievalRequested", "sectionsThatMattered"] as const,
	elaria: ["validatorDisagreement", "staleClaimIds", "missingEvidence", "sectionsThatMattered"] as const,
	raskreia: ["validatorDisagreement", "downstreamSuccess", "sectionsThatMattered"] as const,
	avaritia: ["costObservations", "downstreamSuccess", "sectionsThatMattered"] as const,
	astrelia: ["usedItemIds", "staleClaimIds", "sectionsThatMattered"] as const,
	vaelia: ["externalFindings", "missingEvidence", "additionalRetrievalRequested"] as const,
});

export function validateFeedback(agent: string, report: Partial<Record<FeedbackSignal, unknown>>): FeedbackValidation {
	const resolved = resolveAgent(agent);
	if (resolved.agent === null) {
		const present = FEEDBACK_SIGNALS.filter((signal) => isPresent(report[signal]));
		return { complete: true, expected: [], missing: [], unexpected: [], producer: false, detail: `${resolved.detail}; no per-seat expectation applies, ${present.length} signal(s) recorded as submitted` };
	}
	const profile = AGENT_PROFILES[resolved.agent];
	const expected = [...profile.feedbackExpected];
	const missing = expected.filter((signal) => !isPresent(report[signal as FeedbackSignal]));
	const produces = new Set<string>(PRODUCER_SIGNALS[resolved.agent]);
	const unexpected = FEEDBACK_SIGNALS.filter((signal) => isPresent(report[signal]) && !produces.has(signal));
	return {
		complete: missing.length === 0,
		expected,
		missing,
		unexpected: [...unexpected],
		producer: profile.feedbackProducer,
		detail:
			missing.length === 0
				? `${profile.displayName} reported all ${expected.length} expected signal(s)${unexpected.length === 0 ? "" : `, plus ${unexpected.length} outside this seat's producer set (recorded, not refused)`}`
				: `${profile.displayName} omitted ${missing.length} of ${expected.length} expected signal(s): ${missing.join(", ")}. The report is stored as submitted; spec §22 forbids acting on it online in any case.`,
	};
}

/**
 * The per-seat template a briefing hands back, so the producer knows what to report against.
 *
 * Rendered into the `feedback_request` addendum block. It is a *request*, not a contract: nothing
 * refuses a report that ignores it, and the point is only that a seat should not have to read spec
 * §22 to find out which four fields its role is the one that can fill.
 */
export interface FeedbackRequest {
	runId: string;
	briefingId: string;
	agent: string;
	expected: string[];
	producer: boolean;
	/** Item ids delivered in this briefing, so `usedItemIds` / `ignoredItemIds` have a domain. */
	itemIds: string[];
	note: string;
}

export function feedbackRequestFor(agent: string, runId: string, briefingId: string, itemIds: readonly string[]): FeedbackRequest {
	const resolved = resolveAgent(agent);
	const profile = resolved.agent === null ? null : AGENT_PROFILES[resolved.agent];
	return {
		runId,
		briefingId,
		agent: resolved.requested,
		expected: profile === null ? [] : [...profile.feedbackExpected],
		producer: profile?.feedbackProducer ?? false,
		itemIds: [...itemIds],
		note:
			profile === null
				? "no Conclave seat resolved; any spec §22 signal is accepted"
				: profile.feedbackProducer
					? `${profile.displayName} is a principal feedback producer for this run. Nothing here changes ranking: spec §22 forbids online policy updates, and Mnemosia's retrieval path never reads feedback.jsonl.`
					: `${profile.displayName} consumes this briefing; the signals below are the ones her role is positioned to observe. Reporting is optional and never changes ranking.`,
	};
}

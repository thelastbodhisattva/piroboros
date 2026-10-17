// Ported from mnemosia/adapters/contract.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * The source-adapter boundary (spec §10, design §13).
 *
 * Three obligations live here, and they are the reason this is a module rather than an interface
 * declaration:
 *
 * 1. **Normalization.** `buildEnvelope` is the only way an `ArtifactEnvelope` is constructed. Every
 *    adapter goes through it, so `contentHash`, `tokenEstimate` and `integrityStatus` are computed
 *    by one function using one rule, and a new adapter cannot accidentally invent its own.
 * 2. **Integrity that actually ran.** `integrityStatus` is derived from a comparison, never passed
 *    in. `verified` is reachable only by supplying an expected hash that matches the sha256 of the
 *    content in hand; anything else is `unverified` or `failed`. Setting the field to "verified" is
 *    not expressible through this API.
 * 3. **Error translation.** Every provider throw becomes a `StandardAdapterError` with one of five
 *    codes. `runAdapterQuery` wraps a whole query so an adapter author cannot forget, and
 *    `classifyAdapterError` holds the single mapping table from provider failure text to code.
 *
 * `query` is synchronous because all of it is: both foundations are local SQLite read through
 * `node:sqlite`'s synchronous API (design §13). An async signature here would be a promise about
 * concurrency the runtime cannot keep, and it would make the deadline check racy for no gain.
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "../tokens.ts";
import {
	SCHEMA_VERSION,
	type AdapterChannel,
	type AdapterErrorCode,
	type ArtifactEnvelope,
	type IntegrityStatus,
	type IntegrityViolationEntry,
	type PlannedQuery,
	type RetrievalMethod,
	type Scope,
	type SourceId,
	type SourceType,
} from "../types.ts";

/* ------------------------------------------------------------------------------------------------
 * Errors
 * ---------------------------------------------------------------------------------------------- */

/**
 * The one error type that leaves an adapter. It mirrors AkashicForge's `MemoryMutationError`
 * deliberately: a code a caller can branch on without parsing a message, plus the original failure
 * kept on `cause` so nothing is lost for the trace.
 */
export class StandardAdapterError extends Error {
	readonly sourceId: SourceId;
	readonly code: AdapterErrorCode;
	override readonly cause: unknown;

	constructor(sourceId: SourceId, code: AdapterErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "StandardAdapterError";
		this.sourceId = sourceId;
		this.code = code;
		this.cause = cause;
	}
}

export function isStandardAdapterError(value: unknown): value is StandardAdapterError {
	return value instanceof StandardAdapterError;
}

/**
 * Provider failure text → standard code. The concrete failure set is small and enumerated by
 * design §13 (missing DB, missing/invalid key, SQLITE_BUSY past the 5s timeout, schema
 * drift, oversized results), so this is a table over known failures rather than an attempt at
 * general classification: anything unrecognized is honestly `internal`.
 *
 * Order matters. `auth` is tested before `unavailable` because a missing key file raises ENOENT
 * from inside key derivation, and "the source has no key" is an authorization fact, not a
 * "the ledger is down" fact — they lead to different operator actions.
 */
const ERROR_PATTERNS: ReadonlyArray<{ code: AdapterErrorCode; pattern: RegExp }> = [
	{ code: "timeout", pattern: /SQLITE_BUSY|database is locked|busy_?timeout|deadline exceeded|timed? ?out/i },
	{ code: "auth", pattern: /\bkey\b|decrypt|authenticat|security ?domain|unauthori[sz]ed|forbidden|EACCES|EPERM/i },
	{ code: "unavailable", pattern: /unable to open database|SQLITE_CANTOPEN|no such file|ENOENT|not a database|closed|is not open/i },
	{ code: "schema", pattern: /no such table|no such column|schema|must be one of|must be a |malformed|mutually exclusive|unexpected token|JSON/i },
];

export function classifyAdapterError(error: unknown): AdapterErrorCode {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	for (const { code, pattern } of ERROR_PATTERNS) {
		if (pattern.test(text)) return code;
	}
	return "internal";
}

/** Idempotent: an error that is already standardized keeps its code rather than being reclassified. */
export function toAdapterError(sourceId: SourceId, error: unknown): StandardAdapterError {
	if (isStandardAdapterError(error)) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new StandardAdapterError(sourceId, classifyAdapterError(error), `${sourceId}: ${message}`, error);
}

/**
 * Wraps an adapter body so that no provider exception can escape untranslated. Adapters call this
 * rather than each writing their own try/catch, which is what makes "every upstream failure becomes
 * a StandardAdapterError" a property of the boundary instead of a per-adapter promise.
 */
export function runAdapterQuery<T>(sourceId: SourceId, body: () => T): T {
	try {
		return body();
	} catch (error) {
		throw toAdapterError(sourceId, error);
	}
}

/* ------------------------------------------------------------------------------------------------
 * Deadlines
 * ---------------------------------------------------------------------------------------------- */

/**
 * `deadlineMs` is an absolute epoch-ms instant, not a duration. A paging loop that has already
 * spent time reading page 1 must ask "may I still read page 2 *now*", and only an absolute instant
 * answers that without every caller re-deriving it from a start time it would have to remember.
 */
export function deadlineExceeded(deadlineMs: number, now: number = Date.now()): boolean {
	return now >= deadlineMs;
}

export function assertDeadline(sourceId: SourceId, deadlineMs: number, now: number = Date.now()): void {
	if (deadlineExceeded(deadlineMs, now)) {
		throw new StandardAdapterError(sourceId, "timeout", `${sourceId}: deadline exceeded before the query could run`);
	}
}

/* ------------------------------------------------------------------------------------------------
 * Hashing and integrity
 * ---------------------------------------------------------------------------------------------- */

/**
 * Identical to how AkashicForge computes `content_hash` (store.ts:746, `sha256(content, utf8)` in
 * hex). It has to be, or the verification below would be comparing two different functions and
 * would fail on every honest row.
 */
export function sha256Hex(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Recompute and compare. `expected == null` means the source publishes no integrity claim for this
 * artifact — a source may, for instance, store a fingerprint over a redacted canonicalization
 * rather than a content hash — and that is `unverified`, which is a smaller claim than `verified`
 * and a different one from `failed`.
 */
export function verifyContentHash(content: string, expected: string | null | undefined): { computed: string; status: IntegrityStatus } {
	const computed = sha256Hex(content);
	if (expected === null || expected === undefined || expected.length === 0) return { computed, status: "unverified" };
	return { computed, status: computed === expected ? "verified" : "failed" };
}

/* ------------------------------------------------------------------------------------------------
 * Envelope construction
 * ---------------------------------------------------------------------------------------------- */

export interface EnvelopeInput {
	artifactId: string;
	sourceId: SourceId;
	sourceType: SourceType;
	sourceRef: string;
	content: string;
	createdAt: number;
	updatedAt: number;
	observedAt: number;
	scope: Scope;
	taskScope: string | null;
	channel: AdapterChannel;
	retrievalMethod: RetrievalMethod;
	provenance?: unknown[];
	/**
	 * The hash the source stores for this content, if it stores one. Supplying it is what makes
	 * `verified` reachable; omitting it yields `unverified`.
	 */
	expectedContentHash?: string | null;
	/**
	 * Non-hash integrity failures the adapter detected, e.g. a source's declared security domain not matching the expected one. Any entry forces `failed`, and the list is preserved in provenance so the hard
	 * filter's rejection is explainable rather than just a status.
	 */
	integrityViolations?: string[];
	/**
	 * The **source's own** relevance score for the query that produced this artifact, verbatim.
	 *
	 * This is the one field on this input that an adapter may pass through rather than have computed
	 * for it, and the distinction is the point: `integrityStatus` is refused because an adapter
	 * asserting it would be asserting a check it did not run, whereas this number *was* run — by
	 * SQLite, inside the MATCH the adapter issued — and the adapter is only carrying it. It is not
	 * transformed, clamped or sign-flipped here; see `types.ts` on `retrievalScore`. Omit it (or pass
	 * `null`) when the read published no score, which is every recency scan.
	 */
	retrievalScore?: number | null;
}

/**
 * The only constructor for an `ArtifactEnvelope`.
 *
 * Note what it does *not* accept: `integrityStatus`, `contentHash`, `tokenEstimate`,
 * `schemaVersion`, `classification`. Those are computed or constant, so an adapter cannot assert
 * them. `channel` is `AdapterChannel`, so `SYSTEM_POLICY` and `AGENT_POLICY` are rejected by the
 * compiler (types.ts, AdaptersCannotEmitPrivilegedChannels).
 *
 * `retrievalScore` moved off that list when the bm25 foundation change landed, and it is the only
 * one that did. It is not a claim the adapter makes about its own work — it is a number the store
 * computed and used to discard — so passing it through is transport, not assertion. It is still
 * sanitized here rather than trusted.
 */
export function buildEnvelope(input: EnvelopeInput): ArtifactEnvelope {
	const { computed, status } = verifyContentHash(input.content, input.expectedContentHash);
	const violations = input.integrityViolations ?? [];
	const integrityStatus: IntegrityStatus = violations.length > 0 || status === "failed" ? "failed" : status;

	const provenance: unknown[] = [...(input.provenance ?? [])];
	if (integrityStatus === "failed") {
		const entry: IntegrityViolationEntry = {
			kind: "mnemosia/integrity-violation",
			violations: status === "failed" ? [...violations, "content_hash_mismatch"] : violations,
			expectedContentHash: input.expectedContentHash ?? null,
			computedContentHash: computed,
		};
		provenance.push(entry);
	}

	return {
		schemaVersion: SCHEMA_VERSION.artifactEnvelope,
		artifactId: input.artifactId,
		sourceId: input.sourceId,
		sourceType: input.sourceType,
		sourceRef: input.sourceRef,
		contentRef: { inline: input.content },
		contentHash: computed,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		observedAt: input.observedAt,
		scope: input.scope,
		taskScope: input.taskScope,
		classification: "internal",
		channel: input.channel,
		provenance,
		integrityStatus,
		retrievalMethod: input.retrievalMethod,
		// Carried, never invented: `undefined` (the adapter did not offer one) and a non-finite value
		// both collapse to `null`, so a NaN out of a provider can never reach the ranker as a score.
		retrievalScore: typeof input.retrievalScore === "number" && Number.isFinite(input.retrievalScore) ? input.retrievalScore : null,
		tokenEstimate: estimateTokens(input.content),
	};
}

/* ------------------------------------------------------------------------------------------------
 * The adapter interface
 * ---------------------------------------------------------------------------------------------- */

/**
 * The result of `probe()`. It never throws and never carries an exception: a probe exists to let
 * PLAN_RETRIEVAL decide whether a source is worth querying, and a probe that could itself fail the
 * run would defeat the purpose.
 */
export interface AdapterProbe {
	sourceId: SourceId;
	available: boolean;
	/** Human-readable state, e.g. "8 branches, 0 active manifests". Goes straight into the trace. */
	detail: string;
	/** Set when `available` is false, so the planner can record a typed retrieval gap. */
	code: AdapterErrorCode | null;
	latencyMs: number;
}

export interface AdapterResult {
	sourceId: SourceId;
	envelopes: ArtifactEnvelope[];
	/** True when the deadline or `maxArtifacts` cut the read short: the corpus holds more. */
	truncated: boolean;
	/** How many upstream reads it took. 1 for unpaged sources; >1 proves the source paged. */
	pagesRead: number;
	elapsedMs: number;
}

/**
 * A replaceable source. Everything Mnemosia needs from a provider is these three members, and
 * nothing provider-specific appears in any of their types — which is spec §10's actual requirement.
 */
export interface SourceAdapter {
	readonly sourceId: SourceId;
	/** Cheap liveness check. Must not throw. */
	probe(): AdapterProbe;
	/**
	 * Runs the planned query. Throws only `StandardAdapterError`. A zero-envelope result is a normal
	 * success — an empty source is a retrieval gap for the orchestrator to record, not a failure.
	 *
	 * @param deadlineMs absolute epoch-ms instant after which no further upstream read is started.
	 */
	query(plannedQuery: PlannedQuery, deadlineMs: number): AdapterResult;
}

/* ------------------------------------------------------------------------------------------------
 * Shared adapter helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * AkashicForge caps `limit` at 100 (store.ts:398) and validates it as a positive integer, so a
 * planner asking for 400 candidates must be turned into pages rather than into a rejected query.
 */
export const UPSTREAM_PAGE_LIMIT = 100;

export function pageSizeFor(remaining: number): number {
	return Math.max(1, Math.min(UPSTREAM_PAGE_LIMIT, remaining));
}

/**
 * Terms are already tokenized by the planner; joining them with spaces is what AkashicForge's
 * `toSafeMatchQuery` expects and it re-tokenizes anyway, so nothing here can inject FTS operators.
 * Empty terms means "read by recency", which the store expresses as an absent `query`.
 */
export function matchTextOrUndefined(terms: readonly string[]): string | undefined {
	const cleaned = terms.filter((term) => term.trim().length > 0);
	return cleaned.length === 0 ? undefined : cleaned.join(" ");
}

/**
 * Maps Mnemosia's `Scope` onto AkashicForge's `{ scope, project }` filter pair.
 *
 * A project-level scope resolves to "global memories plus this project's" — the store's behaviour
 * when `project` is given without `scope` (store.ts:661) — because that is what a session working
 * in a repository should see. A project-level scope with no project is refused rather than widened
 * to the whole corpus: silently reading every project would be a scope leak, and the planner is
 * responsible for resolving the path before the adapter is called.
 */
export function scopeFilterFor(sourceId: SourceId, scope: Scope): { scope?: "global" | "project"; project?: string } {
	if (scope.level === "global") return { scope: "global" };
	if (scope.project === null || scope.project.length === 0) {
		throw new StandardAdapterError(sourceId, "schema", `${sourceId}: a project-level scope requires scope.project to be resolved`);
	}
	return { project: scope.project };
}

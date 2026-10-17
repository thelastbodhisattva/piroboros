// Ported from mnemosia/trace.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * The run audit log: append-only JSONL at `<root>/<runId>.jsonl` (the caller supplies the root).
 *
 * Design §14 chooses JSONL over SQLite for three reasons this module has to actually deliver, not
 * merely claim: an append survives partial failure without a transaction, the file is diffable for
 * replay, and Mnemosia's storage stays unmistakably derived rather than becoming a second store.
 *
 * The first reason drives the implementation. Each event is serialized, terminated with a newline,
 * and buffered in memory: events flush to disk in one write when 128 accumulate or on
 * `flushTraces()` (session shutdown, and before every trace read so readers never miss buffered
 * lines). Line format is unchanged, so replay stays byte-identical; the batching trades at-most-128
 * events of durability for far fewer open/write/close cycles per run. A crash therefore leaves a file whose every complete line is
 * valid JSON and whose last line may be a fragment; `readTrace` is written to expect exactly that
 * and drop the fragment rather than throw, because a trace that cannot be read after a crash is
 * worthless precisely when it matters most (design §13, "a crash leaves a truncated-but-valid log
 * ending at the failing state").
 *
 * This module writes what it is given. Redaction is the caller's obligation and happens where the
 * content is already being scanned — AkashicForge's `redactSensitive`, applied in filters.ts and
 * brief.ts (build-order steps 9 and 13) — so that the trace never becomes the one path that skips
 * the scanner (design §18, risk 5).
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION, type ArtifactEnvelope, type Claim, type RetrievalState, type TraceEvent, type TraceEventKind } from "./types.ts";
import { CONCLAVE_AGENTS } from "./agents.ts";

/**
 * A runId becomes a path segment, so it is validated rather than trusted. Without this a runId of
 * `../../vault/notes` would write outside the traces directory — the caller supplies runIds, and a
 * caller is not the same thing as a trustworthy one.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function newRunId(): string {
	return randomUUID();
}

export function assertRunId(runId: string): string {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`invalid runId: must match ${RUN_ID_PATTERN.source}`);
	return runId;
}

export function traceFilePath(runId: string, root: string): string {
	return join(root, `${assertRunId(runId)}.jsonl`);
}

/** What a caller supplies; the writer owns `schemaVersion`, `runId`, `seq` and `at`. */
export interface TraceEventInput {
	state: RetrievalState;
	event: TraceEventKind;
	payload?: Record<string, unknown>;
	policyId?: string | null;
	policyVersion?: string | null;
	/** Injectable clock, so tests and the §16 determinism gate are not at the mercy of Date.now. */
	at?: number;
}

export interface TraceWriter {
	readonly runId: string;
	readonly path: string;
	/** Count of events written so far, i.e. the `seq` the next event will take. */
	readonly seq: number;
	/** Appends one line and returns the event exactly as persisted. */
	append(input: TraceEventInput): TraceEvent;
}

/** Events sit in memory until this many accumulate, then flush in one write. */
const TRACE_FLUSH_THRESHOLD = 128;

interface TraceBuffer {
	path: string;
	fd: number | null;
	lines: string[];
}

const openBuffers = new Set<TraceBuffer>();

function flushBuffer(buffer: TraceBuffer): void {
	if (buffer.lines.length === 0) return;
	try {
		buffer.fd ??= openSync(buffer.path, "a");
		writeSync(buffer.fd, buffer.lines.join(""), null, "utf8");
	} finally {
		buffer.lines.length = 0;
	}
}

/**
 * Flushes every buffered trace writer and closes its file handle. Called on session_shutdown, and
 * before any trace read (`readTraceFile`) so explain/replay/`/mnemosia trace` never observe less
 * than what was appended.
 */
export function flushTraces(): void {
	let failure: unknown = undefined;
	for (const buffer of openBuffers) {
		try {
			flushBuffer(buffer);
		} catch (error) {
			failure ??= error;
		} finally {
			if (buffer.fd !== null) try { closeSync(buffer.fd); } catch { /* already closed */ }
			buffer.fd = null;
		}
	}
	openBuffers.clear();
	if (failure !== undefined) throw failure;
}

export interface OpenTraceOptions {
	/** Trace directory. Required: only derived, rebuildable data ever lands here (design §3). */
	root: string;
	now?: () => number;
	/**
	 * Policy in force, stamped onto every event. Set at PLAN_RETRIEVAL via `withPolicy`, because
	 * §12 requires any decision in a replay to be attributable to the policy that produced it.
	 */
	policyId?: string | null;
	policyVersion?: string | null;
}

/**
 * Opens (creates) the run's trace file. The directory is created eagerly rather than on first
 * append so that a permissions problem surfaces at PLAN_RETRIEVAL, when the run can still report
 * it, instead of halfway through EXECUTE_SOURCE_QUERIES.
 */
export function openTrace(runId: string, options: OpenTraceOptions): TraceWriter {
	const root = options.root;
	const path = traceFilePath(runId, root);
	const now = options.now ?? Date.now;
	mkdirSync(root, { recursive: true });

	let seq = 0;
	let policyId = options.policyId ?? null;
	let policyVersion = options.policyVersion ?? null;

	const buffer: TraceBuffer = { path, fd: null, lines: [] };
	openBuffers.add(buffer);

	return {
		runId,
		path,
		get seq() {
			return seq;
		},
		append(input: TraceEventInput): TraceEvent {
			if (input.policyId !== undefined) policyId = input.policyId;
			if (input.policyVersion !== undefined) policyVersion = input.policyVersion;
			const event: TraceEvent = {
				schemaVersion: SCHEMA_VERSION.traceEvent,
				runId,
				seq,
				at: input.at ?? now(),
				state: input.state,
				event: input.event,
				policyId,
				policyVersion,
				payload: input.payload ?? {},
			};
			buffer.lines.push(`${JSON.stringify(event)}\n`);
			// flushTraces() deregisters every buffer; re-register on append so later flushes see it.
			openBuffers.add(buffer);
			// Threshold flush keeps the in-memory bound at ≤128; this is the only buffer bound.
			if (buffer.lines.length >= TRACE_FLUSH_THRESHOLD) flushBuffer(buffer);
			seq += 1;
			return event;
		},
	};
}

export interface TraceReadResult {
	events: TraceEvent[];
	/** Lines that would not parse. Non-zero after a crash mid-append, and worth surfacing. */
	skippedLines: number;
	/** True when the final line was a fragment, i.e. the run died while writing. */
	truncated: boolean;
}

/**
 * Reads a trace file back. Never throws on malformed content: a corrupt line is counted and
 * skipped, because `explainDecision` must still be able to reconstruct the story from whatever
 * survived. A missing file is an empty read, not an error — a run that never opened a trace and a
 * run whose trace was deleted are indistinguishable and both mean "no audit available".
 */
export function readTraceFile(path: string): TraceReadResult {
	// Readers must never miss buffered events: explain/replay read the file while the writing run's
	// buffer may still hold lines (flushTraces is a no-op when nothing is open).
	flushTraces();
	if (!existsSync(path)) return { events: [], skippedLines: 0, truncated: false };
	const raw = readFileSync(path, "utf8");
	if (raw.length === 0) return { events: [], skippedLines: 0, truncated: false };
	const lines = raw.split("\n");
	// A well-formed file ends with a newline, so the final split element is "". Anything else there
	// is the fragment a crash left behind.
	const trailing = lines[lines.length - 1] ?? "";
	const truncated = trailing.length > 0;
	const events: TraceEvent[] = [];
	let skippedLines = 0;
	for (const line of lines) {
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			skippedLines += 1;
			continue;
		}
		if (isTraceEvent(parsed)) events.push(parsed);
		else skippedLines += 1;
	}
	return { events, skippedLines, truncated };
}

export function readTrace(runId: string, root: string): TraceReadResult {
	return readTraceFile(traceFilePath(runId, root));
}

/* ------------------------------------------------------------------------------------------------
 * Cross-agent lineage (Phase D)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Below this share of attributed accepted claims a run's lineage record must be treated as absent by
 * consumers — too much of what a briefing holds cannot be traced to a seat for per-seat reasoning to
 * mean anything. The number itself stays in the trace regardless: an offline evaluation that never
 * sees the misses cannot tell a healthy corpus from an unattributable one.
 */
export const MIN_LINEAGE_COVERAGE = 0.5;

const SPECIALIST_FINDING_TAG_PREFIX = "specialist-finding:";

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collapses the orchestrator's round suffix back to the run the caller actually named — **only** for
 * ids this orchestrator generated.
 *
 * The `<runId>-r<n>` suffix (orchestrator.ts's orchestrateFn) is produced by Mnemosia itself, so the
 * base runId is recoverable with certainty from the request: a suffix counts as orchestrator-generated
 * exactly when `effectiveRunId` equals `requestRunId` plus `-r<digits>`. An arbitrary caller id that
 * merely happens to end in `-r1` (round 0 runs under the caller's id verbatim) does not match its own
 * request id that way, and stays untouched — normalization must never invent a parent a caller did
 * not have.
 */
export function normalizeOrchestratedRunId(effectiveRunId: string, requestRunId: string): string {
	const match = new RegExp(`^${escapeRegExp(requestRunId)}-r\\d+$`, "u").exec(effectiveRunId);
	return match === null ? effectiveRunId : requestRunId;
}

export interface AgentLineageClaim {
	claimId: string;
	/** The Conclave seat whose specialist finding backs this claim, or `null` when none is attributable. */
	producedBy: string | null;
}

export interface AgentLineageRecord {
	schemaVersion: typeof SCHEMA_VERSION.agentLineage;
	/** The seat that requested the run. */
	requestingAgent: string;
	/** The caller's own runId with any orchestrator round suffix removed (see normalizeOrchestratedRunId). */
	parentRunId: string;
	/** Attributed accepted claims ÷ accepted claims; always numeric, threshold-governed for consumers. */
	joinCoverage: number;
	claims: AgentLineageClaim[];
}

/**
 * Reads a specialist finding's producing seat off an envelope's provenance origins.
 *
 * Preference order is deliberate (D3 hardening):
 *
 * 1. **Ledger actor first, for specialist findings.** A provenance entry whose `actor` names a
 *    Conclave seat carries the attribution AkashicForge set at write time from
 *    proposeSpecialistFinding's authenticated submittingSeat — the strongest signal available on the
 *    read surface, so it wins when present on a row already identified as a specialist finding.
 * 2. **Validated tag fallback.** The `specialist-finding:<seat>` tag both identifies a row as a
 *    specialist finding and attributes it when no actor is published; since the general write path
 *    refuses the reserved prefix, a tagged row went through proposeSpecialistFinding. Even so the
 *    seat it names must be a real one — a forged or stale seat value yields no attribution rather
 *    than a lineage entry.
 *
 * First match in sorted order, so multi-tagged rows attribute deterministically rather than by array
 * luck.
 */
function specialistSeatOfEnvelope(envelope: ArtifactEnvelope): string | null {
	// Identify the row as a specialist finding via the validated tag namespace first; a row without
	// one is never attributed, no matter what else its provenance carries.
	let taggedSeat: string | null = null;
	for (const entry of envelope.provenance) {
		if (entry === null || typeof entry !== "object") continue;
		const tags = (entry as { tags?: unknown }).tags;
		if (!Array.isArray(tags)) continue;
		const seats = tags
			.filter((tag): tag is string => typeof tag === "string" && tag.startsWith(SPECIALIST_FINDING_TAG_PREFIX))
			.map((tag) => tag.slice(SPECIALIST_FINDING_TAG_PREFIX.length))
			.filter((seat) => (CONCLAVE_AGENTS as readonly string[]).includes(seat.toLowerCase()))
			.sort();
		if (seats.length > 0) {
			taggedSeat = seats[0].toLowerCase();
			break;
		}
	}
	if (taggedSeat === null) return null;
	// Ledger actor wins over the tag: it is set at write time from the authenticated submittingSeat.
	for (const entry of envelope.provenance) {
		if (entry === null || typeof entry !== "object") continue;
		const actor = (entry as { actor?: unknown }).actor;
		if (typeof actor === "string" && (CONCLAVE_AGENTS as readonly string[]).includes(actor.toLowerCase())) return actor.toLowerCase();
	}
	return taggedSeat;
}

/**
 * Builds the Phase D lineage record over a run's accepted claims.
 *
 * A claim is attributed through its own evidence: if any artifact backing it carries a
 * `specialist-finding:<seat>` tag, that seat produced it. Nothing here reads ranking state or
 * changes selection — this is annotation of the accepted set, computed once, after hard filtering
 * fixed what "accepted" means.
 */
export function buildAgentLineage(input: { claims: readonly Claim[]; envelopes: readonly ArtifactEnvelope[]; requestingAgent: string; effectiveRunId: string; requestRunId: string }): AgentLineageRecord {
	const seatByArtifact = new Map(input.envelopes.map((envelope) => [envelope.artifactId, specialistSeatOfEnvelope(envelope)]));
	let attributed = 0;
	const claims: AgentLineageClaim[] = input.claims.map((claim) => {
		let producedBy: string | null = null;
		for (const evidence of claim.evidence) {
			const seat = seatByArtifact.get(evidence.artifactId);
			if (seat !== null && seat !== undefined) {
				producedBy = seat;
				break;
			}
		}
		if (producedBy !== null) attributed += 1;
		return { claimId: claim.claimId, producedBy };
	});
	return {
		schemaVersion: SCHEMA_VERSION.agentLineage,
		requestingAgent: input.requestingAgent,
		parentRunId: normalizeOrchestratedRunId(input.effectiveRunId, input.requestRunId),
		joinCoverage: claims.length === 0 ? 0 : attributed / claims.length,
		claims,
	};
}

/**
 * Structural check on a parsed line. Deliberately shallow: it validates the envelope fields a
 * reader indexes by (`runId`, `seq`, `state`, `event`) and leaves `payload` alone, because payload
 * shapes are owned by the module that emitted them and will keep growing.
 */
function isTraceEvent(value: unknown): value is TraceEvent {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.schemaVersion === SCHEMA_VERSION.traceEvent &&
		typeof candidate.runId === "string" &&
		typeof candidate.seq === "number" &&
		typeof candidate.at === "number" &&
		typeof candidate.state === "string" &&
		typeof candidate.event === "string" &&
		typeof candidate.payload === "object" &&
		candidate.payload !== null
	);
}

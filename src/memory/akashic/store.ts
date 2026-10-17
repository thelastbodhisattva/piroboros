// Ported from akashic-forge/store.ts @ f0a8ad4 (MIT; see NOTICE)
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REDACTION_MARKER, redactJsonValue, redactSensitive } from "../../redact.ts";
import { isCharacterRule, scanMemoryText } from "./scanner.ts";

// The scrub is pure and lives in src/redact.ts; re-exported so store consumers keep one import site.
export { REDACTION_MARKER, redactJsonValue, redactSensitive };
export const MAX_MEMORY_CHARS = 4_000;
/** Raw content budget per chunk of a size-aware write; the rest of the per-record cap is marker headroom. */
export const CHUNK_CONTENT_CHARS = 3_600;
/** A write within this many characters of the per-memory cap is flagged nearLimit. */
export const NEAR_MEMORY_LIMIT_CHARS = 400;
// Corpus size is decoupled from injection size: index.ts bounds the session-start snapshot with its
// own MAX_INJECTED_CHARS, so these ceilings only govern how much curated memory may exist at rest.
export const GLOBAL_MEMORY_CHAR_LIMIT = 16_000;
export const PROJECT_MEMORY_CHAR_LIMIT = 32_000;
/** §18.1 unit-of-measure ruling: CHARS everywhere — L0 head ≤ 256 chars, L1 head ≤ 2,048 + tail ≤ 512. */
export const DISCLOSURE_HEAD_CHARS = 256;
export const DISCLOSURE_L1_HEAD_CHARS = 2_048;
export const DISCLOSURE_L1_TAIL_CHARS = 512;

/**
 * Schema axis 2 of 2: the store schema version, a meta row in `store_meta` (NOT `PRAGMA
 * user_version`, which stays 0 and is not an axis — the same distinction the frozen P6 contract
 * documents for the compaction ledger). Validated on open: a database stamped with a NEWER version
 * refuses to open (downgrade would misread newer rows); a stamp older than this build's is the
 * migration window, which has always been the additive CREATE/ALTER discipline in the constructor.
 * Bump semantics: additive table/column additions are MINOR (forward-openable by older builds only
 * if they tolerate unknown columns — they do not, so a MINOR bump still refuses older builds);
 * incompatible changes are MAJOR. Both axes are separate compatibility axes.
 */
// store-schema@2 (G5/SEM1): MINOR bump per §7. The extra tables that motivated it are not part of this
// port; the stamp is kept so a stamped database opens identically.
export const STORE_SCHEMA_VERSION = "akashic-forge/store-schema@2";

/**
 * Forward-migration ladder for the store-schema axis. An entry `<from> → <to>`
 * declares that a store stamped `<from>` can be brought up to `<to>` by this
 * build's constructor ALONE — every step must be an additive MINOR bump whose
 * DDL the idempotent ensureSchema block (CREATE IF NOT EXISTS / ALTER-if-
 * missing, run BEFORE the version check) has already applied by the time the
 * ladder runs, so the migration proper is stamping the meta row forward.
 * Anything not reachable through the ladder — a genuinely unknown version, a
 * downgrade, an incompatible MAJOR — still refuses loudly. A cycle in this
 * literal map is a programming error and refuses rather than loops.
 */
const SCHEMA_MIGRATIONS: ReadonlyMap<string, string> = new Map([
	// G5/SEM1 (store-schema@1 → @2): stamp only; the tables it added are not part of this port.
	["akashic-forge/store-schema@1", "akashic-forge/store-schema@2"],
]);

export interface MemoryLimits {
	global: number;
	project: number;
}

export const DEFAULT_MEMORY_LIMITS: Readonly<MemoryLimits> = { global: GLOBAL_MEMORY_CHAR_LIMIT, project: PROJECT_MEMORY_CHAR_LIMIT };

/** A limit below the per-memory cap could never admit a single memory, so it is treated as nonsense. */
function limitOverride(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= MAX_MEMORY_CHARS ? value : fallback;
}

/** limits.json lives beside the database it governs, so a copied database carries its own limits. */
export function defaultLimitsPathFor(databasePath: string): string | undefined {
	return databasePath === ":memory:" ? undefined : join(dirname(databasePath), "limits.json");
}

/**
 * Optional `limits.json` beside the database, shaped `{ "global": 16000, "project": 32000 }`.
 * This resolves in the AkashicStore constructor at session start, so it fails open in every direction:
 * a missing, unreadable, malformed, or nonsensical file degrades to the built-in defaults rather
 * than throwing, because a throw here would leave the user with no memory at all.
 */
export function resolveMemoryLimits(limitsPath: string | undefined): MemoryLimits {
	try {
		if (!limitsPath || !existsSync(limitsPath)) return { ...DEFAULT_MEMORY_LIMITS };
		// Strip a UTF-8 BOM: Windows editors add one, and JSON.parse rejects it, which would
		// silently discard a valid override instead of applying it.
		const parsed: unknown = JSON.parse(readFileSync(limitsPath, "utf8").replace(/^\u{FEFF}/u, ""));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_MEMORY_LIMITS };
		const value = parsed as Record<string, unknown>;
		return { global: limitOverride(value.global, GLOBAL_MEMORY_CHAR_LIMIT), project: limitOverride(value.project, PROJECT_MEMORY_CHAR_LIMIT) };
	} catch {
		return { ...DEFAULT_MEMORY_LIMITS };
	}
}

export type MemoryScope = "global" | "project";
export type ScopeFilter = MemoryScope | "all";

export const MemoryKind = {
	Decisions: "decisions",
	People: "people",
	ProjectState: "project-state",
	OpenLoops: "open-loops",
	Preferences: "preferences",
	Procedures: "procedures",
} as const;

export type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];
export const MEMORY_KINDS = Object.values(MemoryKind) as MemoryKind[];

export function validateKind(kind: unknown): MemoryKind {
	if (typeof kind === "string" && (MEMORY_KINDS as string[]).includes(kind)) return kind as MemoryKind;
	throw new Error(`kind must be one of: ${MEMORY_KINDS.join(", ")}`);
}

export const MEMORY_STATES = ["PROPOSED", "ACTIVE", "DISPUTED", "SUPERSEDED", "EXPIRED", "REVOKED", "QUARANTINED", "DELETED"] as const;

export type MemoryState = (typeof MEMORY_STATES)[number];

/**
 * ACTIVE is the hub: a memory enters through it and every other state is reached from it.
 * DISPUTED, SUPERSEDED, and EXPIRED are reversible because a conflict can be resolved in the
 * memory's favour, a superseding memory can itself be revoked, and an expiry can be renewed.
 * QUARANTINED returns only to ACTIVE, after review. REVOKED and DELETED are terminal so an
 * audited end state is never quietly reopened. Self-transitions are absent: re-asserting the
 * current state is not a transition.
 */
export const MEMORY_STATE_TRANSITIONS: Readonly<Record<MemoryState, readonly MemoryState[]>> = {
	PROPOSED: ["ACTIVE", "REVOKED", "QUARANTINED", "DELETED"],
	ACTIVE: ["DISPUTED", "SUPERSEDED", "EXPIRED", "REVOKED", "QUARANTINED", "DELETED"],
	DISPUTED: ["ACTIVE", "SUPERSEDED", "EXPIRED", "REVOKED", "QUARANTINED", "DELETED"],
	SUPERSEDED: ["ACTIVE", "REVOKED", "QUARANTINED", "DELETED"],
	EXPIRED: ["ACTIVE", "SUPERSEDED", "REVOKED", "QUARANTINED", "DELETED"],
	QUARANTINED: ["ACTIVE", "REVOKED", "DELETED"],
	REVOKED: [],
	DELETED: [],
};

/** States a caller sees by default; unresolved conflicts stay visible, the rest is history. */
export const RETRIEVABLE_MEMORY_STATES: readonly MemoryState[] = ["ACTIVE", "DISPUTED"];

export function validateState(state: unknown): MemoryState {
	if (typeof state === "string" && (MEMORY_STATES as readonly string[]).includes(state)) return state as MemoryState;
	throw new Error(`state must be one of: ${MEMORY_STATES.join(", ")}`);
}

export function assertMemoryTransition(from: unknown, to: unknown): MemoryState {
	const source = validateState(from);
	const target = validateState(to);
	const allowed = MEMORY_STATE_TRANSITIONS[source];
	if (allowed.length === 0) throw new Error(`invalid memory transition ${source} -> ${target}: ${source} is terminal`);
	if (!allowed.includes(target)) throw new Error(`invalid memory transition ${source} -> ${target}; allowed from ${source}: ${allowed.join(", ")}`);
	return target;
}

export interface MemoryInput {
	content: string;
	kind?: MemoryKind;
	scope?: MemoryScope;
	project?: string;
	tags?: string[];
	importance?: number;
	/**
	 * G8/PROMO1 (§19.1): the pre-built provenance object(s) a promotion carries onto the memory row.
	 * Threaded through BOTH insertMemory INSERT statements so the object lands in the row inside the
	 * caller's transaction; existing callers omit it and take the DDL default `'[]'` unchanged.
	 */
	provenance?: unknown[];
}

export interface MemoryUpdate {
	content?: string;
	kind?: MemoryKind;
	scope?: MemoryScope;
	project?: string;
	tags?: string[];
	importance?: number;
	// Governance fields are omitted by ordinary content edits and written only by a caller that has
	// already validated the lifecycle transition; an absent key always leaves the stored value alone.
	state?: MemoryState;
	version?: number;
	expiresAt?: number | null;
	supersedes?: string | null;
	provenance?: unknown[];
}

export interface MemoryRecord {
	id: string;
	kind: MemoryKind;
	content: string;
	scope: MemoryScope;
	project: string | null;
	tags: string[];
	importance: number;
	state: MemoryState;
	version: number;
	provenance: unknown[];
	expiresAt: number | null;
	supersedes: string | null;
	createdAt: number;
	updatedAt: number;
	/** The persisted integrity hash. Every store read carries it; a record parsed from vault Markdown has never been hashed by the store. */
	contentHash?: string;
	duplicate?: boolean;
	/** Set when this record is one part of a size-aware chunked write; the parts join, in order, into the original content. */
	memoryGroupId?: string | null;
	part?: number | null;
	parts?: number | null;
	/** Present on every record of a chunked write; absent for an ordinary single-record memory. */
	chunked?: boolean;
	/**
	 * FTS5's own `bm25()` relevance score for the query that produced this row, when one did.
	 *
	 * Present **only** on rows returned by a full-text path (`searchMemories`); absent on every
	 * recency, id and scan read, because bm25 is undefined without a MATCH. The value is SQLite's
	 * raw output and is therefore **negative, with a more negative number meaning a better match**,
	 * and it is a *per-query, per-index* quantity: its scale is set by the IDF of the query's terms
	 * over this index, so two scores produced by different queries are not directly comparable. The
	 * store deliberately does not normalize it — normalization requires knowing what the caller is
	 * comparing, and inventing a scale here would be the store ranking on the caller's behalf, which
	 * `api.ts` says it must never do.
	 */
	rank?: number;
}

/** The machine-managed lifecycle half of a record: the half the database, not the vault, owns. */
export type MemoryGovernance = Pick<MemoryRecord, "state" | "version" | "provenance" | "expiresAt" | "supersedes">;

/**
 * A record as a vault file states it. serializeMemory omits a governance key that sits at its default,
 * so an absent key is not an assertion of that default: it means the Markdown has no opinion and the
 * stored row keeps its value. A key that is present is the human's override and wins.
 */
export type VaultMemoryRecord = Omit<MemoryRecord, keyof MemoryGovernance> & Partial<MemoryGovernance>;

/**
 * Merge governance the vault stated over governance the database holds. Absent keys keep the stored
 * value; a row the store has never seen takes the column defaults. This is what lets a governed
 * mutation survive the reconcile that runs at every session start.
 */
export function resolveGovernance(stated: Partial<MemoryGovernance>, current?: MemoryGovernance): MemoryGovernance {
	return {
		state: stated.state ?? current?.state ?? "ACTIVE",
		// version and provenance invert the precedence used by the rest of this merge. They are machine
		// bookkeeping - an optimistic-concurrency counter and store-observed evidence - so a stored row
		// outranks anything a vault file says: honouring a hand-written version would peg the row, every
		// mutation would bump the store, and the next reconcile would drop it back, permanently breaking
		// expectedVersion. With no stored row the vault is the only source and its values are taken,
		// which is what lets a vault restored onto a fresh machine keep its versions instead of
		// resetting to 1. Canonicalization passes no current row, so it still echoes the file verbatim.
		version: current?.version ?? stated.version ?? 1,
		provenance: current?.provenance ?? stated.provenance ?? [],
		expiresAt: stated.expiresAt === undefined ? (current?.expiresAt ?? null) : stated.expiresAt,
		supersedes: stated.supersedes === undefined ? (current?.supersedes ?? null) : stated.supersedes,
	};
}

export interface MutationInput {
	memoryId: string;
	idempotencyKey: string;
	actor: string;
	fromState: MemoryState;
	toState: MemoryState;
	reason?: string;
	prevVersion?: number | null;
	newVersion?: number | null;
	policyVersion?: string | null;
	details?: Record<string, unknown>;
	timestamp?: number;
}

export interface MutationRecord {
	id: number;
	memoryId: string;
	idempotencyKey: string;
	actor: string;
	reason: string | null;
	transition: string;
	prevVersion: number | null;
	newVersion: number | null;
	policyVersion: string | null;
	createdAt: number;
	details: Record<string, unknown>;
	duplicate?: boolean;
}

export interface MemoryUsage {
	scope: MemoryScope;
	project: string | null;
	usedChars: number;
	limitChars: number;
	remainingChars: number;
	percentage: number;
	entries: number;
	needsConsolidation: boolean;
}

// -------------------------------------------------------------------------------------------
// G7/PROG1 (§18): progressive disclosure types. Disclosure levels are READ-TIME projections of
// durable state, never written back (§18.0 binding invariant); the disclosure unit is the
// LOGICAL RECORD — the memory_group_id group, with a NULL-group row as its own group (§18.3
// groupless-row rule). All windows count UTF-16 characters (§18.1 unit-of-measure ruling).
// -------------------------------------------------------------------------------------------

export type DisclosureLevel = "L0" | "L1" | "L2";

/** §18.2: the same bookkeeping field set on the memory plane, where row ids are strings. */
export interface MemoryDisclosureBookkeeping {
	disclosureLevel: "L0" | "L1";
	contentOffset: number;
	contentLimit: number;
	fullLength: number;
	reassembled: false;
	partCount: number;
	firstPartId: string;
}

/** A MemoryRecord projected to its L0/L1 window over the group's RAW space (§18.1 memory-plane scope). */
export type MemoryRecordDisclosureRow = MemoryRecord & MemoryDisclosureBookkeeping;

export interface SearchOptions {
	query: string;
	scope?: ScopeFilter;
	project?: string;
	limit?: number;
	includeAllStates?: boolean;
}

export interface SearchResult {
	source: "memory";
	id: string;
	content: string;
	scope: MemoryScope;
	project: string | null;
	kind?: string;
	tags?: string[];
	importance?: number;
	createdAt: number;
	updatedAt?: number;
	truncated?: boolean;
}

export interface RecentOptions {
	scope?: ScopeFilter;
	project?: string;
	limit?: number;
	includeAllStates?: boolean;
}

export interface RecentResult extends SearchResult {}

export interface StoreStats {
	databasePath: string;
	memories: number;
	globalMemories: number;
	projectMemories: number;
	memoriesByKind: Record<string, number>;
	memoryFtsRows: number;
	/** §18.6 reassembly counter: full-group reassemblies (getMemoryGroup) since this store instance opened. Per-instance, in-memory. */
	reassembly: number;
	memoryUsage: {
		global: MemoryUsage;
		project?: MemoryUsage;
		/** Every project scope that holds memory, so corpus shape is visible without guessing paths. */
		projects: MemoryUsage[];
	};
}

export interface ConsolidateInput {
	ids: string[];
	content?: string;
	kind?: MemoryKind;
	scope?: MemoryScope;
	project?: string;
	tags?: string[];
	importance?: number;
}

export interface ConsolidateResult {
	memory: MemoryRecord;
	removedIds: string[];
}

/** Size-aware write observability: what a remember() did to the caller's content, and why. */
export interface MemoryWriteStatus {
	/** Character count of the original content after redaction and safety validation, before chunking. */
	contentLength: number;
	/** The per-record character cap that triggered chunking (or did not). */
	contentLimit: number;
	/** How many characters of headroom the content has below the cap. */
	contentRemaining: number;
	/** True when the content sits within NEAR_MEMORY_LIMIT_CHARS of the cap. */
	nearLimit: boolean;
	/** True when the content was split into multiple records; false for an ordinary single record. */
	chunked: boolean;
	/** Present when chunked: the deterministic group id and the part count. */
	memoryGroupId?: string;
	parts?: number;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value;
}

/** The one safety check (F1). Write, update, import, render and the mnemosia filters all reach the scanner through here. */
export function validateMemorySafety(value: unknown): string {
	const raw = text(value, "content");
	const rule = scanMemoryText(raw);
	if (rule !== undefined) throw new Error(isCharacterRule(rule) ? "memory content rejected: invisible Unicode is not allowed" : "memory content rejected by the prompt-injection/exfiltration safety scanner");
	return redactSensitive(raw);
}

export function validateMemoryContent(value: unknown): string {
	const content = validateMemorySafety(value);
	if (content.length > MAX_MEMORY_CHARS) {
		throw new Error(`memory content exceeds ${MAX_MEMORY_CHARS} characters; consolidate or shorten it before retrying`);
	}
	return content;
}

function normalizeProject(project: string): string {
	const normalized = resolve(project.trim());
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectKey(project: string | null | undefined): string {
	return project ? normalizeProject(project) : "";
}

function validateProject(project: string | null | undefined, scope: MemoryScope): string | null {
	if (scope === "project") return normalizeProject(text(project, "project"));
	return null;
}

function validateScope(scope: unknown): MemoryScope {
	if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
	return scope;
}

function memoryLimit(limits: MemoryLimits, scope: MemoryScope): number {
	return scope === "global" ? limits.global : limits.project;
}

function validateFilter(scope: ScopeFilter | undefined): ScopeFilter {
	if (scope === undefined || scope === "all" || scope === "global" || scope === "project") return scope ?? "all";
	throw new Error("scope must be all, global, or project");
}

function limitValue(value: number | undefined, fallback = 20): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1) throw new Error("limit must be a positive integer");
	return Math.min(value, 100);
}

function importanceValue(value: number | undefined): number {
	if (value === undefined) return 5;
	if (!Number.isInteger(value) || value < 0 || value > 10) throw new Error("importance must be an integer from 0 to 10");
	return value;
}

function tagsValue(value: string[] | undefined): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) throw new Error("tags must be strings");
	return [...new Set(value.map((tag) => redactSensitive(tag.trim())).filter(Boolean))].slice(0, 20);
}

function versionValue(value: number | undefined, field = "version"): number {
	if (value === undefined) return 1;
	if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
	return value;
}

function provenanceValue(value: unknown[] | undefined): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("provenance must be an array");
	const redacted = redactJsonValue(value) as unknown[];
	try {
		JSON.stringify(redacted);
	} catch {
		throw new Error("provenance must be JSON-serializable");
	}
	return redacted;
}

function expiresAtValue(value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isFinite(value)) throw new Error("expires_at must be a finite timestamp");
	return value;
}

function supersedesValue(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	return redactSensitive(text(value, "supersedes"));
}

export interface ContentChunk {
	/** The chunk's slice of the original content: byte-exact, never rewritten or truncated. */
	content: string;
	part: number;
	parts: number;
}

/**
 * The deterministic, boundary-aware chunker behind the size-aware write policy.
 *
 * AkashicForge may automatically restructure memory to satisfy storage constraints, but it must not
 * silently destroy or semantically rewrite memory at the storage boundary: every chunk is a raw,
 * lossless slice of the original content, and concatenating all chunks reproduces it byte-for-byte.
 * Redaction and the safety scanner run on the whole content before this chunker ever sees it, so the
 * same scanner verdict covers every chunk it emits.
 *
 * Boundaries, coarsest first: paragraph (blank-line run), then sentence, then any whitespace, then a
 * hard character cut. A boundary is preferred to a mid-word cut whenever one exists within the
 * budget; the hard cut exists so pathological input — one enormous word, no whitespace at all —
 * still chunks instead of throwing.
 */
export function chunkContent(content: string, maxChars = CHUNK_CONTENT_CHARS): ContentChunk[] {
	if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");
	if (content.length <= maxChars) return [{ content, part: 1, parts: 1 }];
	const chunks: string[] = [];
	let start = 0;
	// A greedy accumulation: pack each chunk as full as its best boundary allows, because fewer
	// records per group is better for retrieval and for the per-scope capacity budget.
	while (start < content.length) {
		if (content.length - start <= maxChars) {
			chunks.push(content.slice(start));
			break;
		}
		const window = content.slice(start, start + maxChars);
		// Coarse-to-fine: the last blank-line run, sentence end, or whitespace inside the window wins;
		// every boundary index is relative to `start`.
		const boundary = (() => {
			// A blank-line run ends at its last character, and the whole run stays with the chunk it ends,
			// so the next chunk opens on content rather than on a separator. `boundary` is the index of the
			// last character to include, which every other case below follows as well.
			const lf = window.lastIndexOf("\n\n");
			const crlf = window.lastIndexOf("\r\n\r\n");
			const paragraph = Math.max(lf >= 0 ? lf + 1 : -1, crlf >= 0 ? crlf + 3 : -1);
			if (paragraph >= 0) return paragraph;
			const sentence = /[.!?…][ \t\r\n]/gu;
			let sentenceEnd = -1;
			let match: RegExpExecArray | null;
			while ((match = sentence.exec(window)) !== null) sentenceEnd = match.index + match[0].length - 1;
			if (sentenceEnd >= 0) return sentenceEnd;
			const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"), window.lastIndexOf("\n"), window.lastIndexOf("\r"));
			if (space >= 0) return space;
			return -1;
		})();
		// No boundary at all (one enormous word): a hard cut. A boundary that lands exactly at the
		// budget is taken; one past it falls back to the hard cut rather than exceeding the cap.
		let cut = boundary >= 0 ? start + boundary + 1 : start + maxChars;
		// A hard cut must not land between the two halves of a surrogate pair.
		if (boundary < 0 && cut < content.length) {
			const last = content.charCodeAt(cut - 1);
			if (last >= 0xd800 && last <= 0xdbff && cut - 1 > start) cut -= 1;
		}
		chunks.push(content.slice(start, cut));
		start = cut;
	}
	if (chunks.length === 1) return [{ content, part: 1, parts: 1 }];
	return chunks.map((chunk, index) => ({ content: chunk, part: index + 1, parts: chunks.length }));
}

/** The deterministic group id for a chunked write: same full original content, kind, and tags in, same id out. */
export function memoryGroupId(content: string, kind: MemoryKind, tags: readonly string[]): string {
	const canonical = [content, kind, [...tags].sort().join("\u001f")].join("\u001f");
	return `grp-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** The group id format every layer agrees on: `grp-` plus a SHA-256 hex digest. */
export const MEMORY_GROUP_ID_RE = /^grp-[0-9a-f]{64}$/;

/**
 * Prepend a chunk's structural markers: a `[part N/M] [group: id]` line on every part, plus a
 * `split across` note on part 1 so a reader who only ever sees one file knows the memory is split.
 * The markers cost the headroom CHUNK_CONTENT_CHARS leaves below MAX_MEMORY_CHARS.
 */
function decorateChunk(chunk: ContentChunk, groupId: string): string {
	const header = `[part ${chunk.part}/${chunk.parts}] [group: ${groupId}]`;
	return chunk.part === 1 ? `${header}\n[split across ${chunk.parts} parts; retrieve group ${groupId}]\n${chunk.content}` : `${header}\n${chunk.content}`;
}

/**
 * Undo decorateChunk by exact prefix match, so a raw slice that itself begins with a marker-looking
 * line is never eaten: only the exact lines this store generated are stripped. A human-edited body
 * degrades visibly (its marker line survives) rather than silently losing a content line.
 */
function rawChunkContent(memory: Pick<MemoryRecord, "content" | "part" | "parts" | "memoryGroupId">): string {
	let content = memory.content;
	if (memory.part === null || memory.parts === null || memory.memoryGroupId === null) return content;
	const marker = `[part ${memory.part}/${memory.parts}] [group: ${memory.memoryGroupId}]`;
	if (content.startsWith(`${marker}\n`)) content = content.slice(marker.length + 1);
	if (memory.part === 1) {
		const note = `[split across ${memory.parts} parts; retrieve group ${memory.memoryGroupId}]`;
		if (content.startsWith(`${note}\n`)) content = content.slice(note.length + 1);
	}
	return content;
}

/** Reassemble a group's parts into the exact original content: raw slices, in part order, joined. */
export function reassembleGroup(records: readonly MemoryRecord[]): string {
	return [...records]
		.filter((memory) => memory.part !== null)
		.sort((a, b) => (a.part ?? 0) - (b.part ?? 0))
		.map(rawChunkContent)
		.join("");
}

// -------------------------------------------------------------------------------------------
// G7/PROG1 (§18) module machinery: disclosure validation, the RAW-space boundary map entry, and
// the part-intersection window slice. Raw lengths are computed IN JS from the read content
// (§18.3 code-point ruling: SQLite LENGTH counts code points, not UTF-16 units, so astral-plane
// content diverges and SQL LENGTH is never used for raw-length arithmetic); the decoration
// prefix is stripped via rawChunkContent, the exact inverse of decorateChunk.
// -------------------------------------------------------------------------------------------

/** One part of a logical record's RAW-space boundary map: the stripped raw slice plus its cumulative offsets. */
interface RawGroupEntry<TId> {
	id: TId;
	/** The part's raw content (decoration prefix stripped). */
	raw: string;
	/** Raw length in UTF-16 characters, from `raw.length` in JS — never SQL LENGTH. */
	rawLength: number;
	/** Raw-space offset of this part's first character. */
	start: number;
	/** Raw-space offset one past this part's last character. */
	end: number;
}

/**
 * §18.1/§18.3 window slice over a boundary map: assembles exactly the parts whose raw ranges
 * intersect [start, start + length) — the part-intersection rule for L0 heads, L1 head/tail
 * windows, and L2 slices alike. The map's contents are already in memory, so this is a pure
 * re-slice with no second read.
 */
function rawWindow<TId>(map: readonly RawGroupEntry<TId>[], start: number, length: number): string {
	if (length <= 0 || map.length === 0) return "";
	const end = start + length;
	let out = "";
	for (const entry of map) {
		if (entry.end <= start) continue;
		if (entry.start >= end) break;
		const from = Math.max(0, start - entry.start);
		const to = Math.min(entry.rawLength, end - entry.start);
		if (to > from) out += entry.raw.slice(from, to);
	}
	return out;
}

/** Convert free text into literal FTS5 terms; operators and punctuation never reach MATCH. */
export function tokenizeSearch(value: string): string[] {
	text(value, "query");
	const tokens = value.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
	return [...new Set(tokens.filter((token) => /[\p{L}\p{N}_]/u.test(token)).map((token) => token.slice(0, 128)))].slice(0, 32);
}

export function toSafeMatchQuery(value: string): string {
	const tokens = tokenizeSearch(value);
	if (tokens.length === 0) throw new Error("query must contain searchable text");
	return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
}

function parseMetadata(value: unknown): Record<string, unknown> {
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function rowString(row: Record<string, unknown>, key: string): string {
	return String(row[key] ?? "");
}

function rowNumber(row: Record<string, unknown>, key: string): number {
	return Number(row[key] ?? 0);
}

/**
 * The `bm25()` column, when the query that produced this row asked for one.
 *
 * Additive by construction: every non-FTS read selects no such column, so the key is absent and the
 * record is byte-for-byte what it was before. `Number.isFinite` rather than a bare cast because a
 * row from any other origin must not be able to smuggle a NaN into a relevance field.
 */
function rankFromRow(row: Record<string, unknown>): { rank?: number } {
	const value = row[BM25_COLUMN_ALIAS];
	return typeof value === "number" && Number.isFinite(value) ? { rank: value } : {};
}

/**
 * Group fields off a row, additive exactly as `rank` is: a row that predates the size-aware write
 * policy (or a vault record without group frontmatter) carries NULL columns, and NULL means "not a
 * chunk part", which is stated by the key's absence — never by a `null` value — so the record
 * shape of an ordinary memory stays byte-for-byte what it was before the columns existed.
 */
function groupFromRow(row: Record<string, unknown>): { memoryGroupId?: string; part?: number; parts?: number } {
	const groupId = row.memory_group_id;
	if (groupId === null || groupId === undefined || !groupId) return {};
	return { memoryGroupId: String(groupId), part: rowNumber(row, "part"), parts: rowNumber(row, "parts") };
}

function parseProvenance(value: unknown): unknown[] {
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Where `bm25()` lands in an FTS row. Aliased rather than named `rank` because `rank` is a reserved
 * FTS5 column name, and a column list that shadowed it would be a trap for the next reader.
 */
const BM25_COLUMN_ALIAS = "bm25_rank";

const MEMORY_COLUMN_NAMES = ["id", "kind", "content", "content_hash", "scope", "project", "tags", "importance", "state", "version", "expires_at", "supersedes", "provenance", "memory_group_id", "part", "parts", "created_at", "updated_at"] as const;
const MUTATION_COLUMNS = "id, memory_id, idempotency_key, actor, reason, transition, prev_version, new_version, policy_version, created_at, details_json";
/** One column list for every memory read, so a new governance column can never be missed. */
function memoryColumns(alias?: string): string {
	return MEMORY_COLUMN_NAMES.map((column) => (alias ? `${alias}.${column}` : column)).join(", ");
}

/** The lossy projection the tool renders; full records stay available through the typed read paths. */
function memoryResult(memory: MemoryRecord): SearchResult {
	return { source: "memory", id: memory.id, kind: memory.kind, content: memory.content, scope: memory.scope, project: memory.project, tags: memory.tags, importance: memory.importance, createdAt: memory.createdAt, updatedAt: memory.updatedAt };
}

/** Unresolved conflicts stay visible by default; every other state is history a caller opts into. */
function stateWhere(alias: string, includeAllStates: boolean | undefined): string {
	if (includeAllStates === true) return "1 = 1";
	return `${alias}.state IN (${RETRIEVABLE_MEMORY_STATES.map((state) => `'${state}'`).join(", ")})`;
}

export class AkashicStore {
	readonly path: string;
	/** Resolved once per open, so the write path can never validate against different ceilings. */
	readonly limits: MemoryLimits;
	private readonly db: DatabaseSync;
	private depth = 0;
	/** §18.6 reassembly counter: incremented by getMemoryGroup only (listMemoriesByGroup returns parts and the
	 * consolidation path re-chunks). Per store instance; readable via stats().reassembly. */
	private reassemblyCount = 0;

	constructor(databasePath: string, limitsPath: string | undefined = defaultLimitsPathFor(databasePath)) {
		this.path = databasePath;
		this.limits = resolveMemoryLimits(limitsPath);
		if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
		this.db = new DatabaseSync(databasePath);
		this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memories (
				rowid INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				kind TEXT NOT NULL DEFAULT 'project-state',
				scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
				project TEXT,
				project_key TEXT NOT NULL,
				content TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				tags TEXT NOT NULL DEFAULT '[]',
				importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 0 AND 10),
				version INTEGER NOT NULL DEFAULT 1,
				state TEXT NOT NULL DEFAULT 'ACTIVE',
				expires_at INTEGER,
				supersedes TEXT,
				provenance TEXT NOT NULL DEFAULT '[]',
				memory_group_id TEXT,
				part INTEGER,
				parts INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_content ON memories(scope, project_key, content_hash);
			CREATE INDEX IF NOT EXISTS memories_scope_updated ON memories(scope, project_key, updated_at DESC);
			CREATE TABLE IF NOT EXISTS memory_mutations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				memory_id TEXT NOT NULL,
				idempotency_key TEXT NOT NULL UNIQUE,
				actor TEXT NOT NULL,
				reason TEXT,
				transition TEXT NOT NULL,
				prev_version INTEGER,
				new_version INTEGER,
				policy_version TEXT,
				created_at INTEGER NOT NULL,
				details_json TEXT NOT NULL DEFAULT '{}'
			);
			CREATE INDEX IF NOT EXISTS memory_mutations_memory ON memory_mutations(memory_id, id DESC);
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, tokenize = 'unicode61 remove_diacritics 2');
			CREATE TABLE IF NOT EXISTS store_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
		// Governance columns are bolted on exactly the way `kind` was: an additive ALTER TABLE with a
		// constant default, so an existing database backfills in place and re-running is a no-op.
		const columns = new Set(this.db.prepare("PRAGMA table_info(memories)").all().map((column) => rowString(column, "name")));
		if (!columns.has("kind")) this.db.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'project-state'");
		if (!columns.has("version")) this.db.exec("ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
		if (!columns.has("state")) this.db.exec("ALTER TABLE memories ADD COLUMN state TEXT NOT NULL DEFAULT 'ACTIVE'");
		if (!columns.has("expires_at")) this.db.exec("ALTER TABLE memories ADD COLUMN expires_at INTEGER");
		if (!columns.has("supersedes")) this.db.exec("ALTER TABLE memories ADD COLUMN supersedes TEXT");
		if (!columns.has("provenance")) this.db.exec("ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT '[]'");
		// Size-aware write policy: group columns are additive with NULL/absent defaults, so an old
		// row (or a whole old database) backfills as an ordinary unchunked memory and keeps loading.
		if (!columns.has("memory_group_id")) this.db.exec("ALTER TABLE memories ADD COLUMN memory_group_id TEXT");
		if (!columns.has("part")) this.db.exec("ALTER TABLE memories ADD COLUMN part INTEGER");
		if (!columns.has("parts")) this.db.exec("ALTER TABLE memories ADD COLUMN parts INTEGER");
		this.db.exec("CREATE INDEX IF NOT EXISTS memories_group ON memories(memory_group_id, part ASC)");
		try {
			this.validateStoreSchemaVersion();
		} catch (error) {
			// A refused open must not leak the connection it opened while discovering the mismatch.
			this.db.close();
			throw error;
		}
	}

	/**
	 * The DB-level schema axis (STORE_SCHEMA_VERSION, a store_meta row). A fresh or pre-axis database
	 * gets stamped; a database stamped by a different build refuses to open rather than misreading
	 * rows written under a schema it does not know. The additive CREATE/ALTER migration above always
	 * runs BEFORE this check, so a future version bump stamps only after its migrations have succeeded.
	 */
	private validateStoreSchemaVersion(): void {
		const row = this.db.prepare("SELECT value FROM store_meta WHERE key = 'store_schema_version'").get() as { value?: unknown } | undefined;
		if (row === undefined) {
			this.db.prepare("INSERT INTO store_meta (key, value) VALUES ('store_schema_version', ?)").run(STORE_SCHEMA_VERSION);
			return;
		}
		let version = rowString(row, "value");
		if (version !== STORE_SCHEMA_VERSION) {
			// Walk the forward-migration ladder: each hop must be a declared additive
			// MINOR whose DDL ensureSchema has already applied (idempotently, above).
			// The migration proper is stamping the meta row to this build's version.
			const walked = new Set<string>([version]);
			while (version !== STORE_SCHEMA_VERSION) {
				const next = SCHEMA_MIGRATIONS.get(version);
				if (next === undefined || walked.has(next)) {
					throw new Error(`store schema version mismatch: database is '${version}', this build expects '${STORE_SCHEMA_VERSION}', and no forward migration path exists; refusing to open`);
				}
				walked.add(next);
				version = next;
			}
			this.db.prepare("UPDATE store_meta SET value = ? WHERE key = 'store_schema_version'").run(STORE_SCHEMA_VERSION);
		}
	}

	/**
	 * Public and reentrant so a caller can make several store writes atomic — a governed mutation has
	 * to check a version, apply it, and append its ledger row or do none of them. SQLite has no nested
	 * BEGIN, so an inner call joins the outer transaction instead of starting one.
	 */
	transaction<T>(fn: () => T): T {
		if (this.depth > 0) {
			this.depth += 1;
			try {
				return fn();
			} finally {
				this.depth -= 1;
			}
		}
		this.db.exec("BEGIN IMMEDIATE");
		this.depth = 1;
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// Preserve the original failure.
			}
			throw error;
		} finally {
			this.depth = 0;
		}
	}

	private scopeWhere(alias: string, scope: ScopeFilter | undefined, project: string | undefined): { sql: string; args: string[] } {
		const filter = validateFilter(scope);
		if (filter === "global") return { sql: `${alias}.scope = 'global'`, args: [] };
		if (filter === "project") return { sql: `${alias}.scope = 'project' AND ${alias}.project = ?`, args: [normalizeProject(text(project, "project"))] };
		if (project !== undefined) return { sql: `(${alias}.scope = 'global' OR (${alias}.scope = 'project' AND ${alias}.project = ?))`, args: [normalizeProject(text(project, "project"))] };
		return { sql: "1 = 1", args: [] };
	}

	private memoryFromRow(row: Record<string, unknown>): MemoryRecord {
		let tags: string[] = [];
		try {
			const parsed = JSON.parse(rowString(row, "tags"));
			if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
		} catch {
			// Keep malformed legacy metadata harmless.
		}
		const kind = rowString(row, "kind");
		const state = rowString(row, "state");
		return {
			id: rowString(row, "id"),
			kind: MEMORY_KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : MemoryKind.ProjectState,
			content: rowString(row, "content"),
			contentHash: rowString(row, "content_hash"),
			scope: rowString(row, "scope") as MemoryScope,
			project: row.project === null || row.project === undefined ? null : rowString(row, "project") || null,
			tags,
			importance: rowNumber(row, "importance"),
			state: (MEMORY_STATES as readonly string[]).includes(state) ? (state as MemoryState) : "ACTIVE",
			version: rowNumber(row, "version") || 1,
			provenance: parseProvenance(row.provenance),
			expiresAt: row.expires_at === null || row.expires_at === undefined ? null : rowNumber(row, "expires_at"),
			supersedes: row.supersedes === null || row.supersedes === undefined ? null : rowString(row, "supersedes") || null,
			...groupFromRow(row),
			createdAt: rowNumber(row, "created_at"),
			updatedAt: rowNumber(row, "updated_at"),
			...rankFromRow(row),
		};
	}

	private memoryRow(id: string): Record<string, unknown> | undefined {
		return this.db.prepare(`SELECT rowid, ${memoryColumns()} FROM memories WHERE id = ?`).get(text(id, "id"));
	}

	private mutationFromRow(row: Record<string, unknown>): MutationRecord {
		return {
			id: rowNumber(row, "id"),
			memoryId: rowString(row, "memory_id"),
			idempotencyKey: rowString(row, "idempotency_key"),
			actor: rowString(row, "actor"),
			reason: row.reason === null || row.reason === undefined ? null : rowString(row, "reason"),
			transition: rowString(row, "transition"),
			prevVersion: row.prev_version === null || row.prev_version === undefined ? null : rowNumber(row, "prev_version"),
			newVersion: row.new_version === null || row.new_version === undefined ? null : rowNumber(row, "new_version"),
			policyVersion: row.policy_version === null || row.policy_version === undefined ? null : rowString(row, "policy_version"),
			createdAt: rowNumber(row, "created_at"),
			details: parseMetadata(row.details_json),
		};
	}

	memoryUsage(scope: MemoryScope, project?: string): MemoryUsage {
		const validScope = validateScope(scope);
		const normalizedProject = validateProject(project, validScope);
		const rows = this.db.prepare("SELECT content FROM memories WHERE scope = ? AND project_key = ?").all(validScope, projectKey(normalizedProject));
		const usedChars = rows.reduce((total, row) => total + rowString(row, "content").length, 0);
		const limitChars = memoryLimit(this.limits, validScope);
		return {
			scope: validScope,
			project: normalizedProject,
			usedChars,
			limitChars,
			remainingChars: Math.max(0, limitChars - usedChars),
			percentage: Math.round((usedChars / limitChars) * 100),
			entries: rows.length,
			needsConsolidation: usedChars / limitChars >= 0.8,
		};
	}

	private ensureCapacity(scope: MemoryScope, project: string | null, chars: number, excludeId?: string): void {
		const usage = this.memoryUsage(scope, project ?? undefined);
		const rows = this.db.prepare("SELECT id, content FROM memories WHERE scope = ? AND project_key = ?").all(scope, projectKey(project)).filter((row) => rowString(row, "id") !== excludeId);
		const usedChars = rows.reduce((total, row) => total + rowString(row, "content").length, 0);
		if (usedChars + chars <= usage.limitChars) return;
		const currentEntries = rows.map((row) => `${rowString(row, "id")}: ${rowString(row, "content").slice(0, 240)}`).join(" | ");
		throw new Error(`memory at ${usedChars}/${usage.limitChars} chars. Adding this entry (${chars} chars) would exceed the limit. Consolidate or remove entries before retrying. Current entries: ${currentEntries || "none"}`);
	}

	private insertMemory(input: MemoryInput, now: number, group: { groupId: string; part: number; parts: number; content: string } | null = null): { memory: MemoryRecord; duplicate: boolean } {
		const kind = validateKind(input.kind ?? MemoryKind.ProjectState);
		const scope = validateScope(input.scope ?? "project");
		const project = validateProject(input.project, scope);
		if (group !== null) {
			// The size-aware write path has already validated, chunked, and capacity-checked; the decorated
			// chunk still cannot exceed the per-record invariant, and this check enforces it here too.
			if (group.content.length > MAX_MEMORY_CHARS) throw new Error(`memory content exceeds ${MAX_MEMORY_CHARS} characters; consolidate or shorten it before retrying`);
			const id = randomUUID();
			const tags = tagsValue(input.tags);
			const importance = importanceValue(input.importance);
			const provenance = provenanceValue(input.provenance);
			const hash = createHash("sha256").update(group.content, "utf8").digest("hex");
			const result = this.db
				.prepare("INSERT INTO memories (id, kind, scope, project, project_key, content, content_hash, tags, importance, provenance, memory_group_id, part, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(id, kind, scope, project, projectKey(project), group.content, hash, JSON.stringify(tags), importance, JSON.stringify(provenance), group.groupId, group.part, group.parts, now, now);
			const rowid = Number(result.lastInsertRowid);
			this.db.prepare("INSERT INTO memory_fts (rowid, content) VALUES (?, ?)").run(rowid, group.content);
			return {
				memory: {
					id,
					kind,
					content: group.content,
					contentHash: hash,
					scope,
					project,
					tags,
					importance,
					state: "ACTIVE",
					version: 1,
					provenance,
					expiresAt: null,
					supersedes: null,
					memoryGroupId: group.groupId,
					part: group.part,
					parts: group.parts,
					chunked: true,
					createdAt: now,
					updatedAt: now,
				},
				duplicate: false,
			};
		}
		const raw = text(input.content, "content");
		const cleanContent = validateMemoryContent(raw);
		const hash = createHash("sha256").update(cleanContent, "utf8").digest("hex");
		const duplicateRow = this.db
			.prepare(`SELECT rowid, ${memoryColumns()} FROM memories WHERE scope = ? AND project_key = ? AND content_hash = ?`)
			.get(scope, projectKey(project), hash);
		if (duplicateRow) {
			const memory = this.memoryFromRow(duplicateRow);
			memory.duplicate = true;
			return { memory, duplicate: true };
		}
		this.ensureCapacity(scope, project, cleanContent.length);
		const id = randomUUID();
		const tags = tagsValue(input.tags);
		const importance = importanceValue(input.importance);
		const provenance = provenanceValue(input.provenance);
		const result = this.db
			.prepare("INSERT INTO memories (id, kind, scope, project, project_key, content, content_hash, tags, importance, provenance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(id, kind, scope, project, projectKey(project), cleanContent, hash, JSON.stringify(tags), importance, JSON.stringify(provenance), now, now);
		const rowid = Number(result.lastInsertRowid);
		this.db.prepare("INSERT INTO memory_fts (rowid, content) VALUES (?, ?)").run(rowid, cleanContent);
		// Governance columns take their schema defaults: a new memory is always born ACTIVE at version 1.
		return {
			memory: {
				id,
				kind,
				content: cleanContent,
				contentHash: hash,
				scope,
				project,
				tags,
				importance,
				state: "ACTIVE",
				version: 1,
				provenance,
				expiresAt: null,
				supersedes: null,
				createdAt: now,
				updatedAt: now,
			},
			duplicate: false,
		};
	}

	/** The id of a chunked write whose parts this scope already holds in full, or undefined. */
	private existingGroupDuplicate(groupId: string, parts: number, scope: MemoryScope, project: string | null): string | undefined {
		const rows = this.db
			.prepare("SELECT id, part FROM memories WHERE memory_group_id = ? AND scope = ? AND project_key = ?")
			.all(groupId, scope, projectKey(project));
		if (rows.length !== parts) return undefined;
		const seen = new Set(rows.map((row) => rowNumber(row, "part")));
		if (seen.size !== parts) return undefined;
		return rowString(rows[0], "id");
	}

	/**
	 * The size-aware write. Oversized content (> MAX_MEMORY_CHARS) is never truncated, never
	 * LLM-summarized, and never rejected: it is split by the deterministic boundary-aware chunker
	 * into parts that each satisfy the per-record invariant, tagged with the group id derived from
	 * the full original content, and written in one transaction so a group is all-or-nothing.
	 */
	rememberWithStatus(input: MemoryInput): { memories: MemoryRecord[]; status: MemoryWriteStatus } {
		const kind = validateKind(input.kind ?? MemoryKind.ProjectState);
		const scope = validateScope(input.scope ?? "project");
		const project = validateProject(input.project, scope);
		// Safety and redaction run on the FULL content before chunking, so a threat pattern or a
		// credential split across a boundary is still caught, and every chunk is equally clean.
		const cleanContent = validateMemorySafety(text(input.content, "content"));
		const tags = tagsValue(input.tags);
		const status: MemoryWriteStatus = {
			contentLength: cleanContent.length,
			contentLimit: MAX_MEMORY_CHARS,
			contentRemaining: Math.max(0, MAX_MEMORY_CHARS - cleanContent.length),
			nearLimit: cleanContent.length >= MAX_MEMORY_CHARS - NEAR_MEMORY_LIMIT_CHARS,
			chunked: false,
		};
		if (cleanContent.length <= MAX_MEMORY_CHARS) {
			return this.transaction(() => {
				const inserted = this.insertMemory({ ...input, content: cleanContent, kind, scope, project: project ?? undefined, tags }, Date.now());
				return { memories: [inserted.memory], status };
			});
		}
		const groupId = memoryGroupId(cleanContent, kind, tags);
		const chunks = chunkContent(cleanContent);
		const parts = chunks.length;
		if (parts < 2) throw new Error("chunked write produced fewer than two parts");
		status.chunked = true;
		status.memoryGroupId = groupId;
		status.parts = parts;
		return this.transaction(() => {
			// Idempotency for a chunked write: the same full content in the same scope lands as the
			// same group, and a second submission finds every part already present.
			const existing = this.existingGroupDuplicate(groupId, parts, scope, project);
			if (existing !== undefined) {
				// Scope-keyed duplicate population (G8 Nytheria impl-gate B1): memoryGroupId is
				// scope-blind, so listMemoriesByGroup(groupId) returns the UNION of every scope's
				// rows sharing the id. The duplicate return must carry only THIS write's
				// scope/project rows — and memory[0] must be the requested scope's part 1, never
				// a foreign-scope row a caller would stamp into promoted_to.
				const memories = this.listMemoriesByGroup(groupId, scope, project);
				for (const memory of memories) memory.duplicate = true;
				return { memories, status };
			}
			// One capacity check for the whole group: the parts are written in this same transaction,
			// so checking the first against a corpus that still lacks the rest would be a fiction.
			// A group that lost a part (one forgotten) is restored: only the missing parts are written, the held ones stay.
			const held = new Set(this.db.prepare("SELECT part FROM memories WHERE memory_group_id = ? AND scope = ? AND project_key = ?").all(groupId, scope, projectKey(project)).map((row) => rowNumber(row, "part")));
			const missing = chunks.filter((chunk) => !held.has(chunk.part));
			this.ensureCapacity(scope, project, missing.reduce((sum, chunk) => sum + decorateChunk(chunk, groupId).length, 0));
			const inserted = missing.map((chunk, index) => this.insertMemory({ ...input, content: chunk.content, kind, scope, project: project ?? undefined, tags }, Date.now() + index, { groupId, part: chunk.part, parts, content: decorateChunk(chunk, groupId) }));
			if (held.size === 0) return { memories: inserted.map((each) => each.memory), status };
			const memories = this.listMemoriesByGroup(groupId, scope, project);
			// The parts that were already held are duplicates. Only the restored ones are new.
			for (const memory of memories) if (held.has(memory.part ?? 0)) memory.duplicate = true;
			return { memories, status };
		});
	}

	/**
	 * The parts of a chunk group in part order, every state included. The group id ignores scope, so pass
	 * the scope (and project) to read one scope's copy. Without a scope it is the union of every copy.
	 */
	listMemoriesByGroup(groupId: string, scope?: MemoryScope, project?: string | null): MemoryRecord[] {
		if (!MEMORY_GROUP_ID_RE.test(text(groupId, "groupId"))) throw new Error("groupId must be a memory group id (grp-<sha256>)");
		const rows = scope === undefined
			? this.db.prepare(`SELECT ${memoryColumns()} FROM memories WHERE memory_group_id = ? ORDER BY part ASC`).all(groupId)
			: this.db.prepare(`SELECT ${memoryColumns()} FROM memories WHERE memory_group_id = ? AND scope = ? AND project_key = ? ORDER BY part ASC`).all(groupId, scope, projectKey(project));
		return rows.map((row) => this.memoryFromRow(row));
	}

	/** The reassembled original content of a group, plus its parts in order; a group with a missing part still reads. */
	getMemoryGroup(groupId: string, scope?: MemoryScope, project?: string | null): { content: string; parts: MemoryRecord[] } | undefined {
		const parts = this.listMemoriesByGroup(groupId, scope, project);
		if (parts.length === 0) return undefined;
		this.reassemblyCount += 1;
		return { content: reassembleGroup(parts), parts };
	}

	// -------------------------------------------------------------------------------------------
	// G7/PROG1 (§18.1 memory-plane scope): group-aware L0/L1 projections sharing one
	// boundary-map mechanism; a single-row memory is a degenerate group. Accept any part id of the group;
	// getMemoryGroup remains memory L2, untouched.
	// -------------------------------------------------------------------------------------------

	/** Memory L0: group metadata + the first ≤ 256 chars of the group's RAW space. */
	memoryL0(id: string): MemoryRecordDisclosureRow | undefined {
		const row = this.memoryRow(text(id, "id"));
		if (!row) return undefined;
		return this.memoryDisclosureRow(this.memoryFromRow(row), "L0");
	}

	/** Memory L1: + head ≤ 2,048 / tail ≤ 512 chars of the group's RAW space. */
	memoryL1(id: string): MemoryRecordDisclosureRow | undefined {
		const row = this.memoryRow(text(id, "id"));
		if (!row) return undefined;
		return this.memoryDisclosureRow(this.memoryFromRow(row), "L1");
	}

	remember(input: MemoryInput): MemoryRecord {
		return this.rememberWithStatus(input).memories[0];
	}

	record(input: MemoryInput): MemoryRecord {
		return this.remember(input);
	}

	getMemory(id: string): MemoryRecord | undefined {
		const row = this.memoryRow(id);
		return row ? this.memoryFromRow(row) : undefined;
	}

	listMemories(options: RecentOptions & { order?: "importance" | "updated" } = {}): MemoryRecord[] {
		const where = this.scopeWhere("m", options.scope, options.project);
		const limit = limitValue(options.limit);
		// m.id ASC final tie-break: equal (importance, updated_at) rows — e.g. bursts written in the
		// same millisecond — otherwise order by rowid (insertion scan), which is not guaranteed stable
		// across VACUUM or query-plan changes, and the injected memory snapshot must render byte-stable.
		const order = options.order === "importance" ? "m.importance DESC, m.updated_at DESC, m.id ASC" : "m.updated_at DESC, m.id ASC";
		return this.db
			.prepare(`SELECT ${memoryColumns("m")} FROM memories m WHERE ${where.sql} AND ${stateWhere("m", options.includeAllStates)} ORDER BY ${order} LIMIT ?`)
			.all(...where.args, limit)
			.map((row) => this.memoryFromRow(row));
	}

	/** The vault export view: every state, because the Markdown files are the record of record. */
	allMemories(): MemoryRecord[] {
		return this.db.prepare(`SELECT ${memoryColumns()} FROM memories ORDER BY updated_at DESC`).all().map((row) => this.memoryFromRow(row));
	}

	updateMemory(id: string, patch: MemoryUpdate | string): MemoryRecord {
		const memoryId = text(id, "id");
		const changes = typeof patch === "string" ? { content: patch } : patch;
		if (!changes || typeof changes !== "object") throw new Error("update must be an object or content string");
		return this.transaction(() => {
			const oldRow = this.memoryRow(memoryId);
			if (!oldRow) throw new Error(`memory not found: ${memoryId}`);
			const old = this.memoryFromRow(oldRow);
			const kind = validateKind(changes.kind ?? old.kind);
			const scope = validateScope(changes.scope ?? old.scope);
			const project = validateProject(changes.project === undefined ? old.project ?? undefined : changes.project, scope);
			const content = changes.content === undefined ? old.content : text(changes.content, "content");
			const cleanContent = validateMemoryContent(content);
			const hash = createHash("sha256").update(cleanContent, "utf8").digest("hex");
			const duplicate = this.db
				.prepare("SELECT id FROM memories WHERE scope = ? AND project_key = ? AND content_hash = ? AND id <> ?")
				.get(scope, projectKey(project), hash, memoryId);
			if (duplicate) throw new Error("duplicate memory content in this scope");
			this.ensureCapacity(scope, project, cleanContent.length, memoryId);
			const tags = changes.tags === undefined ? old.tags : tagsValue(changes.tags);
			const importance = changes.importance === undefined ? old.importance : importanceValue(changes.importance);
			// A content edit leaves governance alone; only a caller that passes a governance key changes
			// it, and the lifecycle transition behind that key is validated before we are called.
			const state = changes.state === undefined ? old.state : validateState(changes.state);
			const version = changes.version === undefined ? old.version : versionValue(changes.version);
			const expiresAt = changes.expiresAt === undefined ? old.expiresAt : expiresAtValue(changes.expiresAt);
			const supersedes = changes.supersedes === undefined ? old.supersedes : supersedesValue(changes.supersedes);
			const provenance = changes.provenance === undefined ? old.provenance : provenanceValue(changes.provenance);
			const now = Date.now();
			const rowid = rowNumber(oldRow, "rowid");
			this.db.prepare("UPDATE memories SET kind = ?, scope = ?, project = ?, project_key = ?, content = ?, content_hash = ?, tags = ?, importance = ?, state = ?, version = ?, expires_at = ?, supersedes = ?, provenance = ?, updated_at = ? WHERE id = ?").run(kind, scope, project, projectKey(project), cleanContent, hash, JSON.stringify(tags), importance, state, version, expiresAt, supersedes, JSON.stringify(provenance), now, memoryId);
			this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(rowid);
			this.db.prepare("INSERT INTO memory_fts (rowid, content) VALUES (?, ?)").run(rowid, cleanContent);
			return { id: memoryId, kind, content: cleanContent, contentHash: hash, scope, project, tags, importance, state, version, provenance, expiresAt, supersedes, createdAt: old.createdAt, updatedAt: now };
		});
	}

	forgetMemory(id: string): boolean {
		const memoryId = text(id, "id");
		return this.transaction(() => {
			const row = this.memoryRow(memoryId);
			if (!row) return false;
			this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(rowNumber(row, "rowid"));
			this.db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
			return true;
		});
	}

	forget(id: string): boolean {
		return this.forgetMemory(id);
	}

	consolidate(input: ConsolidateInput | string[], content?: string, options: Omit<ConsolidateInput, "ids" | "content"> = {}): ConsolidateResult {
		const request: ConsolidateInput = Array.isArray(input) ? { ...options, ids: input, content } : input;
		if (!request || !Array.isArray(request.ids) || request.ids.length < 2 || request.ids.some((id) => typeof id !== "string" || !id.trim())) throw new Error("consolidate requires at least two memory ids");
		return this.transaction(() => {
			const ids = [...new Set(request.ids.map((id) => id.trim()))];
			const memories = ids.map((id) => {
				const row = this.memoryRow(id);
				if (!row) throw new Error(`memory not found: ${id}`);
				return this.memoryFromRow(row);
			});
			const first = memories[0];
			const kind = validateKind(request.kind ?? first.kind);
			const scope = validateScope(request.scope ?? first.scope);
			const project = validateProject(request.project === undefined ? first.project ?? undefined : request.project, scope);
			if (memories.some((memory) => memory.scope !== scope || projectKey(memory.project) !== projectKey(project))) throw new Error("memories must share scope and project");
			const mergedContent = request.content === undefined ? memories.map((memory) => memory.content).join("\n") : text(request.content, "content");
			for (const memory of memories) {
				const row = this.memoryRow(memory.id);
				if (row) {
					this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(rowNumber(row, "rowid"));
					this.db.prepare("DELETE FROM memories WHERE id = ?").run(memory.id);
				}
			}
			const inserted = this.insertMemory({ content: mergedContent, kind, scope, project: project ?? undefined, tags: request.tags ?? [...new Set(memories.flatMap((memory) => memory.tags))], importance: request.importance ?? Math.max(...memories.map((memory) => memory.importance)) }, Date.now());
			return { memory: inserted.memory, removedIds: ids };
		});
	}

	/** Append-only lifecycle log. Rows are only ever inserted; there is no update or delete path. */
	recordMutation(input: MutationInput): MutationRecord {
		const memoryId = text(input.memoryId, "memoryId");
		const idempotencyKey = text(input.idempotencyKey, "idempotencyKey");
		const actor = redactSensitive(text(input.actor, "actor"));
		const fromState = validateState(input.fromState);
		// A patch that edits content or evidence without moving the record still needs an audit row, so a
		// state-preserving mutation records `X->X` rather than being asserted as a transition. Terminal
		// states stay closed to every mutation, which is what made the self-edge invalid in the first place.
		const toState = validateState(input.toState);
		if (toState !== fromState) assertMemoryTransition(fromState, toState);
		else if (MEMORY_STATE_TRANSITIONS[fromState].length === 0) throw new Error(`invalid memory mutation on ${fromState}: ${fromState} is terminal`);
		const transition = `${fromState}->${toState}`;
		const reason = input.reason === undefined || input.reason === null ? null : redactSensitive(text(input.reason, "reason"));
		const prevVersion = input.prevVersion === undefined || input.prevVersion === null ? null : versionValue(input.prevVersion, "prevVersion");
		const newVersion = input.newVersion === undefined || input.newVersion === null ? null : versionValue(input.newVersion, "newVersion");
		const policyVersion = input.policyVersion === undefined || input.policyVersion === null ? null : redactSensitive(text(input.policyVersion, "policyVersion"));
		let details = "{}";
		if (input.details !== undefined) {
			try {
				details = JSON.stringify(redactJsonValue(input.details));
			} catch {
				throw new Error("details must be JSON-serializable");
			}
		}
		const createdAt = input.timestamp === undefined ? Date.now() : input.timestamp;
		if (!Number.isFinite(createdAt)) throw new Error("timestamp must be finite");
		return this.transaction(() => {
			const existing = this.db.prepare(`SELECT ${MUTATION_COLUMNS} FROM memory_mutations WHERE idempotency_key = ?`).get(idempotencyKey);
			if (existing) {
				const record = this.mutationFromRow(existing);
				record.duplicate = true;
				return record;
			}
			const result = this.db
				.prepare("INSERT INTO memory_mutations (memory_id, idempotency_key, actor, reason, transition, prev_version, new_version, policy_version, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(memoryId, idempotencyKey, actor, reason, transition, prevVersion, newVersion, policyVersion, createdAt, details);
			return { id: Number(result.lastInsertRowid), memoryId, idempotencyKey, actor, reason, transition, prevVersion, newVersion, policyVersion, createdAt, details: input.details ?? {} };
		});
	}

	/** The idempotency lookup a replaying caller needs before it decides whether to write at all. */
	getMutation(idempotencyKey: string): MutationRecord | undefined {
		const row = this.db.prepare(`SELECT ${MUTATION_COLUMNS} FROM memory_mutations WHERE idempotency_key = ?`).get(text(idempotencyKey, "idempotencyKey"));
		return row ? this.mutationFromRow(row) : undefined;
	}

	listMutations(memoryId?: string, limit?: number): MutationRecord[] {
		const bounded = limitValue(limit, 50);
		const rows = memoryId === undefined
			? this.db.prepare(`SELECT ${MUTATION_COLUMNS} FROM memory_mutations ORDER BY id DESC LIMIT ?`).all(bounded)
			: this.db.prepare(`SELECT ${MUTATION_COLUMNS} FROM memory_mutations WHERE memory_id = ? ORDER BY id DESC LIMIT ?`).all(text(memoryId, "memoryId"), bounded);
		return rows.map((row) => this.mutationFromRow(row));
	}

	// -------------------------------------------------------------------------------------------
	// G7/PROG1 (§18) store-private projection machinery: the RAW-space boundary map, projection
	// builders, the shared group-dedupe helper, and the single-record disclosure APIs.
	// -------------------------------------------------------------------------------------------

	/**
	 * §18.3 boundary map (frozen mechanism): ONE ordered scan —
	 * `WHERE (memory_group_id = ?) OR (memory_group_id IS NULL AND id = ?)` with `ORDER BY part ASC`
	 * — over the table the id belongs to. A NULL-group row is its own logical group (the
	 * groupless-row rule), so the map for a groupless id holds exactly that row. Each part's RAW
	 * content is stripped via rawChunkContent (the exact inverse of decorateChunk) and its raw
	 * length computed IN JS from `.length` (the code-point ruling: never SQL LENGTH). Entries
	 * carry the raw slices themselves, so every window read below re-slices them with no second read.
	 */
	private groupBoundaryMap(table: "memories", id: string): RawGroupEntry<string>[] {
		// Two-step resolution, not a NULL-bind: `memory_group_id = NULL` is never true under SQL
		// NULL semantics, so the group id is resolved from the row first, and a groupless row falls
		// back to its own id (the §18.3 groupless-row rule — the row IS its own logical group).
		// The group id ignores scope, so the group is also pinned to this row's scope and project.
		const row = this.db.prepare(`SELECT memory_group_id, scope, project_key FROM ${table} WHERE id = ?`).get(id) as { memory_group_id?: unknown; scope?: unknown; project_key?: unknown } | undefined;
		if (row === undefined) return [];
		const groupId = row.memory_group_id === null || row.memory_group_id === undefined || !row.memory_group_id ? null : String(row.memory_group_id);
		const rows = (groupId === null
				? this.db.prepare(`SELECT id, part, parts, memory_group_id, content FROM ${table} WHERE memory_group_id IS NULL AND id = ? ORDER BY part ASC`).all(id)
				: this.db.prepare(`SELECT id, part, parts, memory_group_id, content FROM ${table} WHERE memory_group_id = ? AND scope = ? AND project_key = ? ORDER BY part ASC`).all(groupId, String(row.scope), String(row.project_key))) as Array<Record<string, unknown>>;
		let cursor = 0;
		return rows.map((row) => {
			const raw = rawChunkContent({
				content: rowString(row, "content"),
				part: row.part === null || row.part === undefined ? null : rowNumber(row, "part"),
				parts: row.parts === null || row.parts === undefined ? null : rowNumber(row, "parts"),
				memoryGroupId: row.memory_group_id === null || row.memory_group_id === undefined || !row.memory_group_id ? null : rowString(row, "memory_group_id"),
			});
			const entry: RawGroupEntry<string> = { id: rowString(row, "id"), raw, rawLength: raw.length, start: cursor, end: cursor + raw.length };
			cursor = entry.end;
			return entry;
		});
	}

	/** Apply the L0/L1 projection to one memory row over its group's RAW space (§18.1 scope decision). */
	private memoryDisclosureRow(row: MemoryRecord, level: Exclude<DisclosureLevel, "L2">): MemoryRecordDisclosureRow {
		const map = this.groupBoundaryMap("memories", row.id);
		const fullLength = map.reduce((total, entry) => total + entry.rawLength, 0);
		const headLimit = level === "L0" ? DISCLOSURE_HEAD_CHARS : DISCLOSURE_L1_HEAD_CHARS;
		const tailLimit = level === "L0" ? 0 : DISCLOSURE_L1_TAIL_CHARS;
		let content: string;
		if (fullLength <= headLimit + tailLimit) {
			content = rawWindow(map, 0, fullLength);
		} else if (level === "L0") {
			content = rawWindow(map, 0, headLimit);
		} else {
			content = `${rawWindow(map, 0, headLimit)}\n…\n${rawWindow(map, fullLength - tailLimit, tailLimit)}`;
		}
		return { ...row, content, disclosureLevel: level, contentOffset: 0, contentLimit: headLimit, fullLength, reassembled: false, partCount: map.length, firstPartId: map.length > 0 ? map[0].id : row.id };
	}

	// -------------------------------------------------------------------------------------------
	// G7/PROG1 (§18.3): the single-record disclosure APIs. All accept ANY part id of the logical
	// record (the boundary map resolves the group); a vanished id returns undefined, exactly like
	// getMemoryGroup (§18.2 missing-id consistency — no throw anywhere).
	// -------------------------------------------------------------------------------------------

	/**
	 * Full-text memory retrieval that keeps whole records, so a caller can see governance and provenance.
	 *
	 * The row also carries FTS5's own `bm25()` as `MemoryRecord.rank`. That is **additive**: the
	 * ordering is unchanged (`importance DESC, updated_at DESC, id ASC` — bm25 does not order anything here),
	 * every existing field is unchanged, and a caller that ignores `rank` sees exactly what it saw
	 * before. The database already computes the number to satisfy the MATCH; discarding it was the
	 * only thing this method used to do with it.
	 */
	searchMemories(options: SearchOptions): MemoryRecord[] {
		const match = toSafeMatchQuery(options.query);
		const limit = limitValue(options.limit);
		const where = this.scopeWhere("m", options.scope, options.project);
		return this.db
			.prepare(`SELECT ${memoryColumns("m")}, bm25(memory_fts) AS ${BM25_COLUMN_ALIAS} FROM memory_fts f JOIN memories m ON m.rowid = f.rowid WHERE memory_fts MATCH ? AND ${where.sql} AND ${stateWhere("m", options.includeAllStates)} ORDER BY m.importance DESC, m.updated_at DESC, m.id ASC LIMIT ?`)
			.all(match, ...where.args, limit)
			.map((row) => this.memoryFromRow(row));
	}

	search(query: string, options?: Omit<SearchOptions, "query">): SearchResult[];
	search(options: SearchOptions): SearchResult[];
	search(queryOrOptions: string | SearchOptions, options: Omit<SearchOptions, "query"> = {}): SearchResult[] {
		const request: SearchOptions = typeof queryOrOptions === "string" ? { ...options, query: queryOrOptions } : queryOrOptions;
		return this.searchMemories(request).map(memoryResult);
	}

	recent(options: RecentOptions = {}): RecentResult[] {
		return this.listMemories({ ...options, limit: limitValue(options.limit) }).map(memoryResult);
	}

	stats(project?: string): StoreStats {
		const count = (sql: string, ...args: Array<string | number | null>) => rowNumber(this.db.prepare(sql).get(...args) ?? {}, "count");
		const memoriesByKind: Record<string, number> = {};
		for (const row of this.db.prepare("SELECT kind, COUNT(*) AS count FROM memories GROUP BY kind ORDER BY count DESC, kind").all()) memoriesByKind[rowString(row, "kind")] = rowNumber(row, "count");
		const projects = this.db.prepare("SELECT DISTINCT project FROM memories WHERE scope = 'project' AND project IS NOT NULL AND project <> '' ORDER BY project").all().map((row) => rowString(row, "project"));
		return {
			databasePath: this.path,
			memories: count("SELECT COUNT(*) AS count FROM memories"),
			globalMemories: count("SELECT COUNT(*) AS count FROM memories WHERE scope = 'global'"),
			projectMemories: count("SELECT COUNT(*) AS count FROM memories WHERE scope = 'project'"),
			memoriesByKind,
			memoryFtsRows: count("SELECT COUNT(*) AS count FROM memory_fts"),
			reassembly: this.reassemblyCount,
			memoryUsage: {
				global: this.memoryUsage("global"),
				...(project !== undefined ? { project: this.memoryUsage("project", project) } : {}),
				projects: projects.map((name) => this.memoryUsage("project", name)),
			},
		};
	}

	get isOpen(): boolean {
		return this.db.isOpen;
	}

	getMeta(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM store_meta WHERE key = ?").get(key);
		return row === undefined ? undefined : rowString(row, "value");
	}

	/** An undefined value removes the key. */
	setMeta(key: string, value: string | undefined): void {
		if (value === undefined) this.db.prepare("DELETE FROM store_meta WHERE key = ?").run(key);
		else this.db.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	/** Memories in `state`, newest first. The default listings skip every state except ACTIVE and DISPUTED. */
	listByState(state: MemoryState, limit = 100): MemoryRecord[] {
		return this.db.prepare(`SELECT ${memoryColumns()} FROM memories WHERE state = ? ORDER BY updated_at DESC, id ASC LIMIT ?`).all(validateState(state), limit).map((row) => this.memoryFromRow(row));
	}

	countMemories(): number {
		return rowNumber(this.db.prepare("SELECT COUNT(*) AS count FROM memories").get() ?? {}, "count");
	}

	countState(state: MemoryState): number {
		return rowNumber(this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE state = ?").get(validateState(state)) ?? {}, "count");
	}

	/**
	 * Insert a record that came from a vault file (F2). Insert only: an id or a content already present is reported
	 * and left alone. The row is PROPOSED at version 1 with importance at most 5, tagged source=vault-import, and the
	 * file's governance keys are ignored. The content passes the same scanner as every other write.
	 */
	importMemory(record: VaultMemoryRecord, now = Date.now()): { status: "inserted"; memory: MemoryRecord } | { status: "exists" | "duplicate"; id: string } {
		const content = validateMemoryContent(record.content);
		return this.transaction(() => {
			if (this.memoryRow(record.id)) return { status: "exists" as const, id: record.id };
			const kind = validateKind(record.kind);
			const scope = validateScope(record.scope);
			const project = validateProject(record.project, scope);
			const hash = createHash("sha256").update(content, "utf8").digest("hex");
			const same = this.db.prepare("SELECT id FROM memories WHERE scope = ? AND project_key = ? AND content_hash = ?").get(scope, projectKey(project), hash);
			if (same) return { status: "duplicate" as const, id: rowString(same, "id") };
			this.ensureCapacity(scope, project, content.length);
			const tags = tagsValue([...record.tags.filter((tag) => tag !== IMPORT_TAG), IMPORT_TAG].slice(-20));
			const importance = Math.min(importanceValue(record.importance), 5);
			const provenance = provenanceValue([{ actor: "vault-import", at: now }]);
			const group = record.memoryGroupId ?? null;
			const result = this.db
				.prepare("INSERT INTO memories (id, kind, scope, project, project_key, content, content_hash, tags, importance, state, provenance, memory_group_id, part, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?)")
				.run(record.id, kind, scope, project, projectKey(project), content, hash, JSON.stringify(tags), importance, JSON.stringify(provenance), group, group === null ? null : record.part ?? null, group === null ? null : record.parts ?? null, now, now);
			this.db.prepare("INSERT INTO memory_fts (rowid, content) VALUES (?, ?)").run(Number(result.lastInsertRowid), content);
			return { status: "inserted" as const, memory: this.memoryFromRow(this.memoryRow(record.id)!) };
		});
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}
}

/** The tag every vault-imported record carries until it is accepted and after. */
export const IMPORT_TAG = "source=vault-import";

/** Stable short hash of a project path, used in vault files so the absolute path is never published. */
export function projectHash(project: string): string {
	return createHash("sha256").update(normalizeProject(project), "utf8").digest("hex").slice(0, 16);
}

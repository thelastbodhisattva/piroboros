// Ported from akashic-forge/api.ts @ f0a8ad4 (MIT; see NOTICE)
import { createHash } from "node:crypto";
import {
	AkashicStore,
	MEMORY_STATE_TRANSITIONS,
	type MemoryRecord,
	type MemoryState,
	type MemoryUpdate,
	type MutationRecord,
	type ScopeFilter,
	assertMemoryTransition,
	validateState,
} from "./store.ts";

/**
 * The in-process surface an orchestrator imports instead of calling the `akashic_memory` tool.
 *
 * It exposes data and enforces storage invariants. It ranks nothing, resolves nothing, and decides
 * nothing about relevance: every judgement belongs to the caller. The two things it does own are
 * completeness — a read never drops a provenance field the row carries — and write governance:
 * idempotency, optimistic concurrency, lifecycle validity, and an audit row per applied mutation.
 */

/** Bumped whenever a shape returned here changes in a way a consumer has to notice. */
export const MEMORY_API_SCHEMA_VERSION = "akashic-forge/memory-api@1";

/** Where a write that names no actor is attributed. A destructive transition may never use it. */
export const DEFAULT_MUTATION_ACTOR = "akashic-forge";

/** These end a memory's usable life, so they demand a named authority rather than a default one. */
export const DESTRUCTIVE_MEMORY_STATES: readonly MemoryState[] = ["REVOKED", "QUARANTINED", "DELETED"];

export type MutationErrorCode = "not_found" | "version_conflict" | "invalid_transition" | "actor_required";

/** One error type with a code, so a caller can branch on the refusal without parsing a message. */
export class MemoryMutationError extends Error {
	readonly code: MutationErrorCode;
	readonly memoryId: string;
	/** The version actually stored, so a losing writer can rebase without a second read. */
	readonly currentVersion?: number;

	constructor(code: MutationErrorCode, message: string, memoryId: string, currentVersion?: number) {
		super(message);
		this.name = "MemoryMutationError";
		this.code = code;
		this.memoryId = memoryId;
		this.currentVersion = currentVersion;
	}
}

/** A memory with every field its row carries, including the persisted integrity hash. */
export interface GovernedMemory extends MemoryRecord {
	contentHash: string;
}

export interface MemoryQuery {
	/** Literal full-text terms. Omit it to read the scope by recency instead. */
	query?: string;
	/** Exact ids, for re-reading known records in any state; mutually exclusive with `query`. */
	ids?: string[];
	scope?: ScopeFilter;
	project?: string;
	/** Default retrieval is ACTIVE and DISPUTED; history is opt-in, exactly as the store defines it. */
	includeAllStates?: boolean;
	limit?: number;
}

export interface MemoryPage {
	schemaVersion: string;
	memories: GovernedMemory[];
}

/** State and version are set by the transition and the version check, never by the patch. */
export type MemoryPatch = Omit<MemoryUpdate, "state" | "version">;

export interface MutateMemoryRequest {
	memoryId: string;
	/** Stable across retries: the same key returns the first result and writes nothing further. */
	idempotencyKey: string;
	/** The version the caller reasoned about. A mismatch is refused rather than merged. */
	expectedVersion: number;
	/** Required for a destructive transition; every other write may fall back to the default actor. */
	actor?: string;
	reason?: string;
	policyVersion?: string;
	/** Target lifecycle state. Omitted means the record keeps the state it already has. */
	transition?: MemoryState;
	patch?: MemoryPatch;
}

export interface MutationResult {
	schemaVersion: string;
	/** True when the idempotency key had already been applied and nothing was written this time. */
	replayed: boolean;
	memory: GovernedMemory;
	mutation: MutationRecord;
}

export interface MemoryApi {
	readonly schemaVersion: string;
	getMemories(query?: MemoryQuery): MemoryPage;
	mutateMemory(request: MutateMemoryRequest): MutationResult;
}

export type { MemoryRecord, MemoryState, MutationRecord, ScopeFilter };

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function isRecord(memory: MemoryRecord | undefined): memory is MemoryRecord {
	return memory !== undefined;
}

/** Store reads carry the stored hash; the fallback keeps the field non-optional for any other origin. */
function governed(memory: MemoryRecord): GovernedMemory {
	return { ...memory, contentHash: memory.contentHash ?? createHash("sha256").update(memory.content, "utf8").digest("hex") };
}

function patchedFields(patch: MemoryPatch): string[] {
	return Object.keys(patch)
		.filter((key) => patch[key as keyof MemoryPatch] !== undefined)
		.sort();
}

export function createMemoryApi(store: AkashicStore): MemoryApi {
	const page = (memories: MemoryRecord[]): MemoryPage => ({ schemaVersion: MEMORY_API_SCHEMA_VERSION, memories: memories.map(governed) });

	return {
		schemaVersion: MEMORY_API_SCHEMA_VERSION,

		getMemories(query = {}): MemoryPage {
			const { ids, query: terms, scope, project, includeAllStates, limit } = query;
			if (ids !== undefined && terms !== undefined) throw new Error("query and ids are mutually exclusive");
			if (ids !== undefined) {
				const unique = [...new Set(ids.map((id) => nonEmpty(id, "ids")))];
				return page(unique.map((id) => store.getMemory(id)).filter(isRecord));
			}
			const options = { scope, project, includeAllStates, limit };
			return page(terms === undefined ? store.listMemories(options) : store.searchMemories({ ...options, query: terms }));
		},

		mutateMemory(request): MutationResult {
			const memoryId = nonEmpty(request.memoryId, "memoryId");
			const idempotencyKey = nonEmpty(request.idempotencyKey, "idempotencyKey");
			if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) throw new Error("expectedVersion must be a positive integer");
			const actor = request.actor === undefined ? DEFAULT_MUTATION_ACTOR : nonEmpty(request.actor, "actor");
			const transition = request.transition === undefined ? undefined : validateState(request.transition);
			if (transition !== undefined && DESTRUCTIVE_MEMORY_STATES.includes(transition) && actor === DEFAULT_MUTATION_ACTOR) {
				throw new MemoryMutationError("actor_required", `a ${transition} transition requires an explicit actor; ${DEFAULT_MUTATION_ACTOR} may not authorize one`, memoryId);
			}
			const patch = request.patch ?? {};

			// One transaction: the version check, the write, and the ledger row commit together or not at all.
			return store.transaction(() => {
				const replay = store.getMutation(idempotencyKey);
				if (replay !== undefined) {
					const replayed = store.getMemory(replay.memoryId);
					if (replayed === undefined) throw new MemoryMutationError("not_found", `memory not found: ${replay.memoryId}`, replay.memoryId);
					return { schemaVersion: MEMORY_API_SCHEMA_VERSION, replayed: true, memory: governed(replayed), mutation: replay };
				}
				const current = store.getMemory(memoryId);
				if (current === undefined) throw new MemoryMutationError("not_found", `memory not found: ${memoryId}`, memoryId);
				if (current.version !== request.expectedVersion) {
					throw new MemoryMutationError("version_conflict", `memory ${memoryId} is at version ${current.version}, not the expected ${request.expectedVersion}`, memoryId, current.version);
				}
				const toState = transition ?? current.state;
				if (toState === current.state) {
					if (MEMORY_STATE_TRANSITIONS[current.state].length === 0) {
						throw new MemoryMutationError("invalid_transition", `invalid memory mutation on ${current.state}: ${current.state} is terminal`, memoryId, current.version);
					}
				} else {
					try {
						assertMemoryTransition(current.state, toState);
					} catch (error) {
						throw new MemoryMutationError("invalid_transition", error instanceof Error ? error.message : String(error), memoryId, current.version);
					}
				}
				const memory = store.updateMemory(memoryId, { ...patch, state: toState, version: current.version + 1 });
				const mutation = store.recordMutation({
					memoryId,
					idempotencyKey,
					actor,
					reason: request.reason,
					fromState: current.state,
					toState,
					prevVersion: current.version,
					newVersion: memory.version,
					policyVersion: request.policyVersion,
					details: { patched: patchedFields(patch) },
				});
				return { schemaVersion: MEMORY_API_SCHEMA_VERSION, replayed: false, memory: governed(memory), mutation };
			});
		},
	};
}

// Ported from mnemosia/adapters/akashic-memories.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Adapter over AkashicForge's curated memory surface (`memoryApi.getMemories`).
 *
 * This is the small, high-authority half of the corpus: ten human-curated, governed rows. It is also the only source in Phase 1 that publishes a real
 * integrity claim — `content_hash`, written as `sha256(content, "utf8")` at store.ts:746 — so it is
 * the only source whose envelopes can reach `integrityStatus: "verified"`, and they reach it by
 * recomputation rather than by assertion.
 *
 * The upstream API arrives by injection. That is not ceremony: it keeps `src/` free of cross-tree
 * imports (Mnemosia's source lives on D:, the foundations on C:), it lets the error-translation
 * tests drive real failures through a fake, and it is what makes "replaceable adapter" true rather
 * than aspirational. src/memory/mnemosia/open.ts passes the genuine `createMemoryApi(store)`, and
 * the typechecker proves the structural types below match the real ones at that call site.
 */

import {
	assertDeadline,
	buildEnvelope,
	classifyAdapterError,
	matchTextOrUndefined,
	pageSizeFor,
	runAdapterQuery,
	scopeFilterFor,
	type AdapterProbe,
	type AdapterResult,
	type SourceAdapter,
} from "./contract.ts";
import { SOURCE_ID, type AkashicMemoryOrigin, type ArtifactEnvelope, type PlannedQuery, type RetrievalMethod } from "../types.ts";

/* ------------------------------------------------------------------------------------------------
 * The upstream surface, described structurally
 * ---------------------------------------------------------------------------------------------- */

/** Mirrors AkashicForge's `GovernedMemory` (api.ts:53) — every column the row carries. */
export interface AkashicMemoryRow {
	id: string;
	kind: string;
	content: string;
	scope: "global" | "project";
	project: string | null;
	tags: string[];
	importance: number;
	state: string;
	version: number;
	provenance: unknown[];
	expiresAt: number | null;
	supersedes: string | null;
	createdAt: number;
	updatedAt: number;
	contentHash?: string;
	/**
	 * FTS5's `bm25()` for the query that produced this row (store.ts `MemoryRecord.rank`).
	 *
	 * Optional because it is present only on the full-text path: a recency read and an id read carry
	 * no MATCH and therefore no score. Negative, more negative meaning a better match.
	 */
	rank?: number;
}

/** Mirrors `MemoryQuery` (api.ts:57). */
export interface AkashicMemoryQuery {
	query?: string;
	ids?: string[];
	scope?: "global" | "project" | "all";
	project?: string;
	includeAllStates?: boolean;
	limit?: number;
}

/** Mirrors `MemoryPage` (api.ts:69). */
export interface AkashicMemoryPage {
	schemaVersion: string;
	memories: AkashicMemoryRow[];
}

/**
 * The single method this adapter needs. Narrowed to a read on purpose: `mutateMemory` is not
 * reachable from here, so "Phase 1 never calls mutateMemory" is enforced by the type of the
 * dependency rather than by remembering not to (design §2).
 */
export interface AkashicMemoryReader {
	getMemories(query?: AkashicMemoryQuery): AkashicMemoryPage;
}

export interface AkashicMemoriesAdapterOptions {
	api: AkashicMemoryReader;
	/** Injectable clock so `observedAt` is reproducible in tests. */
	now?: () => number;
}

/* ------------------------------------------------------------------------------------------------
 * Adapter
 * ---------------------------------------------------------------------------------------------- */

export function createAkashicMemoriesAdapter(options: AkashicMemoriesAdapterOptions): SourceAdapter {
	const sourceId = SOURCE_ID.akashicMemories;
	const now = options.now ?? Date.now;

	function probe(): AdapterProbe {
		const started = Date.now();
		try {
			// One row is enough to prove the database opens, the schema is present, and the read path
			// works. Counting the corpus would cost a scan to learn something the probe does not need.
			const page = options.api.getMemories({ limit: 1 });
			return {
				sourceId,
				available: true,
				detail: `curated memory readable (${page.memories.length === 0 ? "empty corpus" : "at least 1 row"}, schema ${page.schemaVersion})`,
				code: null,
				latencyMs: Date.now() - started,
			};
		} catch (error) {
			// A probe never throws: PLAN_RETRIEVAL must be able to record an unavailable source and
			// keep going, which is the whole graceful-degradation path.
			const message = error instanceof Error ? error.message : String(error);
			return { sourceId, available: false, detail: message, code: classifyAdapterError(error), latencyMs: Date.now() - started };
		}
	}

	function query(plannedQuery: PlannedQuery, deadlineMs: number): AdapterResult {
		const started = Date.now();
		return runAdapterQuery(sourceId, () => {
			assertDeadline(sourceId, deadlineMs, started);
			const filter = scopeFilterFor(sourceId, plannedQuery.scope);
			const limit = pageSizeFor(plannedQuery.maxArtifacts);
			const observedAt = now();

			/**
			 * `any` is executed as a **union of single-term reads**, not as an FTS5 `OR` string.
			 *
			 * AkashicForge quotes every token and joins them with a space (`toSafeMatchQuery`,
			 * store.ts:480-484), so an operator written into the query text would be escaped into a
			 * literal and match nothing. Building the disjunction out of the store's own conjunctive
			 * primitive keeps the foundation untouched and keeps every term subject to the tokenizer
			 * the index was built with. It costs one prepared statement per term over a ten-row table,
			 * which is affordable precisely because the curated corpus is bounded at 16,000 global +
			 * 32,000 project characters (store.ts:13-14) — it would not be affordable on a large corpus,
			 * which is why the planner asks for `all` for any other source.
			 *
			 * Rows are keyed by id, so a row matching two terms is one artifact, and the union is
			 * ordered by first appearance in the planner's term order — a total order, which is what
			 * the §16 determinism gate needs.
			 *
			 * **The per-term bm25 scores are summed, and that is a reconstruction rather than a
			 * heuristic.** FTS5's `bm25()` is `Σ_t idf(t)·tfNorm(t, d)` over the query terms present
			 * in the document; every factor in a term's addend is a property of that term, that
			 * document and the index, and none of them is a property of the *other* terms in the
			 * query. So adding the scores this union collects for one row reproduces exactly the
			 * score a single query over the terms that matched it would have produced — which is the
			 * number the disjunction is standing in for. Taking the best single term instead would
			 * make a row that answers three of the task's words look no better than one that answers
			 * its rarest word only, which is the opposite of what a union is for.
			 */
			const terms = plannedQuery.terms.filter((term) => term.trim().length > 0);
			let rows: AkashicMemoryRow[];
			let retrievalMethod: RetrievalMethod;
			let reads: number;
			if (plannedQuery.matchMode === "any" && terms.length > 0) {
				const byId = new Map<string, AkashicMemoryRow>();
				for (const term of terms) {
					if (byId.size >= limit) break;
					// A token the store refuses to search (punctuation-only under its own tokenizer) is
					// skipped rather than failing the whole disjunction: one unusable term must not zero
					// a query the remaining terms can still answer.
					try {
						for (const row of options.api.getMemories({ ...filter, query: term, limit }).memories) {
							const seen = byId.get(row.id);
							if (seen === undefined) {
								byId.set(row.id, row);
								continue;
							}
							// `set` on an existing key keeps its insertion position, so accumulating the
							// score cannot disturb the term-order the determinism gate depends on.
							if (typeof row.rank === "number") byId.set(row.id, { ...seen, rank: (seen.rank ?? 0) + row.rank });
						}
					} catch (error) {
						// Only the store's own refusal of an unsearchable term is skipped; a database failure surfaces
						// through runAdapterQuery as an adapter error instead of turning into an empty result.
						if (error instanceof Error && error.message === "query must contain searchable text") continue;
						throw error;
					}
				}
				rows = [...byId.values()].slice(0, limit);
				retrievalMethod = "lexical_search";
				reads = terms.length;
			} else {
				const match = matchTextOrUndefined(terms);
				retrievalMethod = match === undefined ? "recency_scan" : "lexical_search";
				// Deliberately a single read rather than a paging loop: the corpus bound above means the
				// 100-row cap is not the binding constraint here the way it is on a large corpus, and if it
				// ever binds `truncated` says so instead of the adapter quietly returning a prefix.
				rows = options.api.getMemories({ ...filter, query: match, limit }).memories;
				reads = 1;
			}

			const envelopes = rows.map((row) => toEnvelope(row, retrievalMethod, observedAt));

			return {
				sourceId,
				envelopes,
				truncated: rows.length >= limit && plannedQuery.maxArtifacts > limit,
				pagesRead: reads,
				elapsedMs: Date.now() - started,
			};
		});
	}

	return { sourceId, probe, query };
}

/* ------------------------------------------------------------------------------------------------
 * Normalization
 * ---------------------------------------------------------------------------------------------- */

function toEnvelope(row: AkashicMemoryRow, retrievalMethod: RetrievalMethod, observedAt: number): ArtifactEnvelope {
	/**
	 * The governance columns are inputs to hard filtering (state, expiry, supersession) and to three
	 * of the seven ranking signals (importance, tags, state). The envelope has no typed home for
	 * them and must not grow provider-specific fields, so they ride in provenance — losslessly, and
	 * ahead of whatever provenance the row itself carried.
	 */
	const origin: AkashicMemoryOrigin = {
		kind: "mnemosia/origin/akashic-memory",
		memoryId: row.id,
		memoryKind: row.kind,
		state: row.state,
		version: row.version,
		importance: row.importance,
		tags: row.tags,
		expiresAt: row.expiresAt,
		supersedes: row.supersedes,
		storedContentHash: row.contentHash ?? null,
	};

	return buildEnvelope({
		artifactId: `akashic-memory:${row.id}`,
		sourceId: SOURCE_ID.akashicMemories,
		sourceType: "curated_memory",
		sourceRef: `akashic-forge/memories/${row.id}`,
		content: row.content,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		observedAt,
		scope: { level: row.scope, project: row.project },
		// A curated memory is not the product of one task: it was distilled to outlive them.
		taskScope: null,
		// Human-curated, vault-canonical prose. It is evidence about the world, never an instruction.
		channel: "RETRIEVED_EVIDENCE",
		retrievalMethod,
		provenance: [origin, ...row.provenance],
		// The real check. A row whose stored hash disagrees with sha256 of its own content has been
		// tampered with or has drifted, and it is hard-filtered before ranking ever sees it (§12).
		expectedContentHash: row.contentHash ?? null,
		// FTS5's own bm25, carried verbatim; absent when the read was a recency scan.
		retrievalScore: row.rank,
	});
}

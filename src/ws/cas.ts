import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";

// The content-addressed history store behind Workspaces: objects by sha256, commits and entries of each Workspace,
// merge records with the snapshot of every live file a merge displaces. One node:sqlite file, one connection per
// process (the home lock makes one process per store). The decision model it serves is ported from LayerFS (MIT; NOTICE).

/** Objects per put batch. */
export const OPEN_BATCH = 500;
/** Raw bytes a put batch holds before it is inserted; bounds memory at about twice this (the bytes and their compressed form). */
export const BATCH_BYTES = 64 * 1024 * 1024;
/** The largest live file a merge snapshots. */
export const SNAPSHOT_MAX = 64 * 1024 * 1024;
/** An object younger than this is never collected, referenced or not, so puts whose rows are not written yet survive a GC. */
export const GC_GRACE = 60 * 60 * 1000;
export const KEEP_RUNS = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, size INTEGER, codec TEXT, data BLOB, at INTEGER);
CREATE TABLE IF NOT EXISTS commits(id INTEGER PRIMARY KEY, workspace INTEGER, parent INTEGER, kind TEXT, at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS entries("commit" INTEGER, path TEXT, object TEXT, hash TEXT, size INTEGER, kind TEXT);
CREATE INDEX IF NOT EXISTS entries_path ON entries("commit", path);
CREATE INDEX IF NOT EXISTS entries_object ON entries(object);
CREATE TABLE IF NOT EXISTS workspaces(id INTEGER PRIMARY KEY, key TEXT UNIQUE, project TEXT, project_dev TEXT, project_ino TEXT, mode TEXT, git_head TEXT, refs TEXT, plan TEXT, base INTEGER, head INTEGER, folder TEXT, ws_caseless INTEGER, live_caseless INTEGER, confine TEXT, state TEXT, hold TEXT, hold_detail TEXT, conv INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS ws_stat(workspace INTEGER, path TEXT, size INTEGER, mtime INTEGER, hash TEXT, PRIMARY KEY(workspace, path));
CREATE TABLE IF NOT EXISTS conflicts(workspace INTEGER, path TEXT, kind TEXT, ours TEXT, theirs TEXT, PRIMARY KEY(workspace, path));
CREATE TABLE IF NOT EXISTS merges(id INTEGER PRIMARY KEY, workspace INTEGER, run TEXT, project TEXT, state TEXT, at INTEGER, pass INTEGER, summary TEXT);
CREATE INDEX IF NOT EXISTS merges_run ON merges(workspace, run);
CREATE TABLE IF NOT EXISTS merge_paths(merge INTEGER, seq INTEGER, path TEXT, from_path TEXT, op TEXT, pre TEXT, post TEXT, mode INTEGER, PRIMARY KEY(merge, seq));
CREATE TABLE IF NOT EXISTS projects(project TEXT PRIMARY KEY, nested TEXT, at INTEGER);
`;

/** An object ready to insert: its sha256 id, raw size and stored form. */
export interface Packed {
	id: string;
	size: number;
	codec: "zstd" | "raw";
	data: Uint8Array;
}

/** Hash and compress outside any transaction. zstd is experimental in Node, so a missing or failing zstd stores the bytes raw. */
export function pack(bytes: Uint8Array): Packed {
	const id = createHash("sha256").update(bytes).digest("hex");
	try {
		const z = zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 } });
		if (z.length < bytes.length) return { id, size: bytes.length, codec: "zstd", data: z };
	} catch { /* stored raw */ }
	return { id, size: bytes.length, codec: "raw", data: bytes };
}

export class Cas {
	readonly db: DatabaseSync;
	private readonly now: () => number;

	/** `now` is injectable so a probe can age objects past GC_GRACE. */
	constructor(path: string, now: () => number = Date.now) {
		this.now = now;
		this.db = new DatabaseSync(path);
		// auto_vacuum is fixed at file creation: set it before any table and before WAL, and fail loudly on a file that has another mode.
		this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		const pragma = (name: string): number => Number((this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name]);
		if (pragma("auto_vacuum") !== 2) throw new Error(`workspace store ${path} is not incremental auto_vacuum`);
		this.db.exec("PRAGMA journal_mode = WAL");
		// FULL flushes the WAL at each commit: a merge record and its snapshot are on disk before the first live change they cover.
		this.db.exec("PRAGMA synchronous = FULL");
		if (pragma("synchronous") !== 2) throw new Error(`workspace store ${path} is not synchronous=FULL`);
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Run `fn` in one transaction (BEGIN IMMEDIATE, COMMIT; a thrown error rolls back and rethrows). `fn` must be
	 * synchronous: an await inside would let other chains' statements run inside it. An async function is refused before
	 * BEGIN, and a function that returns a promise is rolled back and refused.
	 */
	tx<T>(fn: () => T): T {
		if (fn.constructor.name === "AsyncFunction") throw new TypeError("Cas.tx takes a synchronous function");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const out = fn();
			if (typeof (out as { then?: unknown } | null)?.then === "function") {
				(out as Promise<unknown>).then(undefined, () => undefined);
				throw new TypeError("Cas.tx function returned a promise; a transaction holds only synchronous calls");
			}
			this.db.exec("COMMIT");
			return out;
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* the failed commit already ended it */ }
			throw error;
		}
	}

	/** Insert packed objects; statements only, so it runs inside `tx` or alone. A put of an id already stored refreshes `at` and writes nothing else. */
	insert(objects: Packed[]): void {
		const stmt = this.db.prepare("INSERT INTO objects VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at");
		const at = this.now();
		for (const o of objects) stmt.run(o.id, o.size, o.codec, o.data, at);
	}

	/** Store one object in its own transaction and return its id. */
	put(bytes: Uint8Array): string {
		const p = pack(bytes);
		this.tx(() => this.insert([p]));
		return p.id;
	}

	/**
	 * Store many objects, reading them one at a time (never in parallel). The bytes of a batch are held in memory; the batch
	 * is inserted in one transaction at OPEN_BATCH objects, before an object that would take it past BATCH_BYTES raw bytes,
	 * and at the end. Returns the ids in order.
	 */
	async putAll(reads: Iterable<() => Uint8Array | Promise<Uint8Array>>): Promise<string[]> {
		const ids: string[] = [];
		let batch: Packed[] = [];
		let held = 0;
		const flush = (): void => {
			if (batch.length > 0) this.tx(() => this.insert(batch));
			batch = [];
			held = 0;
		};
		for (const read of reads) {
			const bytes = await read();
			if (batch.length > 0 && held + bytes.length > BATCH_BYTES) flush();
			const p = pack(bytes);
			batch.push(p);
			held += bytes.length;
			ids.push(p.id);
			if (batch.length >= OPEN_BATCH) flush();
		}
		flush();
		return ids;
	}

	/** The bytes of an object, or undefined when it is not stored. */
	get(id: string): Buffer | undefined {
		const row = this.db.prepare("SELECT codec, data FROM objects WHERE id = ?").get(id) as { codec: string; data: Uint8Array } | undefined;
		if (!row) return undefined;
		return row.codec === "zstd" ? zlib.zstdDecompressSync(row.data) : Buffer.from(row.data);
	}

	/** The ids of the list that have no row in `objects`: one synchronous query, usable inside `tx` or outside it. */
	missing(ids: string[]): string[] {
		const rows = this.db.prepare("SELECT value FROM json_each(?) WHERE value NOT IN (SELECT id FROM objects)").all(JSON.stringify(ids)) as { value: string }[];
		return rows.map((r) => r.value);
	}

	/**
	 * Drop what no kept record needs, in one transaction. Kept: every Workspace in open, held or conflicted and the newest
	 * KEEP_RUNS per project (their commits, entries and conflict objects); the newest done or undone merge per project, every
	 * failed record and every non-terminal one (their merge_paths and snapshot objects). An object younger than GC_GRACE is
	 * never deleted, referenced or not. Returns the number of objects deleted.
	 */
	gc(): number {
		const keptWs = `SELECT id FROM workspaces WHERE state IN ('open', 'held', 'conflicted')
			OR id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY project ORDER BY created DESC, id DESC) AS rn FROM workspaces) WHERE rn <= ${KEEP_RUNS})`;
		const keptMerges = `SELECT id FROM merges WHERE state IN ('planned', 'writing', 'undoing', 'rollback failed', 'undo failed')
			OR id IN (SELECT MAX(id) FROM merges WHERE state IN ('done', 'undone') GROUP BY project)`;
		return this.tx(() => {
			this.db.exec(`DELETE FROM entries WHERE "commit" IN (SELECT id FROM commits WHERE workspace NOT IN (${keptWs}))`);
			this.db.exec(`DELETE FROM commits WHERE workspace NOT IN (${keptWs})`);
			this.db.exec(`DELETE FROM merge_paths WHERE merge NOT IN (${keptMerges})`);
			const r = this.db.prepare(`DELETE FROM objects WHERE at < ? AND id NOT IN (
				SELECT object FROM entries WHERE object IS NOT NULL
				UNION SELECT pre FROM merge_paths WHERE pre IS NOT NULL
				UNION SELECT ours FROM conflicts WHERE ours IS NOT NULL AND workspace IN (${keptWs})
				UNION SELECT theirs FROM conflicts WHERE theirs IS NOT NULL AND workspace IN (${keptWs}))`).run(this.now() - GC_GRACE);
			return Number(r.changes);
		});
	}

	/** Give free pages back to the file, a slice at a time; run it at an idle moment, never at startup. */
	vacuum(pages: number): void {
		this.db.exec(`PRAGMA incremental_vacuum(${Math.trunc(pages)})`);
	}
}

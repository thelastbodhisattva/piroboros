import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalize, isInside } from "../paths.ts";
import { BATCH_BYTES, Cas, OPEN_BATCH, pack, SNAPSHOT_MAX, type Packed } from "./cas.ts";

// The write path of a merge into the live folder, and the reverse rule that undoes it (rollback, crash recovery, undo).
// Before the first live change every live path the merge touches is in the CAS (its bytes, or "absent") under a committed
// record; each live file is replaced only after its bytes are checked against what the plan saw; the CAS is the only
// source of pre bytes, so an old file is never needed to restore one. Not atomic across files or across a power loss.

export type Fs = Pick<typeof fsp, "lstat" | "open" | "readdir" | "mkdir" | "rmdir" | "unlink" | "rename" | "link" | "copyFile" | "rm" | "statfs" | "symlink" | "readlink" | "readFile" | "writeFile">;
export const realFs: Fs = fsp;

export type Op = "write" | "create" | "delete" | "rename" | "mkdir";
/** One live path the merge changes. `pre` is the live hash the plan saw (null: absent); `post` the hash of Vesperia's file (null: deleted). */
export interface Row { seq: number; path: string; from: string | null; op: Op; pre: string | null; post: string | null; mode: number | null; preSize?: number; postSize?: number; /** A clean line merge: the bytes to place, in place of the Workspace file. */ body?: Uint8Array }
export type Outcome = "unchanged" | "restored" | "removed" | "kept" | "changed" | "protected" | "failed";
export interface RowResult { seq: number; path: string; outcome: Outcome; reason?: string; fromAbsent?: boolean }

/** A hold that needs no record: nothing live changed. `detail` is the hold code's argument. */
export class HoldError extends Error {
	readonly code: "preflight" | "oversize";
	readonly detail: string;
	constructor(code: "preflight" | "oversize", detail: string, message = detail) {
		super(message);
		this.code = code;
		this.detail = detail;
	}
}
/** A pre-flight re-decision found a conflict: the merge writes nothing. */
export class ConflictFound extends Error {
	readonly path: string;
	constructor(path: string) { super(`conflict at ${path}`); this.path = path; }
}

export type Redecided = "drop" | "conflict" | "oversize" | { row: Row };

export interface MergeInput {
	ws: number;
	project: string;
	folder: string;
	run: string | null;
	caseless: boolean;
	rows: Row[];
	/** The first line of the stored summary; the kept old files are appended. */
	head: string;
	/** A path's live bytes changed after the plan: decide it again with these bytes (null: it is absent now). */
	redecide(row: Row, live: Buffer | null): Promise<Redecided>;
}

export interface MergeResult {
	id: number | undefined;
	state: "done" | "rolled back" | "rollback failed" | "pending";
	summary: string;
	lines: string[];
}

export interface WriterDeps {
	cas: Cas;
	fs: Fs;
	/** The folder holding ws.sqlite, for the free-space check. */
	storeDir: string;
	allowed(abs: string): boolean;
	notice(text: string): void;
	now(): number;
	removeFolder(folder: string): Promise<void>;
	platform?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
}

const MARGIN = 64 * 1024 * 1024;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const eexist = (path: string): Error => Object.assign(new Error(`${path} already exists`), { code: "EEXIST" });
const slash = (rel: string): string[] => rel.split("/");

/** ponytail: 6.3 s on win32 (a scanner can hold a fresh file), 350 ms elsewhere; the plan sets both and d1.38 measured the Windows hold. */
const WAITS = { win32: [100, 200, 400, 800, 1_600, 3_200], other: [50, 100, 200] } as const;

type Live = { kind: "absent" } | { kind: "file"; hash: string; size: number; mode: number } | { kind: "dir" } | { kind: "other" };

export class Writer {
	private readonly d: WriterDeps;
	private readonly db: Cas["db"];
	/** True once one call of the current pass used its whole retry budget: later calls get one attempt. */
	private exhausted = false;
	private linkable = new Map<string, boolean>();
	private listings = new Map<string, string[]>();

	constructor(deps: WriterDeps) { this.d = deps; this.db = deps.cas.db; }

	/* --- io --------------------------------------------------------------------------------------------------- */

	/** Drop the cached folder listings, so the next `name` reads the folder as it is now (a plan that follows the user's edits). */
	forgetNames(): void { this.listings.clear(); }

	private startPass(): void { this.exhausted = false; this.linkable.clear(); this.listings.clear(); }

	/** Link, rename, unlink and rmdir retry EBUSY, EPERM and EACCES with async waits; a wait past 1 s shows a notice. */
	private async retry<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const waits = (this.d.platform ?? process.platform) === "win32" ? WAITS.win32 : WAITS.other;
		const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		let waited = 0;
		for (let i = 0; ; i += 1) {
			try { return await fn(); } catch (error) {
				if (!["EBUSY", "EPERM", "EACCES"].includes(code(error) ?? "")) throw error;
				if (this.exhausted || i >= waits.length) { this.exhausted = true; throw error; }
				if (waited + waits[i]! > 1_000 && waited <= 1_000) this.d.notice(`waiting for ${path}, which another program holds`);
				waited += waits[i]!;
				await sleep(waits[i]!);
			}
		}
	}

	private async live(abs: string): Promise<Live> {
		let info;
		try { info = await this.d.fs.lstat(abs); } catch (error) { if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return { kind: "absent" }; throw error; }
		if (info.isDirectory()) return { kind: "dir" };
		if (!info.isFile()) return { kind: "other" };
		return { kind: "file", hash: await this.hashFile(abs), size: info.size, mode: info.mode & 0o777 };
	}

	async hashFile(abs: string): Promise<string> {
		const fh = await this.d.fs.open(abs, "r");
		try {
			const hash = createHash("sha256");
			const buf = Buffer.allocUnsafe(1 << 20);
			for (;;) {
				const { bytesRead } = await fh.read(buf, 0, buf.length, null);
				if (bytesRead === 0) return hash.digest("hex");
				hash.update(buf.subarray(0, bytesRead));
			}
		} finally { await fh.close(); }
	}

	/** Up to `max` bytes through one handle; `over` when the file is larger. */
	private async readBounded(abs: string, max: number): Promise<{ bytes: Buffer } | { over: true }> {
		const fh = await this.d.fs.open(abs, "r");
		try {
			const chunks: Buffer[] = [];
			let total = 0;
			for (;;) {
				const buf = Buffer.allocUnsafe(Math.min(1 << 20, max + 1 - total));
				const { bytesRead } = await fh.read(buf, 0, buf.length, null);
				if (bytesRead === 0) return { bytes: Buffer.concat(chunks) };
				chunks.push(buf.subarray(0, bytesRead));
				total += bytesRead;
				if (total > max) return { over: true };
			}
		} finally { await fh.close(); }
	}

	private tmp = (abs: string, m: number, p: number): string => join(dirname(abs), `.${basename(abs)}.piroboros-tmp-${m}-${p}`);
	private old = (abs: string, m: number, p: number): string => join(dirname(abs), `.${basename(abs)}.piroboros-old-${m}-${p}`);

	private async absent(path: string): Promise<void> {
		try { await this.d.fs.lstat(path); } catch (error) { if (code(error) === "ENOENT") return; throw error; }
		throw eexist(path);
	}

	/** The on-disk name of a live path: on a case-insensitive folder each component takes the case the folder holds. */
	async name(project: string, rel: string, caseless: boolean): Promise<string> {
		let cur = project;
		for (const part of slash(rel)) {
			let hit = part;
			if (caseless) {
				const names = await this.listing(cur);
				hit = names.find((n) => n === part) ?? names.find((n) => n.toLowerCase() === part.toLowerCase()) ?? part;
			}
			cur = join(cur, hit);
		}
		return cur;
	}

	/** The name a row's path takes: for a rename's destination the row's own spelling of the last component, so a case-only rename changes the case. */
	private async target(project: string, row: Row, caseless: boolean): Promise<string> {
		const abs = await this.name(project, row.path, caseless);
		return row.op === "rename" ? join(dirname(abs), basename(row.path)) : abs;
	}

	private async listing(dir: string): Promise<string[]> {
		let names = this.listings.get(dir);
		if (names === undefined) {
			try { names = await this.d.fs.readdir(dir); } catch (error) { if (code(error) !== "ENOENT" && code(error) !== "ENOTDIR") throw error; names = []; }
			this.listings.set(dir, names);
		}
		return names;
	}

	/** Exact-name presence from a fresh listing: on a case-insensitive folder `A` and `B` alias, so existence tests cannot be used. */
	private async exact(abs: string): Promise<boolean> {
		try { return (await this.d.fs.readdir(dirname(abs))).includes(basename(abs)); } catch (error) { if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return false; throw error; }
	}

	/** Whether hard links work on the volume of `dir`: one attempt, outside the retry wrapper, per volume and pass. */
	private async canLink(dir: string, m: number, p: number): Promise<boolean> {
		const dev = String((await this.d.fs.lstat(dir, { bigint: true } as never)).dev);
		const known = this.linkable.get(dev);
		if (known !== undefined) return known;
		const probe = join(dir, `.piroboros-tmp-${m}-${p}-probe`);
		let ok = true;
		try {
			await (await this.d.fs.open(probe, "wx")).close();
			try { await this.d.fs.link(probe, `${probe}-link`); } catch { ok = false; }
		} finally {
			await this.d.fs.unlink(`${probe}-link`).catch(() => undefined);
			await this.d.fs.unlink(probe).catch(() => undefined);
		}
		this.linkable.set(dev, ok);
		return ok;
	}

	/** Put a staged file at a name that must be absent: link then unlink, or lstat then rename on a volume without links. */
	private async place(src: string, dst: string, m: number, p: number, lines: string[]): Promise<void> {
		this.listings.delete(dirname(dst));
		if (await this.canLink(dirname(dst), m, p)) {
			await this.retry(dst, () => this.d.fs.link(src, dst));
			try { await this.retry(src, () => this.d.fs.unlink(src)); } catch (error) { lines.push(`left behind: ${src} (${message(error)})`); }
		} else {
			await this.absent(dst);
			await this.retry(dst, () => this.d.fs.rename(src, dst));
		}
	}

	/** Write bytes to a new name (exclusive create, the file's mode, fsync) and check their hash. */
	private async stageBytes(tmp: string, bytes: Uint8Array, mode: number | null, hash: string): Promise<void> {
		const fh = await this.d.fs.open(tmp, "wx", mode ?? 0o644);
		try { await fh.writeFile(bytes); await fh.datasync(); } finally { await fh.close(); }
		if (await this.hashFile(tmp) !== hash) throw new Error(`${tmp} does not hold the bytes it was written with`);
	}

	private async stageCopy(src: string, tmp: string, mode: number | null, hash: string): Promise<void> {
		const from = await this.d.fs.open(src, "r");
		let to;
		try {
			to = await this.d.fs.open(tmp, "wx", mode ?? 0o644);
			const buf = Buffer.allocUnsafe(1 << 20);
			const h = createHash("sha256");
			for (;;) {
				const { bytesRead } = await from.read(buf, 0, buf.length, null);
				if (bytesRead === 0) break;
				h.update(buf.subarray(0, bytesRead));
				await to.write(buf, 0, bytesRead);
			}
			await to.datasync();
			if (h.digest("hex") !== hash) throw new Error(`${src} changed while it was staged`);
		} finally { await from.close(); await to?.close(); }
	}

	/* --- the merge -------------------------------------------------------------------------------------------- */

	/** Pre-flight and snapshot, the record, staging, the apply and the finish. Throws HoldError or ConflictFound before any record exists. */
	async merge(input: MergeInput): Promise<MergeResult> {
		this.startPass();
		const prepared = await this.prepare(input);
		const { id } = prepared;
		const rows = prepared.rows;
		const lines: string[] = [];
		const olds: { abs: string; old: string; hash: string }[] = [];
		const cancelled = (reason: string): Promise<MergeResult> => this.rollback(id, input, reason, lines);
		// Stage: nothing live is replaced yet.
		try {
			const missing = this.d.cas.missing(rows.flatMap((r) => (r.pre === null ? [] : [r.pre])));
			if (missing.length > 0) return await cancelled(`the snapshot lacks ${missing.length} object${missing.length === 1 ? "" : "s"}`);
			for (const row of rows.filter((r) => r.op === "mkdir")) {
				const abs = await this.name(input.project, row.path, input.caseless);
				await this.d.fs.mkdir(abs);
				this.listings.delete(dirname(abs));
			}
			for (const row of rows.filter((r) => r.post !== null && r.op !== "mkdir")) { const abs = await this.target(input.project, row, input.caseless);
				if (row.body !== undefined) await this.stageBytes(this.tmp(abs, id, 0), row.body, row.mode, row.post!);
				else await this.stageCopy(join(input.folder, ...slash(row.path)), this.tmp(abs, id, 0), row.mode, row.post!);
			}
			for (const row of rows.filter((r) => r.op !== "mkdir")) await this.canLink(dirname(await this.name(input.project, row.path, input.caseless)), id, 0);
		} catch (error) { return cancelled(`staging failed: ${message(error)}`); }
		this.db.prepare("UPDATE merges SET state = 'writing' WHERE id = ?").run(id);
		// Apply in seq order: a delete or rename group, then writes and creates; mkdir rows were made at staging.
		try {
			for (const row of rows.filter((r) => r.op !== "mkdir")) {
				if (row.op === "rename") {
					const a = await this.name(input.project, row.from!, input.caseless);
					const b = await this.target(input.project, row, input.caseless); await this.displace(a, row.pre!, id, olds, lines);
					this.listings.delete(dirname(a));
					await this.place(this.tmp(b, id, 0), b, id, 0, lines);
					continue;
				}
				const abs = await this.target(input.project, row, input.caseless); if (row.pre !== null) await this.displace(abs, row.pre, id, olds, lines);
				if (row.post !== null) await this.place(this.tmp(abs, id, 0), abs, id, 0, lines);
			}
			// Finish: an old file that changed since it was displaced held a write by a program that kept it open.
			for (const o of olds) {
				if (await this.live(o.old).then((s) => s.kind !== "file" || s.hash !== o.hash)) lines.push(`your edit during the merge is saved at ${o.old}`);
			}
		} catch (error) { return cancelled(message(error)); }
		const summary = (): string => [input.head, ...lines].join("\n");
		for (let attempt = 0; ; attempt += 1) {
			try {
				this.d.cas.tx(() => {
					this.db.prepare("UPDATE merges SET state = 'done', summary = ? WHERE id = ?").run(summary(), id);
					this.db.prepare("UPDATE workspaces SET state = 'merged', hold = NULL, hold_detail = NULL WHERE id = ?").run(input.ws);
				});
				break;
			} catch (error) {
				if (attempt >= 2) return cancelled(`the merge record could not be finished: ${message(error)}`);
				await (this.d.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(1_000);
			}
		}
		await this.cleanup(id, input.project, input.caseless, new Map(), true, lines).catch((error: unknown) => lines.push(`cleanup: ${message(error)}`));
		await this.d.removeFolder(input.folder).catch((error: unknown) => lines.push(`the Workspace folder could not be removed: ${message(error)}`));
		return { id, state: "done", summary: summary(), lines };
	}

	/** Move a live path aside and check it is what the plan saw; put it back and stop when it is not. */
	private async displace(abs: string, expect: string, m: number, olds: { abs: string; old: string; hash: string }[], lines: string[]): Promise<void> {
		const old = this.old(abs, m, 0);
		await this.absent(old);
		try { await this.retry(abs, () => this.d.fs.rename(abs, old)); } catch (error) {
			if (code(error) === "ENOENT") throw new Error(`${abs} is gone: the live file changed during the merge`);
			throw error;
		}
		this.listings.delete(dirname(abs));
		const hash = await this.hashFile(old);
		if (hash !== expect) {
			try { await this.place(old, abs, m, 0, lines); } catch (error) {
				if (code(error) === "EEXIST") lines.push(`kept: ${old} (your newer version of ${abs}; a file exists at that name now)`); else throw error;
			}
			throw new Error(`${abs} changed during the merge and was put back`);
		}
		olds.push({ abs, old, hash });
	}

	/** Step 1: checks, free space, the bounded snapshot reads, then the record by the loop that keeps every await outside the transaction. */
	private async prepare(input: MergeInput): Promise<{ id: number; rows: Row[] }> {
		const canonicalProject = canonicalize(input.project);
		let rows = [...input.rows];
		const hold = (reason: string): HoldError => new HoldError("preflight", reason);
		// Path checks and the lock probe for every row that touches an existing live file.
		for (const row of rows.filter((r) => r.op !== "mkdir")) {
			const abs = await this.name(input.project, row.path, input.caseless);
			await this.checkParents(input.project, canonicalProject, abs, row.path);
			if (row.pre !== null) {
				try { await (await this.d.fs.open(abs, "r+")).close(); } catch (error) { if (code(error) !== "ENOENT") throw hold(`${row.path} cannot be opened for writing (${message(error)})`); }
			}
		}
		await this.freeSpace(input, rows);
		// Snapshot: each pre is read through one handle, at most SNAPSHOT_MAX + 1 bytes, and must hash to what the plan saw.
		const packed: Packed[] = [];
		let held = 0;
		const flush = (): void => { if (packed.length > 0) { const batch = packed.splice(0); this.d.cas.tx(() => this.d.cas.insert(batch)); } held = 0; };
		const modes = new Map<number, number>();
		for (let k = 0; k < rows.length; k += 1) {
			for (let attempt = 0; ; attempt += 1) {
				const row = rows[k]!;
				const abs = row.op === "mkdir" ? "" : await this.name(input.project, row.op === "rename" ? row.from! : row.path, input.caseless);
				if (row.op === "mkdir") break;
				let bytes: Buffer | null;
				try {
					const r = await this.readBounded(abs, SNAPSHOT_MAX);
					if ("over" in r) throw new HoldError("oversize", row.path);
					bytes = r.bytes;
				} catch (error) {
					if (error instanceof HoldError) throw error;
					if (code(error) !== "ENOENT") throw hold(`${row.path}: ${message(error)}`);
					bytes = null;
				}
				const hash = bytes === null ? null : sha(bytes);
				if (hash === row.pre) {
					if (bytes !== null) {
						if (held + bytes.length > BATCH_BYTES) flush();
						packed.push(pack(bytes));
						held += bytes.length;
						if (packed.length >= OPEN_BATCH) flush();
						const mode = await this.d.fs.lstat(abs).then((s) => s.mode & 0o777).catch(() => null);
						if (mode !== null) modes.set(row.seq, mode);
					}
					break;
				}
				// The live file changed after the plan: decide this path again, once, with the bytes just read.
				if (attempt > 0) throw hold(`${row.path} kept changing during the merge`);
				const again = await input.redecide(row, bytes);
				if (again === "conflict") throw new ConflictFound(row.path);
				if (again === "oversize") throw new HoldError("oversize", row.path);
				if (again === "drop") { rows = rows.filter((r) => r !== row); k -= 1; break; }
				rows[k] = again.row;
			}
		}
		flush();
		rows = rows.map((r) => (modes.has(r.seq) ? { ...r, mode: modes.get(r.seq)! } : r));
		// The record loop: every await outside the transaction, at most three tries.
		const pres = rows.flatMap((r) => (r.pre === null || r.op === "mkdir" ? [] : [r.pre]));
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const lost = this.d.cas.missing(pres);
			for (const hash of lost) {
				const row = rows.find((r) => r.pre === hash)!;
				const abs = await this.name(input.project, row.op === "rename" ? row.from! : row.path, input.caseless);
				const r = await this.readBounded(abs, SNAPSHOT_MAX).catch(() => undefined);
				if (r === undefined || "over" in r || sha(r.bytes) !== hash) throw hold(`${row.path} changed during the merge`);
				this.d.cas.put(r.bytes);
			}
			const id = this.d.cas.tx(() => {
				if (this.d.cas.missing(pres).length > 0) return undefined;
				const m = Number(this.db.prepare("INSERT INTO merges(workspace, run, project, state, at, pass) VALUES (?, ?, ?, 'planned', ?, 0)").run(input.ws, input.run, input.project, this.d.now()).lastInsertRowid);
				const stmt = this.db.prepare("INSERT INTO merge_paths VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
				for (const r of rows) stmt.run(m, r.seq, r.path, r.from, r.op, r.pre, r.post, r.mode);
				return m;
			});
			if (id !== undefined) return { id, rows };
		}
		throw hold("the store kept dropping snapshot objects; /conclave merge tries again");
	}

	private async checkParents(project: string, canonicalProject: string, abs: string, rel: string): Promise<void> {
		let cur = project;
		for (const part of dirname(abs).slice(project.length).split(/[\\/]/u).filter((s) => s !== "")) {
			cur = join(cur, part);
			let info;
			try { info = await this.d.fs.lstat(cur); } catch (error) { if (code(error) === "ENOENT") break; throw error; }
			if (info.isSymbolicLink()) throw new HoldError("preflight", `${rel}: a link lies in its path`);
			if (!info.isDirectory()) throw new HoldError("preflight", `${rel}: a parent is not a folder`);
		}
		if (!isInside(canonicalProject, canonicalize(abs))) throw new HoldError("preflight", `${rel} resolves outside the project`);
		if (!this.d.allowed(abs)) throw new HoldError("preflight", `${rel} is protected`);
	}

	/** Per volume: the tmp of every row, the rollback tmp of a displaced one, and the snapshot in the store, plus a margin. */
	private async freeSpace(input: MergeInput, rows: Row[]): Promise<void> {
		const need = new Map<string, { dir: string; bytes: number }>();
		const volume = async (path: string): Promise<{ dev: string; dir: string }> => {
			let dir = dirname(path);
			for (;;) {
				try { return { dev: String((await this.d.fs.lstat(dir, { bigint: true } as never)).dev), dir }; } catch (error) {
					if (code(error) !== "ENOENT" || dirname(dir) === dir) throw error;
					dir = dirname(dir);
				}
			}
		};
		const add = (dev: string, dir: string, bytes: number): void => { need.set(dev, { dir: need.get(dev)?.dir ?? dir, bytes: (need.get(dev)?.bytes ?? 0) + bytes }); };
		for (const row of rows.filter((r) => r.op !== "mkdir")) {
			const v = await volume(await this.name(input.project, row.path, input.caseless));
			add(v.dev, v.dir, (row.postSize ?? 0) + (row.pre !== null ? row.preSize ?? 0 : 0));
		}
		const stored = new Set(this.d.cas.missing(rows.flatMap((r) => (r.pre === null ? [] : [r.pre]))));
		const raw = rows.filter((r) => r.pre !== null && stored.has(r.pre)).reduce((sum, r) => sum + (r.preSize ?? 0), 0);
		const s = await volume(join(this.d.storeDir, "x"));
		add(s.dev, s.dir, raw);
		for (const v of need.values()) {
			let free: number;
			try { const st = await this.d.fs.statfs(v.dir); free = Number(st.bavail) * Number(st.bsize); } catch (error) {
				this.d.notice(`free space on ${v.dir} could not be read (${message(error)}); the merge goes on`);
				continue;
			}
			if (free < v.bytes + MARGIN) throw new HoldError("preflight", `not enough free space on the volume of ${v.dir}: needs ${v.bytes + MARGIN}, has ${free}`);
		}
	}

	/* --- the reverse rule ------------------------------------------------------------------------------------- */

	private rowsOf(id: number): Row[] {
		return (this.db.prepare("SELECT seq, path, from_path AS \"from\", op, pre, post, mode FROM merge_paths WHERE merge = ? ORDER BY seq DESC").all(id) as unknown as Row[]);
	}

	private nextPass(id: number): number {
		return this.d.cas.tx(() => {
			this.db.prepare("UPDATE merges SET pass = pass + 1 WHERE id = ?").run(id);
			return Number((this.db.prepare("SELECT pass FROM merges WHERE id = ?").get(id) as { pass: number }).pass);
		});
	}

	/** What a reverse pass would do to one row, and why not when it would do nothing. */
	private async classify(row: Row, project: string, caseless: boolean): Promise<{ verdict: "unchanged" | "act" | "changed" | "protected"; reason?: string; abs: string; from?: string; fromAbsent?: boolean }> {
		const abs = await this.target(project, row, caseless); const from = row.from === null ? undefined : join(dirname(await this.name(project, row.from, caseless)), basename(row.from));
		const target = from ?? abs;
		if (!this.d.allowed(abs) || (from !== undefined && !this.d.allowed(from))) return { verdict: "protected", reason: "the path is protected", abs, ...(from === undefined ? {} : { from }) };
		const out = (verdict: "unchanged" | "act" | "changed", reason?: string, fromAbsent?: boolean) => ({ verdict, ...(reason === undefined ? {} : { reason }), abs, ...(from === undefined ? {} : { from }), ...(fromAbsent ? { fromAbsent } : {}) });
		const at = async (p: string): Promise<Live> => ((await this.exact(p)) || !caseless ? this.live(p) : { kind: "absent" });
		switch (row.op) {
			case "mkdir": { const s = await this.live(abs); return s.kind === "absent" ? out("unchanged") : s.kind === "dir" ? out("act") : out("changed", "a file is at the folder's path"); }
			case "create": { const s = await this.live(abs); if (s.kind === "absent") return out("unchanged"); return s.kind === "file" && s.hash === row.post ? out("act") : out("changed", "the live file holds other bytes"); }
			case "delete": { const s = await this.live(abs); if (s.kind === "file" && s.hash === row.pre) return out("unchanged"); return s.kind === "absent" ? out("act", undefined, true) : out("changed", "the live path holds other bytes"); }
			case "write": {
				const s = await this.live(abs);
				if (s.kind === "file" && s.hash === row.pre) return out("unchanged");
				if (s.kind === "absent") return out("act", undefined, true);
				return s.kind === "file" && s.hash === row.post ? out("act") : out("changed", "the live file holds other bytes");
			}
			case "rename": {
				const a = await at(target);
				const b = await at(abs);
				if (a.kind === "file" && a.hash === row.pre && b.kind === "absent") return out("unchanged");
				if (a.kind === "absent" && (b.kind === "absent" || (b.kind === "file" && b.hash === row.post))) return out("act", undefined, a.kind === "absent" && b.kind === "absent");
				return out("changed", "the live path holds other bytes");
			}
		}
	}

	/** What an undo would do, row by row (descending seq), without touching anything. */
	async preview(id: number, project: string, caseless: boolean): Promise<{ row: Row; verdict: string; reason?: string }[]> {
		this.startPass();
		const out: { row: Row; verdict: string; reason?: string }[] = [];
		for (const row of this.rowsOf(id)) {
			const c = await this.classify(row, project, caseless);
			out.push({ row, verdict: c.verdict === "act" ? (row.op === "create" || row.op === "mkdir" ? "remove" : "restore") : c.verdict, ...(c.reason === undefined ? {} : { reason: c.reason }) });
		}
		return out;
	}

	/** Take a live file in its post state aside, check it, and put it back when it is not what the merge wrote. */
	private async removeLive(abs: string, post: string | null, m: number, p: number, lines: string[]): Promise<boolean> {
		const old = this.old(abs, m, p);
		await this.absent(old);
		await this.retry(abs, () => this.d.fs.rename(abs, old));
		this.listings.delete(dirname(abs));
		if (post !== null && await this.hashFile(old) === post) {
			// The merge's own output: nothing is lost by deleting it, and a folder it sat in can be removed in this pass.
			await this.retry(old, () => this.d.fs.unlink(old)).catch(() => undefined);
			return true;
		}
		try { await this.place(old, abs, m, p, lines); } catch (error) { if (code(error) !== "EEXIST") throw error; lines.push(`kept: ${old} (bytes that are not the merge's output; a file exists at ${abs})`); }
		return false;
	}

	private async placePre(abs: string, row: Row, m: number, p: number, lines: string[]): Promise<void> {
		const bytes = this.d.cas.get(row.pre!);
		if (bytes === undefined) throw new Error("the snapshot object is missing from the store");
		const tmp = this.tmp(abs, m, p);
		await this.stageBytes(tmp, bytes, row.mode, row.pre!);
		await this.place(tmp, abs, m, p, lines);
	}

	/** One reverse pass: `pass` is incremented first, rows run in descending seq, and a failing row never stops the next. */
	async reverse(id: number, project: string, caseless: boolean): Promise<{ results: RowResult[]; lines: string[]; pass: number }> {
		const pass = this.nextPass(id);
		this.startPass();
		const results: RowResult[] = [];
		const lines: string[] = [];
		for (const row of this.rowsOf(id)) {
			const result: RowResult = { seq: row.seq, path: row.path, outcome: "failed" };
			results.push(result);
			try {
				const c = await this.classify(row, project, caseless);
				if (c.verdict === "unchanged") { result.outcome = "unchanged"; continue; }
				if (c.verdict !== "act") { result.outcome = c.verdict; result.reason = c.reason; continue; }
				if (c.fromAbsent) result.fromAbsent = true;
				if (row.op === "mkdir") {
					try {
						// The merge's own staged tmp files do not keep the folder it made.
						for (const name of await this.d.fs.readdir(c.abs).catch(() => [] as string[])) if (name.includes(`.piroboros-tmp-${id}-`)) await this.d.fs.unlink(join(c.abs, name)).catch(() => undefined);
						await this.retry(c.abs, () => this.d.fs.rmdir(c.abs)); result.outcome = "removed";
					} catch (error) {
						if (code(error) === "ENOTEMPTY" || code(error) === "EEXIST") { result.outcome = "kept"; result.reason = "kept: folder not empty"; } else throw error;
					}
					this.listings.delete(dirname(c.abs));
				} else if (row.op === "create") {
					result.outcome = (await this.removeLive(c.abs, row.post, id, pass, lines)) ? "removed" : "changed";
					if (result.outcome === "changed") result.reason = "the live file changed while it was being removed";
				} else if (row.op === "rename") {
					if (await this.exact(c.abs) && !(await this.removeLive(c.abs, row.post, id, pass, lines))) { result.outcome = "changed"; result.reason = "the live file changed while it was being removed"; continue; }
					await this.placePre(c.from!, row, id, pass, lines);
					result.outcome = "restored";
				} else {
					if ((await this.live(c.abs)).kind === "file" && !(await this.removeLive(c.abs, row.post, id, pass, lines))) { result.outcome = "changed"; result.reason = "the live file changed while it was being removed"; continue; }
					if (row.op === "delete" || row.op === "write") await this.placePre(c.abs, row, id, pass, lines);
					result.outcome = "restored";
				}
			} catch (error) {
				result.outcome = "failed";
				result.reason = message(error);
			}
		}
		return { results, lines, pass };
	}

	/** Delete the record's tmp files, and its old files whose bytes the snapshot or the merge's output still holds; keep and list the rest. */
	private async cleanup(id: number, project: string, caseless: boolean, ended: Map<number, Outcome>, done: boolean, lines: string[]): Promise<void> {
		const rows = this.rowsOf(id);
		const folders = new Set<string>();
		for (const row of rows) {
			for (const rel of row.op === "mkdir" ? [row.path] : row.op === "rename" ? [row.path, row.from!] : [row.path]) {
				folders.add(row.op === "mkdir" ? await this.name(project, rel, caseless) : dirname(await this.name(project, rel, caseless)));
			}
		}
		for (const dir of folders) {
			let names: string[];
			try { names = await this.d.fs.readdir(dir); } catch { continue; }
			for (const name of names) {
				const abs = join(dir, name);
				if (new RegExp(`\\.piroboros-tmp-${id}-`, "u").test(name)) { await this.retry(abs, () => this.d.fs.unlink(abs)).catch((error: unknown) => lines.push(`left behind: ${abs} (${message(error)})`)); continue; }
				const match = new RegExp(`^\\.(.+)\\.piroboros-old-${id}-\\d+$`, "u").exec(name);
				if (match === null) continue;
				const row = rows.find((r) => [r.path, r.from].some((p) => p !== null && basename(p).toLowerCase() === match[1]!.toLowerCase()));
				const hash = await this.live(abs).then((s) => (s.kind === "file" ? s.hash : undefined)).catch(() => undefined);
				const outcome = row === undefined ? undefined : ended.get(row.seq);
				const safe = hash !== undefined && row !== undefined && (hash === row.pre || hash === row.post) && (done || outcome === "unchanged" || outcome === "restored" || outcome === "removed");
				if (safe) await this.retry(abs, () => this.d.fs.unlink(abs)).catch((error: unknown) => lines.push(`left behind: ${abs} (${message(error)})`));
				else lines.push(`kept: ${abs} (${row === undefined ? "no row names it" : `it holds bytes neither the snapshot nor the merge wrote, or row ${row.path} did not end restored`})`);
			}
		}
	}

	private ends(results: RowResult[]): { failed: RowResult[]; map: Map<number, Outcome> } {
		return { failed: results.filter((r) => ["changed", "protected", "failed"].includes(r.outcome)), map: new Map(results.map((r) => [r.seq, r.outcome])) };
	}

	private report(results: RowResult[]): string[] {
		return results.flatMap((r) => (r.outcome === "unchanged" ? [] : [`${r.outcome}: ${r.path}${r.reason === undefined ? "" : ` (${r.reason})`}${r.fromAbsent ? " (restored from absent)" : ""}`]));
	}

	/** In-process rollback after a stop in steps 2 to 5; ends the record and holds the Workspace in one transaction. */
	private async rollback(id: number, input: Pick<MergeInput, "ws" | "project" | "caseless">, reason: string, lines: string[]): Promise<MergeResult> {
		let pass: Awaited<ReturnType<Writer["reverse"]>>;
		try { pass = await this.reverse(id, input.project, input.caseless); } catch (error) {
			return { id, state: "pending", summary: `merge ${id} stopped (${reason}) and its rollback did not start: ${message(error)}`, lines };
		}
		const { failed, map } = this.ends(pass.results);
		await this.cleanup(id, input.project, input.caseless, map, false, pass.lines);
		const state = failed.length === 0 ? "rolled back" : "rollback failed";
		const summary = [`merge ${id} stopped: ${reason}`, state === "rolled back" ? "Everything was put back." : `${failed.length} path${failed.length === 1 ? "" : "s"} could not be restored:`, ...this.report(pass.results), ...pass.lines, ...lines].join("\n");
		try {
			this.d.cas.tx(() => {
				this.db.prepare("UPDATE merges SET state = ?, summary = ? WHERE id = ?").run(state, summary, id);
				this.db.prepare("UPDATE workspaces SET state = 'held', hold = 'rollback', hold_detail = ? WHERE id = ?").run(String(id), input.ws);
			});
		} catch (error) { return { id, state: "pending", summary: `merge ${id} stopped (${reason}); its rollback ran but could not be recorded: ${message(error)}`, lines }; }
		return { id, state, summary, lines: [...pass.lines, ...lines] };
	}

	/* --- recovery and undo ------------------------------------------------------------------------------------ */

	/**
	 * At startup, before the scheduler: a `planned` or `writing` record is rolled back, a `done` one is cleaned up and its
	 * Workspace folder removed, an `undoing` one is run again. Returns one line per record.
	 */
	async recover(): Promise<string[]> {
		const out: string[] = [];
		const records = this.db.prepare("SELECT m.id, m.state, m.workspace AS ws, m.project, w.folder, w.live_caseless AS caseless FROM merges m LEFT JOIN workspaces w ON w.id = m.workspace WHERE m.state IN ('planned', 'writing', 'done', 'undoing') ORDER BY m.id").all() as { id: number; state: string; ws: number; project: string; folder: string | null; caseless: number }[];
		for (const r of records) {
			const caseless = r.caseless === 1;
			try {
				if (r.state === "done") {
					const lines: string[] = [];
					await this.cleanup(r.id, r.project, caseless, new Map(), true, lines);
					if (r.folder !== null) await this.d.removeFolder(r.folder);
					out.push(`merge ${r.id}: finished cleaning up${lines.length === 0 ? "" : `; ${lines.join("; ")}`}`);
				} else if (r.state === "undoing") {
					const res = await this.finishUndo(r.id, r.project, caseless);
					out.push(`undo of merge ${r.id}: ${res.state}`);
				} else {
					const res = await this.rollback(r.id, { ws: r.ws, project: r.project, caseless }, "the merge was interrupted", []);
					out.push(`merge ${r.id} was interrupted and is ${res.state}`);
				}
			} catch (error) { out.push(`merge record ${r.id} was not recovered: ${message(error)}`); }
		}
		return out;
	}

	/** `/conclave undo` over the newest record of a project: one reverse pass, the cleanup, and the end state. */
	async finishUndo(id: number, project: string, caseless: boolean): Promise<{ state: "undone" | "undo failed"; text: string }> {
		this.db.prepare("UPDATE merges SET state = 'undoing' WHERE id = ?").run(id);
		const pass = await this.reverse(id, project, caseless);
		const { failed, map } = this.ends(pass.results);
		await this.cleanup(id, project, caseless, map, false, pass.lines);
		const state = failed.length === 0 ? "undone" : "undo failed";
		this.db.prepare("UPDATE merges SET state = ? WHERE id = ?").run(state, id);
		const text = [state === "undone" ? "Undo finished." : `Undo finished with ${failed.length} path${failed.length === 1 ? "" : "s"} skipped or failed; /conclave undo runs it again over every row.`, ...this.report(pass.results), ...pass.lines].join("\n");
		return { state, text };
	}
}

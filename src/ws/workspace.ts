import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { checkPath, checkRead, WIDE_SECRET, type GuardConfig } from "../guard.ts";
import { canonicalize, isInside, samePath } from "../paths.ts";
import { ConflictFound, HoldError, realFs, Writer, type Fs, type Row } from "./apply.ts";
import { BATCH_BYTES, Cas, GC_GRACE, OPEN_BATCH, pack, SNAPSHOT_MAX, type Packed } from "./cas.ts";
import { HostGit, WsRefusal, type GitSpy, type GitState } from "./git.ts";
import { decide, TEXT_MAX, type ConflictKind, type Side } from "./merge.ts";

// Workspaces for Vesperia: one private copy of the git-visible files of a project per run, checkpointed into the CAS, merged
// back three-way when her run ends `done`. The merge writes through ./apply.ts. Unconfined in P27d1: the Workspace keeps her
// away from the live folder by convention and the start notice says so.

export { WsRefusal } from "./git.ts";
export type Mode = "git" | "plain" | "none";
export type WsState = "open" | "held" | "conflicted" | "merged" | "discarded";
export type ExecMerge = { state: WsState | "none"; record?: number; code?: string };

export interface WsRow {
	id: number; key: string; project: string; project_dev: string; project_ino: string; mode: "git" | "plain"; git_head: string | null; refs: string | null; plan: string;
	base: number; head: number; folder: string; ws_caseless: number; live_caseless: number; confine: string; state: WsState; hold: string | null; hold_detail: string | null; conv: number | null; created: number;
}

export const LINK_NAMES = ["node_modules"];
export const FILE_BOUND = 25_000;
export const BYTE_BOUND = 2 * 1024 ** 3;
export const BULK_DELETE = 20;
const SHELL_ACTIVE = [/\.lnk$/iu, /\.url$/iu, /\.scf$/iu, /^desktop\.ini$/iu, /^autorun\.inf$/iu, /\.library-ms$/iu, /\.searchConnector-ms$/iu];
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
// ponytail: a scan walks every file; about 0.6 s at 25,000 files. fs.watch when a scan measures over 1 s.

const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const posix = (p: string): string => p.replaceAll("\\", "/");
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

export interface WsOptions {
	/** PIROBOROS_HOME: the store is ${home}/ws/store.sqlite. */
	home: string;
	guard(): GuardConfig;
	settings(): { enabled: boolean; nested: "ask" | "copy" | "inplace" };
	notice(text: string): void;
	/** Where Workspace folders live; default the per-platform folder. A probe puts it under its scratchpad. */
	wsRoot?: string;
	fs?: Fs;
	now?: () => number;
	platform?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
	gitSpy?: GitSpy;
	/** Task status for the ended rule and the commands. Set by the Conclave once the harness exists. */
	taskStatus?: (taskId: string) => Promise<"running" | "parked" | "terminal" | "missing">;
}

/** The files of a Workspace as the merge and the scan see them: path to hash, object (when stored), size and kind. */
interface Ent { path: string; hash: string | null; object: string | null; size: number; kind: "file" | "link" | "skipped" }

interface PlanConflict { path: string; kind: ConflictKind | "case"; ours: Buffer | null; oursSize: number; theirsHash: string | null; theirs: Buffer | null; liveSize: number; wsPath: string }
interface Plan {
	rows: Row[];
	conflicts: PlanConflict[];
	left: { path: string; reason: string }[];
	oversize: { path: string; ws: string }[];
	headMoved?: { from: string; to: string };
	deletes: number;
	ignored: string[];
	ignoreFailed: boolean;
	changed: number;
	redecide(row: Row, live: Buffer | null): Promise<"drop" | "conflict" | "oversize" | { row: Row }>;
}
/** What a `/conclave merge` prompt showed; the merge after the answer goes ahead only when its new plan shows the same. */
const shown = (p: Plan): string => JSON.stringify([p.headMoved?.to ?? null, p.deletes >= BULK_DELETE, p.oversize.map((o) => o.path).sort(), p.conflicts.map((c) => `${c.kind} ${c.liveSize > SNAPSHOT_MAX} ${c.path}`).sort()]);

export const wsRootFor = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string =>
	platform === "win32" ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "piroboros-ws")
		: platform === "darwin" ? join(homedir(), "Library", "Application Support", "piroboros-ws")
		: join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "piroboros-ws");

/** The text a hold shows, one per code. */
export function holdText(code: string | null, detail: string | null): string {
	const d = detail ?? "";
	switch (code) {
		case "verdict": return `Vesperia's run ended ${d}; /conclave merge applies her changes, /conclave discard drops them`;
		case "cancelled": return "the run was cancelled";
		case "conflicts": return `${d} conflicts`;
		case "head-moved": { const [a, b] = d.split(" "); return `the live HEAD moved from ${a?.slice(0, 8)} to ${b?.slice(0, 8)} since the Workspace opened`; }
		case "bulk-delete": return `the merge would delete ${d} live files`;
		case "oversize": return `${d.split("\n").length} of Vesperia's changes replace live files over 64 MiB, which cannot be snapshotted, so they are not merged: ${d.split("\n").join(", ")}; copy them yourself before /conclave merge, which removes the Workspace afterwards`;
		case "preflight": return `the merge could not start at ${d}; nothing was changed`;
		case "rollback": return `merge ${d} was rolled back`;
		case "backend": return `confinement backend unavailable: ${d}`;
		case "ignore-rules": return "the live ignore rules could not be read";
		case "target-moved": return "the project folder is not the one the Workspace was opened for";
		case "folder-missing": return "the Workspace folder is missing";
		case "not-recovered": return `merge record ${d} was not recovered`;
		case "parked": return "task parked by the restart limit";
		case "ended": return `the run ended without closing its Workspace (${d})`;
		default: return code === null ? "no hold" : `${code} ${d}`.trim();
	}
}

const LIMITED = (items: string[], max = 20): string[] => (items.length > max ? [...items.slice(0, max), `and ${items.length - max} more`] : items);

export class Workspaces {
	readonly cas: Cas;
	readonly git: HostGit;
	readonly writer: Writer;
	readonly wsRoot: string;
	readonly hash: string;
	private readonly o: WsOptions;
	private readonly fs: Fs;
	private readonly now: () => number;
	private nextId: number;
	private readonly byConv = new Map<number, WsRow>();
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly queued = new Set<number>();
	private readonly ignored = new Map<number, string[]>();
	private readonly chainKeys = new Map<string, string>();
	taskStatus: WsOptions["taskStatus"];

	constructor(options: WsOptions) {
		this.o = options;
		this.fs = options.fs ?? realFs;
		this.now = options.now ?? Date.now;
		this.taskStatus = options.taskStatus;
		const dir = join(options.home, "ws");
		mkdirSync(join(dir, "no-hooks"), { recursive: true });
		this.cas = new Cas(join(dir, "store.sqlite"), this.now);
		this.git = new HostGit(options.home, options.gitSpy);
		this.hash = sha(canonicalize(options.home)).slice(0, 12);
		this.wsRoot = options.wsRoot ?? wsRootFor(options.platform);
		this.nextId = Number((this.cas.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM workspaces").get() as { m: number }).m) + 1;
		this.writer = new Writer({
			cas: this.cas, fs: this.fs, storeDir: dir, now: this.now, notice: options.notice, removeFolder: (folder) => this.removeFolder(folder),
			allowed: (abs) => checkPath(abs, undefined, options.guard(), true).allowed, ...(options.platform === undefined ? {} : { platform: options.platform }), ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
		});
		for (const row of this.rows("state IN ('open', 'held', 'conflicted')")) if (row.conv !== null) this.byConv.set(row.conv, row);
	}

	close(): void { this.cas.close(); }

	/* --- rows --------------------------------------------------------------------------------------------------- */

	private rows(where: string, ...params: (string | number)[]): WsRow[] {
		return this.cas.db.prepare(`SELECT * FROM workspaces WHERE ${where} ORDER BY created DESC, id DESC`).all(...params) as unknown as WsRow[];
	}

	row(id: number): WsRow | undefined { return this.rows("id = ?", id)[0]; }
	byKey(key: string): WsRow | undefined { return this.rows("key = ?", key)[0]; }
	/** The newest Workspace of a project that is still in play. */
	forProject(project: string): WsRow | undefined { return this.rows("project = ? AND state IN ('open', 'held', 'conflicted')", canonicalize(project))[0]; }
	forConv(conv: number): WsRow | undefined { return this.byConv.get(conv); }

	private set(id: number, patch: Partial<Pick<WsRow, "state" | "hold" | "hold_detail" | "key" | "conv" | "head">>): void {
		const entries = Object.entries(patch);
		this.cas.db.prepare(`UPDATE workspaces SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, v]) => v as string | number | null), id);
		this.refresh(id);
	}

	/** Re-read a row into the conversation map (the writer changes some states in its own transactions). */
	private refresh(id: number): void {
		const row = this.row(id);
		if (row?.conv != null) { if (["open", "held", "conflicted"].includes(row.state)) this.byConv.set(row.conv, row); else this.byConv.delete(row.conv); }
	}

	private hold(id: number, code: string, detail: string | null = null, state: WsState = "held"): void { this.set(id, { state, hold: code, hold_detail: detail }); }

	/** The newest merge record of a Workspace for a run key. */
	private record(ws: number, run: string): { id: number; state: string; summary: string | null } | undefined {
		return this.cas.db.prepare("SELECT id, state, summary FROM merges WHERE workspace = ? AND run = ? ORDER BY id DESC LIMIT 1").get(ws, run) as { id: number; state: string; summary: string | null } | undefined;
	}

	/** One promise chain per repository (or project folder), so an undo never runs during a merge of the same files. Each link catches. */
	private chain<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
		this.chains.set(key, run.catch(() => undefined));
		return run;
	}

	/** The chain key: the repository's top level when the project is inside one, else the project folder. */
	private async chainKey(project: string): Promise<string> {
		let key = this.chainKeys.get(project);
		if (key === undefined) {
			key = project;
			try { const s = await this.git.state(project); if (s.kind === "tree") key = s.toplevel; } catch { /* the project folder is the key */ }
			this.chainKeys.set(project, key);
		}
		return key;
	}

	private chained<T>(project: string, fn: () => Promise<T>): Promise<T> { return this.chainKey(project).then((key) => this.chain(key, fn)); }

	/* --- mode --------------------------------------------------------------------------------------------------- */

	/**
	 * Fix the mode of a Vesperia run at approve: `git` (a Workspace with an allow-listed .git), `plain` (without .git) or `none`
	 * (in place). A nested project (a subfolder of a repository, a worktree or a submodule) takes the setting, the kept answer
	 * or one question through `ask`. A held Workspace of another mode refuses the approve.
	 */
	async resolveMode(projectIn: string, ask?: (question: string) => Promise<boolean>): Promise<{ ok: true; mode: Mode; from: string; note?: string } | { ok: false; error: string }> {
		const project = canonicalize(projectIn);
		const s = this.o.settings();
		const held = this.rows("project = ? AND state IN ('held', 'conflicted')", project)[0];
		let mode: Mode;
		let from: string;
		let setting: string | undefined;
		let note: string | undefined;
		try {
			if (!s.enabled) { mode = "none"; from = "workspace.enabled is false"; setting = "workspace.enabled"; } else {
				const state = await this.git.state(project);
				if (state.kind === "none") { mode = "plain"; from = "no git"; } else {
					const nested = !samePath(state.toplevel, project) || await this.fs.lstat(join(project, ".git")).then((i) => i.isFile()).catch(() => false);
					if (!nested) { mode = "git"; from = "not a nested project"; } else if (s.nested === "copy") { mode = "plain"; from = "the setting workspace.nested"; setting = "workspace.nested"; } else if (s.nested === "inplace") { mode = "none"; from = "the setting workspace.nested"; setting = "workspace.nested"; } else {
						const kept = this.cas.db.prepare("SELECT nested FROM projects WHERE project = ?").get(project) as { nested: string } | undefined;
						if (kept !== undefined) { mode = kept.nested === "inplace" ? "none" : "plain"; from = "your kept answer for this folder"; setting = "workspace.nested"; } else if (held !== undefined) { mode = held.mode; from = "the held Workspace"; } else {
							if (ask === undefined) return { ok: false, error: "this folder needs a one-time choice, which only the chat screen can ask; or set workspace.nested to copy or inplace" };
							const what = state.kind === "tree" && samePath(state.toplevel, project) ? "a folder whose .git is a file (a worktree or a submodule)" : `a subfolder of the git repository ${state.toplevel}`;
							const yes = await ask([
								`${project} is ${what}.`,
								"A Workspace here holds the folder's git-visible files without git: Vesperia's git commands see no repository, and her changes merge back as usual.",
								"In place, Vesperia writes straight to your files as in 0.2.0: /conclave undo covers her write and edit calls, not bash, and her shell is not confined.",
								"Your answer is kept for this folder; the setting workspace.nested overrides it.",
								"Let Vesperia work in place, writing straight to your files?",
							].join("\n"));
							mode = yes ? "none" : "plain";
							from = "your answer";
							this.cas.db.prepare("INSERT INTO projects VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET nested = excluded.nested, at = excluded.at").run(project, yes ? "inplace" : "copy", this.now());
						}
					}
				}
			}
		} catch (error) {
			if (error instanceof WsRefusal) return { ok: false, error: error.message };
			throw error;
		}
		if (held !== undefined && held.mode !== mode) {
			return { ok: false, error: `Vesperia's earlier Workspace for ${project} runs ${held.mode}, and this approve would run ${mode === "none" ? "in place" : mode} because ${setting ?? "the project"} changed; /conclave merge or /conclave discard it first, or set ${setting ?? "the project"} back.` };
		}
		if (mode === "none" && from !== "workspace.enabled is false") note = `Vesperia works in place in ${project} (your choice for this folder; workspace.nested changes it)`;
		return { ok: true, mode, from, ...(note === undefined ? {} : { note }) };
	}

	/* --- open --------------------------------------------------------------------------------------------------- */

	private async pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { for (let i = next++; i < items.length; i = next++) await fn(items[i]!); }));
	}

	/**
	 * Open the Workspace of a run key (pipeline `start` phase). A row for the key is reused (a replayed `start`); a held or
	 * conflicted Workspace of the project with the same plan is reopened in place; otherwise the copy is made. Returns the
	 * folder Vesperia's conversation gets as its cwd and the start notice.
	 */
	async open(key: string, mode: "git" | "plain", projectIn: string, plan: string): Promise<{ folder: string; notice: string[] }> {
		const project = canonicalize(projectIn);
		return this.chained(project, async () => {
			const known = this.byKey(key);
			if (known !== undefined && ["open", "held", "conflicted"].includes(known.state)) { this.set(known.id, { state: "open", hold: null, hold_detail: null }); return { folder: known.folder, notice: [] }; }
			await this.endedRule(project);
			const same = this.rows("project = ? AND state IN ('open', 'held', 'conflicted')", project)[0];
			if (same !== undefined) {
				if (same.state === "open") throw new WsRefusal("Vesperia is already working on this project in another conversation; wait for that run or /conclave cancel it there");
				if (same.plan !== plan) throw new WsRefusal(`Vesperia's earlier Workspace holds ${this.changedPaths(same.id).length} changed files; /conclave merge or /conclave discard first.`);
				const refs = same.refs === null ? [] : (JSON.parse(same.refs) as string[]);
				if (same.mode === "git" && refs.length > 0 && (await this.git.missingObjects(project, refs)).length > 0) {
					throw new WsRefusal(`the live repository no longer has objects this Workspace's git needs (pruned since ${new Date(same.created).toISOString().slice(0, 10)}); its files are intact: /conclave merge or /conclave discard still work.`);
				}
				this.cas.tx(() => { this.cas.db.prepare("UPDATE workspaces SET key = ?, conv = NULL, state = 'open', hold = NULL, hold_detail = NULL WHERE id = ?").run(key, same.id); });
				if (same.conv !== null) this.byConv.delete(same.conv);
				return { folder: same.folder, notice: [`Vesperia continues in her earlier Workspace of ${project} (${this.changedPaths(same.id).length} changed files)`] };
			}
			return this.copyIn(key, mode, project, plan);
		});
	}

	/** Attach the Vesperia conversation to the Workspace of a key (inside the start commit, so a replay rewrites it). */
	attach(key: string, conv: number): void {
		const row = this.byKey(key);
		if (row === undefined) return;
		this.set(row.id, { conv });
	}

	private async copyIn(key: string, mode: "git" | "plain", project: string, plan: string): Promise<{ folder: string; notice: string[] }> {
		const cfg = this.o.guard();
		const refuse = (text: string): never => { throw new WsRefusal(text); };
		const read = checkRead(project, undefined, cfg);
		if (!read.allowed) refuse(`${project} is inside a protected location (${read.reason}); add it to guard.allow, or set workspace.enabled to false`);
		const rootDir = join(this.wsRoot, this.hash);
		if (!checkPath(rootDir, undefined, cfg, true).allowed) refuse(`the Workspace folder ${rootDir} would be inside a protected location; change guard.deny or wsRoot`);
		const state: GitState = await this.git.state(project);
		if (state.kind === "tree") {
			const op = this.git.operationInProgress(state.gitDir);
			if (op !== undefined) refuse(`finish or abort the ${op} in ${project} first`);
		}
		// The copy set.
		const secrets: string[] = [];
		const skipped: string[] = [];
		const links: string[] = [];
		let listed: string[];
		if (state.kind === "tree") listed = await this.git.files(project);
		else listed = await this.walkProject(project, links);
		const dev = (await this.fs.lstat(project, { bigint: true } as never)) as unknown as { dev: bigint; ino: bigint };
		const items: { path: string; size: number; mode: number; link?: string }[] = [];
		const missing: string[] = [];
		await this.pool(listed, 16, async (path) => {
			if (WIDE_SECRET.some((p) => p.test(basename(path)))) { secrets.push(path); return; }
			try {
				const info = await this.fs.lstat(join(project, path));
				if (info.isDirectory()) { skipped.push(`${path} (a folder: a nested repository or an uninitialized submodule)`); return; }
				if (info.isSymbolicLink()) items.push({ path, size: 0, mode: 0, link: await this.fs.readlink(join(project, path)) });
				else if (info.isFile()) items.push({ path, size: info.size, mode: info.mode & 0o777 });
				else skipped.push(`${path} (not a regular file)`);
			} catch (error) {
				if (code(error) === "ENOENT") missing.push(path); else skipped.push(`${path} (${code(error) ?? msg(error)})`);
			}
		});
		// Case folding: probe the Workspace volume and the live folder without writing to the live one.
		// The live folder's case sensitivity: lstat a case-swapped form of a path with a letter and compare inodes; nothing is written.
		const first = items.find((i) => /[a-z]/iu.test(i.path));
		const inode = async (path: string): Promise<bigint | undefined> => ((await this.fs.lstat(join(project, path), { bigint: true } as never).catch(() => undefined)) as unknown as { ino: bigint } | undefined)?.ino;
		const liveCaseless = first !== undefined && (await inode(first.path.replace(/[a-z]/giu, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())))) === (await inode(first.path)) && (await inode(first.path)) !== undefined;
		const id = this.nextId++;
		const folder = join(rootDir, String(id));
		await this.fs.mkdir(folder, { recursive: true, mode: 0o700 } as never);
		const wsCaseless = await this.probeCaseless(folder);
		if (wsCaseless) {
			const groups = new Map<string, string[]>();
			for (const i of items) groups.set(i.path.toLowerCase(), [...(groups.get(i.path.toLowerCase()) ?? []), i.path]);
			for (const [, paths] of groups) if (paths.length > 1) { skipped.push(`${paths.join(", ")} (names equal under case folding)`); for (const p of paths) items.splice(items.findIndex((i) => i.path === p), 1); }
		}
		try {
			const gitFiles = mode === "git" && state.kind === "tree" ? await this.gitAllowList(state.gitDir) : [];
			const total = items.length + gitFiles.length;
			const bytes = items.reduce((n, i) => n + i.size, 0) + gitFiles.reduce((n, g) => n + g.size, 0);
			if (total > FILE_BOUND) refuse(`${project} has ${total} files to copy, over the limit of ${FILE_BOUND}; set workspace.enabled to false to run in place`);
			if (bytes > BYTE_BOUND) refuse(`${project} has ${bytes} bytes to copy, over the limit of 2 GiB; set workspace.enabled to false to run in place`);
			if (state.kind === "tree") {
				for (const dir of await this.git.ignoredDirs(project)) if (LINK_NAMES.includes(basename(dir.replace(/\/$/u, "")))) links.push(dir.replace(/\/$/u, ""));
			}
			const objects: Packed[] = [];
			let held = 0;
			const flush = (): void => { if (objects.length > 0) { const batch = objects.splice(0); this.cas.tx(() => this.cas.insert(batch)); } held = 0; };
			const made = new Set<string>();
			const ensure = async (dir: string): Promise<void> => { if (!made.has(dir)) { await this.fs.mkdir(dir, { recursive: true } as never); made.add(dir); } };
			const ents = new Map<string, Ent>();
			const unreadable: string[] = [];
			await this.pool(items, 8, async (item) => {
				const src = join(project, item.path);
				const dst = join(folder, item.path);
				await ensure(dirname(dst));
				if (item.link !== undefined) {
					try { await this.fs.symlink(item.link, dst); ents.set(item.path, { path: item.path, hash: sha(item.link), object: null, size: 0, kind: "link" }); } catch (error) { skipped.push(`${item.path} (the symlink could not be recreated: ${code(error)})`); }
					return;
				}
				try {
					if (item.size <= TEXT_MAX) {
						const data = await this.fs.readFile(src);
						await this.fs.writeFile(dst, data, { mode: item.mode });
						const p = pack(data);
						if (held + data.length > BATCH_BYTES) flush();
						objects.push(p);
						held += data.length;
						ents.set(item.path, { path: item.path, hash: p.id, object: p.id, size: data.length, kind: "file" });
						if (objects.length >= OPEN_BATCH) flush();
					} else {
						await this.fs.copyFile(src, dst);
						ents.set(item.path, { path: item.path, hash: await this.writer.hashFile(dst), object: null, size: item.size, kind: "file" });
					}
				} catch (error) { unreadable.push(`${item.path} (${code(error) ?? msg(error)})`); }
			});
			flush();
			skipped.push(...unreadable);
			for (const path of missing) ents.set(path, { path, hash: null, object: null, size: 0, kind: "skipped" });
			// LINK_NAMES folders (node_modules) start as empty real folders: no link into the live project, ever.
			for (const rel of links) await ensure(join(folder, rel));
			if (mode === "git" && state.kind === "tree") await this.copyGit(state.gitDir, folder, gitFiles);
			// Stat every copied path: a path missing or of another size after the copy becomes `skipped`.
			const stats = new Map<string, { size: number; mtime: number }>();
			await this.pool([...ents.values()].filter((e) => e.kind !== "skipped"), 16, async (e) => {
				try {
					const info = await this.fs.lstat(join(folder, e.path));
					if (e.kind === "file" && info.size !== e.size) { ents.set(e.path, { ...e, hash: null, object: null, kind: "skipped" }); skipped.push(`${e.path} (it changed during the copy)`); return; }
					stats.set(e.path, { size: info.size, mtime: Math.floor(info.mtimeMs) });
				} catch { ents.set(e.path, { ...e, hash: null, object: null, kind: "skipped" }); skipped.push(`${e.path} (it vanished during the copy)`); }
			});
			const head = state.kind === "tree" ? (await this.git.head(project)) ?? "" : null;
			const refs = mode === "git" && state.kind === "tree" ? await this.git.refIds(project) : [];
			if (refs.length > 0 && (await this.git.missingObjects(project, refs)).length > 0) refuse("the live repository is missing objects that its own refs name; run git fsck there first");
			const objectIds = [...ents.values()].flatMap((e) => (e.object === null ? [] : [e.object]));
			let baseId = 0;
			this.cas.tx(() => {
				if (this.cas.missing(objectIds).length > 0) throw new WsRefusal("the store dropped objects of this copy while it was made; approve again");
				const confine = JSON.stringify({ name: "none" });
				this.cas.db.prepare("INSERT INTO workspaces(id, key, project, project_dev, project_ino, mode, git_head, refs, plan, folder, ws_caseless, live_caseless, confine, state, conv, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)")
					.run(id, key, project, String(dev.dev), String(dev.ino), mode, head, refs.length === 0 ? null : JSON.stringify(refs), plan, folder, wsCaseless ? 1 : 0, liveCaseless ? 1 : 0, confine, this.now());
				baseId = Number(this.cas.db.prepare("INSERT INTO commits(workspace, parent, kind, at, note) VALUES (?, NULL, 'base', ?, 'open')").run(id, this.now()).lastInsertRowid);
				const entry = this.cas.db.prepare('INSERT INTO entries("commit", path, object, hash, size, kind) VALUES (?, ?, ?, ?, ?, ?)');
				const stat = this.cas.db.prepare("INSERT INTO ws_stat VALUES (?, ?, ?, ?, ?)");
				for (const e of ents.values()) {
					entry.run(baseId, e.path, e.object, e.hash, e.size, e.kind);
					const st = stats.get(e.path);
					if (st !== undefined) stat.run(id, e.path, st.size, st.mtime, e.hash);
				}
				this.cas.db.prepare("UPDATE workspaces SET base = ?, head = ? WHERE id = ?").run(baseId, baseId, id);
			});
			const list = (names: string[]): string => `${names.slice(0, 10).join(", ")}${names.length > 10 ? ` and ${names.length - 10} more` : ""}`;
			const out: string[] = [
				`Vesperia works in a Workspace copy of ${project} (${ents.size} files${links.length > 0 ? `, ${links.join(", ")} starts empty` : ""}${secrets.length > 0 ? `; left out: ${list(secrets)}` : ""}${skipped.length > 0 || missing.length > 0 ? `${secrets.length > 0 ? "," : "; left out:"} ${list([...skipped, ...missing.map((m) => `${m} (missing on disk)`)])}` : ""}; ${mode === "git" ? "with git" : state.kind === "tree" ? "without git: this folder is nested" : "without git"}). Shell confinement: none.`,
				"WARNING: shell commands are not confined on this system. Vesperia's commands run in the Workspace folder but can still read and write any path your account can, including your live project.",
			];
			return { folder, notice: out };
		} catch (error) {
			await this.removeFolder(folder).catch(() => undefined);
			throw error;
		}
	}

	private async probeCaseless(folder: string): Promise<boolean> {
		const probe = join(folder, ".piroboros-case-probe");
		try {
			await (await this.fs.open(probe, "wx")).close();
			return await this.fs.lstat(probe.replace(/case-probe$/u, "CASE-PROBE")).then(() => true, () => false);
		} finally { await this.fs.unlink(probe).catch(() => undefined); }
	}

	private async walkProject(project: string, links: string[]): Promise<string[]> {
		const out: string[] = [];
		const walk = async (dir: string, rel: string): Promise<void> => {
			for (const e of await this.fs.readdir(dir, { withFileTypes: true } as never) as unknown as import("node:fs").Dirent[]) {
				const path = rel === "" ? e.name : `${rel}/${e.name}`;
				if (e.name === ".git") continue;
				if (e.isDirectory() && LINK_NAMES.includes(e.name)) { links.push(path); continue; }
				if (e.isDirectory()) await walk(join(dir, e.name), path); else out.push(path);
			}
		};
		await walk(project, "");
		return out;
	}

	/** The files of the live .git that a git Workspace copies: an allow-list, no objects, hooks, lfs, modules or worktrees. */
	private async gitAllowList(gitDir: string): Promise<{ rel: string; size: number }[]> {
		const out: { rel: string; size: number }[] = [];
		const walk = async (rel: string): Promise<void> => {
			const abs = join(gitDir, rel);
			let info;
			try { info = await this.fs.lstat(abs); } catch { return; }
			if (info.isSymbolicLink() || rel.endsWith(".lock")) return;
			if (info.isDirectory()) { for (const name of await this.fs.readdir(abs)) await walk(`${rel}/${name}`); } else if (info.isFile()) out.push({ rel, size: info.size });
		};
		for (const name of ["HEAD", "config", "index", "refs", "packed-refs", "info", "shallow", "logs", "reftable"]) await walk(name);
		return out;
	}

	private async copyGit(gitDir: string, folder: string, files: { rel: string; size: number }[]): Promise<void> {
		const dest = join(folder, ".git");
		await this.fs.mkdir(join(dest, "objects", "pack"), { recursive: true } as never);
		await this.fs.mkdir(join(dest, "objects", "info"), { recursive: true } as never);
		for (const f of files) {
			if (f.rel === "config") { await this.fs.writeFile(join(dest, "config"), await this.git.copyConfig(gitDir)); continue; }
			await this.fs.mkdir(dirname(join(dest, f.rel)), { recursive: true } as never);
			await this.fs.copyFile(join(gitDir, f.rel), join(dest, f.rel));
		}
		// Borrow the live repository's objects: its own object folder, then the alternates it already has.
		const own = join(gitDir, "objects");
		const inherited = await this.fs.readFile(join(own, "info", "alternates"), "utf8").then((t) => t.split(/\r?\n/u).filter((l) => l !== ""), () => [] as string[]);
		await this.fs.writeFile(join(dest, "objects", "info", "alternates"), `${[own, ...inherited].map(posix).join("\n")}\n`);
	}

	/* --- manifests, scan and checkpoints ------------------------------------------------------------------------ */

	private manifest(ws: number, kinds: string): Map<string, Ent> {
		const out = new Map<string, Ent>();
		const rows = this.cas.db.prepare(`SELECT e.path, e.hash, e.object, e.size, e.kind FROM entries e JOIN commits c ON c.id = e."commit" WHERE c.workspace = ? AND c.kind IN (${kinds}) ORDER BY c.id ASC, e.rowid ASC`).all(ws) as unknown as Ent[];
		for (const r of rows) out.set(r.path, r);
		return out;
	}

	private headOf(ws: number): Map<string, Ent> { return this.manifest(ws, "'base', 'refresh', 'checkpoint'"); }
	private baseOf(ws: number): Map<string, Ent> { return this.manifest(ws, "'base', 'refresh'"); }

	/** The paths Vesperia changed since the base. */
	private changedPaths(ws: number): string[] {
		const head = this.headOf(ws);
		const base = this.baseOf(ws);
		return [...new Set([...head.keys(), ...base.keys()])].filter((p) => (head.get(p)?.hash ?? null) !== (base.get(p)?.hash ?? null) || (head.get(p)?.kind ?? null) !== (base.get(p)?.kind ?? null)).sort();
	}

	private async walkWs(folder: string): Promise<Map<string, "file" | "other">> {
		const out = new Map<string, "file" | "other">();
		const walk = async (dir: string, rel: string): Promise<void> => {
			let list: import("node:fs").Dirent[];
			try { list = await this.fs.readdir(dir, { withFileTypes: true } as never) as unknown as import("node:fs").Dirent[]; } catch (error) { if (rel === "") throw error; return; }
			for (const e of list) {
				const path = rel === "" ? e.name : `${rel}/${e.name}`;
				if (e.name === ".git" || (e.name !== undefined && LINK_NAMES.includes(e.name) && (e.isDirectory() || e.isSymbolicLink()))) continue;
				if (e.isDirectory()) await walk(join(dir, e.name), path); else out.set(path, e.isFile() ? "file" : "other");
			}
		};
		await walk(folder, "");
		return out;
	}

	/** Compare the Workspace with its stat rows and checkpoint what changed. Returns the new git-ignored paths and whether the ignore check failed. */
	private async scanNow(row: WsRow, only?: string[], force = false): Promise<{ ignoredNew: string[]; ignoreFailed: boolean }> {
		const stat = new Map((this.cas.db.prepare("SELECT path, size, mtime, hash FROM ws_stat WHERE workspace = ?").all(row.id) as unknown as { path: string; size: number; mtime: number; hash: string }[]).map((s) => [s.path, s]));
		const onDisk = only === undefined ? await this.walkWs(row.folder) : new Map(only.map((p) => [p, "file" as const]));
		const candidates = only ?? [...new Set([...onDisk.keys(), ...stat.keys()])];
		const changed: { path: string; hash: string; size: number; mtime: number; link: boolean }[] = [];
		const deleted: string[] = [];
		const touch: { path: string; size: number; mtime: number; hash: string }[] = [];
		const fresh: typeof changed = [];
		await this.pool(candidates, 16, async (path) => {
			// A full scan decides presence by the exact names the walk listed: lstat would find `Readme.md` under `README.md` on a case-insensitive folder.
			if (only === undefined && !onDisk.has(path)) { if (stat.has(path)) deleted.push(path); return; }
			let info;
			try { info = await this.fs.lstat(join(row.folder, path)); } catch (error) {
				if (code(error) === "ENOENT" || code(error) === "ENOTDIR") { if (stat.has(path)) deleted.push(path); return; }
				throw error;
			}
			if (info.isDirectory()) { if (stat.has(path)) deleted.push(path); return; }
			const link = !info.isFile();
			const known = stat.get(path);
			const mtime = Math.floor(info.mtimeMs);
			if (known !== undefined && !force && known.size === info.size && known.mtime === mtime) return;
			const hash = link ? sha(await this.fs.readlink(join(row.folder, path)).catch(() => "")) : await this.writer.hashFile(join(row.folder, path));
			if (known === undefined) fresh.push({ path, hash, size: info.size, mtime, link });
			else if (known.hash === hash) touch.push({ path, size: info.size, mtime, hash });
			else changed.push({ path, hash, size: info.size, mtime, link });
		});
		// New paths: secret names are never checkpointed; paths the live repository ignores are kept in memory for the merge notice.
		let ignoredNew: string[] = [];
		let ignoreFailed = false;
		let adds = fresh.filter((f) => !WIDE_SECRET.some((p) => p.test(basename(f.path))));
		if (adds.length > 0 && row.git_head !== null) {
			try {
				const hit = await this.git.ignored(row.project, adds.map((a) => a.path));
				ignoredNew = [...hit];
				adds = adds.filter((a) => !hit.has(a.path));
			} catch (error) { ignoreFailed = true; this.o.notice(`the live ignore rules could not be read (${msg(error)}); the merge will hold`); }
		}
		if (only === undefined) this.ignored.set(row.id, ignoredNew);
		await this.checkpoint(row, [...changed, ...adds], deleted, touch);
		return { ignoredNew, ignoreFailed };
	}

	/** Insert the changed paths as `checkpoint` commits, in batches by the CAS rule, each batch with its objects in one transaction. */
	private async checkpoint(row: WsRow, changed: { path: string; hash: string; size: number; mtime: number; link: boolean }[], deleted: string[], touch: { path: string; size: number; mtime: number; hash: string }[]): Promise<void> {
		if (touch.length > 0) this.cas.tx(() => { const st = this.cas.db.prepare("UPDATE ws_stat SET size = ?, mtime = ? WHERE workspace = ? AND path = ?"); for (const t of touch) st.run(t.size, t.mtime, row.id, t.path); });
		let batch: { c: (typeof changed)[number]; p?: Packed }[] = [];
		let held = 0;
		const commit = (list: typeof batch, gone: string[]): void => {
			this.cas.tx(() => {
				this.cas.insert(list.flatMap((b) => (b.p === undefined ? [] : [b.p])));
				const parent = (this.cas.db.prepare("SELECT head FROM workspaces WHERE id = ?").get(row.id) as { head: number }).head;
				const id = Number(this.cas.db.prepare("INSERT INTO commits(workspace, parent, kind, at, note) VALUES (?, ?, 'checkpoint', ?, NULL)").run(row.id, parent, this.now()).lastInsertRowid);
				const entry = this.cas.db.prepare('INSERT INTO entries("commit", path, object, hash, size, kind) VALUES (?, ?, ?, ?, ?, ?)');
				const stat = this.cas.db.prepare("INSERT INTO ws_stat VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, hash = excluded.hash");
				for (const b of list) { entry.run(id, b.c.path, b.p?.id ?? null, b.c.hash, b.c.size, b.c.link ? "link" : "file"); stat.run(row.id, b.c.path, b.c.size, b.c.mtime, b.c.hash); }
				for (const path of gone) { entry.run(id, path, null, null, 0, "file"); this.cas.db.prepare("DELETE FROM ws_stat WHERE workspace = ? AND path = ?").run(row.id, path); }
				this.cas.db.prepare("UPDATE workspaces SET head = ? WHERE id = ?").run(id, row.id);
			});
		};
		for (const c of changed) {
			let p: Packed | undefined;
			if (!c.link && c.size <= TEXT_MAX) {
				const data = await this.fs.readFile(join(row.folder, c.path));
				if (sha(data) !== c.hash) { c.hash = sha(data); c.size = data.length; }
				if (held + data.length > BATCH_BYTES && batch.length > 0) { commit(batch, []); batch = []; held = 0; }
				p = pack(data);
				held += data.length;
			}
			batch.push({ c, ...(p === undefined ? {} : { p }) });
			if (batch.length >= OPEN_BATCH) { commit(batch, []); batch = []; held = 0; }
		}
		if (batch.length > 0 || deleted.length > 0) commit(batch, deleted);
	}

	/** After a tool call of a Workspace conversation: write and edit checkpoint their one path, bash starts a coalesced scan. */
	async after(conv: number, tool: string, path: unknown, cwd: string | undefined): Promise<void> {
		const row = this.byConv.get(conv);
		if (row === undefined || row.state !== "open") return;
		try {
			if (tool === "bash") {
				if (this.queued.has(row.id)) return;
				this.queued.add(row.id);
				void this.chained(row.project, async () => { this.queued.delete(row.id); await this.scanNow(row); }).catch((error: unknown) => this.o.notice(`checkpoint: ${msg(error)}`));
				return;
			}
			if (typeof path !== "string") return;
			const rel = posix(relative(canonicalize(row.folder), canonicalize(path, cwd)));
			if (rel.startsWith("..") || rel === "" || rel.split("/").some((part) => part === ".git" || LINK_NAMES.includes(part))) return;
			await this.chained(row.project, () => this.scanNow(row, [rel], true));
		} catch (error) { this.o.notice(`checkpoint: ${msg(error)}`); }
	}

	/* --- guard glue --------------------------------------------------------------------------------------------- */

	/** Whether the conversation runs in a Workspace. */
	has(conv: number): boolean { return this.byConv.has(conv); }

	/** GIT_CEILING_DIRECTORIES for a plain Workspace's shell: the Workspace folder's parent, so git never finds a repository above it. */
	ceilingFor(cwd: string): string | undefined {
		for (const row of this.byConv.values()) if (row.mode === "plain" && row.state === "open") { try { if (isInside(canonicalize(row.folder), canonicalize(cwd))) return dirname(row.folder); } catch { /* no ceiling */ } }
		return undefined;
	}

	/** The project folder for a path inside a Workspace folder (memory records go to the project, not the copy). */
	projectOf(path: string): string | undefined {
		for (const row of this.byConv.values()) { try { if (isInside(canonicalize(row.folder), canonicalize(path))) return join(row.project, relative(canonicalize(row.folder), canonicalize(path))); } catch { /* not inside */ } }
		return undefined;
	}

	/* --- plan ------------------------------------------------------------------------------------------------- */

	private async liveInfo(abs: string): Promise<{ kind: "absent" } | { kind: "dir" } | { kind: "link" } | { kind: "file"; hash: string; size: number; bytes?: Buffer }> {
		let info;
		try { info = await this.fs.lstat(abs); } catch (error) { if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return { kind: "absent" }; throw error; }
		if (info.isDirectory()) return { kind: "dir" };
		if (!info.isFile()) return { kind: "link" };
		if (info.size <= TEXT_MAX) { const bytes = await this.fs.readFile(abs); return { kind: "file", hash: sha(bytes), size: bytes.length, bytes }; }
		return { kind: "file", hash: await this.writer.hashFile(abs), size: info.size };
	}

	private big(n: number): Uint8Array { return new Uint8Array(TEXT_MAX + 1).fill(n); }

	/** Read the plan: the final scan, then a decision per path Vesperia changed. Nothing is written. */
	private async plan(row: WsRow): Promise<Plan> {
		const scan = await this.scanNow(row);
		const head = this.headOf(row.id);
		const base = this.baseOf(row.id);
		const caseless = row.live_caseless === 1;
		const rows: Row[] = [];
		const conflicts: PlanConflict[] = [];
		const left: Plan["left"] = [];
		const oversize: Plan["oversize"] = [];
		const paths = this.changedPaths(row.id);
		const label = `workspace ${row.id}`;
		const entryOf = (p: string): Ent | undefined => { const e = head.get(p); return e === undefined || e.hash === null ? undefined : e; };
		const baseEnt = (p: string): Ent | undefined => { const e = base.get(p); return e === undefined || e.hash === null ? undefined : e; };
		const items = new Map<string, { ours: Ent | undefined; base: Ent | undefined; abs: string }>();
		const sideOf = async (e: Ent | undefined, n: number, source: "ws" | "base", path: string): Promise<Side> => {
			if (e === undefined) return undefined;
			if (e.size > TEXT_MAX) return this.big(n);
			if (source === "base") return e.object === null ? this.big(n) : this.cas.get(e.object) ?? this.big(n);
			return await this.fs.readFile(join(row.folder, path)).catch(() => this.big(n));
		};
		const refuseReason = (p: string, e: Ent | undefined, b: Ent | undefined): string | undefined => {
			if (b?.kind === "skipped") return "skipped at open";
			if (e?.kind === "link") return "link";
			if (/[\\:*?"<>|-]/u.test(basename(p)) || /[. ]$/u.test(basename(p))) return "name not portable";
			if (WIDE_SECRET.some((x) => x.test(basename(p)))) return "secret name";
			if (p.split("/").some((part) => RESERVED.test(part))) return "reserved name";
			if (e !== undefined && SHELL_ACTIVE.some((x) => x.test(basename(p)))) return "shell-active name";
			if (!checkPath(join(row.project, p), row.project, this.o.guard(), true).allowed) return "protected";
			return undefined;
		};
		const todo: { path: string; ours: Ent | undefined; base: Ent | undefined }[] = [];
		for (const p of paths) {
			const ours = entryOf(p);
			const b = baseEnt(p);
			const why = refuseReason(p, ours, base.get(p));
			if (why !== undefined) { left.push({ path: p, reason: why }); continue; }
			todo.push({ path: p, ours, base: b });
		}
		// Case-only renames: a delete of A and an add of B equal under case folding, with A unchanged live.
		const renames = new Map<string, string>();
		if (caseless) {
			const adds = todo.filter((t) => t.ours !== undefined && t.base === undefined);
			for (const del of todo.filter((t) => t.ours === undefined && t.base !== undefined)) {
				const add = adds.find((a) => a.path.toLowerCase() === del.path.toLowerCase() && a.path !== del.path);
				if (add !== undefined) renames.set(add.path, del.path);
			}
		}
		const renamed = new Set(renames.values());
		const created = new Map<string, number>();
		const live = new Map<string, Awaited<ReturnType<Workspaces["liveInfo"]>>>();
		const mkdirs = new Set<string>();
		const dirFor = async (rel: string): Promise<string | undefined> => {
			// A parent that is a live file is a type conflict; a missing parent is made by a mkdir row.
			const parts = rel.split("/").slice(0, -1);
			let cur = "";
			for (const part of parts) {
				cur = cur === "" ? part : `${cur}/${part}`;
				const abs = await this.writer.name(row.project, cur, caseless);
				const info = await this.liveInfo(abs);
				if (info.kind === "absent") { mkdirs.add(cur); continue; }
				if (info.kind !== "dir") return cur;
			}
			return undefined;
		};
		const conflict = (path: string, kind: PlanConflict["kind"], ours: Ent | undefined, theirs?: { hash: string | null; bytes?: Buffer; size: number }): void => {
			conflicts.push({ path, kind, ours: null, oursSize: ours?.size ?? 0, theirsHash: theirs?.hash ?? null, theirs: theirs?.bytes ?? null, liveSize: theirs?.size ?? 0, wsPath: join(row.folder, ...path.split("/")) });
		};
		const makeRow = (path: string, from: string | null, op: Row["op"], pre: string | null, post: string | null, extra: Partial<Row> = {}): Row => ({ seq: 0, path, from, op, pre, post, mode: null, ...extra });
		const decideFor = async (path: string, ours: Ent | undefined, b: Ent | undefined, theirs: Awaited<ReturnType<Workspaces["liveInfo"]>>, abs: string): Promise<Row | "skip" | "oversize" | "conflict"> => {
			const theirHash = theirs.kind === "file" ? theirs.hash : null;
			const theirSize = theirs.kind === "file" ? theirs.size : 0;
			if (theirs.kind === "link") { left.push({ path, reason: "link" }); return "skip"; }
			if ((ours?.hash ?? null) === theirHash && theirs.kind !== "dir") return "skip";
			const oursMode = ours === undefined ? null : await this.fs.lstat(join(row.folder, path)).then((s) => s.mode & 0o777).catch(() => null);
			const takeOurs = (): Row | "oversize" => {
				if (theirs.kind === "file" && theirSize > SNAPSHOT_MAX) { oversize.push({ path, ws: join(row.folder, ...path.split("/")) }); return "oversize"; }
				if (ours === undefined) return makeRow(path, null, "delete", theirHash, null, { preSize: theirSize });
				if (theirs.kind === "absent") return makeRow(path, null, "create", null, ours.hash, { mode: oursMode, postSize: ours.size });
				return makeRow(path, null, "write", theirHash, ours.hash, { mode: oursMode, preSize: theirSize, postSize: ours.size });
			};
			if ((theirHash ?? null) === (b?.hash ?? null) && theirs.kind !== "dir") return takeOurs();
			if (theirs.kind === "dir" || (ours !== undefined && theirs.kind === "absent" && (await dirFor(path)) !== undefined)) { conflict(path, "type", ours, { hash: theirHash, size: theirSize }); return "conflict"; }
			// Both sides moved away from the base: the line merge, or a named conflict.
			const d = decide(path, await sideOf(b, 3, "base", path), await sideOf(ours, 1, "ws", path), theirs.kind === "file" ? (theirs.bytes ?? this.big(2)) : undefined, { labels: [label, `live ${row.id}`] });
			void abs;
			if (d.op === "skip") return "skip";
			if (d.op === "ours") return takeOurs();
			if (d.op === "merged") {
				const body = Buffer.from(d.text);
				if (theirs.kind === "file" && theirSize > SNAPSHOT_MAX) { oversize.push({ path, ws: join(row.folder, ...path.split("/")) }); return "oversize"; }
				return makeRow(path, null, theirs.kind === "absent" ? "create" : "write", theirHash, sha(body), { mode: oursMode, preSize: theirSize, postSize: body.length, body });
			}
			conflict(path, d.kind, ours, { hash: theirHash, bytes: theirs.kind === "file" ? theirs.bytes : undefined, size: theirSize });
			return "conflict";
		};
		const processed = new Set<string>();
		for (const t of todo) {
			if (renamed.has(t.path) || processed.has(t.path)) continue;
			const abs = await this.writer.name(row.project, t.path, caseless);
			const theirs = await this.liveInfo(abs);
			live.set(t.path, theirs);
			items.set(t.path, { ours: t.ours, base: t.base, abs });
			// A new path equal under case folding to a different live path is a case conflict.
			if (caseless && t.ours !== undefined && t.base === undefined && !renames.has(t.path) && theirs.kind !== "absent" && relative(row.project, abs).replaceAll("\\", "/") !== t.path) { conflict(t.path, "case", t.ours, { hash: theirs.kind === "file" ? theirs.hash : null, size: 0 }); continue; }
			const outcome = await decideFor(t.path, t.ours, t.base, theirs, abs);
			if (typeof outcome !== "string") { rows.push(outcome); if (outcome.op !== "delete") created.set(t.path, rows.length - 1); }
		}
		for (const [bPath, aPath] of renames) {
			const a = todo.find((t) => t.path === aPath)!;
			const b = todo.find((t) => t.path === bPath)!;
			const absA = await this.writer.name(row.project, aPath, caseless);
			const theirs = await this.liveInfo(absA);
			items.set(bPath, { ours: b.ours, base: b.base, abs: absA });
			if (theirs.kind === "file" && theirs.hash === a.base!.hash) {
				if (theirs.size > SNAPSHOT_MAX) { oversize.push({ path: aPath, ws: join(row.folder, ...bPath.split("/")) }); continue; }
				rows.push(makeRow(bPath, aPath, "rename", theirs.hash, b.ours!.hash, { mode: null, preSize: theirs.size, postSize: b.ours!.size }));
			} else if (theirs.kind === "absent") {
				// A is gone live: B is a new file there.
				const out = await decideFor(bPath, b.ours, undefined, await this.liveInfo(await this.writer.name(row.project, bPath, caseless)), absA);
				if (typeof out !== "string") rows.push(out);
			} else conflict(bPath, "case", b.ours, { hash: theirs.kind === "file" ? theirs.hash : null, size: 0 });
		}
		// Folder rows for every path the merge creates, parents before children; deletes and renames, then writes and creates.
		for (const r of rows) if (r.op === "write" || r.op === "create" || r.op === "rename") { const bad = await dirFor(r.path); if (bad !== undefined) { rows.splice(rows.indexOf(r), 1); conflict(r.path, "type", entryOf(r.path)); } }
		const ordered: Row[] = [...[...mkdirs].sort((a, b) => a.split("/").length - b.split("/").length).map((p) => makeRow(p, null, "mkdir", null, null)), ...rows.filter((r) => r.op === "delete" || r.op === "rename"), ...rows.filter((r) => r.op === "write" || r.op === "create")];
		ordered.forEach((r, i) => { r.seq = i + 1; });
		// Ours bytes for the conflicts, stored before anything else can change them.
		for (const c of conflicts) {
			const e = entryOf(c.path);
			if (e !== undefined) c.ours = await this.fs.readFile(join(row.folder, ...c.path.split("/"))).catch(() => null);
		}
		const plan: Plan = {
			rows: ordered, conflicts, left, oversize, deletes: ordered.filter((r) => r.op === "delete").length, ignored: scan.ignoredNew, ignoreFailed: scan.ignoreFailed, changed: paths.length,
			redecide: async (r, bytes) => {
				const item = items.get(r.path);
				if (item === undefined || r.op === "rename" || r.op === "mkdir") return "conflict";
				const theirs = bytes === null ? { kind: "absent" as const } : { kind: "file" as const, hash: sha(bytes), size: bytes.length, bytes };
				const before = conflicts.length;
				const out = await decideFor(r.path, item.ours, item.base, theirs, item.abs);
				if (conflicts.length > before) { conflicts.pop(); return "conflict"; }
				if (out === "oversize") return "oversize";
				if (typeof out === "string") return "drop";
				return { row: { ...out, seq: r.seq } };
			},
		};
		if (row.git_head !== null) {
			const now = await this.git.head(row.project);
			if ((now ?? "") !== row.git_head) plan.headMoved = { from: row.git_head, to: now ?? "" };
		}
		return plan;
	}

	/* --- merge ------------------------------------------------------------------------------------------------- */

	private async execMerge(row: WsRow, plan: Plan, run: string | null, rows: Row[]): Promise<{ text: string; state: WsState; record?: number; code?: string }> {
		const summaryHead = (): string => {
			const n = rows.filter((r) => r.op !== "mkdir").length;
			const out = [`Merged ${n} file${n === 1 ? "" : "s"} from the Workspace into ${row.project}`];
			for (const l of LIMITED(plan.left.map((x) => `not merged: ${x.reason}: ${x.path}`))) out.push(l);
			for (const o of plan.oversize) out.push(`not merged: over 64 MiB: ${o.path}`);
			if (plan.ignored.length > 0) out.push(`Vesperia also created ${plan.ignored.length} git-ignored paths (not merged): ${plan.ignored.slice(0, 10).join(", ")}`);
			return out.join("\n");
		};
		if (rows.filter((r) => r.op !== "mkdir").length === 0) {
			const oversized = plan.oversize.length > 0;
			this.cas.tx(() => { this.set(row.id, { state: oversized ? "discarded" : "merged", hold: null, hold_detail: oversized ? "nothing left to merge" : "no changes" }); });
			await this.removeFolder(row.folder).catch((error: unknown) => this.o.notice(`the Workspace folder could not be removed: ${msg(error)}`));
			return { text: oversized ? `nothing merged: ${plan.oversize.length} changes over 64 MiB were left out; the Workspace was removed` : `Vesperia changed no files in ${row.project}; nothing was merged`, state: oversized ? "discarded" : "merged" };
		}
		try {
			const r = await this.writer.merge({ ws: row.id, project: row.project, folder: row.folder, run, caseless: row.live_caseless === 1, rows, head: summaryHead(), redecide: plan.redecide });
			this.refresh(row.id);
			if (r.state === "done") { this.gc(); return { text: r.summary, state: "merged", record: r.id }; }
			if (r.state === "pending") { let held = ""; try { this.hold(row.id, "not-recovered", String(r.id)); } catch (error) { held = ` (its hold could not be written either: ${msg(error)})`; } return { text: `${r.summary}\nmerge record ${r.id} is still pending; restart piroboros to recover it${held}`, state: "held", record: r.id, code: "not-recovered" }; }
			return { text: r.summary, state: "held", record: r.id, code: "rollback" };
		} catch (error) {
			if (error instanceof HoldError) { this.hold(row.id, error.code, error.detail.replaceAll(", ", "\n")); return { text: `Merge held: ${holdText(error.code, error.detail)}`, state: "held", code: error.code }; }
			if (error instanceof ConflictFound) return this.storeConflicts(row, await this.plan(row), "the live file changed again");
			this.hold(row.id, "preflight", `${row.project}: ${msg(error)}`);
			return { text: `Merge held: ${msg(error)}`, state: "held", code: "preflight" };
		}
	}

	/** Write nothing live: keep Vesperia's version of each conflicted path in the store and mark the Workspace conflicted. */
	private storeConflicts(row: WsRow, plan: Plan, why?: string): { text: string; state: WsState; code: string } {
		if (plan.conflicts.length === 0) { this.hold(row.id, "preflight", `${row.project}: ${why ?? "a path changed during the merge"}`); return { text: `Merge held: ${why ?? "a path changed during the merge"}`, state: "held", code: "preflight" }; }
		const puts = plan.conflicts.map((c) => (c.ours === null ? undefined : pack(c.ours)));
		const theirs = plan.conflicts.map((c) => (c.theirs === null ? undefined : pack(c.theirs)));
		this.cas.tx(() => {
			this.cas.insert([...puts, ...theirs].filter((p): p is Packed => p !== undefined));
			this.cas.db.prepare("DELETE FROM conflicts WHERE workspace = ?").run(row.id);
			const stmt = this.cas.db.prepare("INSERT INTO conflicts VALUES (?, ?, ?, ?, ?)");
			plan.conflicts.forEach((c, i) => stmt.run(row.id, c.path, c.kind, puts[i]?.id ?? null, c.theirsHash));
			this.hold(row.id, "conflicts", String(plan.conflicts.length), "conflicted");
		});
		return { text: this.conflictText(plan.conflicts), state: "conflicted", code: "conflicts" };
	}

	private conflictText(conflicts: { path: string; kind: string }[]): string {
		return [`Merge refused: ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}; nothing was written to the live folder`, ...LIMITED(conflicts.map((c) => `  ${c.kind}: ${c.path}`)), "Resolve them in the live folder or the Workspace and run /conclave merge again, or /conclave discard."].join("\n");
	}

	/** GC after each merge, undo or discard, and the store-size notice. */
	gc(): void {
		try {
			this.cas.gc();
			const db = this.cas.db;
			const size = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count) * Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
			if (size > 1024 ** 3) this.o.notice(`the Workspace store is ${(size / 1024 ** 3).toFixed(1)} GiB after cleanup; /conclave discard held Workspaces you no longer need`);
		} catch (error) { this.o.notice(`workspace cleanup: ${msg(error)}`); }
	}

	/**
	 * The merge of the `run` phase, by the replay table: W is the Workspace with this run key, R its newest merge record for
	 * the key. Only an `open` Workspace with no record merges, and only on a `done` verdict. Nothing here asks the user.
	 */
	async settle(key: string, verdict: string, failure?: string, backend?: string): Promise<{ text: string; merge: ExecMerge }> {
		const w = this.byKey(key);
		if (w === undefined) return { text: "the Workspace record for this run is missing; nothing was merged", merge: { state: "held" } };
		return this.chained(w.project, async () => {
			const row = this.row(w.id)!;
			const r = this.record(row.id, key);
			const out = (text: string, extra: Partial<ExecMerge> = {}): { text: string; merge: ExecMerge } => { const now = this.row(row.id)!; return { text, merge: { state: now.state, ...(r === undefined ? {} : { record: r.id }), ...(now.hold === null ? {} : { code: now.hold }), ...extra } }; };
			if (r !== undefined && ["planned", "writing", "undoing"].includes(r.state)) {
				if (row.state === "open") { try { this.hold(row.id, "not-recovered", String(r.id)); } catch { return out(`merge record ${r.id} is still ${r.state}; restart piroboros to recover it (its hold could not be written either)`); } }
				return out(`merge record ${r.id} is still ${r.state}; restart piroboros to recover it`);
			}
			if (row.state === "open" && r === undefined) {
				if (verdict !== "done") { this.hold(row.id, "verdict", failure ?? (verdict === "unknown" ? "without a verdict" : verdict)); return out(holdText("verdict", failure ?? (verdict === "unknown" ? "without a verdict" : verdict))); }
				if (backend !== undefined) { this.hold(row.id, "backend", backend); return out(holdText("backend", backend)); }
				const result = await this.mergeNow(row, key);
				return { text: result.text, merge: { state: result.state, ...(result.record === undefined ? {} : { record: result.record }), ...(result.code === undefined ? {} : { code: result.code }) } };
			}
			if (row.state === "open") { this.hold(row.id, "not-recovered", String(r!.id)); return out(`Workspace ${row.id} is open with merge record ${r!.id} ${r!.state}; nothing was merged`); }
			if ((row.state === "held" || row.state === "conflicted") && r === undefined) return out(row.state === "conflicted" ? this.conflictText(this.cas.db.prepare("SELECT path, kind FROM conflicts WHERE workspace = ?").all(row.id) as { path: string; kind: string }[]) : holdText(row.hold, row.hold_detail));
			if (row.state === "held" && r !== undefined && (r.state === "rolled back" || r.state === "rollback failed")) return out(r.summary ?? holdText(row.hold, row.hold_detail));
			if (row.state === "merged" && r !== undefined && ["done", "undone", "undo failed"].includes(r.state)) { if (existsSync(row.folder)) await this.removeFolder(row.folder).catch(() => undefined); return out(r.summary ?? "merged"); }
			if ((row.state === "merged" || row.state === "discarded") && r === undefined) return out(row.state === "merged" ? (row.hold_detail === "no changes" ? "Vesperia changed no files; nothing was merged" : "the Workspace was merged by /conclave merge") : (row.hold_detail === "nothing left to merge" ? "ended after /conclave merge, which had nothing left to merge" : "the Workspace was discarded"));
			return out(`Workspace ${row.id} is ${row.state} with merge record ${r?.id ?? "none"} ${r?.state ?? ""}; nothing was merged`);
		});
	}

	/** Plan and merge an open or confirmed Workspace; holds and conflicts end as states. `confirmed` names the hold codes the user saw. */
	private async mergeNow(row: WsRow, run: string | null, confirmed: Set<string> = new Set(), force = false, seen?: string): Promise<{ text: string; state: WsState; record?: number; code?: string }> {
		const fail = (code: string, detail: string): { text: string; state: WsState; code: string } => { this.hold(row.id, code, detail); return { text: `Merge held: ${holdText(code, detail)}`, state: "held", code }; };
		try { if (!existsSync(row.folder)) return fail("folder-missing", ""); } catch { return fail("folder-missing", ""); }
		const info = await this.fs.lstat(row.project, { bigint: true } as never).catch(() => undefined) as unknown as { dev: bigint; ino: bigint } | undefined;
		if (info === undefined || String(info.dev) !== row.project_dev || String(info.ino) !== row.project_ino) return fail("target-moved", "");
		const plan = await this.plan(row);
		if (plan.ignoreFailed) return fail("ignore-rules", "");
		if (seen !== undefined && shown(plan) !== seen) return { text: "The live folder or the Workspace changed while you answered; nothing was merged. Run /conclave merge again.", state: row.state };
		if (plan.conflicts.length > 0 && !force) return this.storeConflicts(row, plan);
		if (plan.headMoved !== undefined && !confirmed.has("head-moved")) return fail("head-moved", `${plan.headMoved.from} ${plan.headMoved.to}`);
		if (plan.deletes >= BULK_DELETE && !confirmed.has("bulk-delete")) return fail("bulk-delete", String(plan.deletes));
		if (plan.oversize.length > 0 && !confirmed.has("oversize")) return fail("oversize", plan.oversize.map((o) => `${o.path} (her version: ${o.ws})`).join("\n"));
		let rows = plan.rows;
		if (force) {
			// Force: her version stored before the markers replaces the live path; her deletions delete. type and case rows are never forced.
			const extra: Row[] = [];
			for (const c of plan.conflicts) {
				if (c.kind === "type" || c.kind === "case") continue;
				if (c.liveSize > SNAPSHOT_MAX) { plan.left.push({ path: c.path, reason: "over 64 MiB" }); continue; }
				const live = await this.liveInfo(await this.writer.name(row.project, c.path, row.live_caseless === 1));
				const pre = live.kind === "file" ? live.hash : null;
				if (c.ours === null) { if (pre !== null) extra.push({ seq: 0, path: c.path, from: null, op: "delete", pre, post: null, mode: null, preSize: live.kind === "file" ? live.size : 0 }); continue; }
				extra.push({ seq: 0, path: c.path, from: null, op: pre === null ? "create" : "write", pre, post: sha(c.ours), mode: null, preSize: live.kind === "file" ? live.size : 0, postSize: c.ours.length, body: c.ours });
			}
			rows = [...rows.filter((r) => r.op === "mkdir"), ...rows.filter((r) => r.op === "delete" || r.op === "rename"), ...extra.filter((r) => r.op === "delete"), ...rows.filter((r) => r.op === "write" || r.op === "create"), ...extra.filter((r) => r.op !== "delete")];
			rows.forEach((r, i) => { r.seq = i + 1; });
		}
		const out = await this.execMerge(row, plan, run, rows);
		return out;
	}

	/* --- commands ---------------------------------------------------------------------------------------------- */

	private async taskState(row: WsRow): Promise<"running" | "parked" | "terminal" | "missing"> {
		return (await this.taskStatus?.(row.key.split(":")[0]!)) ?? "missing";
	}

	/** An `open` Workspace whose task is terminal or missing never reached its hold: set it `held` with code `ended`. */
	async endedRule(project?: string): Promise<void> {
		for (const row of this.rows("state = 'open'")) {
			if (project !== undefined && row.project !== project) continue;
			let state;
			try { state = await this.taskState(row); } catch (error) { this.o.notice(`the task of Workspace ${row.id} could not be read (${msg(error)}); it is left unchanged`); continue; }
			if (state === "terminal" || state === "missing") this.hold(row.id, "ended", state);
			else if (state === "parked") this.hold(row.id, "parked");
		}
	}

	/** Startup, after the harness opens: the ended rule for every Workspace, and a parked task of a `merged` or `discarded` one is returned for abortTask. */
	async startup(parkedTaskIds: string[]): Promise<{ abort: string[] }> {
		await this.endedRule();
		const abort: string[] = [];
		for (const id of parkedTaskIds) {
			const row = this.rows("key LIKE ?", `${id}:%`)[0];
			if (row !== undefined && (row.state === "merged" || row.state === "discarded")) abort.push(id);
		}
		const held = this.rows("state IN ('held', 'conflicted')");
		const old = held.filter((r) => this.now() - r.created > 7 * 86_400_000);
		if (held.length > 2 || old.length > 0) this.o.notice(`${held.length} held Workspaces${old.length > 0 ? `, ${old.length} older than 7 days` : ""}: /conclave merge or /conclave discard them`);
		await this.sweep();
		return { abort };
	}

	/** Remove folders of the own home hash that no open, held or conflicted Workspace names. */
	async sweep(): Promise<void> {
		const dir = join(this.wsRoot, this.hash);
		const keep = new Set(this.rows("state IN ('open', 'held', 'conflicted')").map((r) => String(r.id)));
		let names: string[];
		try { names = await this.fs.readdir(dir); } catch { return; }
		for (const name of names) if (!keep.has(name)) await this.removeFolder(join(dir, name)).catch((error: unknown) => this.o.notice(`could not remove ${join(dir, name)}: ${msg(error)}`));
	}

	/** Never rmSync recursive over a Workspace: links are removed as links, then the real folders. */
	async removeFolder(dir: string): Promise<void> {
		const walk = async (d: string): Promise<void> => {
			let list: import("node:fs").Dirent[];
			try { list = await this.fs.readdir(d, { withFileTypes: true } as never) as unknown as import("node:fs").Dirent[]; } catch { return; }
			for (const e of list) {
				const p = join(d, e.name);
				if (e.isSymbolicLink()) await this.fs.unlink(p).catch(() => this.fs.rmdir(p));
				else if (e.isDirectory()) await walk(p);
			}
		};
		await walk(dir);
		await this.fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
	}

	/**
	 * `/conclave merge` on a held or conflicted Workspace: plan again, one prompt for every pending reason, then the merge (or
	 * force). Returns the reply, and whether the Workspace ended (merged or discarded).
	 */
	async mergeCommand(id: number, ask: (question: string) => Promise<boolean>): Promise<{ text: string; ended: boolean }> {
		type Reply = { text: string; ended: boolean };
		const first = this.row(id);
		if (first === undefined) return { text: "nothing to merge", ended: false };
		// The prompt is asked outside the chain, so a checkpoint or another Workspace's operation never waits for the user's answer; the merge re-enters the chain and plans again.
		const step = await this.chained<Reply | { question: string; no: Reply; go: (row: WsRow) => Promise<Reply> }>(first.project, async () => {
			const row = this.row(id)!;
			if (row.state !== "held" && row.state !== "conflicted") return { text: "nothing to merge", ended: false };
			if (!existsSync(row.folder)) { this.hold(row.id, "folder-missing"); return { text: `Merge held: ${holdText("folder-missing", null)}`, ended: false }; }
			const plan = await this.plan(row);
			const reasons: string[] = [];
			const confirmed = new Set<string>();
			if (row.state === "held" && row.hold !== "conflicts") reasons.push(holdText(row.hold, row.hold_detail));
			if (plan.headMoved !== undefined) { reasons.push(holdText("head-moved", `${plan.headMoved.from} ${plan.headMoved.to}`)); confirmed.add("head-moved"); }
			if (plan.deletes >= BULK_DELETE) { reasons.push(holdText("bulk-delete", String(plan.deletes))); confirmed.add("bulk-delete"); }
			if (plan.oversize.length > 0) { reasons.push(holdText("oversize", plan.oversize.map((o) => `${o.path} (her version: ${o.ws})`).join("\n"))); confirmed.add("oversize"); }
			const over = plan.oversize.length > 0 || plan.conflicts.some((c) => c.liveSize > SNAPSHOT_MAX);
			const finish = (out: { text: string; state: WsState }): Reply => ({ text: out.text, ended: out.state === "merged" || out.state === "discarded" });
			if (plan.conflicts.length > 0) {
				const stored = this.storeConflicts(row, plan);
				if (plan.conflicts.some((c) => c.kind === "type" || c.kind === "case")) return { text: `${stored.text}\nForce is not offered while a type or case conflict is unresolved.`, ended: false };
				const lines = LIMITED(plan.conflicts.map((c) => `${c.kind} ${c.path}: ${c.liveSize > SNAPSHOT_MAX ? `not merged: over 64 MiB (her version: ${c.wsPath}); copy it yourself first: the Workspace is removed after the merge` : c.ours === null ? "her deletion deletes the live file" : "her version replaces the live file"}`));
				return { question: [...reasons, ...lines, `Replace your version of these ${plan.conflicts.length} paths with Vesperia's? (her version from before the markers; her deletions delete)`].join("\n"), no: { text: `${stored.text}\nmerge not run; nothing was changed`, ended: false }, go: async (r) => finish(await this.mergeNow(r, null, confirmed, true, shown(plan))) };
			}
			const question = over ? "Merge the other paths? The Workspace, with Vesperia's version of these files, is removed after the merge." : "Merge Vesperia's changes?";
			return { question: [...reasons, question].join("\n"), no: { text: "merge not run; the Workspace stays held", ended: false }, go: async (r) => finish(await this.mergeNow(r, null, confirmed, false, shown(plan))) };
		});
		if (!("question" in step)) return step;
		if (!(await ask(step.question))) return step.no;
		return this.chained(first.project, async () => {
			const row = this.row(id);
			if (row === undefined || (row.state !== "held" && row.state !== "conflicted")) return { text: "nothing to merge", ended: false };
			return step.go(row);
		});
	}

	/** `/conclave discard`: ask (outside the chain), remove the folder, mark discarded. */
	async discardCommand(id: number, ask: (question: string) => Promise<boolean>): Promise<{ text: string; ended: boolean }> {
		const first = this.row(id);
		if (first === undefined) return { text: "nothing to discard", ended: false };
		const question = await this.chained(first.project, async () => {
			const row = this.row(id)!;
			if (row.state !== "held" && row.state !== "conflicted") return undefined;
			const n = this.changedPaths(row.id).length;
			return `${holdText(row.hold, row.hold_detail)}\nDiscard Vesperia's Workspace, with ${n} changed file${n === 1 ? "" : "s"}? Nothing in the live folder changes.`;
		});
		if (question === undefined) return { text: "nothing to discard", ended: false };
		if (!(await ask(question))) return { text: "discard cancelled", ended: false };
		return this.chained(first.project, async () => {
			const row = this.row(id)!;
			if (row.state !== "held" && row.state !== "conflicted") return { text: "nothing to discard", ended: false };
			this.set(row.id, { state: "discarded", hold: null, hold_detail: null });
			await this.removeFolder(row.folder).catch((error: unknown) => this.o.notice(`the Workspace folder could not be removed: ${msg(error)}`));
			this.gc();
			return { text: `Workspace discarded; ${row.project} was not changed`, ended: true };
		});
	}

	/** `/conclave retry` on a parked task: a `parked` hold goes back to `open` first. */
	reopenParked(id: number): void { const row = this.row(id); if (row?.state === "held" && row.hold === "parked") this.set(id, { state: "open", hold: null, hold_detail: null }); }

	/** The abort handler: hold an `open` Workspace as cancelled, and say what the Workspace state is. */
	cancelled(key: string): { text: string; verdict: "failed" | "done"; merge: ExecMerge } | undefined {
		const row = this.byKey(key);
		if (row === undefined) return undefined;
		if (row.state === "open") this.hold(row.id, "cancelled");
		const w = this.row(row.id)!;
		const r = this.record(w.id, key);
		const merge: ExecMerge = { state: w.state, ...(r === undefined ? {} : { record: r.id }), ...(w.hold === null ? {} : { code: w.hold }) };
		if (row.state === "open") return { text: "", verdict: "failed", merge };
		if (w.state === "held" || w.state === "conflicted") return { text: `Vesperia's run was cancelled; its Workspace stays ${w.state}: ${w.state === "conflicted" ? holdText("conflicts", w.hold_detail) : holdText(w.hold, w.hold_detail)}`, verdict: "failed", merge };
		if (w.state === "merged" && r !== undefined && r.state === "done") return { text: `Vesperia's run was cancelled after its merge: ${r.summary}`, verdict: "done", merge };
		if (w.state === "merged") return { text: `ended after /conclave merge: ${this.cas.db.prepare("SELECT summary FROM merges WHERE workspace = ? ORDER BY id DESC LIMIT 1").get(w.id) === undefined ? "nothing was merged" : (this.cas.db.prepare("SELECT summary FROM merges WHERE workspace = ? ORDER BY id DESC LIMIT 1").get(w.id) as { summary: string }).summary}`, verdict: "failed", merge };
		return { text: w.hold_detail === "nothing left to merge" ? "ended after /conclave merge, which had nothing left to merge" : "ended after /conclave discard", verdict: "failed", merge };
	}

	/** `/conclave status`: the Workspace state, hold text, mode and its source, folder, checkpoints and confinement. */
	statusLines(project: string, from?: string, parked = false): string[] {
		const w = this.rows("project = ?", canonicalize(project))[0];
		if (w === undefined) return [];
		const commits = Number((this.cas.db.prepare("SELECT COUNT(*) AS n FROM commits WHERE workspace = ? AND kind = 'checkpoint'").get(w.id) as { n: number }).n);
		return [`Workspace ${w.id}: ${w.state}${w.hold === null ? "" : ` (${holdText(w.hold, w.hold_detail)})`}${parked ? " [task parked]" : ""}`, `  mode ${w.mode}${from === undefined ? "" : ` (${from})`}, folder ${w.folder}, ${commits} checkpoint${commits === 1 ? "" : "s"}`, "  shell confinement: none; commands are not confined"];
	}

	/* --- undo -------------------------------------------------------------------------------------------------- */

	/** The newest merge record of a project, for `/conclave undo`. */
	latestRecord(project: string): { id: number; state: string; ws: number; caseless: boolean } | undefined {
		const r = this.cas.db.prepare("SELECT m.id, m.state, m.workspace AS ws, w.live_caseless AS c FROM merges m JOIN workspaces w ON w.id = m.workspace WHERE m.project = ? ORDER BY m.id DESC LIMIT 1").get(canonicalize(project)) as { id: number; state: string; ws: number; c: number } | undefined;
		return r === undefined ? undefined : { id: r.id, state: r.state, ws: r.ws, caseless: r.c === 1 };
	}

	/** `/conclave undo` of the newest merge record of a project. Returns the reply and whether files were restored. */
	async undoCommand(projectIn: string, ask: (question: string) => Promise<boolean>): Promise<{ text: string; restored: boolean } | undefined> {
		const project = canonicalize(projectIn);
		const r = this.latestRecord(project);
		if (r === undefined) return undefined;
		return this.chained(project, async () => {
			const rec = this.latestRecord(project)!;
			if (rec.state === "undone") return { text: "already undone", restored: false };
			if (rec.state === "rolled back") return { text: "the last merge was rolled back; nothing to undo", restored: false };
			if (["planned", "writing", "undoing"].includes(rec.state)) return { text: "a merge or undo was interrupted; restart piroboros to recover it", restored: false };
			const verdicts = await this.writer.preview(rec.id, project, rec.caseless);
			const pick = (v: string): string[] => verdicts.filter((x) => x.verdict === v).map((x) => `  ${x.row.path}${x.reason === undefined ? "" : ` (${x.reason})`}`);
			const list = (title: string, lines: string[]): string[] => (lines.length === 0 ? [] : [`${title} (${lines.length}):`, ...lines]);
			const preview = ["Undo of the last Vesperia merge.", ...list("Files to restore", pick("restore")), ...list("Files and folders to remove (created by the merge)", pick("remove")), ...list("Skipped, changed since the merge", pick("changed")), ...list("Skipped, protected", pick("protected")), ...list("Already as before the merge", pick("unchanged")), "Changes made through bash are covered: the merge applied them."].join("\n");
			if (!(await ask(`${preview}\nRestore these files?`))) return { text: "undo cancelled; nothing was changed", restored: false };
			const out = await this.writer.finishUndo(rec.id, project, rec.caseless);
			this.gc();
			return { text: out.text, restored: out.state === "undone" || verdicts.some((v) => v.verdict === "restore" || v.verdict === "remove") };
		});
	}

	/** Startup: roll back or finish every merge record the last run left behind, before the scheduler starts. */
	recover(): Promise<string[]> { return this.writer.recover(); }
}

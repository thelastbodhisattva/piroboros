import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { checkPath, checkRead, denyRoots, WIDE_SECRET, type GuardConfig } from "../guard.ts";
import { canonicalize, isInside, samePath } from "../paths.ts";
import { ConflictFound, HoldError, realFs, Writer, type Fs, type Row } from "./apply.ts";
import { needsRepick, confineFor, nativeDeps, type Confine, type ConfineDeps, type Found } from "./confine.ts";
import { dockerKill, dockerRemove, dockerSweep, type DockerConf } from "./docker.ts";
import { wslRemove, wslSweep, type Remote, type WslPlan } from "./wsl.ts";
import { BATCH_BYTES, Cas, OPEN_BATCH, pack, SNAPSHOT_MAX, type Packed } from "./cas.ts";
import { HostGit, WsRefusal, type GitSpy, type GitState } from "./git.ts";
import { lwwMatch, lwwRules, type LwwRule } from "./lww.ts";
import { decide, hasBlock, TEXT_MAX, type ConflictKind, type Side } from "./merge.ts";

// Workspaces for Vesperia: one private copy of the git-visible files of a project per run, checkpointed into the CAS, merged
// back three-way when her run ends `done`. The merge writes through ./apply.ts. Unconfined in P27d1: the Workspace keeps her
// away from the live folder by convention and the start notice says so. P27e1 adds bubblewrap on Linux (./confine.ts).

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
/** Whether the Workspace is used from a WSL distro (bubblewrap there, or Docker through the runner): its place folders and line endings are prepared on Windows. */
const onWsl = (c: Confine): boolean => c.wsl !== undefined || c.docker?.remote !== undefined;

export interface WsOptions {
	/** PIROBOROS_HOME: the store is ${home}/ws/store.sqlite. */
	home: string;
	guard(): GuardConfig;
	settings(): { enabled: boolean; nested: "ask" | "copy" | "inplace"; confine?: "auto" | "none" | "docker"; network?: boolean; wslDistro?: string; dockerImage?: string };
	/** Replaces parts of what confinement reads from the machine (probes). */
	confineDeps?: Partial<ConfineDeps>;
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

interface PlanConflict { path: string; kind: ConflictKind | "case"; ours: Buffer | null; oursSize: number; theirsHash: string | null; theirs: Buffer | null; liveSize: number; wsPath: string; text?: string; lines?: number[] }
interface Plan {
	rows: Row[];
	conflicts: PlanConflict[];
	left: { path: string; reason: string }[];
	oversize: { path: string; ws: string }[];
	headMoved?: { from: string; to: string };
	deletes: number;
	ignored: string[];
	ignoreFailed: boolean;
	/** Workspace folders the scan could not list: the merge holds until they can be. */
	unreadable: string[];
	/** `.lww` decisions: the rule and the side kept. */
	lww: { path: string; rule: string; kept: "ours" | "theirs" }[];
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
		case "unreadable": return `folders in the Workspace could not be read (${d.split("\n").join(", ")}), so what they hold cannot be merged or told deleted; fix their permissions, then /conclave merge`;
		case "target-moved": return "the project folder is not the one the Workspace was opened for";
		case "folder-missing": return "the Workspace folder is missing";
		case "not-recovered": return `merge record ${d} was not recovered`;
		case "parked": return "task parked by the restart limit";
		case "ended": return `the run ended without closing its Workspace (${d})`;
		default: return code === null ? "no hold" : `${code} ${d}`.trim();
	}
}

const LIMITED = (items: string[], max = 20): string[] => (items.length > max ? [...items.slice(0, max), `and ${items.length - max} more`] : items);

/**
 * Host access below a Workspace folder after Vesperia has had it: she can replace any folder in it with a link. Every component
 * from the folder down to the parent of the leaf is lstat-ed and must be a real folder (`make` creates a missing one), and a
 * leaf that exists must be a regular file. A write goes to a new name in the same folder and is renamed over the leaf, which
 * replaces a link and never follows it; a delete unlinks the leaf only. A link or a non-folder refuses with a WsRefusal.
 */
async function wsDir(fs: Fs, folder: string, parts: string[], make: boolean): Promise<string> {
	let cur = folder;
	for (const part of parts) {
		cur = join(cur, part);
		let info = await fs.lstat(cur).catch((error: unknown) => { if (make && code(error) === "ENOENT") return undefined; throw error; });
		if (info === undefined) { await fs.mkdir(cur); info = await fs.lstat(cur); }
		if (!info.isDirectory()) throw new WsRefusal(`${cur} in the Workspace is a link or not a folder`);
	}
	return cur;
}

/**
 * `refused(rel)`: whether the guard refuses reading `rel` under `project` (nested guard.deny, a credential folder inside a guard.allow folder). A checkRead costs about
 * 0.8 ms, which was 20 s over 24,000 files, and below a folder the verdict does not depend on the file name (secret names are filtered before this), so it is asked once
 * per folder. Under a deny root that lies inside the project, and when a root cannot be evaluated, each path is asked itself.
 */
function readRefuser(project: string, cfg: GuardConfig): (rel: string) => boolean {
	const inner: string[] = [];
	let each = false;
	for (const root of denyRoots(cfg)) { try { const c = canonicalize(root); if (isInside(project, c)) inner.push(c); } catch { each = true; } }
	const folders = new Map<string, boolean>();
	return (rel) => {
		const abs = join(project, ...rel.split("/"));
		if (each || inner.some((r) => isInside(r, abs))) return !checkRead(abs, undefined, cfg).allowed;
		const dir = dirname(abs);
		let allowed = folders.get(dir);
		if (allowed === undefined) { allowed = checkRead(join(dir, ".piroboros-folder"), undefined, cfg).allowed; folders.set(dir, allowed); }
		return !allowed;
	};
}

let putSeq = 0;
async function wsPut(fs: Fs, folder: string, rel: string, src: { bytes: Buffer | string } | { file: string }): Promise<void> {
	const parts = rel.split("/");
	const dir = await wsDir(fs, folder, parts.slice(0, -1), false);
	const leaf = join(dir, parts.at(-1)!);
	const old = await fs.lstat(leaf).catch(() => undefined);
	if (old !== undefined && !old.isFile()) throw new WsRefusal(`${leaf} in the Workspace is a link or not a regular file`);
	const tmp = join(dir, `.${parts.at(-1)}.piroboros-new-${process.pid}-${++putSeq}`);
	try {
		if ("file" in src) await fs.copyFile(src.file, tmp, constants.COPYFILE_EXCL);
		else { const fh = await fs.open(tmp, "wx", (old?.mode ?? 0o644) & 0o777); try { await fh.writeFile(src.bytes); } finally { await fh.close(); } }
		await fs.rename(tmp, leaf);
	} catch (error) { await fs.unlink(tmp).catch(() => undefined); throw error; }
}

/** Whether a file was removed (false: it or a parent was not there). */
async function wsUnlink(fs: Fs, folder: string, rel: string): Promise<boolean> {
	const parts = rel.split("/");
	try { await fs.unlink(join(await wsDir(fs, folder, parts.slice(0, -1), false), parts.at(-1)!)); return true; } catch (error) { if (code(error) === "ENOENT") return false; throw error; }
}

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
	/** Workspaces whose confinement backend was found unavailable in this run, with the reason: no command spawns, and the run ends held with code `backend`. */
	private readonly down = new Map<number, string>();
	private readonly upgrades = new Map<number, Promise<void>>();
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

	/** A hold removes the Workspace's container (best effort; the startup sweep finishes it). A parked task keeps it: `reopenParked` does not reopen through `open`. */
	private hold(id: number, code: string, detail: string | null = null, state: WsState = "held"): void {
		this.set(id, { state, hold: code, hold_detail: detail });
		const c = code === "parked" ? undefined : (JSON.parse(this.row(id)?.confine ?? "{}") as Confine).docker;
		if (c !== undefined) void dockerRemove(this.confineDeps(), c).catch(() => undefined);
	}

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
				const earlier = JSON.parse(same.confine) as Confine;
				await this.quiet(same);
				const prior = earlier.wsl ?? earlier.docker;
				const places = prior?.places ?? ["node_modules"];
				const picked = await this.pick(same.folder, { places, project, files: 0, prev: earlier.wsl, prevDocker: earlier.docker });
				if (onWsl(picked.confine)) for (const place of places) await wsDir(this.fs, same.folder, place.split("/"), true);
				// A Workspace of 0.3.2 or earlier borrowed the live repository's objects through this file. It goes (the leaf only, through no link), and no object folder is bound or mounted any more.
				const history = same.mode === "git" ? await wsUnlink(this.fs, same.folder, ".git/objects/info/alternates").catch((error: unknown) => { this.o.notice(`the Workspace's git alternates file could not be removed (${msg(error)})`); return false; }) : false;
				this.down.delete(same.id);
				const refreshed = await this.refreshLive(same).catch((error: unknown) => { this.o.notice(`the earlier Workspace could not be refreshed from ${project} (${msg(error)})`); return 0; });
				this.cas.tx(() => { this.cas.db.prepare("UPDATE workspaces SET key = ?, conv = NULL, state = 'open', hold = NULL, hold_detail = NULL, confine = ? WHERE id = ?").run(key, JSON.stringify(picked.confine), same.id); });
				if (same.conv !== null) this.byConv.delete(same.conv);
				return { folder: same.folder, notice: [`Vesperia continues in her earlier Workspace of ${project} (${this.changedPaths(same.id).length} changed files${refreshed > 0 ? `; ${refreshed} you changed in your folder were refreshed` : ""})`, `Shell confinement: ${picked.label}.`, ...picked.notice, ...(history ? ["Git history is no longer available in this Workspace; its files are unchanged."] : [])] };
			}
			return this.copyIn(key, mode, project, plan);
		});
	}

	/**
	 * Reopen: every base path Vesperia never changed that the user changed live is copied into the Workspace (or removed when
	 * the user deleted it) and a `refresh` commit makes the live bytes its new base. Changed and conflicted paths keep their base.
	 */
	private async refreshLive(row: WsRow): Promise<number> {
		await this.scanNow(row);
		const head = this.headOf(row.id);
		const changed: { path: string; hash: string; size: number; mtime: number; link: boolean }[] = [];
		const deleted: string[] = [];
		const wsPath = (p: string): string => join(row.folder, ...p.split("/"));
		const denied = readRefuser(row.project, this.o.guard());
		const todo = [...this.baseOf(row.id)].filter(([p, b]) => b.kind === "file" && b.hash !== null && head.get(p)?.hash === b.hash && !p.split("/").some((part) => LINK_NAMES.includes(part)));
		const refused: string[] = [];
		await this.pool(todo, 16, async ([p, b]) => {
			// Every write below goes through the link-safe helpers: Vesperia may have replaced a folder of the Workspace with a link. A path refused there is skipped.
			try {
				const live = await this.liveInfo(await this.writer.name(row.project, p, row.live_caseless === 1));
				if (live.kind === "absent") { await wsUnlink(this.fs, row.folder, p).catch((error: unknown) => { if (error instanceof WsRefusal) throw error; }); deleted.push(p); return; }
				if (live.kind !== "file" || live.hash === b.hash) return;
				if (denied(p)) return;
				await wsPut(this.fs, row.folder, p, live.bytes !== undefined ? { bytes: live.bytes } : { file: join(row.project, ...p.split("/")) });
				changed.push({ path: p, hash: live.hash, size: live.size, mtime: Math.floor((await this.fs.lstat(wsPath(p))).mtimeMs), link: false });
			} catch (error) { if (!(error instanceof WsRefusal)) throw error; refused.push(msg(error)); }
		});
		if (refused.length > 0) this.o.notice(`the refresh skipped ${refused.length} path${refused.length === 1 ? "" : "s"} of the Workspace: ${LIMITED(refused, 3).join("; ")}`);
		await this.checkpoint(row, changed, deleted, [], "refresh");
		return changed.length + deleted.length;
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
		const denied = readRefuser(project, cfg);
		await this.pool(listed, 16, async (path) => {
			if (WIDE_SECRET.some((p) => p.test(basename(path)))) { secrets.push(path); return; }
			// A path with a node_modules component starts empty (the scan never looks there, so a copied file would read as deleted); a path guard.deny holds stays out.
			if (path.split("/").some((part) => LINK_NAMES.includes(part))) { skipped.push(`${path} (inside a folder that starts empty)`); return; }
			if (denied(path)) { skipped.push(`${path} (protected)`); return; }
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
		let chosen: Confine | undefined;
		try {
			const total = items.length;
			const bytes = items.reduce((n, i) => n + i.size, 0);
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
			const objectIds = [...ents.values()].flatMap((e) => (e.object === null ? [] : [e.object]));
			const places = [...new Set([...links, "node_modules"])];
			const picked = await this.pick(folder, { places, project, files: items.length });
			chosen = picked.confine;
			if (onWsl(chosen)) for (const place of places) await ensure(join(folder, place));
			// A git Workspace is its own repository: one commit of the files just copied. Nothing of the live .git comes along (no object, ref, index or reflog), so a credential committed once and deleted since is not in it.
			if (mode === "git" && state.kind === "tree") {
				await this.git.init(folder, await this.git.branch(project));
				await this.fs.writeFile(join(folder, ".git", "config"), await this.git.copyConfig(state.gitDir));
				await this.liveLineEndings(project, folder);
				const copied = new Map(items.map((i) => [i.path, i]));
				await this.git.baseCommit(folder, [...ents.values()].filter((e) => e.kind !== "skipped").map((e) => { const i = copied.get(e.path)!; return { path: e.path, mode: e.kind === "link" ? "120000" as const : i.mode & 0o111 ? "100755" as const : "100644" as const, size: stats.get(e.path)!.size, ...(i.link === undefined ? {} : { link: i.link }) }; }));
			}
			let baseId = 0;
			this.cas.tx(() => {
				if (this.cas.missing(objectIds).length > 0) throw new WsRefusal("the store dropped objects of this copy while it was made; approve again");
				const confine = JSON.stringify(picked.confine);
				this.cas.db.prepare("INSERT INTO workspaces(id, key, project, project_dev, project_ino, mode, git_head, refs, plan, folder, ws_caseless, live_caseless, confine, state, conv, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)")
					.run(id, key, project, String(dev.dev), String(dev.ino), mode, head, null, plan, folder, wsCaseless ? 1 : 0, liveCaseless ? 1 : 0, confine, this.now());
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
				`Vesperia works in a Workspace copy of ${project} (${ents.size} files${links.length > 0 ? `, ${links.join(", ")} starts empty` : ""}${secrets.length > 0 ? `; left out: ${list(secrets)}` : ""}${skipped.length > 0 || missing.length > 0 ? `${secrets.length > 0 ? "," : "; left out:"} ${list([...skipped, ...missing.map((m) => `${m} (missing on disk)`)])}` : ""}; ${mode === "git" ? "with git" : state.kind === "tree" ? "without git: this folder is nested" : "without git"}). Shell confinement: ${picked.label}.`,
				...picked.notice,
			];
			return { folder, notice: out };
		} catch (error) {
			await this.removeFolder(folder, chosen).catch(() => undefined);
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

	/** The Workspace's repository does not read the host's system and global config (Linux git in a sandbox never does): copy the live repository's effective core.autocrlf and core.eol into its own config, before the base commit. */
	private async liveLineEndings(project: string, folder: string): Promise<void> {
		const lines: string[] = [];
		for (const name of ["autocrlf", "eol"]) { const r = await this.git.run(project, ["config", "--get", `core.${name}`]); if (r.code === 0 && r.out.toString("utf8").trim() !== "") lines.push(`\t${name} = ${JSON.stringify(r.out.toString("utf8").trim())}`); }
		if (lines.length > 0) await this.fs.writeFile(join(folder, ".git", "config"), `${await this.fs.readFile(join(folder, ".git", "config"), "utf8")}[core]\n${lines.join("\n")}\n`);
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
	private changedPaths(ws: number, head = this.headOf(ws), base = this.baseOf(ws)): string[] {
		return [...new Set([...head.keys(), ...base.keys()])].filter((p) => (head.get(p)?.hash ?? null) !== (base.get(p)?.hash ?? null) || (head.get(p)?.kind ?? null) !== (base.get(p)?.kind ?? null)).sort();
	}

	/** The files of the Workspace by their paths, and the folders below the root that could not be listed (a folder that vanished during the walk is not one of them). */
	private async walkWs(folder: string): Promise<{ out: Map<string, "file" | "other">; unreadable: string[] }> {
		const out = new Map<string, "file" | "other">();
		const unreadable: string[] = [];
		const walk = async (dir: string, rel: string): Promise<void> => {
			let list: import("node:fs").Dirent[];
			try { list = await this.fs.readdir(dir, { withFileTypes: true } as never) as unknown as import("node:fs").Dirent[]; } catch (error) {
				if (rel === "") throw error;
				if (code(error) !== "ENOENT" && code(error) !== "ENOTDIR") unreadable.push(rel);
				return;
			}
			for (const e of list) {
				const path = rel === "" ? e.name : `${rel}/${e.name}`;
				if (e.name === ".git" || (e.name !== undefined && LINK_NAMES.includes(e.name) && (e.isDirectory() || e.isSymbolicLink()))) continue;
				if (e.isDirectory()) await walk(join(dir, e.name), path); else out.set(path, e.isFile() ? "file" : "other");
			}
		};
		await walk(folder, "");
		return { out, unreadable };
	}

	/** Compare the Workspace with its stat rows and checkpoint what changed. Returns the new git-ignored paths, whether the ignore check failed, and the folders that could not be read (what they hold is neither changed nor deleted here). */
	private async scanNow(row: WsRow, only?: string[], force = false): Promise<{ ignoredNew: string[]; ignoreFailed: boolean; unreadable: string[] }> {
		const stat = new Map((this.cas.db.prepare("SELECT path, size, mtime, hash FROM ws_stat WHERE workspace = ?").all(row.id) as unknown as { path: string; size: number; mtime: number; hash: string }[]).map((s) => [s.path, s]));
		const walked = only === undefined ? await this.walkWs(row.folder) : undefined;
		const onDisk = walked?.out ?? new Map(only!.map((p) => [p, "file" as const]));
		const unreadable = walked?.unreadable ?? [];
		const candidates = only ?? [...new Set([...onDisk.keys(), ...stat.keys()])];
		const changed: { path: string; hash: string; size: number; mtime: number; link: boolean }[] = [];
		const deleted: string[] = [];
		const touch: { path: string; size: number; mtime: number; hash: string }[] = [];
		const fresh: typeof changed = [];
		await this.pool(candidates, 16, async (path) => {
			// A full scan decides presence by the exact names the walk listed: lstat would find `Readme.md` under `README.md` on a case-insensitive folder.
			if (only === undefined && !onDisk.has(path)) { if (stat.has(path) && !unreadable.some((dir) => path.startsWith(`${dir}/`))) deleted.push(path); return; }
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
			const hash = link ? sha(await this.fs.readlink(join(row.folder, path)).catch(() => "")) : await this.writer.hashFile(join(row.folder, path), info.size);
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
		await this.checkpoint(row, [...changed, ...adds], deleted, touch);
		return { ignoredNew, ignoreFailed, unreadable };
	}

	/** Insert the changed paths as `checkpoint` commits, in batches by the CAS rule, each batch with its objects in one transaction. */
	private async checkpoint(row: WsRow, changed: { path: string; hash: string; size: number; mtime: number; link: boolean }[], deleted: string[], touch: { path: string; size: number; mtime: number; hash: string }[], kind: "checkpoint" | "refresh" = "checkpoint"): Promise<void> {
		if (touch.length > 0) this.cas.tx(() => { const st = this.cas.db.prepare("UPDATE ws_stat SET size = ?, mtime = ? WHERE workspace = ? AND path = ?"); for (const t of touch) st.run(t.size, t.mtime, row.id, t.path); });
		let batch: { c: (typeof changed)[number]; p?: Packed }[] = [];
		let held = 0;
		const commit = (list: typeof batch, gone: string[]): void => {
			this.cas.tx(() => {
				this.cas.insert(list.flatMap((b) => (b.p === undefined ? [] : [b.p])));
				const parent = (this.cas.db.prepare("SELECT head FROM workspaces WHERE id = ?").get(row.id) as { head: number }).head;
				const id = Number(this.cas.db.prepare("INSERT INTO commits(workspace, parent, kind, at, note) VALUES (?, ?, ?, ?, NULL)").run(row.id, parent, kind, this.now()).lastInsertRowid);
				const entry = this.cas.db.prepare('INSERT INTO entries("commit", path, object, hash, size, kind) VALUES (?, ?, ?, ?, ?, ?)');
				const stat = this.cas.db.prepare("INSERT INTO ws_stat VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, hash = excluded.hash");
				for (const b of list) { entry.run(id, b.c.path, b.p?.id ?? null, b.c.hash, b.c.size, b.c.link ? "link" : "file"); stat.run(row.id, b.c.path, b.c.size, b.c.mtime, b.c.hash); }
				const unstat = this.cas.db.prepare("DELETE FROM ws_stat WHERE workspace = ? AND path = ?");
				for (const path of gone) { entry.run(id, path, null, null, 0, "file"); unstat.run(row.id, path); }
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

	private confineDeps(): ConfineDeps { return { ...nativeDeps(this.o.guard(), this.wsRoot), ...this.o.confineDeps }; }

	/** The confinement backend for a Workspace folder, chosen at each open and reopen (4.3.1). */
	private pick(folder: string, plan: WslPlan): ReturnType<typeof confineFor> {
		const s = this.o.settings();
		return confineFor({ confine: s.confine ?? "auto", network: s.network ?? true, distro: s.wslDistro, docker: s.dockerImage }, this.confineDeps(), folder, plan);
	}

	/**
	 * Before a host pass over a Workspace: end every process in its container. bubblewrap (native and in WSL) already ends every
	 * process with its command (--die-with-parent --unshare-all: the sandbox's PID namespace goes with it), but a `docker exec`
	 * process can outlive its command in the long-lived container and race the host's reads and writes.
	 */
	private async quiet(row: WsRow): Promise<void> {
		try { const c = (JSON.parse(row.confine) as Confine).docker; if (c !== undefined) await dockerKill(this.confineDeps(), c); } catch { /* no container, or an engine that does not answer: the pass goes on */ }
	}

	/**
	 * A Workspace of 0.3.1 or 0.3.2 (a sandbox that bound the live git objects) or of 0.3.3 before the system-folders view (a WSL argv that binds the whole root), resumed without a reopen (a retry or a restart), still stores an old sandbox. Before its first command: the backend is picked again
	 * (the code reopen uses; a Docker container is replaced by a fresh one), which drops the stored `alt` and the object binds, and the alternates file is removed once with a notice. A replacement that fails marks the Workspace
	 * down, so the run ends held with code `backend`.
	 */
	private upgradeOld(id: number): Promise<void> {
		let done = this.upgrades.get(id);
		if (done === undefined) {
			done = (async () => {
				const row = this.row(id);
				if (row === undefined) return;
				await this.chained(row.project, async () => {
					const old = JSON.parse(row.confine) as Confine;
					try {
						// The stored WSL argv and the Docker mounts hold the object binds, so the backend is picked again as a reopen does (a Docker container is removed and a fresh one made first).
						const places = (old.wsl ?? old.docker)!.places;
						const picked = await this.pick(row.folder, { places, project: row.project, files: 0, prev: old.wsl, prevDocker: old.docker });
						if (picked.confine.name !== old.name) throw new Error(picked.confine.why ?? `${old.name} could not be started again`);
						if (onWsl(picked.confine)) for (const place of places) await wsDir(this.fs, row.folder, place.split("/"), true);
						this.o.notice(`Shell confinement of this Workspace: ${picked.label}.`);
						const history = row.mode === "git" ? await wsUnlink(this.fs, row.folder, ".git/objects/info/alternates").catch((error: unknown) => { this.o.notice(`the Workspace's git alternates file could not be removed (${msg(error)})`); return false; }) : false;
						this.cas.db.prepare("UPDATE workspaces SET confine = ? WHERE id = ?").run(JSON.stringify(picked.confine), id);
						this.refresh(id);
						if (history) this.o.notice("Git history is no longer available in this Workspace; its files are unchanged.");
					} catch (error) { this.down.set(id, `this Workspace's stored sandbox is out of date and could not be replaced (${msg(error)}); approve the run again to reopen it`); }
				});
			})();
			this.upgrades.set(id, done);
		}
		return done;
	}

	/** The open Workspace a shell cwd lies in, when its row names a backend: what ConfinedShellEnv wraps the command with. */
	shellFor(cwd: string): Found | undefined {
		for (const row of this.byConv.values()) {
			if (row.state !== "open") continue;
			try {
				const confine = JSON.parse(row.confine) as Confine;
				if (confine.name !== "none" && isInside(canonicalize(row.folder), canonicalize(cwd))) return { ws: row.folder, project: row.project, confine, deps: this.confineDeps(), down: this.down.get(row.id), mark: (reason) => { this.down.set(row.id, reason); }, ...(needsRepick(confine) && !this.down.has(row.id) ? { upgrade: () => this.upgradeOld(row.id) } : {}) };
			} catch { /* not this row */ }
		}
		return undefined;
	}

	/** Whether the project's open Workspace runs its shell confined, and in a container (the brief says so). */
	confinedFor(project: string, name?: Confine["name"]): boolean {
		try { const got = (JSON.parse(this.rows("project = ? AND state = 'open'", canonicalize(project))[0]?.confine ?? "{}") as Partial<Confine>).name; return name === undefined ? got === "bubblewrap" || got === "docker" : got === name; } catch { return false; }
	}

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

	private async liveInfo(abs: string): Promise<{ kind: "absent" } | { kind: "dir" } | { kind: "link" } | { kind: "file"; hash: string; size: number; mtime: number; bytes?: Buffer }> {
		let info;
		try { info = await this.fs.lstat(abs); } catch (error) { if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return { kind: "absent" }; throw error; }
		if (info.isDirectory()) return { kind: "dir" };
		if (!info.isFile()) return { kind: "link" };
		const mtime = Math.floor(info.mtimeMs);
		if (info.size <= TEXT_MAX) { const bytes = await this.fs.readFile(abs); return { kind: "file", hash: sha(bytes), size: bytes.length, mtime, bytes }; }
		return { kind: "file", hash: await this.writer.hashFile(abs, info.size), size: info.size, mtime };
	}

	private big(n: number): Uint8Array { return new Uint8Array(TEXT_MAX + 1).fill(n); }

	/** The rules of the project folder's root `.lww` and its `%include` files (regular files inside the project, at most 64 KiB each). */
	// ponytail: read with node:fs, not the injected fs; the file is small and only matched against paths.
	private lwwFor(project: string): LwwRule[] {
		const read = (file: string): string | undefined => {
			try {
				const p = resolve(project, file);
				if (!isInside(project, p) || !lstatSync(p).isFile()) return undefined;
				const b = readFileSync(p);
				return b.length <= 65_536 ? b.toString("utf8") : undefined;
			} catch { return undefined; }
		};
		const text = read(".lww");
		return text === undefined ? [] : lwwRules(text, read);
	}

	/** Read the plan: the final scan, then a decision per path Vesperia changed. Housekeeping aside (resolved conflict rows are dropped), nothing is written. */
	private async plan(row: WsRow): Promise<Plan> {
		this.writer.forgetNames();
		const scan = await this.scanNow(row);
		const head = this.headOf(row.id);
		const base = this.baseOf(row.id);
		const caseless = row.live_caseless === 1;
		const rows: Row[] = [];
		const conflicts: PlanConflict[] = [];
		const left: Plan["left"] = [];
		const oversize: Plan["oversize"] = [];
		const paths = this.changedPaths(row.id, head, base);
		const label = `workspace ${row.id}`;
		const rules = this.lwwFor(row.project);
		const lww: Plan["lww"] = [];
		const rebased = new Set<string>();
		const old = new Map((this.cas.db.prepare("SELECT path, kind, ours, theirs FROM conflicts WHERE workspace = ?").all(row.id) as unknown as { path: string; kind: string; ours: string | null; theirs: string | null }[]).map((c) => [c.path, c]));
		const entryOf = (p: string): Ent | undefined => { const e = head.get(p); return e === undefined || e.hash === null ? undefined : e; };
		const baseEnt = (p: string): Ent | undefined => { const e = base.get(p); return e === undefined || e.hash === null ? undefined : e; };
		const wsAbs = (p: string): string => join(row.folder, ...p.split("/"));
		const items = new Map<string, { ours: Ent | undefined; base: Ent | undefined; over?: Buffer }>();
		const sideOf = async (e: Ent | undefined, n: number, source: "ws" | "base", path: string): Promise<Side> => {
			if (e === undefined) return undefined;
			if (e.size > TEXT_MAX) return this.big(n);
			if (source === "base") return e.object === null ? this.big(n) : this.cas.get(e.object) ?? this.big(n);
			return await this.fs.readFile(join(row.folder, path)).catch(() => this.big(n));
		};
		const refuseReason = (p: string, e: Ent | undefined, b: Ent | undefined): string | undefined => {
			if (b?.kind === "skipped") return "skipped at open";
			if (p.split("/").some((part) => LINK_NAMES.includes(part))) return "inside node_modules";
			if (e?.kind === "link") return "link";
			if (/[\\:*?"<>|-]/u.test(basename(p)) || /[. ]$/u.test(basename(p))) return "name not portable";
			if (WIDE_SECRET.some((x) => x.test(basename(p)))) return "secret name";
			if (p.split("/").some((part) => RESERVED.test(part))) return "reserved name";
			if (e !== undefined && SHELL_ACTIVE.some((x) => x.test(basename(p)))) return "shell-active name";
			if (!checkPath(join(row.project, p), row.project, this.o.guard(), true).allowed) return "protected";
			return undefined;
		};
		const todo: { path: string; ours: Ent | undefined; base: Ent | undefined; over?: Buffer }[] = [];
		for (const p of paths) {
			const ours = entryOf(p);
			let b = baseEnt(p);
			const why = refuseReason(p, ours, base.get(p));
			if (why !== undefined) { left.push({ path: p, reason: why }); continue; }
			// A path with a conflict row: while its marker block stands, Vesperia's version is the stored one; once resolved, the recorded live text is its base.
			let over: Buffer | undefined;
			const c = old.get(p);
			if (c !== undefined && (c.kind === "content" || c.kind === "add/add") && c.theirs !== null) {
				const mine = ours === undefined ? undefined : await this.fs.readFile(wsAbs(p)).catch(() => undefined);
				const stored = c.ours === null ? undefined : this.cas.get(c.ours);
				const recorded = this.cas.get(c.theirs);
				if (mine !== undefined && stored !== undefined && hasBlock(mine.toString("utf8"), row.id)) over = stored;
				else if (recorded !== undefined) { b = { path: p, hash: c.theirs, object: c.theirs, size: recorded.length, kind: "file" }; rebased.add(p); }
			}
			todo.push({ path: p, ours, base: b, ...(over === undefined ? {} : { over }) });
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
		const conflict = (path: string, kind: PlanConflict["kind"], ours: Ent | undefined, theirs?: { hash: string | null; bytes?: Buffer; size: number }, marked?: { text: string; lines: number[] }): void => {
			conflicts.push({ path, kind, ours: null, oursSize: ours?.size ?? 0, theirsHash: theirs?.hash ?? null, theirs: theirs?.bytes ?? null, liveSize: theirs?.size ?? 0, wsPath: wsAbs(path), ...(marked === undefined ? {} : marked) });
		};
		const makeRow = (path: string, from: string | null, op: Row["op"], pre: string | null, post: string | null, extra: Partial<Row> = {}): Row => ({ seq: 0, path, from, op, pre, post, mode: null, ...extra });
		const decideFor = async (path: string, entry: Ent | undefined, b: Ent | undefined, theirs: Awaited<ReturnType<Workspaces["liveInfo"]>>, over?: Buffer): Promise<Row | "skip" | "oversize" | "conflict"> => {
			const ours: Ent | undefined = over === undefined ? entry : { path, hash: sha(over), object: null, size: over.length, kind: "file" };
			const theirHash = theirs.kind === "file" ? theirs.hash : null;
			const theirSize = theirs.kind === "file" ? theirs.size : 0;
			if (theirs.kind === "link") { left.push({ path, reason: "link" }); return "skip"; }
			if ((ours?.hash ?? null) === theirHash && theirs.kind !== "dir") return "skip";
			const oursMode = ours === undefined ? null : await this.fs.lstat(join(row.folder, path)).then((s) => s.mode & 0o777).catch(() => null);
			const takeOurs = (): Row | "oversize" => {
				if (theirs.kind === "file" && theirSize > SNAPSHOT_MAX) { oversize.push({ path, ws: join(row.folder, ...path.split("/")) }); return "oversize"; }
				if (ours === undefined) return makeRow(path, null, "delete", theirHash, null, { preSize: theirSize });
				if (theirs.kind === "absent") return makeRow(path, null, "create", null, ours.hash, { mode: oursMode, postSize: ours.size, ...(over === undefined ? {} : { body: over }) });
				return makeRow(path, null, "write", theirHash, ours.hash, { mode: oursMode, preSize: theirSize, postSize: ours.size, ...(over === undefined ? {} : { body: over }) });
			};
			if ((theirHash ?? null) === (b?.hash ?? null) && theirs.kind !== "dir") return takeOurs();
			if (theirs.kind === "dir" || (ours !== undefined && theirs.kind === "absent" && (await dirFor(path)) !== undefined)) { conflict(path, "type", ours, { hash: theirHash, size: theirSize }); return "conflict"; }
			// Both sides moved away from the base: the line merge, or a named conflict.
			const rule = rules.length > 0 ? lwwMatch(rules, path) : null;
			const times = rule === null ? undefined : { rules, ours: this.oursTime(row.id, path, ours !== undefined), theirs: theirs.kind === "file" ? theirs.mtime : -Infinity };
			const d = decide(path, await sideOf(b, 3, "base", path), over ?? await sideOf(ours, 1, "ws", path), theirs.kind === "file" ? (theirs.bytes ?? this.big(2)) : undefined, { labels: [label, `live ${row.id}`], ...(times === undefined ? {} : { lww: times }) });
			if ("lww" in d && d.lww !== undefined) lww.push({ path, ...d.lww });
			if (d.op === "skip") return "skip";
			if (d.op === "ours") return takeOurs();
			if (d.op === "merged") {
				const body = Buffer.from(d.text);
				if (theirs.kind === "file" && theirSize > SNAPSHOT_MAX) { oversize.push({ path, ws: join(row.folder, ...path.split("/")) }); return "oversize"; }
				return makeRow(path, null, theirs.kind === "absent" ? "create" : "write", theirHash, sha(body), { mode: oursMode, preSize: theirSize, postSize: body.length, body });
			}
			conflict(path, d.kind, ours, { hash: theirHash, bytes: theirs.kind === "file" ? theirs.bytes : undefined, size: theirSize }, d.text === undefined ? undefined : { text: d.text, lines: (d.hunks ?? []).map((h) => h.line) });
			return "conflict";
		};
		const processed = new Set<string>();
		for (const t of todo) {
			if (renamed.has(t.path) || processed.has(t.path)) continue;
			const abs = await this.writer.name(row.project, t.path, caseless);
			const theirs = await this.liveInfo(abs);
			items.set(t.path, { ours: t.ours, base: t.base, ...(t.over === undefined ? {} : { over: t.over }) });
			// A new path equal under case folding to a different live path is a case conflict.
			if (caseless && t.ours !== undefined && t.base === undefined && !renames.has(t.path) && theirs.kind !== "absent" && relative(row.project, abs).replaceAll("\\", "/") !== t.path) { conflict(t.path, "case", t.ours, { hash: theirs.kind === "file" ? theirs.hash : null, size: 0 }); continue; }
			const outcome = await decideFor(t.path, t.ours, t.base, theirs, t.over);
			if (typeof outcome !== "string") rows.push(outcome);
		}
		for (const [bPath, aPath] of renames) {
			const a = todo.find((t) => t.path === aPath)!;
			const b = todo.find((t) => t.path === bPath)!;
			const absA = await this.writer.name(row.project, aPath, caseless);
			const theirs = await this.liveInfo(absA);
			items.set(bPath, { ours: b.ours, base: b.base });
			if (theirs.kind === "file" && theirs.hash === a.base!.hash) {
				if (theirs.size > SNAPSHOT_MAX) { oversize.push({ path: aPath, ws: join(row.folder, ...bPath.split("/")) }); continue; }
				rows.push(makeRow(bPath, aPath, "rename", theirs.hash, b.ours!.hash, { mode: null, preSize: theirs.size, postSize: b.ours!.size }));
			} else if (theirs.kind === "absent") {
				// A is gone live: B is a new file there.
				const out = await decideFor(bPath, b.ours, undefined, await this.liveInfo(await this.writer.name(row.project, bPath, caseless)));
				if (typeof out !== "string") rows.push(out);
			} else conflict(bPath, "case", b.ours, { hash: theirs.kind === "file" ? theirs.hash : null, size: 0 });
		}
		// Folder rows for every path the merge creates, parents before children; deletes and renames, then writes and creates.
		for (const r of [...rows]) if (r.op === "write" || r.op === "create" || r.op === "rename") { const bad = await dirFor(r.path); if (bad !== undefined) { rows.splice(rows.indexOf(r), 1); conflict(r.path, "type", entryOf(r.path)); } }
		const ordered: Row[] = [...[...mkdirs].sort((a, b) => a.split("/").length - b.split("/").length).map((p) => makeRow(p, null, "mkdir", null, null)), ...rows.filter((r) => r.op === "delete" || r.op === "rename"), ...rows.filter((r) => r.op === "write" || r.op === "create")];
		ordered.forEach((r, i) => { r.seq = i + 1; });
		// Ours bytes for the conflicts, stored before anything else can change them.
		for (const c of conflicts) {
			const e = entryOf(c.path);
			if (e !== undefined) c.ours = items.get(c.path)?.over ?? await this.fs.readFile(wsAbs(c.path)).catch(() => null);
		}
		const plan: Plan = {
			rows: ordered, conflicts, left, oversize, deletes: ordered.filter((r) => r.op === "delete").length, ignored: scan.ignoredNew, ignoreFailed: scan.ignoreFailed, unreadable: scan.unreadable, lww,
			redecide: async (r, bytes) => {
				const item = items.get(r.path);
				if (item === undefined || r.op === "rename" || r.op === "mkdir") return "conflict";
				const theirs = bytes === null ? { kind: "absent" as const } : { kind: "file" as const, hash: sha(bytes), size: bytes.length, mtime: this.now(), bytes };
				const before = conflicts.length;
				const out = await decideFor(r.path, item.ours, item.base, theirs, item.over);
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
		// A row whose path no longer conflicts (made equal to live, or Vesperia's change gone) is cleared; a resolved marker path keeps its row as the next base.
		const keep = new Set([...conflicts.map((c) => c.path), ...rebased]);
		const gone = [...old.keys()].filter((p) => !keep.has(p));
		if (gone.length > 0) this.cas.tx(() => { const del = this.cas.db.prepare("DELETE FROM conflicts WHERE workspace = ? AND path = ?"); for (const p of gone) del.run(row.id, p); });
		return plan;
	}

	/** The time Vesperia's side of a path was last modified, in integer milliseconds: its file's time at the last scan, or when the scan found it deleted. */
	private oursTime(ws: number, path: string, present: boolean): number {
		const sql = present ? "SELECT mtime AS t FROM ws_stat WHERE workspace = ? AND path = ?" : `SELECT c."at" AS t FROM entries e JOIN commits c ON c.id = e."commit" WHERE c.workspace = ? AND e.path = ? AND e.hash IS NULL ORDER BY c.id DESC LIMIT 1`;
		return Number((this.cas.db.prepare(sql).get(ws, path) as { t: number } | undefined)?.t ?? 0);
	}

	/* --- merge ------------------------------------------------------------------------------------------------- */

	private async execMerge(row: WsRow, plan: Plan, run: string | null, rows: Row[]): Promise<{ text: string; state: WsState; record?: number; code?: string }> {
		const summaryHead = (): string => {
			const n = rows.filter((r) => r.op !== "mkdir").length;
			const out = [`Merged ${n} file${n === 1 ? "" : "s"} from the Workspace into ${row.project}`];
			for (const l of LIMITED(plan.left.map((x) => `not merged: ${x.reason}: ${x.path}`))) out.push(l);
			for (const o of plan.oversize) out.push(`not merged: over 64 MiB: ${o.path}`);
			out.push(...this.lwwLines(plan.lww).map((l) => l.trim()));
			if (plan.ignored.length > 0) out.push(`Vesperia also created ${plan.ignored.length} git-ignored paths (not merged): ${plan.ignored.slice(0, 10).join(", ")}`);
			return out.join("\n");
		};
		if (rows.filter((r) => r.op !== "mkdir").length === 0) {
			const oversized = plan.oversize.length > 0;
			this.cas.tx(() => { this.set(row.id, { state: oversized ? "discarded" : "merged", hold: null, hold_detail: oversized ? "nothing left to merge" : "no changes" }); });
			await this.removeFolder(row.folder).catch((error: unknown) => this.o.notice(`the Workspace folder could not be removed: ${msg(error)}`));
			return { text: [oversized ? `nothing merged: ${plan.oversize.length} changes over 64 MiB were left out; the Workspace was removed` : `Vesperia changed no files in ${row.project}; nothing was merged`, ...LIMITED(plan.left.map((x) => `not merged: ${x.reason}: ${x.path}`)), ...this.lwwLines(plan.lww).map((l) => l.trim())].join("\n"), state: oversized ? "discarded" : "merged" };
		}
		try {
			const r = await this.writer.merge({ ws: row.id, project: row.project, folder: row.folder, run, caseless: row.live_caseless === 1, rows, head: summaryHead(), redecide: plan.redecide });
			this.refresh(row.id);
			if (r.state === "done") { this.gc(); return { text: r.summary, state: "merged", record: r.id }; }
			if (r.state === "pending") { let held = ""; try { this.hold(row.id, "not-recovered", String(r.id)); } catch (error) { held = ` (its hold could not be written either: ${msg(error)})`; } return { text: `${r.summary}\nmerge record ${r.id} is still pending; restart piroboros to recover it${held}`, state: "held", record: r.id, code: "not-recovered" }; }
			return { text: r.summary, state: "held", record: r.id, code: "rollback" };
		} catch (error) {
			if (error instanceof HoldError) { this.hold(row.id, error.code, error.detail.replaceAll(", ", "\n")); return { text: `Merge held: ${holdText(error.code, error.detail)}`, state: "held", code: error.code }; }
			if (error instanceof ConflictFound) return await this.storeConflicts(row, await this.plan(row), "the live file changed again");
			this.hold(row.id, "preflight", `${row.project}: ${msg(error)}`);
			return { text: `Merge held: ${msg(error)}`, state: "held", code: "preflight" };
		}
	}

	/** Write nothing live: keep Vesperia's version of each conflicted path in the store, mark the Workspace conflicted, and write the marker text of each text conflict into the Workspace. */
	private async storeConflicts(row: WsRow, plan: Plan, why?: string): Promise<{ text: string; state: WsState; code: string }> {
		if (plan.conflicts.length === 0) { this.hold(row.id, "preflight", `${row.project}: ${why ?? "a path changed during the merge"}`); return { text: `Merge held: ${why ?? "a path changed during the merge"}`, state: "held", code: "preflight" }; }
		const before = plan.conflicts.map((c) => (this.cas.db.prepare("SELECT theirs FROM conflicts WHERE workspace = ? AND path = ?").get(row.id, c.path) as { theirs: string | null } | undefined)?.theirs);
		const puts = plan.conflicts.map((c) => (c.ours === null ? undefined : pack(c.ours)));
		const theirs = plan.conflicts.map((c) => (c.theirs === null ? undefined : pack(c.theirs)));
		this.cas.tx(() => {
			this.cas.insert([...puts, ...theirs].filter((p): p is Packed => p !== undefined));
			const stmt = this.cas.db.prepare("INSERT OR REPLACE INTO conflicts VALUES (?, ?, ?, ?, ?)");
			plan.conflicts.forEach((c, i) => stmt.run(row.id, c.path, c.kind, puts[i]?.id ?? null, c.theirsHash));
			this.hold(row.id, "conflicts", String(plan.conflicts.length), "conflicted");
		});
		// Markers go in after the store holds her version. A block the user is editing stays while the live text is the one it was made against.
		for (const [i, c] of plan.conflicts.entries()) {
			if (c.text === undefined || before[i] === c.theirsHash) continue;
			try { await wsPut(this.fs, row.folder, c.path, { bytes: c.text }); } catch (error) {
				if (!(error instanceof WsRefusal)) throw error;
				this.o.notice(`the conflict markers for ${c.path} were not written: ${msg(error)}`);
			}
		}
		return { text: this.conflictText(plan.conflicts, plan.lww), state: "conflicted", code: "conflicts" };
	}

	private conflictText(conflicts: { path: string; kind: string; lines?: number[] }[], lww: Plan["lww"] = []): string {
		const at = (c: { lines?: number[] }): string => (c.lines === undefined || c.lines.length === 0 ? "" : ` (marked at line${c.lines.length === 1 ? "" : "s"} ${c.lines.join(", ")})`);
		return [`Merge refused: ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}; nothing was written to the live folder`, ...LIMITED(conflicts.map((c) => `  ${c.kind}: ${c.path}${at(c)}`)), ...this.lwwLines(lww), "Resolve them in the live folder or the Workspace (remove the marker blocks, or make the Workspace file equal the live one) and run /conclave merge again, or /conclave discard."].join("\n");
	}

	private lwwLines(lww: Plan["lww"]): string[] {
		return LIMITED([...new Map(lww.map((l) => [l.path, l])).values()].map((l) => `  .lww ${l.rule}: ${l.path} kept the ${l.kept === "ours" ? "Workspace" : "live"} side`));
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
	async settle(key: string, verdict: string, failure?: string): Promise<{ text: string; merge: ExecMerge }> {
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
				const down = this.down.get(row.id);
				if (down !== undefined) { this.hold(row.id, "backend", down); return out(holdText("backend", down)); }
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
		await this.quiet(row);
		const plan = await this.plan(row);
		if (plan.ignoreFailed) return fail("ignore-rules", "");
		if (plan.unreadable.length > 0) return fail("unreadable", LIMITED(plan.unreadable).join("\n"));
		if (seen !== undefined && shown(plan) !== seen) return { text: "The live folder or the Workspace changed while you answered; nothing was merged. Run /conclave merge again.", state: row.state };
		if (plan.conflicts.length > 0 && !force) return await this.storeConflicts(row, plan);
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
		// The ext4 folders of each distro a Workspace of this store used: ids with no open, held or conflicted row go (only the own home-hash folder is listed).
		const deps = this.confineDeps();
		const used = new Map<string, Remote>();
		const engines = new Map<string, DockerConf>();
		for (const row of this.rows("1 = 1")) {
			const confine = JSON.parse(row.confine) as Confine;
			const c = confine.wsl ?? confine.docker?.remote;
			if (c !== undefined) used.set(`${c.distro}/${c.user}`, c);
			if (confine.docker !== undefined) engines.set(`${confine.docker.cli}/${confine.docker.remote?.distro}/${confine.docker.remote?.user}`, confine.docker);
		}
		if (deps.wsl !== undefined) for (const c of used.values()) await wslSweep(deps.wsl, c, keep).catch((error: unknown) => this.o.notice(`could not sweep the sandbox folders in ${c.distro}: ${msg(error)}`));
		// Containers of this home hash with no `open` row. ponytail: an orphan is found only through an engine some row of this store used.
		const open = new Set(this.rows("state = 'open'").map((r) => String(r.id)));
		for (const c of engines.values()) await dockerSweep(deps, c, this.hash, open).catch((error: unknown) => this.o.notice(`could not sweep the containers: ${msg(error)}`));
	}

	/** Never rmSync recursive over a Workspace: links are removed as links, then the real folders. */
	async removeFolder(dir: string, known?: Confine): Promise<void> {
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
		let confine = known;
		try { confine ??= JSON.parse(this.rows("folder = ?", dir)[0]?.confine ?? "{}") as Confine; } catch { /* no row */ }
		const deps = this.confineDeps();
		if (confine?.docker !== undefined) await dockerRemove(deps, confine.docker).catch((error: unknown) => this.o.notice(`the container ${confine.docker?.container.slice(0, 12)} could not be removed: ${msg(error)}`));
		const remote = confine?.wsl ?? confine?.docker?.remote;
		if (remote !== undefined && deps.wsl !== undefined) await wslRemove(deps.wsl, remote).catch((error: unknown) => this.o.notice(`the sandbox folder ${remote.ext4} could not be removed: ${msg(error)}`));
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
			await this.quiet(row);
			const plan = await this.plan(row);
			if (plan.unreadable.length > 0) { const detail = LIMITED(plan.unreadable).join("\n"); this.hold(row.id, "unreadable", detail); return { text: `Merge held: ${holdText("unreadable", detail)}`, ended: false }; }
			const reasons: string[] = [];
			const confirmed = new Set<string>();
			if (row.state === "held" && row.hold !== "conflicts") reasons.push(holdText(row.hold, row.hold_detail));
			if (plan.headMoved !== undefined) { reasons.push(holdText("head-moved", `${plan.headMoved.from} ${plan.headMoved.to}`)); confirmed.add("head-moved"); }
			if (plan.deletes >= BULK_DELETE) { reasons.push(holdText("bulk-delete", String(plan.deletes))); confirmed.add("bulk-delete"); }
			if (plan.oversize.length > 0) { reasons.push(holdText("oversize", plan.oversize.map((o) => `${o.path} (her version: ${o.ws})`).join("\n"))); confirmed.add("oversize"); }
			const over = plan.oversize.length > 0 || plan.conflicts.some((c) => c.liveSize > SNAPSHOT_MAX);
			const finish = (out: { text: string; state: WsState }): Reply => ({ text: out.text, ended: out.state === "merged" || out.state === "discarded" });
			if (plan.conflicts.length > 0) {
				const stored = await this.storeConflicts(row, plan);
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
		if (w.state === "merged") return { text: `ended after /conclave merge: ${(this.cas.db.prepare("SELECT summary FROM merges WHERE workspace = ? ORDER BY id DESC LIMIT 1").get(w.id) as { summary: string } | undefined)?.summary ?? "nothing was merged"}`, verdict: "failed", merge };
		return { text: w.hold_detail === "nothing left to merge" ? "ended after /conclave merge, which had nothing left to merge" : "ended after /conclave discard", verdict: "failed", merge };
	}

	/** `/conclave status`: the Workspace state, hold text, mode and its source, folder, checkpoints and confinement. */
	statusLines(project: string, from?: string, parked = false): string[] {
		const w = this.rows("project = ?", canonicalize(project))[0];
		if (w === undefined) return [];
		const commits = Number((this.cas.db.prepare("SELECT COUNT(*) AS n FROM commits WHERE workspace = ? AND kind = 'checkpoint'").get(w.id) as { n: number }).n);
		return [`Workspace ${w.id}: ${w.state}${w.hold === null ? "" : ` (${holdText(w.hold, w.hold_detail)})`}${parked ? " [task parked]" : ""}`, `  mode ${w.mode}${from === undefined ? "" : ` (${from})`}, folder ${w.folder}, ${commits} checkpoint${commits === 1 ? "" : "s"}`, (() => { const c = JSON.parse(w.confine) as Confine; return c.name !== "none" ? `  shell confinement: ${c.name}${c.docker === undefined ? "" : ` (${c.docker.image})`}${c.wsl === undefined && c.docker?.remote === undefined ? "" : ` in WSL (${(c.wsl ?? c.docker!.remote!).distro})`}, network ${c.net === false ? "off" : "on"}` : `  shell confinement: none; commands are not confined${c.why === undefined ? "" : ` (${c.why})`}`; })()];
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

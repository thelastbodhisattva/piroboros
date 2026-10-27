import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { canonicalize } from "../paths.ts";

// Host git for Workspaces. Every call here carries SAFE_GIT and gets an environment without any GIT_* name in any letter case,
// so nothing in the user's shell, a git hook parent or a Workspace config changes what it reads or runs. Calls are against the
// live repository, with one exception: `init`, `baseCommit` (`fast-import` and `read-tree`) build the Workspace's own repository at open, when the host has
// just written the folder and nothing of Vesperia's is in it. After that piroboros never runs git with a Workspace as the repository.

/** A message for the user: the reason a Workspace cannot open or a mode cannot be resolved, with the way out. */
export class WsRefusal extends Error {}

export interface GitResult { code: number | null; out: Buffer; err: string }
export type GitSpy = (call: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }) => void;

/** Options that stop the user's own fsmonitor, pager and hooks from running under piroboros. */
export const safeGit = (home: string): string[] => ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", `core.hooksPath=${join(home, "ws", "no-hooks")}`];

/**
 * piroboros's environment without any GIT_* name (any case: Git for Windows honours a lower-case git_dir), then the fixed
 * ones. check-ignore refuses GIT_LITERAL_PATHSPECS, so it runs without it and gets `./`-prefixed paths instead.
 */
export function gitEnv(literal: boolean, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) if (!/^GIT_/iu.test(name)) env[name] = value;
	env.GIT_TERMINAL_PROMPT = "0";
	env.LC_ALL = "C";
	if (literal) env.GIT_LITERAL_PATHSPECS = "1";
	return env;
}

const firstLine = (text: string): string => text.trim().split(/\r?\n/u)[0] ?? "";
const dubious = (project: string): string => ` piroboros ignores GIT_* variables, including GIT_CONFIG_GLOBAL; run git config --global --add safe.directory ${project} in a shell where GIT_CONFIG_GLOBAL is not set.`;

export type GitState = { kind: "none" } | { kind: "tree"; toplevel: string; gitDir: string };

/** The config keys copied into a git Workspace; everything else (fsmonitor, hooksPath, filters, includes, credentials, the repository format) is dropped. */
const CONFIG_KEYS = /^(?:core\.(?:bare|filemode|symlinks|ignorecase|precomposeunicode|autocrlf|eol|safecrlf|logallrefupdates|quotepath)|user\.(?:name|email)|remote\..+\.(?:url|fetch)|branch\..+\.(?:remote|merge))$/u;

export class HostGit {
	readonly home: string;
	private readonly spy: GitSpy | undefined;

	constructor(home: string, spy?: GitSpy) {
		this.home = home;
		this.spy = spy;
	}

	/** `feed` writes a large stdin itself (await `put` on each chunk); `input` is a small one. */
	run(cwd: string, args: string[], options: { input?: string | Buffer; feed?: (stdin: Writable) => Promise<void>; literal?: boolean } = {}): Promise<GitResult> {
		const env = gitEnv(options.literal ?? true);
		const argv = [...safeGit(this.home), ...args];
		this.spy?.({ args: argv, env, cwd });
		return new Promise((resolve, reject) => {
			const child = spawn("git", argv, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
			const out: Buffer[] = [];
			let err = "";
			child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (text: string) => { if (err.length < 8_000) err += text; });
			child.stdin.on("error", () => { /* git exited before reading its input */ });
			child.on("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new WsRefusal("git is not installed or not on PATH, so a Workspace cannot be made; install git, or set workspace.enabled to false to run in place") : error));
			let fed: unknown;
			child.on("close", (code) => (fed !== undefined ? reject(fed) : resolve({ code, out: Buffer.concat(out), err })));
			if (options.feed === undefined) { child.stdin.end(options.input); return; }
			options.feed(child.stdin).then(() => child.stdin.end(), (error: unknown) => { fed = error; child.kill(); });
		});
	}

	private fail(project: string, result: GitResult, what: string): WsRefusal {
		const detail = firstLine(result.err);
		return new WsRefusal(`git failed in ${project} (${what}${detail === "" ? `, exit ${result.code}` : `: ${detail}`}); a Workspace needs a working git there, or set workspace.enabled to false to run in place.${/dubious ownership/iu.test(result.err) ? dubious(project) : ""}`);
	}

	/** none (no git at all), or the work tree it is in. A bare repository and a folder inside a git dir are refused. */
	async state(project: string): Promise<GitState> {
		const flags = await this.run(project, ["rev-parse", "--is-bare-repository", "--is-inside-git-dir", "--is-inside-work-tree"]);
		if (flags.code === 128 && /not a git repository/iu.test(flags.err)) return { kind: "none" };
		if (flags.code !== 0) throw this.fail(project, flags, "rev-parse");
		const [bare, inGitDir] = flags.out.toString("utf8").trim().split(/\r?\n/u);
		if (bare === "true") throw new WsRefusal(`${project} is a bare git repository, which has no files to work on; open a checkout of it instead`);
		if (inGitDir === "true") throw new WsRefusal(`${project} is inside a git dir; open the work tree instead`);
		const both = await this.run(project, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
		const pair = both.code === 0 ? both.out.toString("utf8").trim().split(/\r?\n/u) : [];
		// A failure, or an unexpected shape, repeats the two single calls so the refusal names the one that failed.
		if (pair.length === 2) return { kind: "tree", toplevel: canonicalize(pair[0]!), gitDir: canonicalize(pair[1]!) };
		const top = await this.run(project, ["rev-parse", "--show-toplevel"]);
		const dir = await this.run(project, ["rev-parse", "--absolute-git-dir"]);
		if (top.code !== 0) throw this.fail(project, top, "rev-parse --show-toplevel");
		if (dir.code !== 0) throw this.fail(project, dir, "rev-parse --absolute-git-dir");
		return { kind: "tree", toplevel: canonicalize(top.out.toString("utf8").trim()), gitDir: canonicalize(dir.out.toString("utf8").trim()) };
	}

	/** "finish or abort the <operation>" when the live repository is in the middle of one; read from its own git dir. */
	operationInProgress(gitDir: string): string | undefined {
		const marks: [string, string][] = [["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"]];
		return marks.find(([name]) => existsSync(join(gitDir, name)))?.[1];
	}

	private async lines(project: string, args: string[], what: string): Promise<string[]> {
		const r = await this.run(project, args);
		if (r.code !== 0) throw this.fail(project, r, what);
		return r.out.toString("utf8").split("\0").filter((p) => p !== "");
	}

	/** Tracked plus untracked and not ignored paths under `project`, relative to it, deduplicated. */
	async files(project: string): Promise<string[]> {
		return [...new Set(await this.lines(project, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], "ls-files"))];
	}

	/** Ignored directories under `project` (names end with a slash). */
	ignoredDirs(project: string): Promise<string[]> {
		return this.lines(project, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], "ls-files --ignored");
	}

	/** The paths of `paths` that the repository's ignore rules match, read literally (a `./` prefix goes in and comes out). Throws on exit 128. */
	async ignored(project: string, paths: string[]): Promise<Set<string>> {
		if (paths.length === 0) return new Set();
		const r = await this.run(project, ["check-ignore", "--no-index", "-z", "--stdin"], { input: paths.map((p) => `./${p}\0`).join(""), literal: false });
		if (r.code === 1) return new Set();
		if (r.code !== 0) throw this.fail(project, r, "check-ignore");
		return new Set(r.out.toString("utf8").split("\0").filter((p) => p !== "").map((p) => p.replace(/^\.[\\/]/u, "")));
	}

	async head(project: string): Promise<string | undefined> {
		const r = await this.run(project, ["rev-parse", "HEAD"]);
		return r.code === 0 ? r.out.toString("utf8").trim() : undefined;
	}

	/** The branch HEAD is on, or undefined when it is detached. */
	async branch(project: string): Promise<string | undefined> {
		const r = await this.run(project, ["symbolic-ref", "-q", "--short", "HEAD"]);
		return r.code === 0 && r.out.toString("utf8").trim() !== "" ? r.out.toString("utf8").trim() : undefined;
	}

	/** A new empty repository in `folder` (no hook templates), HEAD on `branch` when given. See the note at the top: this runs against a Workspace. */
	async init(folder: string, branch: string | undefined): Promise<void> {
		const r = await this.run(folder, ["init", "-q", "--template="]);
		if (r.code !== 0) throw this.fail(folder, r, "init");
		if (branch === undefined) return;
		const h = await this.run(folder, [`--git-dir=${join(folder, ".git")}`, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
		if (h.code !== 0) throw this.fail(folder, h, "symbolic-ref");
	}

	/**
	 * Make the one base commit of `folder` from the copied files (fixed identity), as one `fast-import` stream of the raw bytes, then `read-tree` for the index. Neither runs a clean
	 * filter, an eol conversion or a hook, so no filter of the user's global or system git config runs on the host, and a few loose objects stay out of the Workspace.
	 * Each file is read from `folder` once, one at a time. See the note at the top: this runs against a Workspace.
	 */
	async baseCommit(folder: string, files: { path: string; mode: "100644" | "100755" | "120000"; size: number; link?: string }[]): Promise<void> {
		const where = [`--git-dir=${join(folder, ".git")}`, `--work-tree=${folder}`];
		const ref = await this.run(folder, [...where, "symbolic-ref", "-q", "HEAD"]);
		const branch = ref.out.toString("utf8").trim();
		if (ref.code !== 0 || !branch.startsWith("refs/heads/")) throw this.fail(folder, ref, "symbolic-ref");
		const quote = (path: string): string => `"${path.replace(/[\\"\x00-\x1f\x7f]/gu, (c) => (c === "\\" || c === '"' ? `\\${c}` : `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`))}"`;
		const put = (w: Writable, chunk: Buffer | string): Promise<void> => (w.write(chunk) || w.destroyed ? Promise.resolve() : new Promise((done) => { const end = (): void => { w.off("drain", end); w.off("close", end); done(); }; w.once("drain", end); w.once("close", end); }));
		const feed = async (w: Writable): Promise<void> => {
			// Small pieces gather into ~256 KiB writes: a pipe write per piece costs more than reading the file. A big file streams through.
			let batch: Buffer[] = [];
			let held = 0;
			const add = async (chunk: Buffer | string): Promise<void> => { const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk; batch.push(b); held += b.length; if (held >= 262_144) await flush(); };
			const flush = async (): Promise<void> => { const b = Buffer.concat(batch); batch = []; held = 0; await put(w, b); };
			await add(`commit ${branch}\ncommitter piroboros <piroboros@localhost> ${Math.floor(Date.now() / 1000)} +0000\ndata <<EOM\npiroboros Workspace base\nEOM\n`);
			// A file read costs about 0.7 ms here, so 16 small files are read ahead (at most 16 MiB held); each result is the bytes, or the error to throw in its turn.
			const small = (f: (typeof files)[number]): boolean => f.link === undefined && f.size <= 1_048_576;
			const ahead: Promise<Buffer | Error>[] = [];
			let next = 0;
			for (let i = 0; i < files.length; i += 1) {
				while (ahead.length < 16 && next < files.length) { const g = files[next++]!; ahead.push(small(g) ? readFile(join(folder, g.path)).catch((error: Error) => error) : Promise.resolve(Buffer.alloc(0))); }
				const f = files[i]!;
				const bytes = await ahead.shift()!;
				if (bytes instanceof Error) throw bytes;
				if (w.destroyed) return;
				await add(`M ${f.mode} inline ${quote(f.path)}\n`);
				if (f.link !== undefined) { const text = Buffer.from(f.link); await add(`data ${text.length}\n`); await add(text); } else if (small(f)) {
					if (bytes.length !== f.size) throw new Error(`${f.path} changed while it was committed`);
					await add(`data ${f.size}\n`); await add(bytes);
				} else { await add(`data ${f.size}\n`); await flush(); for await (const chunk of createReadStream(join(folder, f.path))) await put(w, chunk as Buffer); }
				await add("\n");
			}
			await add("done\n");
			await flush();
		};
		const imported = await this.run(folder, [...where, "fast-import", "--quiet", "--done", "--date-format=raw"], { feed });
		if (imported.code !== 0) throw this.fail(folder, imported, "fast-import");
		const index = await this.run(folder, [...where, "read-tree", "HEAD"]);
		if (index.code !== 0) throw this.fail(folder, index, "read-tree");
	}

	/** The live repository's own config reduced to the allowed keys, as a fresh INI text. Every remote gets a push URL that fails. */
	async copyConfig(gitDir: string): Promise<string> {
		const r = await this.run(gitDir, ["config", "--file", join(gitDir, "config"), "--no-includes", "--list", "-z"]);
		if (r.code !== 0) throw this.fail(gitDir, r, "config --list");
		const sections = new Map<string, string[]>();
		const add = (section: string, line: string): void => { sections.set(section, [...(sections.get(section) ?? []), line]); };
		const quote = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
		add("core", "bare = false");
		for (const entry of r.out.toString("utf8").split("\0").filter((e) => e !== "")) {
			const nl = entry.indexOf("\n");
			const key = nl < 0 ? entry : entry.slice(0, nl);
			if (key === "core.bare" || !CONFIG_KEYS.test(key)) continue;
			const value = nl < 0 ? "true" : entry.slice(nl + 1);
			const dots = key.split(".");
			const variable = dots.pop()!;
			const name = dots.shift()!;
			add(dots.length === 0 ? name : `${name} "${dots.join(".").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`, `${variable} = ${quote(value)}`);
		}
		for (const section of [...sections.keys()]) if (section.startsWith("remote ")) add(section, `pushurl = ${quote("piroboros-workspace-no-push")}`);
		return [...sections].map(([section, lines]) => `[${section}]\n${lines.map((l) => `\t${l}`).join("\n")}\n`).join("");
	}
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../paths.ts";

// Host git for Workspaces. piroboros never runs git with a Workspace as the repository: every call here is against the live
// repository, carries SAFE_GIT, and gets an environment without any GIT_* name in any letter case, so nothing in the
// user's shell, a git hook parent or a Workspace config changes what it reads or runs.

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

/** The config keys copied into a git Workspace; everything else (fsmonitor, hooksPath, filters, includes, credentials) is dropped. */
const CONFIG_KEYS = /^(?:core\.(?:repositoryformatversion|bare|filemode|symlinks|ignorecase|precomposeunicode|autocrlf|eol|safecrlf|logallrefupdates|quotepath)|extensions\.(?:objectformat|refstorage)|user\.(?:name|email)|remote\..+\.(?:url|fetch)|branch\..+\.(?:remote|merge))$/u;

export class HostGit {
	readonly home: string;
	private readonly spy: GitSpy | undefined;

	constructor(home: string, spy?: GitSpy) {
		this.home = home;
		this.spy = spy;
	}

	run(cwd: string, args: string[], options: { input?: string | Buffer; literal?: boolean } = {}): Promise<GitResult> {
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
			child.on("close", (code) => resolve({ code, out: Buffer.concat(out), err }));
			child.stdin.end(options.input);
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

	/** The commit ids HEAD and every ref point at. `knownHead` is the caller's own `head()` ("" for none), to skip a second call. */
	async refIds(project: string, knownHead?: string): Promise<string[]> {
		const refs = await this.run(project, ["for-each-ref", "--format=%(objectname)"]);
		if (refs.code !== 0) throw this.fail(project, refs, "for-each-ref");
		const head = knownHead === undefined ? await this.head(project) : knownHead === "" ? undefined : knownHead;
		return [...new Set([...(head === undefined ? [] : [head]), ...refs.out.toString("utf8").split(/\r?\n/u).filter((id) => id !== "")])];
	}

	/** The ids of the list the repository does not have. */
	async missingObjects(project: string, ids: string[]): Promise<string[]> {
		if (ids.length === 0) return [];
		const r = await this.run(project, ["cat-file", "--batch-check"], { input: `${ids.join("\n")}\n` });
		if (r.code !== 0) throw this.fail(project, r, "cat-file");
		return r.out.toString("utf8").split(/\r?\n/u).filter((line) => /\bmissing$/u.test(line)).map((line) => line.split(" ")[0]!);
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

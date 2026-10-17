import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { FileFinderApi, GrepCursor, GrepMode } from "@ff-labs/fff-node";
import { AgentDoc, ctx, defineTool, type ToolExecutionApi, type ToolRegistration } from "./durable.ts";
import { checkPath, type GuardConfig } from "./guard.ts";
import { redactSensitive } from "./redact.ts";
import { clampContext, formatFind, formatGrep, isWildcardOnly, normalizeConstraint, truncateLine, NO_FILES_FOUND, type GrepLine } from "./search-format.ts";

// find and grep (F1). fff, an indexed finder, answers first. ripgrep answers when exact:true is asked, or when
// fff cannot load or returns an error; details.backend says which one answered and why. Every result path goes
// through the guard's deny check before it is returned, and the text is redacted. The terminal render applies
// SafeText. rg runs as a child with an argument list and no shell.

type Fff = typeof import("@ff-labs/fff-node");

export const FIND_LIMIT = 30;
export const GREP_LIMIT = 20;
export const MAX_OUTPUT_CHARS = 20_000;
const SCAN_MS = 15_000;
const RG_TIMEOUT_MS = 30_000;
const RG_MAX_EVENTS = 5_000;
const CURSOR_KEYS = 50;

/** The code names the failure; the text after it is for the model. */
export class SearchError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

export interface SearchDeps {
	/** PIROBOROS_HOME. The frecency and history databases live in ${home}/fff. */
	home: string;
	/** Read on every call, so /reload can replace the deny list. */
	guard(): GuardConfig;
	/** Loads the fff package. Tests replace it to force a load failure. */
	loadFff?(): Promise<Fff>;
	/** The ripgrep program. Default `rg`. */
	rg?: string;
}

export interface SearchStatus {
	fff: { ok: true } | { ok: false; reason: string };
	rg: boolean;
}

export interface Search {
	tools: ToolRegistration[];
	/** Destroys the fff index. Safe to call twice. */
	close(): void;
	/** Working directory of the live index, if one exists. */
	indexCwd(): string | undefined;
	status(): Promise<SearchStatus>;
}

type Holder = { cwd: string; finder: FileFinderApi; cursors: Map<string, GrepCursor[]> };
type Reply = { text: string; backend: "fff" | "rg"; reason?: string; total?: number; page: number };

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const shown = (path: string): string => path.replace(/^\.[\\/]/u, "").replaceAll("\\", "/");

/** An rg glob for a constraint: a directory prefix means everything under it. */
const rgGlob = (constraint: string): string => (constraint.endsWith("/") ? `${constraint}**` : constraint);

/** Run rg with an argument list. `onLine` returns true to stop early. Output is read as lines of UTF-8 text. */
function runRg(program: string, args: string[], cwd: string, onLine: (line: string) => boolean): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let rest = "";
		let stderr = "";
		let stopped = false;
		const timer = setTimeout(() => {
			child.kill();
			reject(new SearchError("search_timeout", `ripgrep did not finish within ${RG_TIMEOUT_MS / 1000} seconds; narrow the search with glob`));
		}, RG_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => { if (stderr.length < 4_000) stderr += text; });
		child.stdout.on("data", (text: string) => {
			if (stopped) return;
			const parts = (rest + text).split("\n");
			rest = parts.pop() ?? "";
			for (const line of parts) {
				if (onLine(line.replace(/\r$/u, ""))) {
					stopped = true;
					child.kill();
					return;
				}
			}
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(error.code === "ENOENT" ? new SearchError("search_rg_unavailable", "ripgrep (rg) was not found on PATH") : error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (!stopped && rest !== "") onLine(rest.replace(/\r$/u, ""));
			resolve({ code, stderr });
		});
	});
}

/** Whether fff loads here, and whether rg starts. Used by setup and by the status of a running search. */
export async function probeSearch(options: { rg?: string; loadFff?: () => Promise<Fff> } = {}): Promise<SearchStatus> {
	let fff: SearchStatus["fff"];
	try {
		const module = await (options.loadFff ?? (() => import("@ff-labs/fff-node")))();
		fff = module.binaryExists() ? { ok: true } : { ok: false, reason: "the native library for this platform is not installed" };
	} catch (error) {
		fff = { ok: false, reason: reasonOf(error) };
	}
	const rg = await runRg(options.rg ?? "rg", ["--version"], process.cwd(), () => false).then((r) => r.code === 0, () => false);
	return { fff, rg };
}

export function createSearch(deps: SearchDeps): Search {
	const rg = deps.rg ?? "rg";
	let fffPromise: Promise<Fff> | undefined;
	let holder: Holder | undefined;
	let creating: Promise<unknown> = Promise.resolve();

	const loadFff = (): Promise<Fff> => (fffPromise ??= (deps.loadFff ?? (() => import("@ff-labs/fff-node")))());
	const allowed = (path: string, cwd: string): boolean => checkPath(path, cwd, deps.guard()).allowed;

	const destroy = (): void => {
		if (holder !== undefined && !holder.finder.isDestroyed) holder.finder.destroy();
		holder = undefined;
	};

	/** One index per working directory; a different directory replaces it. Creation is serialized. */
	const finderFor = (cwd: string): Promise<Holder> => {
		const next = creating.then(async () => {
			if (holder !== undefined && holder.cwd === cwd && !holder.finder.isDestroyed) return holder;
			destroy();
			const fff = await loadFff();
			const base = { basePath: cwd, aiMode: true, enableHomeDirScanning: false, enableFsRootScanning: false };
			mkdirSync(join(deps.home, "fff"), { recursive: true });
			let made = fff.FileFinder.create({ ...base, frecencyDbPath: join(deps.home, "fff", "frecency.db"), historyDbPath: join(deps.home, "fff", "history.db") });
			// a locked or damaged database must not turn search off
			if (!made.ok) made = fff.FileFinder.create(base);
			if (!made.ok) throw new Error(made.error);
			const waited = await made.value.waitForScan(SCAN_MS);
			if (!waited.ok) {
				made.value.destroy();
				throw new Error(waited.error);
			}
			return (holder = { cwd, finder: made.value, cursors: new Map() });
		});
		creating = next.catch(() => undefined);
		return next;
	};

	const constraintOf = (glob: string | undefined, cwd: string): string | undefined => {
		try {
			return glob === undefined ? undefined : normalizeConstraint(glob, cwd);
		} catch (error) {
			throw new SearchError("search_glob_outside", reasonOf(error));
		}
	};

	const FFF_DOWN = "fff unavailable: ";
	/** rg missing after fff failed is one named error; an exact search without rg names rg alone. */
	const unavailable = (reason: string, error: unknown): SearchError =>
		error instanceof SearchError && error.code === "search_rg_unavailable" && reason.startsWith(FFF_DOWN)
			? new SearchError("search_unavailable", `fff is unavailable (${reason.slice(FFF_DOWN.length)}) and ripgrep (rg) was not found on PATH`)
			: (error as SearchError);

	/* --- find --- */

	async function findFff(cwd: string, query: string, constraint: string | undefined, page: number): Promise<Reply> {
		const h = await finderFor(cwd);
		// fff-node 0.11.0 reads pageIndex as the offset of the first item (checked: 30 returns the 31st item on), not as a page number.
		const res = h.finder.fileSearch([constraint, query].filter((part) => part !== undefined && part !== "").join(" "), { pageIndex: (page - 1) * FIND_LIMIT, pageSize: FIND_LIMIT });
		if (!res.ok) throw new Error(res.error);
		const { items, scores, totalMatched } = res.value;
		const formatted = formatFind(items.filter((item) => allowed(item.relativePath, cwd)), scores[0]?.total ?? 0, FIND_LIMIT, query);
		const notes: string[] = [];
		const seen = (page - 1) * FIND_LIMIT + items.length;
		if (formatted.weak && formatted.shown > 0) notes.push(`"${query}" gave only weak fuzzy matches; showing ${formatted.shown} of ${totalMatched}`);
		else if (items.length >= FIND_LIMIT && totalMatched > seen) notes.push(`${totalMatched - seen} more; page=${page + 1}`);
		return { text: notes.length > 0 ? `${formatted.output}\n\n[${notes.join(". ")}]` : formatted.output, backend: "fff", total: totalMatched, page };
	}

	async function findRg(cwd: string, query: string, constraint: string | undefined, page: number, reason: string): Promise<Reply> {
		const argv = ["--no-config", "--no-messages", "--no-require-git", "--files", "--sort", "path", "--glob", "!.git", ...(constraint === undefined ? [] : ["--glob", rgGlob(constraint)]), "--", "."];
		const words = query.toLowerCase().split(/\s+/u).filter((word) => word !== "");
		const hits: string[] = [];
		let run: { code: number | null; stderr: string };
		try {
			run = await runRg(rg, argv, cwd, (line) => {
				const path = shown(line);
				if (path !== "" && words.every((word) => path.toLowerCase().includes(word)) && allowed(path, cwd)) hits.push(path);
				return false;
			});
		} catch (error) {
			throw unavailable(reason, error);
		}
		// 0 lists files, 1 lists none. Anything else is an rg failure, never "no files"; a partial listing with some unreadable paths still counts.
		if (run.code !== 0 && run.code !== 1 && hits.length === 0) throw new SearchError("search_rg_failed", run.stderr.trim().split("\n")[0] || `ripgrep exited with code ${run.code}`);
		const slice = hits.slice((page - 1) * FIND_LIMIT, page * FIND_LIMIT);
		if (slice.length === 0) return { text: NO_FILES_FOUND, backend: "rg", reason, total: hits.length, page };
		const more = hits.length - page * FIND_LIMIT;
		return { text: more > 0 ? `${slice.join("\n")}\n\n[${more} more; page=${page + 1}]` : slice.join("\n"), backend: "rg", reason, total: hits.length, page };
	}

	async function find(cwd: string, query: string, glob: string | undefined, page: number): Promise<Reply> {
		const constraint = constraintOf(glob, cwd);
		let reason: string;
		try {
			return await findFff(cwd, query, constraint, page);
		} catch (error) {
			reason = `${FFF_DOWN}${reasonOf(error)}`;
		}
		return findRg(cwd, query, constraint, page, reason);
	}

	/* --- grep --- */

	interface GrepArgs { pattern: string; mode: GrepMode; constraint: string | undefined; context: number; page: number }

	async function grepFff(cwd: string, a: GrepArgs): Promise<Reply> {
		const h = await finderFor(cwd);
		const key = JSON.stringify([a.pattern, a.mode, a.constraint ?? "", a.context]);
		const known = h.cursors.get(key) ?? [];
		if (a.page > 1 && known[a.page - 2] === undefined) throw new SearchError("search_page_unavailable", `page ${a.page} needs page ${a.page - 1} first, with the same arguments`);
		const options = { smartCase: true, maxMatchesPerFile: 200, pageSize: GREP_LIMIT, classifyDefinitions: true, timeBudgetMs: 10_000 };
		const query = a.constraint === undefined ? a.pattern : `${a.constraint} ${a.pattern}`;
		const first = h.finder.grep(query, { ...options, mode: a.mode, cursor: a.page > 1 ? known[a.page - 2]! : null, beforeContext: a.context, afterContext: a.context });
		if (!first.ok) throw new Error(first.error);
		let result = first.value;
		const notes: string[] = [];
		if (result.items.length === 0 && result.nextCursor === null && a.page === 1 && a.mode === "plain") {
			const fuzzy = h.finder.grep(query, { ...options, mode: "fuzzy", cursor: null });
			if (fuzzy.ok && fuzzy.value.items.length > 0) {
				result = fuzzy.value;
				notes.push("0 exact matches; these are fuzzy matches");
			}
		}
		if (result.regexFallbackError) notes.push(`Invalid regex: ${result.regexFallbackError}; matched as plain text`);
		if (result.nextCursor !== null) {
			known[a.page - 1] = result.nextCursor;
			h.cursors.delete(key);
			h.cursors.set(key, known);
			if (h.cursors.size > CURSOR_KEYS) h.cursors.delete(h.cursors.keys().next().value as string);
			notes.push(`more results; page=${a.page + 1}`);
		}
		const items = result.items.filter((item) => allowed(item.relativePath, cwd)) as GrepLine[];
		const body = formatGrep(items);
		return { text: notes.length > 0 ? `${body}\n\n[${notes.join(". ")}]` : body, backend: "fff", total: result.totalMatched, page: a.page };
	}

	type RgEvent = { path: string; line: number; text: string; match: boolean };

	async function grepRg(cwd: string, a: GrepArgs, reason: string): Promise<Reply> {
		const argv = [
			"--no-config", "--no-messages", "--no-require-git", "--json", "--smart-case", "--max-count", "200", "--max-filesize", "1M", "--glob", "!.git",
			...(a.constraint === undefined ? [] : ["--glob", rgGlob(a.constraint)]),
			...(a.context > 0 ? ["-C", String(a.context)] : []),
			...(a.mode === "regex" ? [] : ["--fixed-strings"]),
			"-e", a.pattern, "--", ".",
		];
		const events: RgEvent[] = [];
		const verdicts = new Map<string, boolean>();
		let matches = 0;
		const want = a.page * GREP_LIMIT + 1;
		let run: { code: number | null; stderr: string };
		try {
			run = await runRg(rg, argv, cwd, (line) => {
				let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
				try { event = JSON.parse(line); } catch { return false; }
				if (event.type !== "match" && event.type !== "context") return false;
				const path = event.data?.path?.text;
				const text = event.data?.lines?.text;
				if (path === undefined || text === undefined || event.data?.line_number === undefined) return false;
				const name = shown(path);
				let ok = verdicts.get(name);
				if (ok === undefined) verdicts.set(name, (ok = allowed(name, cwd)));
				if (!ok) return false;
				events.push({ path: name, line: event.data.line_number, text: text.replace(/\r?\n$/u, ""), match: event.type === "match" });
				if (event.type === "match") matches += 1;
				return matches >= want || events.length >= RG_MAX_EVENTS;
			});
		} catch (error) {
			throw unavailable(reason, error);
		}
		if (run.code === 2 && events.length === 0 && run.stderr.trim() !== "") throw new SearchError(/regex|parse error/iu.test(run.stderr) ? "search_invalid_pattern" : "search_rg_failed", run.stderr.trim().split("\n")[0]!);
		const all = events.filter((event) => event.match);
		const page = all.slice((a.page - 1) * GREP_LIMIT, a.page * GREP_LIMIT);
		if (page.length === 0) return { text: "No matches found", backend: "rg", reason, total: 0, page: a.page };
		const chosen = new Map<string, number[]>();
		for (const event of page) chosen.set(event.path, [...(chosen.get(event.path) ?? []), event.line]);
		const lines: string[] = [];
		let current = "";
		for (const event of events) {
			const near = chosen.get(event.path);
			if (near === undefined || !near.some((line) => Math.abs(line - event.line) <= (event.match ? 0 : a.context))) continue;
			if (event.path !== current) {
				if (lines.length > 0) lines.push("");
				current = event.path;
				lines.push(current);
			}
			lines.push(` ${event.line}${event.match ? ":" : "-"} ${truncateLine(event.text)}`);
		}
		const more = all.length > a.page * GREP_LIMIT;
		return { text: more ? `${lines.join("\n")}\n\n[more results; page=${a.page + 1}]` : lines.join("\n"), backend: "rg", reason, total: all.length, page: a.page };
	}

	async function grep(cwd: string, args: { pattern: string; mode?: GrepMode; glob?: string; context?: number; exact?: boolean; page?: number }): Promise<Reply> {
		const a: GrepArgs = { pattern: args.pattern, mode: args.mode ?? "plain", constraint: constraintOf(args.glob, cwd), context: clampContext(args.context), page: args.page ?? 1 };
		if (a.pattern === "") throw new SearchError("search_empty_pattern", "the pattern is empty");
		if (args.exact === true && a.mode === "fuzzy") throw new SearchError("search_exact_fuzzy", "exact search uses ripgrep, which has no fuzzy mode; use mode plain or regex");
		if (a.mode === "regex" && isWildcardOnly(a.pattern)) return { text: `Pattern '${a.pattern}' matches everything; give a concrete word or identifier.`, backend: "fff", total: 0, page: a.page };
		let reason = "exact search";
		if (args.exact !== true) {
			try {
				return await grepFff(cwd, a);
			} catch (error) {
				if (error instanceof SearchError) throw error;
				reason = `${FFF_DOWN}${reasonOf(error)}`;
			}
		}
		return grepRg(cwd, a.mode === "fuzzy" ? { ...a, mode: "plain" } : a, a.mode === "fuzzy" && args.exact !== true ? `${reason}; fuzzy needs fff, so plain matching was used` : reason);
	}

	/* --- tools --- */

	const cwdOf = async (api: ToolExecutionApi): Promise<string> => (await api.snapshot(AgentDoc, api.conversationId, ctx))?.cwd ?? process.cwd();

	const finish = (reply: Reply) => {
		const redacted = redactSensitive(reply.text);
		const text = redacted.length > MAX_OUTPUT_CHARS ? `${redacted.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at ${MAX_OUTPUT_CHARS} characters; narrow the search]` : redacted;
		return {
			output: [{ type: "text" as const, text }],
			details: { backend: reply.backend, page: reply.page, ...(reply.reason === undefined ? {} : { reason: reply.reason }), ...(reply.total === undefined ? {} : { total: reply.total }) },
		};
	};

	const page = Type.Optional(Type.Integer({ minimum: 1, description: "Page number, from 1." }));
	const glob = Type.Optional(Type.String({ description: "Limits the paths: a directory (src/), a file name (main.rs) or a glob (*.ts, src/**/*.ts)." }));

	const findTool = defineTool({
		name: "find",
		description: "Find files by fuzzy path match, most used first. Several words narrow the match. Matches the whole path, not only the file name.",
		parameters: Type.Object({ query: Type.String({ description: "Words from the path." }), glob, page }),
		replay: "safe",
		async execute(args, api) {
			return finish(await find(await cwdOf(api as ToolExecutionApi), args.query, args.glob, args.page ?? 1));
		},
	});

	const grepTool = defineTool({
		name: "grep",
		description: "Search file contents, most used files first. A bare identifier works best. exact: true searches every file with ripgrep and reads the pattern as given.",
		parameters: Type.Object({
			pattern: Type.String(),
			mode: Type.Optional(Type.Union([Type.Literal("plain"), Type.Literal("regex"), Type.Literal("fuzzy")], { description: "Default plain." })),
			glob,
			context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Lines of context around each match." })),
			exact: Type.Optional(Type.Boolean({ description: "Use ripgrep. No time limit and no query syntax." })),
			page,
		}),
		replay: "safe",
		async execute(args, api) {
			return finish(await grep(await cwdOf(api as ToolExecutionApi), args));
		},
	});

	return {
		tools: [findTool, grepTool] as ToolRegistration[],
		close: destroy,
		indexCwd: () => holder?.cwd,
		status: () => probeSearch({ rg, loadFff: deps.loadFff }),
	};
}

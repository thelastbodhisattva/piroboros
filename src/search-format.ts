// Output formatting for find and grep, ported from @ff-labs/pi-fff 0.11.0 (MIT, by dmtrKovalenko; see NOTICE):
// file annotations, compact grep lines, the weak-match detector and the path-constraint normalizer. The
// rules are the same; the types are the structural subset piroboros uses. Native frecency order is kept:
// the source warns that re-sorting only confuses models.
// Definition-first: pi-fff asks the engine to classify definition lines (classifyDefinitions) and does no
// ordering of its own, so piroboros does the same and exposes the flag through the backend.

import { isAbsolute, relative, sep } from "node:path";

export const GREP_MAX_LINE_LENGTH = 500;
export const GREP_CONTEXT_MAX = 20;
export const FIND_WEAK_SAMPLE_SIZE = 5;
const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

export interface FileLike {
	gitStatus?: string;
	totalFrecencyScore?: number;
	accessFrecencyScore?: number;
}

export interface GrepLine extends FileLike {
	relativePath: string;
	lineNumber: number;
	lineContent: string;
	contextBefore?: string[];
	contextAfter?: string[];
}

export function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
	const trimmed = line.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)} [cut]`;
}

/** A non-negative whole number no larger than the cap, so a large value cannot multiply the output. */
export function clampContext(context: number | undefined): number {
	if (!context || context < 0) return 0;
	return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

/** At most one tag per file. A file with uncommitted changes outranks a frequently used one. */
export function fileAnnotation(item: FileLike): string {
	const git = item.gitStatus;
	if (git && git !== "clean" && git !== "unknown" && git !== "") return `  [${git} in git]`;
	const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
	if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
	if (frecency >= WARM_FRECENCY) return "  [often touched file]";
	return "";
}

/** Matches grouped by file in the order the engine returned them; context lines use `-`, match lines use `:`. */
export function formatGrep(items: readonly GrepLine[]): string {
	if (items.length === 0) return "No matches found";
	const lines: string[] = [];
	let current = "";
	for (const match of items) {
		if (match.relativePath !== current) {
			if (lines.length > 0) lines.push("");
			current = match.relativePath;
			lines.push(`${current}${fileAnnotation(match)}`);
		}
		const before = match.contextBefore ?? [];
		before.forEach((line, i) => lines.push(` ${match.lineNumber - before.length + i}- ${truncateLine(line)}`));
		lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);
		(match.contextAfter ?? []).forEach((line, i) => lines.push(` ${match.lineNumber + 1 + i}- ${truncateLine(line)}`));
	}
	return lines.join("\n");
}

/** A perfect match scores 12 per query character in the engine; under half of that is scattered fuzzy noise. */
export const weakScoreThreshold = (query: string): number => Math.floor((query.length * 12 * 50) / 100);

export interface FormattedFind {
	output: string;
	weak: boolean;
	shown: number;
}

/** Both backends skip what .gitignore lists, so an empty result must not read as "the file does not exist". */
export const NO_FILES_FOUND = "No files found. Paths ignored by .gitignore, such as node_modules, were not searched.";

/** A weak top score trims the list to a small sample instead of filling the context with noise. */
export function formatFind(items: readonly (FileLike & { relativePath: string })[], topScore: number, limit: number, query: string): FormattedFind {
	if (items.length === 0) return { output: NO_FILES_FOUND, weak: false, shown: 0 };
	const weak = topScore < weakScoreThreshold(query);
	const shown = items.slice(0, weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit);
	return { output: shown.map((item) => `${item.relativePath}${fileAnnotation(item)}`).join("\n"), weak, shown: shown.length };
}

/** A pattern made only of wildcards matches every line. */
export const isWildcardOnly = (pattern: string): boolean => /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/u.test(pattern.trim());

/**
 * Turn a path or glob argument into the constraint syntax the fff query parser reads. A path inside the working
 * directory becomes relative; one outside it is refused. Returns undefined for "the whole tree".
 */
export function normalizeConstraint(value: string, cwd: string): string | undefined {
	let text = value.trim();
	if (text === "") return undefined;
	if (isAbsolute(text)) {
		const rel = relative(cwd, text).split(sep).join("/");
		if (rel === "") return undefined;
		if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) throw new Error(`glob must stay inside the working directory: ${value}`);
		text = rel;
	}
	if (text === "." || text === "./") return undefined;
	if (text.startsWith("./")) text = text.slice(2);
	if (text === "**" || text === "**/" || text === "**/*") return undefined;
	// a trailing recursive directory glob means "inside this directory"
	const dir = /^(.*)\/\*\*(?:\/\*)?$/u.exec(text)?.[1];
	if (dir && !/[*?[{]/u.test(dir)) return `${dir}/`;
	if (text.startsWith("/") || text.endsWith("/")) return text;
	if (/[*?[{]/u.test(text)) return text;
	if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/u.test(text.split("/").pop() ?? "")) return text;
	return `${text}/`;
}

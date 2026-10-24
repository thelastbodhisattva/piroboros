// The merge decision model of a Workspace: per path, what the merge does with Vesperia's version (ours), the live version
// (theirs) and the version both started from (base). Ported from the LayerFS decision model (model.js merge3Lines and
// merge3Trees, MIT; credited in NOTICE), not its filesystem. Pure functions over bytes; nothing here touches disk.

import { diffChunks } from "../diff.ts";
import { lwwMatch, type LwwRule } from "./lww.ts";

export const TEXT_MAX = 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Text for line merging: at most TEXT_MAX, no NUL in the first 8 KiB, valid UTF-8. A BOM stays in the text. */
export function isText(bytes: Uint8Array): boolean {
	if (bytes.length > TEXT_MAX || bytes.subarray(0, 8192).includes(0)) return false;
	try { decoder.decode(bytes); return true; } catch { return false; }
}

/** Lines that keep their terminators (`\r\n`, `\n`, or none on the last line); nothing is normalized. */
export function splitLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

export interface Hunk {
	line: number;
	ours: string[];
	theirs: string[];
}

// For each line of `a`, the index of the matching line of `b` (or -1); null when the diff is refused. The diff runs from
// `b` to `a`, so its tie-break between equal-length alignments is the one model.js's matchLines has.
function matchLines(a: string[], b: string[]): number[] | null {
	const ops = diffChunks(b, a);
	if (!ops) return null;
	const m = new Array<number>(a.length).fill(-1);
	let i = 0;
	let j = 0;
	for (const op of ops) {
		if (op === " ") { m[i] = j; i += 1; j += 1; } else if (op === "+") i += 1; else j += 1;
	}
	return m;
}

/**
 * Line merge: a chunk between lines unchanged on both sides takes the side that changed it, a chunk both sides changed
 * identically is taken once, and both changing it differently is a conflict block with marker lines. Marker lines end
 * with the dominant terminator of `ours`. Null when a diff is refused as too large (the caller makes a `content` conflict).
 */
export function merge3Lines(base: string, ours: string, theirs: string, labels: [string, string]): { text: string; hunks: Hunk[] } | null {
	const b = splitLines(base);
	const o = splitLines(ours);
	const t = splitLines(theirs);
	const mo = matchLines(b, o);
	const mt = matchLines(b, t);
	if (!mo || !mt) return null;
	const crlf = o.filter((l) => l.endsWith("\r\n")).length;
	const eol = crlf > o.filter((l) => l.endsWith("\n")).length - crlf ? "\r\n" : "\n";
	const out: string[] = [];
	const hunks: Hunk[] = [];
	let bi = 0;
	let oi = 0;
	let ti = 0;
	const eq = (x: string[], y: string[]): boolean => x.length === y.length && x.every((v, k) => v === y[k]);
	// A block's last line without a terminator gets one, so the next marker starts a line.
	const closed = (ls: string[]): string[] => (ls.length > 0 && !ls[ls.length - 1]!.endsWith("\n") ? [...ls.slice(0, -1), ls[ls.length - 1]! + eol] : ls);
	const chunk = (be: number, oe: number, te: number): void => {
		const cb = b.slice(bi, be);
		const co = o.slice(oi, oe);
		const ct = t.slice(ti, te);
		if (eq(co, cb)) out.push(...ct);
		else if (eq(ct, cb) || eq(co, ct)) out.push(...co);
		else {
			hunks.push({ line: out.length + 1, ours: co, theirs: ct });
			out.push(`<<<<<<< ${labels[0]}${eol}`, ...closed(co), `=======${eol}`, ...closed(ct), `>>>>>>> ${labels[1]}${ct.length > 0 && !ct[ct.length - 1]!.endsWith("\n") ? "" : eol}`);
		}
	};
	for (let k = 0; k < b.length; k += 1) {
		if (mo[k]! < 0 || mt[k]! < 0 || mo[k]! < oi || mt[k]! < ti) continue;
		chunk(k, mo[k]!, mt[k]!);
		out.push(b[k]!);
		bi = k + 1;
		oi = mo[k]! + 1;
		ti = mt[k]! + 1;
	}
	chunk(b.length, o.length, t.length);
	return { text: out.join(""), hunks };
}

/** One side of a path: its bytes, "dir" for a directory, undefined when absent. */
export type Side = Uint8Array | "dir" | undefined;

export type ConflictKind = "content" | "add/add" | "modify/delete" | "delete/modify" | "type" | "binary";

export type Decision =
	/** Nothing to write: the live path already holds the result. `lww` names a rule that kept the live side. */
	| { op: "skip"; lww?: { rule: string; kept: "theirs" } }
	/** Write ours (delete the live path when ours is absent). `lww` names a rule that kept ours. */
	| { op: "ours"; lww?: { rule: string; kept: "ours" } }
	/** A clean line merge; write this text. */
	| { op: "merged"; text: string }
	/** A conflict. `text` is the merged text with markers and `hunks` its blocks, for a `content` or `add/add` conflict a diff did not refuse. */
	| { op: "conflict"; kind: ConflictKind; text?: string; hunks?: Hunk[] };

export interface DecideOptions {
	labels: [string, string];
	/** The parsed .lww rules and the modification times in integer milliseconds; a deleted live path has no time, so use -Infinity. */
	lww?: { rules: LwwRule[]; ours: number; theirs: number };
}

const same = (x: Side, y: Side): boolean =>
	x === y || (x instanceof Uint8Array && y instanceof Uint8Array && Buffer.compare(x, y) === 0);

/**
 * The decision for one path that ours changed relative to base. In order: equal sides need nothing; live unchanged takes
 * ours; a file against a directory is `type`; an `.lww` rule takes the side modified later (ours on a tie); a deletion
 * against a modification is `modify/delete` or `delete/modify`; text within bounds is line merged (`add/add` when there
 * is no base); anything else is `binary`.
 */
export function decide(path: string, base: Side, ours: Side, theirs: Side, opts: DecideOptions): Decision {
	if (same(ours, theirs)) return { op: "skip" };
	if (same(theirs, base)) return { op: "ours" };
	const file = (s: Side): s is Uint8Array => s instanceof Uint8Array;
	if ((file(ours) && theirs === "dir") || (ours === "dir" && file(theirs))) return { op: "conflict", kind: "type" };
	const rule = opts.lww && lwwMatch(opts.lww.rules, path);
	if (rule && opts.lww) {
		return opts.lww.ours >= opts.lww.theirs ? { op: "ours", lww: { rule: rule.pattern, kept: "ours" } } : { op: "skip", lww: { rule: rule.pattern, kept: "theirs" } };
	}
	if (ours === undefined) return { op: "conflict", kind: "delete/modify" };
	if (theirs === undefined) return { op: "conflict", kind: "modify/delete" };
	if (file(ours) && file(theirs) && isText(ours) && isText(theirs) && (base === undefined || (file(base) && isText(base)))) {
		const m = merge3Lines(base === undefined ? "" : decoder.decode(base), decoder.decode(ours), decoder.decode(theirs), opts.labels);
		const kind = base === undefined ? "add/add" : "content";
		if (!m) return { op: "conflict", kind: "content" };
		return m.hunks.length === 0 ? { op: "merged", text: m.text } : { op: "conflict", kind, text: m.text, hunks: m.hunks };
	}
	return { op: "conflict", kind: "binary" };
}

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";

// Path helpers shared by the home validator (config.ts) and the guard. No pi imports.

const WINDOWS = process.platform === "win32";

/** Names that make a path unsafe to evaluate. Returned instead of throwing so callers can fail closed. */
export class PathRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathRefused";
	}
}

function realNative(path: string): string {
	return realpathSync.native(path);
}

/**
 * Canonical form used for every containment test: absolute, with the nearest existing ancestor resolved
 * through the filesystem (links, junctions and 8.3 names) and the remaining tail re-joined. The tail does
 * not need to exist, so deny roots that are absent on this machine still work.
 *
 * Refused (PathRefused): alternate data stream syntax, UNC paths other than local admin shares, and
 * device paths other than the `\\?\` drive form.
 */
export function canonicalize(input: string, cwd: string = process.cwd()): string {
	if (typeof input !== "string" || input.length === 0 || input.includes("\0")) throw new PathRefused("empty or invalid path");
	let value = input;
	if (WINDOWS) {
		if (/^\\\\[?.]\\UNC\\/iu.test(value)) value = `\\\\${value.slice(8)}`;
		else if (/^\\\\[?.]\\[a-z]:/iu.test(value)) value = value.slice(4);
		else if (/^\\\\[?.]\\/u.test(value)) throw new PathRefused("device path refused");
		value = value.replace(/^\/\/[?.]\//u, "");
		const unc = /^[\\/]{2}([^\\/]+)[\\/]+([a-z])\$(?:[\\/]|$)/iu.exec(value);
		if (/^[\\/]{2}[^\\/]/u.test(value)) {
			if (unc === null || !isLocalHost(unc[1]!)) throw new PathRefused("UNC path refused");
			value = `${unc[2]!.toUpperCase()}:${value.slice(unc[0].length - 1)}`;
		}
		// An alternate data stream (`file:stream`) or a colon anywhere but the drive letter.
		if (value.replace(/^[a-z]:/iu, "").includes(":")) throw new PathRefused("alternate data stream syntax refused");
	}
	let absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
	if (WINDOWS) absolute = win32.normalize(absolute).split(win32.sep).map(stripTrailing).join(win32.sep);
	// Resolve the nearest existing ancestor through the filesystem, then re-join the tail.
	let head = absolute;
	const tail: string[] = [];
	while (!existsSyncSafe(head)) {
		const parent = dirname(head);
		if (parent === head) break;
		tail.unshift(parse(head).base);
		head = parent;
	}
	let base = head;
	try {
		base = existsSyncSafe(head) ? realNative(head) : head;
	} catch {
		throw new PathRefused("path could not be resolved");
	}
	return tail.length === 0 ? base : join(base, ...tail);
}

function existsSyncSafe(path: string): boolean {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}

/** Windows ignores trailing dots and spaces on a path component. */
function stripTrailing(component: string): string {
	if (component === "." || component === ".." || component === "") return component;
	const stripped = component.replace(/[. ]+$/u, "");
	return stripped.length === 0 ? component : stripped;
}

function isLocalHost(name: string): boolean {
	const n = name.toLowerCase();
	return n === "localhost" || n === "127.0.0.1" || n === "::1" || n === (process.env.COMPUTERNAME ?? "").toLowerCase();
}

const fold = (value: string): string => (WINDOWS ? value.toLowerCase() : value);

/** True when `candidate` is `root` or lies below it. Both must already be canonical. */
export function isInside(root: string, candidate: string): boolean {
	const rel = relative(fold(root), fold(candidate));
	if (rel === "") return true;
	if (isAbsolute(rel)) return false; // another drive
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Case-insensitive path equality on canonical paths. */
export function samePath(a: string, b: string): boolean {
	return fold(a) === fold(b);
}

/** Segments of a canonical path, folded for comparison. */
export function segments(path: string): string[] {
	return fold(path).split(/[\\/]+/u).filter((part) => part.length > 0);
}

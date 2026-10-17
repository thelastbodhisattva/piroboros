import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalize, isInside } from "./paths.ts";

// Undo store for a Vesperia run (P13a). Before a write or edit by Vesperia, the guard saves the file's bytes under
// ${home}/undo/<vesperia conversation id>/. One JSON and one .bin per path, named by the hash of the guard's folded
// path key. The copies are exact: they are never redacted, so they may hold secrets that were already in the file.
// Only the latest run is kept. Whether a path was captured already is decided by the JSON on disk, never by memory.
// Changes made through bash are not captured; the bash calls are only counted.

export const FILE_CAP = 1_048_576;
export const RUN_CAP = 20 * 1_048_576;

export interface UndoRecord {
	path: string;
	cwd: string;
	existed: boolean;
	preHash?: string;
	postHash?: string;
	size?: number;
	notRestorable?: string;
}

const sha = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const nameOf = (key: string): string => sha(key);
const root = (home: string): string => join(home, "undo");
const dirOf = (home: string, run: number): string => join(root(home), String(run));

/** Make the run's folder. The first time a new run appears, every other run's folder is deleted. Vesperia's start calls it, so a run that writes nothing still replaces the older folder. */
export function ensureRun(home: string, run: number): string {
	const dir = dirOf(home, run);
	if (!existsSync(dir)) {
		try {
			for (const other of readdirSync(root(home))) if (other !== String(run)) rmSync(join(root(home), other), { recursive: true, force: true });
		} catch { /* no undo folder yet */ }
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	return dir;
}

const runBytes = (dir: string): number => {
	let total = 0;
	for (const name of readdirSync(dir)) if (name.endsWith(".bin")) total += statSync(join(dir, name)).size;
	return total;
};

/** Save the pre-image of `path` (canonical) unless this run already has one. Throws only on a storage error; the guard fails open. */
export function capture(home: string, run: number, key: string, path: string, cwd: string): void {
	const dir = ensureRun(home, run);
	const json = join(dir, `${nameOf(key)}.json`);
	const bin = join(dir, `${nameOf(key)}.bin`);
	if (existsSync(json)) return;
	const record: UndoRecord = { path, cwd, existed: false };
	let bytes: Buffer | undefined;
	let info;
	try { info = statSync(path); } catch { info = undefined; }
	if (info !== undefined) {
		record.existed = true;
		record.size = info.size;
		if (!info.isFile()) record.notRestorable = "not a regular file";
		else if (info.size > FILE_CAP) record.notRestorable = "larger than 1 MB";
		else if (runBytes(dir) + info.size > RUN_CAP) record.notRestorable = "the run's copies reached 20 MB";
		else {
			try {
				bytes = readFileSync(path);
				record.preHash = sha(bytes);
				record.size = bytes.length;
			} catch { record.notRestorable = "could not be read"; }
		}
	}
	// The JSON is the marker: a .bin without one is a crashed capture, and the write has not happened yet.
	rmSync(bin, { force: true });
	if (bytes !== undefined) writeFileSync(bin, bytes, { flag: "wx", mode: 0o600 });
	try { writeFileSync(json, JSON.stringify(record), { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

/** After a failed capture: a JSON-only record so the undo preview still lists the file. Throws when even that cannot be stored. */
export function captureLost(home: string, run: number, key: string, path: string, cwd: string, error: unknown): void {
	const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
	const record: UndoRecord = { path, cwd, existed: existsSync(path), notRestorable: `the copy could not be saved: ${code}` };
	try { writeFileSync(join(ensureRun(home, run), `${nameOf(key)}.json`), JSON.stringify(record), { flag: "wx", mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
}

/** The hash Vesperia left behind; the last write wins. Nothing happens for a path that was not captured. */
export function recordPost(home: string, run: number, key: string, postHash: string): void {
	const json = join(dirOf(home, run), `${nameOf(key)}.json`);
	if (!existsSync(json)) return;
	const record = JSON.parse(readFileSync(json, "utf8")) as UndoRecord;
	record.postHash = postHash;
	writeFileSync(json, JSON.stringify(record), { mode: 0o600 });
}

/** Count one shell call of the run. An append is one step, so parallel calls do not lose counts. */
export function countBash(home: string, run: number): void {
	appendFileSync(join(ensureRun(home, run), "bash.count"), "x", { mode: 0o600 });
}

export interface RunFolder { run: number; records: UndoRecord[]; bash: number }

/** The stored run, or undefined when there is none. */
export function loadRun(home: string): RunFolder | undefined {
	let runs: number[];
	try { runs = readdirSync(root(home)).filter((name) => /^\d+$/u.test(name)).map(Number).sort((a, b) => b - a); } catch { return undefined; }
	const run = runs[0];
	if (run === undefined) return undefined;
	const dir = dirOf(home, run);
	const records: UndoRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try { records.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as UndoRecord); } catch { /* a damaged record is not listed; the undo cannot trust it */ }
	}
	let bash = 0;
	try { bash = statSync(join(dir, "bash.count")).size; } catch { /* none */ }
	return { run, records, bash };
}

export type Verdict =
	| { kind: "restore" | "delete" | "unchanged" | "changed" }
	| { kind: "skip"; reason: string };
export type Entry = { record: UndoRecord; verdict: Verdict };

const hashOf = (path: string): string | undefined => {
	try { return lstatSync(path).isFile() ? sha(readFileSync(path)) : undefined; } catch { return undefined; }
};

/** What an undo would do with one record. Nothing stored is trusted: the path is checked again and the copy is hashed again. */
export function assess(home: string, run: number, record: UndoRecord, allowed: (path: string, cwd: string) => boolean): Verdict {
	if (record.notRestorable !== undefined) return { kind: "skip", reason: record.notRestorable };
	let target: string;
	try {
		target = canonicalize(record.path, record.cwd);
		if (target !== record.path) return { kind: "skip", reason: "the path no longer resolves to the stored one" };
		if (!isInside(canonicalize(record.cwd), target)) return { kind: "skip", reason: "outside the run's working directory" };
	} catch { return { kind: "skip", reason: "the path could not be evaluated" }; }
	if (!allowed(target, record.cwd)) return { kind: "skip", reason: "the path is protected" };
	if (record.existed) {
		const bin = join(dirOf(home, run), `${nameOf(process.platform === "win32" ? target.toLowerCase() : target)}.bin`);
		let bytes: Buffer;
		try { bytes = readFileSync(bin); } catch { return { kind: "skip", reason: "the saved copy is missing" }; }
		if (sha(bytes) !== record.preHash) return { kind: "skip", reason: "the saved copy is damaged" };
	}
	let current: string | undefined;
	try { lstatSync(target); current = hashOf(target) ?? "?"; } catch { current = undefined; }
	if (record.existed) {
		if (current === record.preHash) return { kind: "unchanged" };
		return current !== undefined && current === record.postHash ? { kind: "restore" } : { kind: "changed" };
	}
	if (current === undefined) return { kind: "unchanged" };
	return current === record.postHash ? { kind: "delete" } : { kind: "changed" };
}

export const plan = (home: string, folder: RunFolder, allowed: (path: string, cwd: string) => boolean): Entry[] =>
	folder.records.map((record) => ({ record, verdict: assess(home, folder.run, record, allowed) }));

const list = (title: string, paths: readonly string[]): string[] => (paths.length === 0 ? [] : [`${title} (${paths.length}):`, ...paths.map((path) => `  ${path}`)]);
const bashLine = (bash: number): string => (bash === 0 ? "Vesperia ran no shell commands." : `Vesperia ran ${bash} shell command${bash === 1 ? "" : "s"}; changes made through bash are not covered.`);
const MEMORY_LINE = "Vesperia's decision memory, if any, stays quarantined until you run /akashic accept; there is no reject command.";

const pick = (entries: readonly Entry[], kind: string): string[] => entries.filter((e) => e.verdict.kind === kind).map((e) => e.record.path);
const skipped = (entries: readonly Entry[]): string[] => entries.flatMap((e) => (e.verdict.kind === "skip" ? [`${e.record.path} (${e.verdict.reason})`] : []));

/** The list shown before anything is touched. */
export function preview(entries: readonly Entry[], bash: number): string {
	return [
		"Undo of the last Vesperia run. Only write and edit changes are covered.",
		...list("Files to restore", pick(entries, "restore")),
		...list("Files to delete (created by the run)", pick(entries, "delete")),
		...list("Skipped, changed since the run", pick(entries, "changed")),
		...list("Not restorable", skipped(entries)),
		...list("Already as before the run", pick(entries, "unchanged")),
		bashLine(bash),
		MEMORY_LINE,
	].join("\n");
}

/** Do the restores and deletions, each one assessed again just before it runs. Returns the report and whether anything was restored. */
export function apply(home: string, folder: RunFolder, allowed: (path: string, cwd: string) => boolean): { text: string; restored: boolean } {
	const done: Entry[] = [];
	const failed: string[] = [];
	const dirs = new Set<string>();
	for (const { record } of plan(home, folder, allowed)) {
		// Assessed again here, after the user confirmed, so a change in between is caught.
		const verdict = assess(home, folder.run, record, allowed);
		try {
			if (verdict.kind === "restore") writeFileSync(record.path, readFileSync(join(dirOf(home, folder.run), `${nameOf(process.platform === "win32" ? record.path.toLowerCase() : record.path)}.bin`)));
			else if (verdict.kind === "delete") { unlinkSync(record.path); dirs.add(dirname(record.path)); }
		} catch (error) {
			failed.push(`${record.path} (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		done.push({ record, verdict });
	}
	const left = [...dirs].filter((dir) => { try { return readdirSync(dir).length === 0; } catch { return false; } });
	if (failed.length === 0) rmSync(dirOf(home, folder.run), { recursive: true, force: true });
	return {
		restored: done.some((e) => e.verdict.kind === "restore" || e.verdict.kind === "delete"),
		text: [
			"Undo finished.",
			...list("Restored", pick(done, "restore")),
			...list("Deleted", pick(done, "delete")),
			...list("Failed", failed),
			...(failed.length === 0 ? [] : ["Run /conclave undo again to retry the failed files."]),
			...list("Skipped, changed since the run", pick(done, "changed")),
			...list("Not restorable", skipped(done)),
			...list("Already as before the run", pick(done, "unchanged")),
			...list("Empty folders left in place", left),
			bashLine(folder.bash),
			MEMORY_LINE,
		].join("\n"),
	};
}

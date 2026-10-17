import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AgentDoc, createEditTool, createReadTool, createWriteTool, createBashTool, ctx, defineExtension, hook, isTaskLive, ROOT, ToolTask, wrapTool,
	type BashPrepare, type Extension, type HarnessType, type HookApi, type ToolRegistration,
} from "./durable.ts";
import { canonicalize, isInside, PathRefused, samePath } from "./paths.ts";
import { clipShellOutput } from "./shell.ts";
import { capture, captureLost, countBash, recordPost } from "./undo.ts";

// guard: the extension that mediates every file tool and every shell call, in every conversation.
// It is selected first in every conversation, so its wraps and hooks apply before anything else.
//
// - read/write/edit: the target path is canonicalized (links, junctions, 8.3 names resolved) and compared,
//   case-insensitively, with the hard-deny roots. Deny roots are resolved on every check, so a root that
//   appears later is still honored, and an absent root never throws.
// - basename rules: .env, .env.local and .env.*.local are denied anywhere. .envrc and env.ts are not.
// - read exception (checkRead, the read tool only): files under <home>/skills may be read, secret names excepted.
//   write, edit, find and grep, and every other deny root, keep the strict checkPath.
// - shell: only an allowlisted environment reaches the child, and every call carries a timeout no larger
//   than shellTimeoutMs (the guard is the only place that rewrites tool arguments).
// - read before write: write and edit to an existing file are refused unless this conversation read it and the
//   content is unchanged since. The map (conversation, path) -> content hash lives in memory, so a restart means
//   the model reads again. A new file needs no read. Files changed by a bash command are not tracked: bash is
//   not confined by the guard beyond its environment, timeout and writer rules.
// - writers: only the root, while no pipeline is live, or the recorded Vesperia child may write or run a
//   shell. Liveness comes from the task record and fails closed.

export interface GuardConfig {
	/** PIROBOROS_HOME; denied together with everything under it. */
	home: string;
	/** The user profile; ~/.pi, ~/.ssh and ~/.claude are denied. */
	profile?: string;
	/** settings.guard.deny. */
	deny: readonly string[];
	/** Cap for every shell call, in milliseconds. */
	shellTimeoutMs: number;
	/** settings.shellEnvAllow, added to the built-in allowlist. */
	shellEnvAllow: readonly string[];
}

export interface PipelineState {
	/** Task id of the live Conclave pipeline, if the `conclave` doc records one. */
	taskId?: string;
	/** Conversation id of the recorded Vesperia child. */
	vesperia?: number;
}

export interface GuardDeps {
	/** Read on every check, so /reload can replace the configuration. */
	config(): GuardConfig;
	/** Reads the recorded pipeline; undefined means none. A throw is treated as a live pipeline. */
	pipeline?(): Promise<PipelineState | undefined>;
	/** True while the root's turn was started by Conclave reports alone (F3). A throw blocks, like any unreadable state. */
	reportOnly?(): Promise<boolean>;
	/** One-line notice to the user (the runtime's notice channel); used when the undo store fails. */
	warn?(message: string): void;
}

const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash"]);
const PATH_TOOLS = new Set(["read", "write", "edit"]);

// Variables a bash child may inherit. Everything else, including every secret, is dropped.
//  PATH: finds programs. HOME, USER, LOGNAME: identity that tools like git expect. LANG, LC_ALL: text encoding.
//  TMPDIR: scratch space on Linux and macOS.
export const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"] as const;
//  Windows only. SystemRoot: Windows programs and Git Bash will not start without it. TEMP, TMP: scratch space.
//  USERPROFILE: Git Bash derives HOME from it when HOME is unset.
export const ENV_ALLOW_WINDOWS = ["SystemRoot", "TEMP", "TMP", "USERPROFILE"] as const;
// Always set: colors off, so tool output reads as plain text.
const ENV_FIXED = { NO_COLOR: "1", TERM: "dumb" } as const;

const ENV_BASENAME = [/^\.env$/iu, /^\.env\.local$/iu, /^\.env\..+\.local$/iu];

export function denyRoots(config: GuardConfig): string[] {
	const profile = config.profile ?? homedir();
	return [config.home, join(profile, ".pi"), join(profile, ".ssh"), join(profile, ".claude"), ...config.deny];
}

// A verb counts when no word character or hyphen touches it on either side, so `skill`, `killer` and `kill-port` pass
// while `kill -9`, `/bin/kill` and `taskkill.exe` match. Even `echo kill` is blocked: simple beats exact here.
const KILL_VERB = /(?<![\w-])(?:taskkill|tskill|stop-process|spps|pkill|killall|kill)(?![\w-])/iu;
const WMIC_KILL = /\bwmic\b[^\n]*\bprocess\b[^\n]*\b(?:delete|terminate)\b/iu;

/**
 * True for a shell command that kills processes. This is a tripwire against accidents (taskkill /IM node.exe would
 * end piroboros and every other node process), not confinement: bash is not sandboxed and can be worded around it.
 */
export function killsProcess(command: unknown): boolean {
	return typeof command === "string" && (KILL_VERB.test(command) || WMIC_KILL.test(command));
}

export interface PathVerdict {
	allowed: boolean;
	reason?: string;
}

// Names that never open under the read exception for <home>/skills, whatever folder they sit in.
const SECRET_BASENAME = [...ENV_BASENAME, /\.(?:pem|key|p12|pfx|kdbx)$/iu, /^id_(?:rsa|ed25519|ecdsa)/iu, /\.sqlite/iu, /^(?:auth\.json|\.netrc|\.npmrc)$/iu];

/** True when a read of `target` (canonical) falls under the home exception: inside the real <home>/skills, and not a secret name. */
function homeSkillsRead(target: string, base: string, config: GuardConfig): boolean {
	// The canonical skills folder must be exactly <home>/skills: a link or junction that points it elsewhere opens nothing.
	const skills = canonicalize(join(config.home, "skills"));
	return samePath(skills, join(canonicalize(config.home), "skills")) && isInside(skills, target) && !SECRET_BASENAME.some((pattern) => pattern.test(base));
}

function evaluate(path: unknown, cwd: string | undefined, config: GuardConfig, read: boolean): PathVerdict {
	try {
		if (typeof path !== "string") return { allowed: false, reason: "the path argument is missing or not text" };
		const target = canonicalize(path, cwd);
		const base = target.split(/[\\/]/u).pop() ?? "";
		if (ENV_BASENAME.some((pattern) => pattern.test(base))) return { allowed: false, reason: "environment files (.env) are not accessible to tools" };
		for (const [at, root] of denyRoots(config).entries()) {
			let canonicalRoot: string;
			try {
				canonicalRoot = canonicalize(root);
			} catch {
				return { allowed: false, reason: "a protected location could not be evaluated" };
			}
			// The exception is for the home root only (the first deny root), per root: every other deny root still refuses a path inside it.
			if (isInside(canonicalRoot, target) && !(read && at === 0 && homeSkillsRead(target, base, config))) return { allowed: false, reason: "that location holds credentials or application data and is protected" };
		}
		return { allowed: true };
	} catch (error) {
		return { allowed: false, reason: error instanceof PathRefused ? `path refused: ${error.message}` : "the path could not be evaluated" };
	}
}

/** Decide whether a tool may touch `path`. Any failure to evaluate the path is a refusal. */
export function checkPath(path: unknown, cwd: string | undefined, config: GuardConfig): PathVerdict {
	return evaluate(path, cwd, config, false);
}

/** checkPath for reading: also allows files under <home>/skills (the user's installed skills), secrets excluded. Writes never use it. */
export function checkRead(path: unknown, cwd: string | undefined, config: GuardConfig): PathVerdict {
	return evaluate(path, cwd, config, true);
}

/** The environment a shell child receives: the allowlist only, nothing inherited. */
export function shellEnv(config: GuardConfig, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const names = [...ENV_ALLOW, ...(process.platform === "win32" ? ENV_ALLOW_WINDOWS : []), ...config.shellEnvAllow];
	const env: Record<string, string> = {};
	for (const name of names) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	return { ...env, ...ENV_FIXED };
}

const hashFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

export interface Guard {
	extension: Extension;
	/** Provide the opened harness, which the liveness check reads task records through. */
	bindHarness(harness: Pick<HarnessType, "getTask">): void;
	shellPrepare: BashPrepare;
	/** The current guard configuration; /conclave undo reads the home and the path rules from it. */
	config(): GuardConfig;
	/** The base tools, built so that the shell tool takes its environment from this guard. */
	tools(): ToolRegistration[];
}

// Bounds on the read records. Dropping one only means a later write asks for a fresh read, so it fails closed.
export const MAX_PATHS = 2_000;
export const MAX_CONVERSATIONS = 64;
export const MAX_PENDING = 256;

/** Drop the oldest entries of a Map until at most `max` remain. */
export function trim(map: Map<unknown, unknown>, max: number): void {
	for (const key of map.keys()) {
		if (map.size <= max) return;
		map.delete(key);
	}
}

export function createGuard(deps: GuardDeps): Guard {
	let harness: Pick<HarnessType, "getTask"> | undefined;
	// conversation -> path key -> content hash at the last read or own write
	const seen = new Map<number, Map<string, string>>();
	// hash taken before a read runs, recorded only if the read succeeds, so a change during the read is caught later
	const pending = new Map<string, { id: number; key: string; hash: string }>();
	const keyOf = (path: unknown, cwd: string | undefined): string => {
		const key = canonicalize(String(path), cwd);
		return process.platform === "win32" ? key.toLowerCase() : key;
	};
	const hashIfFile = (path: string): string | undefined => {
		try { return statSync(path).isFile() ? hashFile(path) : undefined; } catch { return undefined; }
	};
	const remember = (id: number, key: string, hash: string): void => {
		const map = seen.get(id) ?? new Map<string, string>();
		seen.delete(id);
		seen.set(id, map); // most recently used last
		map.delete(key);
		map.set(key, hash);
		trim(map, MAX_PATHS);
		trim(seen, MAX_CONVERSATIONS);
	};
	/** Why a write or edit to this path must wait for a read; undefined when it may go ahead. */
	const readFirst = (id: number, path: unknown, cwd: string | undefined): string | undefined => {
		const target = canonicalize(String(path), cwd);
		let isFile = false;
		try { isFile = statSync(target).isFile(); } catch { return undefined; } // does not exist: a new file
		if (!isFile) return undefined;
		const known = seen.get(id)?.get(keyOf(path, cwd));
		if (known === undefined) return "that file exists and has not been read in this conversation; read it first";
		return hashIfFile(target) === known ? undefined : "that file changed since it was read; read it again";
	};

	/** True when the recorded Vesperia child is this conversation. An unreadable record means no. */
	const isVesperia = async (id: number): Promise<boolean> => {
		try { return (await deps.pipeline?.())?.vesperia === id; } catch { return false; }
	};

	const writerDenied = async(conversationId: number): Promise<string | undefined> => {
		let state: PipelineState | undefined;
		try {
			state = deps.pipeline ? await deps.pipeline() : undefined;
		} catch {
			return "the Conclave state could not be read, so writes are paused (fail closed)";
		}
		if (state?.vesperia !== undefined && conversationId === state.vesperia) return undefined;
		if (conversationId !== ROOT) return "only the root conversation or the Vesperia child may write or run commands";
		if (state?.taskId !== undefined) {
			if (harness === undefined) return "the guard is not bound to a harness, so a live Conclave pipeline cannot be ruled out";
			if (await isTaskLive(harness, state.taskId)) return "a Conclave pipeline is running; use /conclave cancel to stop it before writing from the root";
		}
		// F3: reports are untrusted data. A turn made only of reports may not write or run commands until the user sends something.
		try {
			if (deps.reportOnly && (await deps.reportOnly())) return "this turn was started by Conclave reports, which are untrusted data; send a message to allow writes and commands";
		} catch {
			return "the turn's origin could not be read, so writes are paused (fail closed)";
		}
		return undefined;
	};

	// Child conversations (Conclave members) may only touch files under their working directory.
	const contained = (path: unknown, cwd: string | undefined): PathVerdict => {
		try {
			if (cwd === undefined || cwd === "") return { allowed: false, reason: "this conversation has no working directory, so file access is refused" };
			if (typeof path !== "string") return { allowed: false, reason: "the path argument is missing or not text" };
			return isInside(canonicalize(cwd), canonicalize(path, cwd)) ? { allowed: true } : { allowed: false, reason: "this conversation may only touch files under its working directory" };
		} catch {
			return { allowed: false, reason: "the path could not be evaluated" };
		}
	};

	const shellPrepare: BashPrepare = (execution) => {
		execution.inheritEnv = false;
		execution.env = shellEnv(deps.config());
	};

	const beforeTool = async (call: { name: string; id?: string; arguments: unknown }, api: HookApi) => {
		const config = deps.config();
		const args = (call.arguments ?? {}) as Record<string, unknown>;
		const id = api.conversationId as number;
		let cwd: string | undefined;
		if (PATH_TOOLS.has(call.name)) {
			try { cwd = (await api.snapshot(AgentDoc, api.conversationId, ctx))?.cwd; } catch { cwd = undefined; }
			const verdict = call.name === "read" ? checkRead(args.path, cwd, config) : checkPath(args.path, cwd, config);
			if (!verdict.allowed) return { block: `blocked by guard: ${verdict.reason}` };
			if (id !== (ROOT as number)) {
				const inside = contained(args.path, cwd);
				if (!inside.allowed) return { block: `blocked by guard: ${inside.reason}` };
			}
		}
		if (WRITE_TOOLS.has(call.name) || SHELL_TOOLS.has(call.name)) {
			const denied = await writerDenied(id);
			if (denied !== undefined) return { block: `blocked by guard: ${denied}` };
		}
		if (SHELL_TOOLS.has(call.name) && killsProcess(args.command)) return { block: "blocked by guard: process-kill commands are not allowed from the agent" };
		if (WRITE_TOOLS.has(call.name)) {
			const refusal = readFirst(id, args.path, cwd);
			if (refusal !== undefined) return { block: `blocked by guard: ${refusal}` };
		}
		// Every block check has passed. A Vesperia write or edit saves the pre-image first; a storage error never stops the call.
		if (WRITE_TOOLS.has(call.name) && cwd !== undefined && (await isVesperia(id))) {
			const key = keyOf(args.path, cwd);
			const path = canonicalize(String(args.path), cwd);
			try { capture(config.home, id, key, path, cwd); } catch (error) {
				// Fail open: the write goes ahead. Try to list the file as not restorable; if that fails too, warn.
				try { captureLost(config.home, id, key, path, cwd, error); } catch { deps.warn?.(`undo: could not save a copy of ${path}; /conclave undo will not list it`); }
			}
		}
		// countBash failing stays silent: a missing count only understates the bash calls in the undo preview.
		if (SHELL_TOOLS.has(call.name) && (await isVesperia(id))) {
			try { countBash(config.home, id); } catch { /* fail open */ }
		}
		if (call.name === "read" && call.id !== undefined) {
			const hash = hashIfFile(canonicalize(String(args.path), cwd));
			if (hash !== undefined) { pending.set(call.id, { id, key: keyOf(args.path, cwd), hash }); trim(pending, MAX_PENDING); }
		}
		if (SHELL_TOOLS.has(call.name)) {
			const cap = Math.max(1, Math.ceil(config.shellTimeoutMs / 1000));
			const asked = typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : cap;
			return { arguments: { ...args, timeout: Math.min(asked, cap) } as never };
		}
		return undefined;
	};

	const afterTool = async (call: { name: string; id?: string; arguments: unknown }, result: { isError?: boolean }, api: HookApi) => {
		const entry = call.id === undefined ? undefined : pending.get(call.id);
		if (call.id !== undefined) pending.delete(call.id);
		if (result.isError) return undefined;
		if (entry !== undefined) remember(entry.id, entry.key, entry.hash);
		if (WRITE_TOOLS.has(call.name)) {
			const args = (call.arguments ?? {}) as Record<string, unknown>;
			let cwd: string | undefined;
			try { cwd = (await api.snapshot(AgentDoc, api.conversationId, ctx))?.cwd; } catch { cwd = undefined; }
			const hash = hashIfFile(canonicalize(String(args.path), cwd));
			if (hash !== undefined) {
				remember(api.conversationId as number, keyOf(args.path, cwd), hash);
				if (await isVesperia(api.conversationId as number)) try { recordPost(deps.config().home, api.conversationId as number, keyOf(args.path, cwd), hash); } catch { deps.warn?.("undo: could not record the final state of a written file; /conclave undo may skip it"); }
			}
		}
		return undefined;
	};

	const read = createReadTool();
	const extension = defineExtension({
		name: "guard",
		wraps: [wrapTool(read, (tool) => ({ ...tool, replay: "safe" as const }))],
		hooks: [hook(ToolTask, { beforeTool, afterTool })],
	});

	return {
		extension,
		bindHarness(h) { harness = h; },
		shellPrepare,
		config: deps.config,
		tools() {
			return [read, createWriteTool(), createEditTool(), clipShellOutput(createBashTool({ prepare: shellPrepare }))] as ToolRegistration[];
		},
	};
}

/**
 * Every stored selection must list `guard` first. Returns the conversations that do not. The caller reconfigures
 * the root and refuses to use any other offender.
 */
export async function conversationsWithoutGuardFirst(harness: HarnessType): Promise<number[]> {
	const ids = await harness.commit(async (tx) => {
		const found: number[] = [];
		let cursor: Parameters<typeof tx.scanConversations>[2];
		for (;;) {
			const page = await tx.scanConversations({}, 100, cursor);
			for (const conversation of page.items) found.push(conversation.id as number);
			if (page.next === undefined) break;
			cursor = page.next;
		}
		return found;
	}, ctx);
	const bad: number[] = [];
	for (const id of ids) {
		const selection = (await harness.snapshot(AgentDoc, id as never, ctx))?.extensions;
		if (Array.isArray(selection) && selection[0] !== "guard") bad.push(id);
		if (selection !== undefined && !Array.isArray(selection) && selection.remove?.includes("guard")) bad.push(id);
	}
	return bad;
}

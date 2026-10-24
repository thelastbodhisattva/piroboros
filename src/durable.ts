import { existsSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
	AgentDoc,
	CompactionTask,
	configure,
	createRegistry,
	defineDoc,
	defineDocFamily,
	defineEntry,
	defineTask,
	defineTool,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	section,
	SessionFailed,
	ToolTask,
	watchEvents,
	wrapTool,
	type AgentEvent,
	type AgentEventStream,
	type Conversation,
	type EntryRecord,
	type ToolExecutionApi,
	type Extension,
	type Harness as HarnessType,
	type HarnessOptions,
	type HarnessSettings,
	type HookApi,
	type Registry,
	type ReportInfo,
	type Storage,
	type Submission,
	type SubmissionRecord,
	type TaskRecord,
	type TaskRuntime,
	type ToolRegistration,
	type TaskInspection,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createEditTool, createReadTool, createWriteTool, createBashTool, type BashPrepare } from "@earendil-works/pi-durable/tools";
import type { Models } from "./models.ts";
import { findBash, sgrStripper } from "./shell.ts";

// The only module that imports pi-durable. It re-exports what the rest of piroboros uses and holds the
// named behaviors that the durable-contract test pins, so a version bump is one edit plus that test.

export {
	AgentDoc, BACKGROUND_CONTEXT, CompactionTask, configure, createBashTool, createEditTool, createReadTool, createRegistry, createWriteTool, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, defineTool,
	GenerationTask, hook, InboxDoc, LiveDoc, MemoryStorage, NodeExecutionEnv, openNodeSqliteStorage, ROOT_CONVERSATION_ID, section, SessionFailed, ToolTask, watchEvents, withCancel, wrapTool,
};
export type { Storage, AgentEvent,AgentEventStream, BashPrepare, Context, Conversation, EntryRecord, Extension, HarnessType, HarnessSettings, HookApi, Registry, ReportInfo, Submission, SubmissionRecord, TaskRecord, TaskRuntime, ToolExecutionApi, ToolRegistration, Tx, UserInput };

export const ctx: Context = BACKGROUND_CONTEXT;
export const ROOT = ROOT_CONVERSATION_ID;

/**
 * pi-durable 1.2.0 fails the whole Session on any storage error: it closes itself and every later call rejects with
 * SessionFailed. This calls `listener` once with the storage error; a normal close() never calls it.
 */
export function onSessionFailed(harness: HarnessType, listener: (error: unknown) => void): void {
	void harness.closed.then((end) => { if (end.reason === "failed") listener(end.error); });
}

export interface OpenOptions {
	/** Storage file, or undefined for in-memory storage (tests). */
	path?: string;
	/** Test seam: a ready storage, used instead of `path`. */
	storage?: Storage;
	models: Models;
	registry: Registry;
	settings?: HarnessSettings;
	env?: (cwd: string | undefined) => NodeExecutionEnv | undefined;
	onReport?: (error: unknown, info: ReportInfo) => void;
	telemetry?: HarnessOptions["telemetry"];
	identity?: HarnessOptions["identity"];
}

/** Runs shell commands with the bash that findBash located, and stores their output without color codes. */
class ShellEnv extends NodeExecutionEnv {
	override async exec(command: Parameters<NodeExecutionEnv["exec"]>[0], options: Parameters<NodeExecutionEnv["exec"]>[1], context: Parameters<NodeExecutionEnv["exec"]>[2]) {
		// H2: the bash tool asks for a spill file once output passes its limits. Nothing is spilled: the file would
		// hold a full copy of the output (and any secret in it) in %TEMP%. shell.ts clips oversized output instead.
		const { spill: _spill, ...plain } = options ?? {};
		options = plain;
		const onOutput = options?.onOutput;
		if (onOutput === undefined) return super.exec(command, options, context);
		const strip = sgrStripper();
		const result = await super.exec(command, { ...options, onOutput: (text, ctx, info) => {
			const clean = strip.push(text, info.stream);
			if (clean !== "" || info.skipped) onOutput(clean, ctx, info);
		} }, context);
		for (const stream of ["stdout", "stderr"] as const) {
			const rest = strip.flush(stream);
			if (rest !== "") onOutput(rest, context, { stream } as never);
		}
		return result;
	}
}

export async function openHarness(options: OpenOptions): Promise<HarnessType> {
	const storage = options.storage ?? (options.path === undefined ? new MemoryStorage() : (backupBeforeSchema2(options.path), await openNodeSqliteStorage(options.path)));
	return Harness.open(storage, {
		models: options.models,
		...(options.identity === undefined ? {} : { identity: options.identity }),
		registry: options.registry,
		settings: options.settings,
		env: (target) => (options.env ? options.env(target.cwd) : new ShellEnv({ cwd: target.cwd ?? process.cwd(), shellPath: findBash() })),
		onReport: options.onReport ?? (() => {}),
		...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
	}, ctx);
}

/** Copy a SQLite database through `<target>.tmp`, checked by quick_check, so a partial copy never has the final name. The caller rules out an existing target. */
export function backupDatabase(source: string, target: string): void {
	const tmp = `${target}.tmp`;
	rmSync(tmp, { force: true });
	try {
		const db = new DatabaseSync(source);
		try { db.prepare("VACUUM INTO ?").run(tmp); } finally { db.close(); }
		const copy = new DatabaseSync(tmp, { readOnly: true });
		try {
			const rows = copy.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
			if (rows.length !== 1 || rows[0]!.quick_check !== "ok") throw new Error(`the copy failed quick_check: ${rows.map((r) => r.quick_check).join("; ")}`);
		} finally { copy.close(); }
		renameSync(tmp, target);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** ponytail: one-time guard for the schema 1 to 2 migration of pi-durable main, after which 0.1.0 cannot open the chat database. Delete after 0.3.0. */
function backupBeforeSchema2(path: string): void {
	const target = join(dirname(path), "chat.schema1.sqlite");
	if (target === path) throw new Error(`invariant: the chat database may not be named ${target}`);
	if (!existsSync(path)) return;
	const db = new DatabaseSync(path);
	let version: unknown;
	try {
		const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'").get();
		version = table === undefined ? undefined : (db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version?: unknown } | undefined)?.version;
	} finally {
		db.close();
	}
	if (version !== 1) return; // no table (new or empty file) or already schema 2: nothing to back up
	if (existsSync(target)) throw new Error(`${target} is from an earlier upgrade and ${path} is schema 1 again; move ${target} somewhere else, then start piroboros again`);
	try {
		backupDatabase(path, target);
	} catch (error) {
		throw new Error(`could not back up the chat database before its schema 2 migration (if the disk is full, free space): ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Tasks the restart limit parked (pi-durable main). They stay parked across starts until aborted or retried. */
export async function parkedTasks(harness: Pick<HarnessType, "inspect">): Promise<TaskInspection["record"][]> {
	return (await harness.inspect(ctx)).tasks.filter((t) => t.state.kind === "blocked" && t.state.reason === "restart_limit").map((t) => t.record);
}

/* --- named behaviors ---------------------------------------------------------------------------------- */

export const MARKER_KIND = "piroboros.turn";

/** True when the root has no run in progress. */
export async function isIdle(harness: HarnessType, conversationId = ROOT): Promise<boolean> {
	const live = await harness.snapshot(LiveDoc, conversationId, ctx);
	return live?.run === undefined;
}

/**
 * Submit the head marker of a turn on an idle root. A write on an idle conversation settles `done` at once; any
 * other status means the root was busy, which would turn a post-tools boundary into a final one, so it throws.
 */
export async function submitTurn(root: Conversation, data: { at: number; cwd: string; items: readonly { id: string; source: string; member: string | null }[] }, requestId: string): Promise<Submission> {
	const submission = await root.submit({ type: "write", entry: { kind: MARKER_KIND, head: "self", data: data as never }, requestId }, ctx);
	const record = await submission.status(ctx);
	if (record.status !== "done") throw new Error(`invariant: marker ${requestId} did not settle done (status ${record.status}); markers are only submitted when the root is idle`);
	return submission;
}

export const NOTE_KIND = "piroboros.note";

/**
 * Append a memory snapshot note to an idle root, with no head: it joins the log and the index, not the context of a
 * turn. Like the marker it settles `done` at once on an idle conversation, and any other status is a bug.
 */
export async function submitNote(root: Conversation, data: { at: number; hash: string; ids: readonly string[]; content: string }, requestId: string): Promise<Submission> {
	const submission = await root.submit({ type: "write", entry: { kind: NOTE_KIND, data: data as never }, requestId }, ctx);
	const record = await submission.status(ctx);
	if (record.status !== "done") throw new Error(`invariant: note ${requestId} did not settle done (status ${record.status}); notes are only submitted when the root is idle`);
	return submission;
}

/** Submit user input. `steer` places it at the next boundary of a running turn; plain input starts a run on an idle root. */
export function submitInput(root: Conversation, content: UserInput, requestId: string): Promise<Submission> {
	return root.submit({ type: "input", content, requestId }, ctx);
}

export function submitSteer(root: Conversation, content: UserInput, requestId: string): Promise<Submission> {
	return root.submit({ type: "input", content, whenBusy: "steer", requestId }, ctx);
}

/** Every status but "terminal" is live: pending, running, waiting, sleeping, completing. A status this code does not know, or a missing one, counts as live (fails closed). */
export const isLiveStatus = (status: string | undefined): boolean => status !== "terminal";

/**
 * Whether a task is live. Fails closed: a task that cannot be read, is absent, or reports a status this
 * code does not know counts as live.
 */
export async function isTaskLive(harness: Pick<HarnessType, "getTask">, taskId: string): Promise<boolean> {
	try {
		const record = await harness.getTask((/^\d+$/u.test(taskId) ? Number(taskId) : taskId) as never, ctx);
		if (record === undefined) return true;
		const status = (record.state as { status?: string }).status;
		return isLiveStatus(status);
	} catch {
		return true;
	}
}

/** Committed entries of a conversation, newest first. */
export async function recentEntries(conversation: Conversation, limit: number) {
	const page = await conversation.entries({}, limit, undefined, ctx);
	return page.items;
}

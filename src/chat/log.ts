import { AgentDoc, ctx, defineDoc, defineDocFamily, ROOT, type Conversation, type EntryRecord, type HarnessType } from "../durable.ts";
import { ConfigError } from "../config.ts";
import type { Message } from "../models.ts";
import { NODE_TEXT_MAX, utf8Bytes } from "./view.ts";

// The log (D3): the transcript stays in the conversation, and a dense index maps it to numbered messages. Message i is
// the pair (entry id, part). The index holds [entryId, part, kind, bytes] per message, 1,024 messages to a document.
// The text is never copied: zoom and date read the entry again. Inline nodes (at most 512 bytes) are created in the
// same commit that indexes their messages.

/** One-way door: a live log is never silently remapped. */
export const MAPPING_VERSION = 3;
const FRESH_START = "delete chat.sqlite (and chat.schema1.sqlite, if there is one) in PIROBOROS_HOME to start fresh; auth.json and settings.json are kept";
export const CHUNK = 1_024;
export const SPLIT_CHARS = 30_000;
export const PASS_ENTRIES = 256;

export type Kind = "user" | "piroboros" | "tool" | "echo" | "work" | "note";
export type Row = [entryId: number, part: number, kind: string, bytes: number];

/**
 * The kind tag of the assistant's own messages was `unii` before P5c. Rows already stored keep that string, because
 * stored rows never change; every reader shows them as `piroboros`. Nodes already built keep their text.
 */
export const kindLabel = (kind: string): string => (kind === "unii" ? "piroboros" : kind);

export const LogChunkDoc = defineDocFamily<{ rows: Row[] }, Record<string, never>>({
	scope: "session",
	kind: "piroboros.log",
	version: 1,
	family: true,
	initial: () => ({ rows: [] }),
	migrate: (_value, fromVersion) => { throw new Error(`unsupported piroboros.log v${fromVersion}`); },
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export type Cursor = {
	lastEntryId: number;
	/** Messages indexed. */
	T: number;
	mappingVersion: number;
	/** Tool call ids of the latest included assistant entry; a tool result is indexed only when it answers one. */
	calls: string[];
	/** Sources of the items of the last turn marker, until the user entry that follows it is mapped. */
	marker: string[] | null;
};

export const CursorDoc = defineDoc<Cursor>({
	scope: "session",
	kind: "piroboros.cursor",
	version: 1,
	initial: () => ({ lastEntryId: 0, T: 0, mappingVersion: MAPPING_VERSION, calls: [], marker: null }),
	migrate: (_value, fromVersion) => { throw new Error(`unsupported piroboros.cursor v${fromVersion}`); },
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export const NodeDoc = defineDocFamily<{ text: string; bytes: number }, { text: string; bytes: number }>({
	scope: "session",
	kind: "piroboros.node",
	version: 1,
	family: true,
	initial: (seed) => ({ text: seed.text, bytes: seed.bytes }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
	migrate: (_value, fromVersion) => { throw new Error(`unsupported piroboros.node v${fromVersion}`); },
});

export const nodeKey = (level: number, index: number): string => `${level}:${index}`;

/**
 * The compactor's work lists (D6). Nodes are listed here instead of being found by scanning the tree. `leaves` are
 * the messages over 512 bytes that have no node yet, oldest first; `merges` are parents whose halves are built and
 * that are too long to join inline, first come first served; `running` have a live BuildNode task; `failed` are
 * waiting for the next indexed message; `completed` were built by a task and wait for the compact loop.
 */
export type Queue = {
	leaves: number[];
	merges: string[];
	running: string[];
	failed: string[];
	completed: string[];
	/** Messages indexed when the failed nodes were last retried. */
	seenT: number;
	/** The batch of the chat view that the compaction view last merged for. */
	cviewBatch: number;
	built: number;
	/** Calls repeated for bad output, plus calls repeated after a provider error. */
	retries: number;
	/** Calls repeated after the provider said it was busy (HTTP 429 or 503). They do not count as errors. Absent in queues written before P5c. */
	busy: number;
	/** Failed tasks in a row; a built node resets it. */
	streak: number;
	usage: { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number };
	/** The last failure, already scrubbed and cut short. */
	lastError: string | null;
};

export const emptyQueue = (): Queue => ({ leaves: [], merges: [], running: [], failed: [], completed: [], seenT: 0, cviewBatch: 0, built: 0, retries: 0, busy: 0, streak: 0, usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lastError: null });

export const QueueDoc = defineDoc<Queue>({
	scope: "session",
	kind: "piroboros.queue",
	version: 1,
	initial: emptyQueue,
	migrate: (_value, fromVersion) => { throw new Error(`unsupported piroboros.queue v${fromVersion}`); },
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** The text cut to at most `max` UTF-8 bytes, never inside a character. */
export function clipBytes(text: string, max: number): string {
	if (utf8Bytes(text) <= max) return text;
	return Buffer.from(text).subarray(0, max - 3).toString("utf8").replace(/�+$/u, "") + "...";
}

/**
 * Node (level, index) with `text` is built. While its sibling is built too, join the two: a parent that fits in 512
 * bytes becomes an inline node (added to `created`, and the walk goes on up); one that does not is added to `merges`
 * for a model call. A parent that already exists is left alone. `lookup` reads a built node's text.
 */
export async function joinUp(level: number, index: number, text: string, created: Map<string, string>, merges: Set<string>, lookup: (level: number, index: number) => Promise<string | undefined>): Promise<void> {
	for (;;) {
		const left = index % 2 === 0;
		const sibling = await lookup(level, left ? index + 1 : index - 1);
		if (sibling === undefined) return;
		const parent = index >> 1;
		if ((await lookup(level + 1, parent)) !== undefined) return;
		const joined = left ? `${text}\n${sibling}` : `${sibling}\n${text}`;
		if (utf8Bytes(joined) > NODE_TEXT_MAX) {
			merges.add(nodeKey(level + 1, parent));
			return;
		}
		level += 1;
		index = parent;
		text = joined;
		created.set(nodeKey(level, index), text);
	}
}

export class MappingVersionError extends ConfigError {
	constructor(found: number) {
		super("mapping_version", `the chat index uses mapping version ${found}, but this build maps version ${MAPPING_VERSION}; refusing to start so the log is not remapped; ${FRESH_START}`);
	}
}

/** A database written under the old extension name and labels is not migrated. */
export class LegacyStoreError extends ConfigError {
	constructor() {
		super("legacy_store", `this chat database was written by an earlier build that used different stored names; it cannot be opened, so ${FRESH_START}`);
	}
}

/* --- mapping ------------------------------------------------------------------------------------------------- */

export interface MapState {
	calls: string[];
	marker: string[] | null;
}

export interface Mapped {
	kind: Kind;
	text: string;
}

const EXCLUDED_STOP = new Set(["aborted", "error", "deferred"]);
const normalize = (text: string): string => text.replace(/\r\n?/gu, "\n");

/** Cut text into pieces of at most `SPLIT_CHARS` UTF-16 units, never between the halves of a surrogate pair. */
export function splitText(text: string): string[] {
	if (text.length <= SPLIT_CHARS) return [text];
	const out: string[] = [];
	let at = 0;
	while (text.length - at > SPLIT_CHARS) {
		let end = at + SPLIT_CHARS;
		const last = text.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end -= 1;
		out.push(text.slice(at, end));
		at = end;
	}
	out.push(text.slice(at));
	return out;
}

type Block = { type?: string; text?: string; mimeType?: string; data?: string };
const imageText = (block: Block): string => `[image: ${block.mimeType ?? "unknown"}, ${Buffer.byteLength(block.data ?? "", "base64")} bytes]`;
const blockText = (block: Block): string | undefined => (block.type === "text" ? block.text ?? "" : block.type === "image" ? imageText(block) : undefined);

const asSource = (value: unknown): Kind => (value === "conclave" ? "work" : "user");

/** Index text of an akashic snapshot note (F4): a placeholder, never the content. */
export function notePlaceholder(data: unknown): string {
	const d = (data ?? {}) as { hash?: unknown; ids?: unknown };
	const hash = typeof d.hash === "string" ? d.hash : "unknown";
	const ids = Array.isArray(d.ids) ? d.ids.filter((id) => typeof id === "string" || typeof id === "number").join(", ") : "";
	return `[akashic snapshot ${hash}: ids ${ids}]`;
}

/** The framed memory snapshot a note entry holds. zoom shows it; the index and the compactor only ever see the placeholder. */
export function noteContent(entry: EntryRecord): string | undefined {
	const content = (entry.data as { content?: unknown } | undefined)?.content;
	return entry.kind === "piroboros.note" && typeof content === "string" ? content : undefined;
}

/** The date of an entry: the message's own timestamp, or `data.at` for notes and markers. */
export function entryTimestamp(entry: EntryRecord): number | undefined {
	const stamp = (entry.model?.[0] as { timestamp?: unknown } | undefined)?.timestamp;
	if (typeof stamp === "number") return stamp;
	const at = (entry.data as { at?: unknown } | undefined)?.at;
	return typeof at === "number" ? at : undefined;
}

/**
 * Map one transcript entry to messages (mappingVersion 3). Never throws on content shape. `state` carries what the
 * rules need from earlier entries and is returned updated. `onAlarm` is told about entries that must never occur.
 */
export function mapEntry(entry: EntryRecord, state: MapState, onAlarm?: (text: string) => void): { out: Mapped[]; state: MapState } {
	const out: Mapped[] = [];
	const push = (kind: Kind, text: string): void => { for (const piece of splitText(normalize(text))) out.push({ kind, text: piece }); };
	let next = state;
	const message = entry.model?.[0] as (Message & { content?: unknown }) | undefined;
	const blocks = (): Block[] => (Array.isArray(message?.content) ? (message!.content as Block[]).filter((b) => b !== null && typeof b === "object") : typeof message?.content === "string" ? [{ type: "text", text: message.content }] : []);
	switch (entry.kind) {
		case "piroboros.turn": {
			const items = (entry.data as { items?: unknown } | undefined)?.items;
			next = { ...state, marker: Array.isArray(items) ? items.map((item) => asSource((item as { source?: unknown } | null)?.source)) : [] };
			break;
		}
		case "pi.user":
		case "pi.reset": {
			let k = 0;
			for (const block of blocks()) {
				if (block.type === "text") {
					if ((block.text ?? "") === "") { k += 1; continue; }
					push(entry.kind === "pi.user" ? (state.marker?.[k] as Kind | undefined) ?? "user" : "user", block.text ?? "");
					k += 1;
				} else {
					const text = blockText(block);
					if (text !== undefined) push("user", text);
				}
			}
			if (entry.kind === "pi.user") next = { ...state, marker: null };
			break;
		}
		case "pi.assistant": {
			const assistant = message as { stopReason?: string; content?: Block[] } | undefined;
			if (assistant === undefined || EXCLUDED_STOP.has(assistant.stopReason ?? "")) { next = { ...state, calls: [] }; break; }
			const content = Array.isArray(assistant.content) ? (assistant.content as Array<Block & { id?: string; name?: string; arguments?: unknown }>).filter((b) => b !== null && typeof b === "object") : [];
			const text = content.filter((b) => b.type === "text" && (b.text ?? "").trim() !== "").map((b) => b.text).join("\n");
			if (text !== "") push("piroboros", text);
			const calls: string[] = [];
			for (const call of content) {
				if (call.type !== "toolCall") continue;
				// H5: the plan is transient, so neither the call nor its result is indexed.
				if (call.name === "plan") continue;
				if (typeof call.id === "string") calls.push(call.id);
				push("tool", `${call.name ?? "tool"} ${JSON.stringify(call.arguments ?? {})}`);
			}
			next = { ...state, calls };
			break;
		}
		case "pi.tool-result": {
			const result = message as { toolCallId?: string; toolName?: string } | undefined;
			if (result?.toolCallId === undefined || !state.calls.includes(result.toolCallId)) break;
			push("echo", `${result.toolName ?? "tool"}: ${blocks().map(blockText).filter((t) => t !== undefined).join("\n")}`);
			break;
		}
		case "pi.compaction":
			onAlarm?.(`entry ${entry.id} is a pi.compaction; piroboros never compacts the transcript, so the index skips it`);
			break;
		case "piroboros.note":
			push("note", notePlaceholder(entry.data));
			break;
		default:
			break;
	}
	return { out, state: next };
}

/** Text of message `part` of an entry, for zoom. Inclusion rules are not re-applied: the index already decided. */
export function partText(entry: EntryRecord, part: number): string | undefined {
	const id = (entry.model?.[0] as { toolCallId?: string } | undefined)?.toolCallId;
	return mapEntry(entry, { calls: id === undefined ? [] : [id], marker: null }).out[part]?.text;
}

/* --- the index pass ------------------------------------------------------------------------------------------- */

export const leafText = (kind: string, text: string): string => `${kindLabel(kind)}: ${text}`;

export async function snapshotNodeText(harness: Pick<HarnessType, "snapshot">, level: number, index: number): Promise<string | undefined> {
	return (await harness.snapshot(NodeDoc, nodeKey(level, index), ctx))?.text;
}

export interface IndexDeps {
	harness: HarnessType;
	root: Conversation;
	onAlarm?(text: string): void;
}

/** Throws LegacyStoreError for a database from before the rename, MappingVersionError when the index was written by another mapping. */
export async function checkMappingVersion(harness: Pick<HarnessType, "snapshot">, known: readonly string[]): Promise<void> {
	// A stored root that selects an extension this build does not have was written before the rename.
	const stored = (await harness.snapshot(AgentDoc, ROOT, ctx))?.extensions;
	if (Array.isArray(stored) && stored.some((name) => !known.includes(name))) throw new LegacyStoreError();
	const cursor = await harness.snapshot(CursorDoc, ctx);
	if (cursor !== undefined && cursor.mappingVersion !== MAPPING_VERSION) throw new MappingVersionError(cursor.mappingVersion);
}

/**
 * Index the next page of root entries. Entries are read outside the commit (committed entries never change), the
 * sibling nodes needed for inline joins are read by snapshot, and one commit writes the chunks, the new nodes and
 * the cursor. Returns false when there was nothing to index.
 */
export async function indexPass(deps: IndexDeps): Promise<boolean> {
	const { harness, root } = deps;
	const stored = await harness.snapshot(CursorDoc, ctx);
	if (stored !== undefined && stored.mappingVersion !== MAPPING_VERSION) throw new MappingVersionError(stored.mappingVersion);
	const base: Cursor = stored === undefined ? { lastEntryId: 0, T: 0, mappingVersion: MAPPING_VERSION, calls: [], marker: null } : { ...stored, calls: [...stored.calls], marker: stored.marker === null ? null : [...stored.marker] };
	const page = await root.entries({ minEntryId: (base.lastEntryId + 1) as never, order: "ascending" }, PASS_ENTRIES, undefined, ctx);
	if (page.items.length === 0) return false;

	let state: MapState = { calls: base.calls, marker: base.marker };
	const alarms: string[] = [];
	const messages: Array<{ id: number; row: Row; text: string }> = [];
	let T = base.T;
	for (const entry of page.items) {
		const mapped = mapEntry(entry, state, (text) => alarms.push(text));
		state = mapped.state;
		mapped.out.forEach((m, part) => {
			messages.push({ id: T, row: [entry.id as number, part, m.kind, utf8Bytes(m.text)], text: m.text });
			T += 1;
		});
	}

	// Inline nodes: a leaf that fits in 512 bytes is its own node; two built siblings join when the result fits.
	const created = new Map<string, string>();
	const lookup = async (level: number, index: number): Promise<string | undefined> => created.get(nodeKey(level, index)) ?? snapshotNodeText(harness, level, index);
	// A leaf over 512 bytes waits for the compactor, except a note: its text is only a placeholder, and notes are never
	// sent to the compactor (F4), so a long one is cut here.
	const longLeaves: number[] = [];
	const wanted = new Set<string>();
	for (const m of messages) {
		let text = leafText(m.row[2], m.text);
		if (utf8Bytes(text) > NODE_TEXT_MAX) {
			if (m.row[2] !== "note") {
				longLeaves.push(m.id);
				continue;
			}
			text = clipBytes(text, NODE_TEXT_MAX);
		}
		created.set(nodeKey(0, m.id), text);
		await joinUp(0, m.id, text, created, wanted, lookup);
	}

	const last = page.items[page.items.length - 1]!.id as number;
	await harness.commit(async (tx) => {
		const cursor = await tx.doc(CursorDoc);
		if (cursor.lastEntryId !== base.lastEntryId || cursor.T !== base.T) throw new Error("invariant: the index cursor moved during a pass; the index has one writer");
		for (const m of messages) {
			const chunk = await tx.doc(LogChunkDoc, String(Math.floor(m.id / CHUNK)), {});
			chunk.rows.push(m.row);
		}
		for (const [key, text] of created) await tx.doc(NodeDoc, key, { text, bytes: utf8Bytes(text) });
		if (longLeaves.length > 0 || wanted.size > 0) {
			const queue = await tx.doc(QueueDoc);
			queue.leaves.push(...longLeaves);
			for (const key of wanted) if (!queue.merges.includes(key) && !queue.running.includes(key) && !queue.failed.includes(key)) queue.merges.push(key);
		}
		cursor.lastEntryId = last;
		cursor.T = T;
		cursor.calls = state.calls;
		cursor.marker = state.marker;
		cursor.mappingVersion = MAPPING_VERSION;
	}, ctx);
	for (const text of alarms) deps.onAlarm?.(text);
	return true;
}

/** The row of message `id`, or undefined. */
export async function readRow(harness: Pick<HarnessType, "snapshot">, id: number): Promise<Row | undefined> {
	return (await harness.snapshot(LogChunkDoc, String(Math.floor(id / CHUNK)), ctx))?.rows[id % CHUNK];
}

export { ROOT };

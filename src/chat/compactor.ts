import { compactorStatus, withDefaults, type Settings } from "../config.ts";
import { ctx, defineExtension, defineTask, ROOT, type Context, type Extension, type HarnessType, type TaskRuntime } from "../durable.ts";
import { resolveModel, type AnyModel, type Message, type Models } from "../models.ts";
import { redactOutbound, redactSensitive } from "../redact.ts";
import { CursorDoc, emptyQueue, joinUp, kindLabel, nodeKey, NodeDoc, partText, QueueDoc, readRow, snapshotNodeText, type Queue } from "./log.ts";
import { collectLiterals, newScrubMemo, outboundVerdict, scrubLines, type ScrubMemo } from "./outbound.ts";
import { CHAT_PROMPT, compactMergeTask, compactMessageTask, tooLongRetry } from "./prompt.ts";
import { applyView, CviewDoc, planAdvance, ViewDoc } from "./tree.ts";
import { lineBytes, lineFirst, lineSize, lineText, NODE_TEXT_MAX, shrink, utf8Bytes, type CompactorLabel, type Line } from "./view.ts";

// The compactor (D6, D7): BuildNode tasks that write the model-made nodes, the compact pass that feeds them and
// joins their results, and the gate that makes a turn wait for them. Nodes are created only in the commit that has
// just built them (a BuildNode completion, or an inline join), and existence is read by snapshot, never probed with
// tx.doc. Requests carry no tools. Anything that leaves the machine goes through `outbound` at the moment it is sent.

export const CVIEW_MAX = 32_000;
export const CVIEW_TARGET = 16_000;
export const MAX_CALLS = 5;
export const MAX_ERRORS = 3;
/** One compactor request may take this long; a longer one is cut and counts as a provider error. */
export const COMPACTOR_REQUEST_TIMEOUT_MS = 300_000;
/** Provider "busy" replies (HTTP 429 or 503) that one node may retry before they count as errors. */
export const MAX_BUSY = 20;
/** A busy reply waits this many times longer than an error does. */
const BUSY_FACTOR = 5;
/** The message of a failed call starts with its HTTP status, as in "429 model concurrency full". */
export const isBusy = (message: string | undefined): boolean => message !== undefined && /^\W*(?:HTTP\s*)?(?:status\s*)?(?:429|503)\b/iu.test(message);
/** Failed tasks in a row that open the breaker. */
export const BREAKER_STREAK = 3;
/** How many leaves may be unbuilt before a leaf starts (D6). */
const LEAF_WINDOW = 8;
const ERROR_CHARS = 300;
/** Context-line texts kept between tasks: a 32,000-byte view holds a few hundred lines. */
const CONTEXT_CACHE_MAX = 4_096;

export type BuildInput = { level: number; index: number };
type Checkpoint =
	| { phase: "prepare" }
	/** `shape` is the compaction-view context as run-length coded levels (see packShape); the prompt is rebuilt from committed docs on every call. */
	| { phase: "ask"; shape: string; replies: string[]; calls: number; errors: number; at: number; busy?: number };
export type BuildResult = { key: string; bytes: number; calls: number };

export interface CompactorDeps {
	settings(): Settings;
	models: Models;
	/** auth.json, whose values are scrubbed from everything sent. */
	authPath: string;
	env: NodeJS.ProcessEnv;
	instructions?(): string | undefined;
	/** Waits after a provider error; the length is the number of tries. */
	backoffMs?: readonly number[];
	/** Test seam: replaces COMPACTOR_REQUEST_TIMEOUT_MS. */
	requestTimeoutMs?: number;
}

export type CompactorState = { label: CompactorLabel; reason?: string };

export interface CompactorReport extends CompactorState {
	model?: string;
	maxConcurrent: number;
	waiting: number;
	inFlight: number;
	built: number;
	retries: number;
	busyRetries: number;
	breaker: "closed" | "open";
	breakerReason?: string;
	lastError: string | null;
}

export type GateResult =
	| { kind: "skipped" }
	| { kind: "built" }
	/** The turn proceeds with placeholders: the breaker was already open, or it opened while the gate waited. */
	| { kind: "degraded"; message: string };

const without = <T>(list: T[], item: T): void => {
	const at = list.indexOf(item);
	if (at >= 0) list.splice(at, 1);
};
const parseKey = (key: string): [number, number] => {
	const [level, index] = key.split(":").map(Number);
	return [level!, index!];
};
/**
 * Nodes the queue shows are not built: a node over a leaf still in `leaves` (a parent needs both children), and a node
 * waiting, running or failed. `leaves` is ascending: the index pass appends in message order.
 */
const unbuiltIn = (queue: Readonly<Queue>): ((level: number, index: number) => boolean) => {
	const queued = new Set([...queue.merges, ...queue.running, ...queue.failed]);
	const leaves = Array.from(queue.leaves); // a plain copy: the snapshot's arrays are slow to index
	return (level, index) => {
		if (queued.has(nodeKey(level, index))) return true;
		const lo = index * 2 ** level;
		let a = 0;
		let b = leaves.length;
		while (a < b) {
			const mid = (a + b) >> 1;
			if (leaves[mid]! < lo) a = mid + 1;
			else b = mid;
		}
		return a < leaves.length && leaves[a]! < lo + 2 ** level;
	};
};
const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim().slice(0, ERROR_CHARS);

export class Compactor {
	readonly extension: Extension;
	private readonly deps: CompactorDeps;
	private harness: HarnessType | undefined;
	/** Set when a gate gave up; cleared when a node is built. D7 keeps it in memory. */
	private tripped: string | undefined;
	private readonly task: ReturnType<typeof makeTask>;
	/** Scrub results by chunk for each strictness, bounded by scrubLines; cleared when the credential literals change. */
	private readonly memos = new Map<boolean, ScrubMemo>();
	private memoSignature = "";
	/** Texts of built nodes read as prompt context; see rebuild. */
	readonly contextTexts = new Map<string, string>();

	constructor(deps: CompactorDeps) {
		this.deps = deps;
		this.task = makeTask(this);
		this.extension = defineExtension({ name: "compactor", tasks: [this.task] as never });
	}

	bind(harness: HarnessType): void {
		this.harness = harness;
	}

	private get h(): HarnessType {
		if (this.harness === undefined) throw new Error("the compactor is not bound to a harness");
		return this.harness;
	}

	settings(): Settings {
		return this.deps.settings();
	}

	requestTimeoutMs(): number {
		return this.deps.requestTimeoutMs ?? COMPACTOR_REQUEST_TIMEOUT_MS;
	}

	backoff(tries: number): number {
		const list = this.deps.backoffMs ?? [1_000, 2_000];
		return list[Math.min(tries, list.length) - 1] ?? 0;
	}

	/** The wait after the `busy`-th busy reply of one node. */
	busyBackoff(busy: number): number {
		return this.backoff(Math.min(busy, 2)) * (busy >= 3 ? 2 : 1) * BUSY_FACTOR; // 1, 2, then 4 seconds times the factor
	}

	/** The state of the compactor now. Evaluated on every call, so a changed setting applies at once. */
	state(): CompactorState {
		const settings = this.deps.settings();
		const label = compactorStatus(settings);
		if (label === "not configured") return { label, reason: "no compactor model is set" };
		if (label === "disabled") return { label, reason: "compactor.enabled is false" };
		const verdict = outboundVerdict(settings, resolveModel(this.deps.models, settings.compactor!.model!));
		return verdict.ok ? { label } : { label: "disabled", reason: verdict.reason };
	}

	/** Remove what must not leave the machine from `text`; a failure to read auth.json fails the request. */
	scrubFor(strict: boolean): (text: string) => string {
		const literals = collectLiterals(this.deps.authPath, this.deps.env);
		// The memo is only valid for one set of literals: a changed credential starts it over.
		const signature = literals.join("\0");
		if (signature !== this.memoSignature) {
			this.memos.clear();
			this.memoSignature = signature;
		}
		const memo = this.memos.get(strict) ?? newScrubMemo();
		this.memos.set(strict, memo);
		return (text) => scrubLines(text, (part) => redactOutbound(part, { literals, strict }), memo, literals);
	}

	/** A failure message that is safe to store and show. It never throws. */
	clean(message: string): string {
		try {
			return oneLine(this.scrubFor(true)(message));
		} catch {
			return oneLine(redactSensitive(message));
		}
	}

	systemPrompt(): string {
		const own = this.deps.instructions?.();
		return own === undefined ? CHAT_PROMPT : `${CHAT_PROMPT}\n\n${own}`;
	}

	private open(queue: Readonly<Queue>): string | undefined {
		if (this.tripped !== undefined) return this.tripped;
		return queue.streak >= BREAKER_STREAK ? `${queue.streak} builds failed in a row` : undefined;
	}

	/* --- the compact pass --------------------------------------------------------------------------------------- */

	/**
	 * One pass: join the parents of finished nodes, advance the compaction view, retry failed nodes after a new
	 * message, and start tasks up to the concurrency cap. Returns true when it changed anything, so the caller loops.
	 */
	async pass(): Promise<boolean> {
		const harness = this.h;
		const queue = await harness.snapshot(QueueDoc, ctx);
		if (queue === undefined) return false;
		const cursor = await harness.snapshot(CursorDoc, ctx);
		const T = cursor?.T ?? 0;
		const configured = this.state().label === "configured";

		const done = queue.completed.slice(0, 64);
		if (done.length > 0) this.tripped = undefined;
		const created = new Map<string, string>();
		const wanted = new Set<string>();
		// Nothing commits during the walk, so a node read once (built or not) is not read again by this pass.
		const seen = new Map<string, string | undefined>();
		const lookup = async (level: number, index: number): Promise<string | undefined> => {
			const key = nodeKey(level, index);
			const made = created.get(key);
			if (made !== undefined) return made;
			if (!seen.has(key)) seen.set(key, await snapshotNodeText(harness, level, index));
			return seen.get(key);
		};
		for (const key of done) {
			const [level, index] = parseKey(key);
			const text = await lookup(level, index);
			if (text !== undefined) await joinUp(level, index, text, created, wanted, lookup);
		}

		const view = await harness.snapshot(ViewDoc, ctx);
		const batch = view?.batchSeq ?? 0;
		const before = await harness.snapshot(CviewDoc, ctx);
		const target = Math.max(before?.T ?? 0, Math.min(queue.leaves[0] ?? T, T));
		// It merges down to 16,000 when the chat view has batched, and keeps going while a merge was waiting for a parent.
		const next = await planAdvance(harness, before, target, CVIEW_MAX, CVIEW_TARGET, (v, nodes) => { if (v.shrinking || batch !== queue.cviewBatch) shrink(v, nodes, CVIEW_MAX, CVIEW_TARGET); }, unbuiltIn(queue));
		const viewChanged = next.T !== (before?.T ?? 0) || next.bytes !== (before?.bytes ?? 0) || next.lines.length !== (before?.lines.length ?? 0);

		const starts: Array<[number, number]> = [];
		let changed = done.length > 0 || created.size > 0 || wanted.size > 0 || viewChanged || batch !== queue.cviewBatch;
		await harness.commit(async (tx) => {
			const q = await tx.doc(QueueDoc);
			for (const [key, text] of created) await tx.doc(NodeDoc, key, { text, bytes: utf8Bytes(text) });
			for (const key of done) without(q.completed, key);
			const listed = (key: string): boolean => q.merges.includes(key) || q.running.includes(key) || q.failed.includes(key);
			for (const key of wanted) if (!listed(key)) q.merges.push(key);
			if (T > q.seenT) {
				// A new message is the retry signal for failed nodes. Failed leaves stay in `leaves`; failed merges go back in line.
				for (const key of q.failed.splice(0)) if (parseKey(key)[0] > 0 && !q.merges.includes(key)) q.merges.push(key);
				q.seenT = T;
				changed = true;
			}
			if (viewChanged) await applyView(tx, before, next, CviewDoc);
			q.cviewBatch = batch;
			if (configured) {
				const cap = Math.min(8, withDefaults(this.deps.settings()).compactor.maxConcurrent, this.open(q) === undefined ? 8 : 1);
				const slots = cap - q.running.length;
				const keys: string[] = [];
				for (const id of q.leaves.slice(0, LEAF_WINDOW)) if (keys.length < slots && !q.running.includes(nodeKey(0, id)) && !q.failed.includes(nodeKey(0, id))) keys.push(nodeKey(0, id));
				while (keys.length < slots && q.merges.length > 0) keys.push(q.merges.shift()!);
				for (const key of keys) {
					q.running.push(key);
					starts.push(parseKey(key));
				}
			}
			for (const [level, index] of starts) await tx.createTask(this.task, { level, index }, { ownership: { kind: "conversation" }, conversationId: ROOT, background: true });
		}, ctx);
		return changed || starts.length > 0;
	}

	/* --- the gate (D7) ------------------------------------------------------------------------------------------ */

	/** Wait until every leaf below `T` is built, the breaker opens, or `gateTimeoutMs` passes. The turn proceeds either way. */
	async gate(T: number, signal?: AbortSignal): Promise<GateResult> {
		const harness = this.h;
		if (this.state().label !== "configured") return { kind: "skipped" };
		const deadline = Date.now() + withDefaults(this.deps.settings()).gateTimeoutMs;
		while (signal?.aborted !== true) {
			const queue = (await harness.snapshot(QueueDoc, ctx)) ?? emptyQueue();
			if ((queue.leaves[0] ?? T) >= T) return { kind: "built" };
			const open = this.open(queue);
			if (open !== undefined) return { kind: "degraded", message: `compactor degraded (${open}); this turn's view shows placeholders for unbuilt lines` };
			const left = deadline - Date.now();
			if (left <= 0) {
				this.tripped = "the gate timed out";
				return { kind: "degraded", message: `compactor too slow: the gate timed out after ${Math.round(withDefaults(this.deps.settings()).gateTimeoutMs / 1000)} s; this turn's view shows placeholders for unbuilt lines until a node is built` };
			}
			// The wait ends at the next commit, at the stop signal, or after 250 ms, whichever comes first.
			let unsubscribe = (): void => {};
			let timer: ReturnType<typeof setTimeout> | undefined;
			let wake = (): void => {};
			await new Promise<void>((resolve) => {
				wake = resolve;
				unsubscribe = harness.subscribeCommits(() => resolve());
				timer = setTimeout(resolve, Math.min(left, 250));
				signal?.addEventListener("abort", wake, { once: true });
			}).finally(() => {
				unsubscribe();
				clearTimeout(timer);
				signal?.removeEventListener("abort", wake);
			});
		}
		return { kind: "skipped" };
	}

	/* --- status ------------------------------------------------------------------------------------------------- */

	async report(): Promise<CompactorReport> {
		const queue = (await this.h.snapshot(QueueDoc, ctx)) ?? emptyQueue();
		const state = this.state();
		const settings = this.deps.settings();
		const breaker = this.open(queue);
		return {
			...state,
			...(settings.compactor?.model === undefined ? {} : { model: settings.compactor.model }),
			maxConcurrent: withDefaults(settings).compactor.maxConcurrent,
			waiting: queue.leaves.length + queue.merges.length + queue.failed.filter((key) => parseKey(key)[0] > 0).length,
			inFlight: queue.running.length,
			built: queue.built,
			retries: queue.retries,
			busyRetries: queue.busy ?? 0,
			breaker: breaker === undefined ? "closed" : "open",
			...(breaker === undefined ? {} : { breakerReason: breaker }),
			lastError: queue.lastError,
		};
	}

	/** The line the TUI keeps on screen when the compactor is not doing its job, or undefined. */
	async note(): Promise<string | undefined> {
		const state = this.state();
		if (state.label === "not configured") return undefined;
		if (state.label === "disabled") return `compactor disabled: ${state.reason}`;
		const open = this.open((await this.h.snapshot(QueueDoc, ctx)) ?? emptyQueue());
		return open === undefined ? undefined : `compactor degraded (${open}); lines that are not summarized yet show as placeholders`;
	}
}

/* --- BuildNode ----------------------------------------------------------------------------------------------------- */

type Rt = TaskRuntime<BuildInput, Checkpoint, BuildResult, object>;

const textOf = (message: { content: Array<{ type: string; text?: string }> }): string => message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("").replace(/\r\n?/gu, "\n").replace(/^\d+\+\d+\|/u, "").trim();

/** The first 512 bytes of a reply, for the "Too long" retry. */
const cut = (text: string): string => Buffer.from(text).subarray(0, NODE_TEXT_MAX).toString("utf8").replace(/�+$/u, "");

/**
 * The last resort when every try stayed over the limit: `text` cut to at most `max` bytes, at the last clause boundary
 * (`; `, `. ` or `, `), else at the last space, else at the byte limit. The cut never splits a character.
 */
export function clauseCut(text: string, max = NODE_TEXT_MAX): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= max) return text;
	let end = max;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1; // the byte at `end` would start in the middle of a character
	const head = bytes.subarray(0, end).toString("utf8");
	const clause = Math.max(head.lastIndexOf("; "), head.lastIndexOf(". "), head.lastIndexOf(", "));
	if (clause > 0) return head.slice(0, clause + 1);
	const space = head.lastIndexOf(" ");
	return (space > 0 ? head.slice(0, space) : head).trimEnd();
}

const shortest = (replies: readonly string[]): string => replies.reduce((best, reply) => (utf8Bytes(reply) < utf8Bytes(best) ? reply : best));

/** Contiguous view lines from message `first`, as their levels run-length coded: "40:5*3,4*1" is three level-5 lines from message 40, then one level-4 line. */
export const packShape = (first: number, levels: readonly number[]): string => {
	if (levels.length === 0) return "";
	const runs: string[] = [];
	for (let k = 0; k < levels.length;) {
		let n = 1;
		while (levels[k + n] === levels[k]) n += 1;
		runs.push(`${levels[k]}*${n}`);
		k += n;
	}
	return `${first}:${runs.join(",")}`;
};

/**
 * The request text of a node, from committed data alone: the message (or the two built halves) for the task, and the
 * node texts of the context lines for the chat. Nodes and log rows never change once written, so the same node and
 * shape give the same bytes on every call, before or after a restart.
 */
export async function rebuild(runtime: Rt, context: Context, input: BuildInput, shape: string, texts: Map<string, string> = new Map()): Promise<{ chat: string; task: string }> {
	const { level, index } = input;
	let task: string;
	if (level === 0) {
		const row = await readRow(runtime as never, index);
		const entry = row === undefined ? undefined : await runtime.entry(row[0] as never, context);
		const text = row === undefined || entry === undefined ? undefined : partText(entry, row[1]);
		if (row === undefined || text === undefined) throw new Error(`message ${index} cannot be read for compaction`);
		task = compactMessageTask(index, kindLabel(row[2]), text);
	} else {
		const size = 2 ** level;
		const first = index * size;
		const half = size / 2;
		const a = await snapshotNodeText(runtime as never, level - 1, index * 2);
		const b = await snapshotNodeText(runtime as never, level - 1, index * 2 + 1);
		if (a === undefined || b === undefined) throw new Error(`the halves of ${first}+${size} are not both built`);
		const one = (id: number, text: string): string => `${id}+${half}|${text.replace(/\n/gu, " ")}`;
		task = compactMergeTask(`${first}+${half}`, `${first + half}+${half}`, first, first + size - 1, one(first, a), one(first + half, b));
	}
	let lines = "";
	const [start, runs] = shape === "" ? ["0", ""] : shape.split(":") as [string, string];
	let first = Number(start);
	for (const run of runs === "" ? [] : runs.split(",")) {
		const [l, count] = run.split("*").map(Number) as [number, number];
		for (let k = 0; k < count; k += 1) {
			const at = first / 2 ** l;
			const key = nodeKey(l, at);
			// A built node never changes, so `texts` (the caller's bounded cache, first in first out) may hold it for good.
			let text = texts.get(key);
			if (text === undefined) {
				text = await snapshotNodeText(runtime as never, l, at);
				if (text === undefined) throw new Error(`node ${key} of the context is missing`);
				texts.set(key, text);
				if (texts.size > CONTEXT_CACHE_MAX) texts.delete(texts.keys().next().value!);
			}
			lines += lineText([l, at, text]);
			first += 2 ** l;
		}
	}
	return { chat: `<chat>\n${lines}</chat>`, task };
}

function makeTask(compactor: Compactor) {
	const settle = async (runtime: Rt, context: Context, input: BuildInput, change: (q: Queue) => void, outcome: { text?: string; calls?: number; error?: string }): Promise<void> => {
		const key = nodeKey(input.level, input.index);
		await runtime.commit(async (tx) => {
			const q = await tx.doc(QueueDoc);
			change(q);
			const live = q.running.includes(key);
			without(q.running, key);
			if (outcome.error !== undefined) {
				if (!q.failed.includes(key)) q.failed.push(key);
				q.streak += 1;
				q.lastError = outcome.error;
				return { status: "terminal", outcome: { status: "failed", error: { message: outcome.error } } };
			}
			const text = outcome.text!;
			// A task whose key is no longer running has been settled elsewhere; it creates nothing.
			if (live) {
				if (input.level === 0) without(q.leaves, input.index);
				q.completed.push(key);
				q.built += 1;
				q.streak = 0;
				await tx.doc(NodeDoc, key, { text, bytes: utf8Bytes(text) });
			}
			return { status: "terminal", outcome: { status: "completed", result: { key, bytes: utf8Bytes(text), calls: outcome.calls ?? 0 } } };
		}, context);
	};
	const fail = (runtime: Rt, context: Context, input: BuildInput, message: string): Promise<void> => settle(runtime, context, input, () => {}, { error: compactor.clean(message) });

	return defineTask<BuildInput, Checkpoint, BuildResult>({
		name: "piroboros.buildNode",
		version: 2,
		initial: () => ({ phase: "prepare" }),
		phases: {
			prepare: async (task, runtime, context) => {
				const { level, index } = task.input;
				try {
					// Context: the built lines of the compaction view that end before the node (D5), kept as their levels only. The view
					// is 32,000 bytes when the compactor keeps up; when it lags the view cannot merge and grows, so the newest 32,000 bytes are used.
					const last = level === 0 ? index - 1 : (index + 1) * 2 ** level - 1;
					const cview = await runtime.snapshot(CviewDoc, context);
					const built: Line[] = [];
					for (const line of cview?.lines ?? []) {
						if (line[2] === null || lineFirst(line as never) + lineSize(line as never) - 1 > last) break;
						built.push([line[0], line[1], line[2]]);
					}
					let from = built.length;
					for (let bytes = 0; from > 0 && bytes + lineBytes(built[from - 1]!) <= CVIEW_MAX; from -= 1) bytes += lineBytes(built[from - 1]!);
					const kept = built.slice(from);
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "ask", shape: packShape(kept.length === 0 ? 0 : lineFirst(kept[0]!), kept.map((line) => line[0])), replies: [], calls: 0, errors: 0, at: runtime.now() } }), context);
				} catch (error) {
					runtime.signal.throwIfAborted();
					await fail(runtime, context, task.input, error instanceof Error ? error.message : String(error));
				}
			},
			ask: async (task, runtime, context) => {
				const cp = task.state.checkpoint;
				try {
					// Every request re-reads the settings: the model, the consent and the credentials are checked now.
					const settings = compactor.settings();
					const model = compactorStatus(settings) === "configured" ? (resolveModel(runtime.models as Models, settings.compactor!.model!) as AnyModel | undefined) : undefined;
					const verdict = model === undefined ? ({ ok: false, reason: "the compactor is not configured or its model is not available" } as const) : outboundVerdict(settings, model);
					if (model === undefined || !verdict.ok) return await fail(runtime, context, task.input, `not sent: ${verdict.ok ? "no model" : verdict.reason}`);
					const scrub = compactor.scrubFor(verdict.strict);
					const stamp = cp.at;
					const built = await rebuild(runtime, context, task.input, cp.shape, compactor.contextTexts);					const messages: Message[] = [{ role: "user", content: [{ type: "text", text: scrub(built.chat) }, { type: "text", text: scrub(built.task) }], timestamp: stamp }];
					for (const reply of cp.replies) {
						messages.push({ role: "assistant", content: [{ type: "text", text: scrub(reply) }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: stamp } as Message);
						messages.push({ role: "user", content: [{ type: "text", text: tooLongRetry(utf8Bytes(reply), scrub(cut(reply))) }], timestamp: stamp });
					}
					const thinking = withDefaults(settings).compactor.thinking;
					const reply = await runtime.models.completeSimple(model, { systemPrompt: scrub(compactor.systemPrompt()), messages }, {
						signal: AbortSignal.any([runtime.signal, AbortSignal.timeout(compactor.requestTimeoutMs())]),
						maxTokens: model.maxTokens > 0 ? Math.min(model.maxTokens, 8_192) : 8_192,
						...(thinking === "off" ? {} : { reasoning: thinking as never }),
					});
					runtime.signal.throwIfAborted();
					const usage = reply.usage;
					const spend = (q: Queue): void => {
						q.usage.calls += 1;
						q.usage.input += usage?.input ?? 0;
						q.usage.output += usage?.output ?? 0;
						q.usage.cacheRead += usage?.cacheRead ?? 0;
						q.usage.cacheWrite += usage?.cacheWrite ?? 0;
					};
					if (reply.stopReason === "error" || reply.stopReason === "aborted") {
						const message = compactor.clean(reply.errorMessage ?? "the provider returned an error");
						// A busy provider (429, 503) is waited out with a longer backoff and no strike, up to MAX_BUSY times for this node.
						const busy = (cp.busy ?? 0) + 1;
						if (isBusy(reply.errorMessage) && busy <= MAX_BUSY) {
							await runtime.commit(async (tx) => {
								const q = await tx.doc(QueueDoc);
								spend(q);
								q.busy = (q.busy ?? 0) + 1;
								q.lastError = message;
								return { status: "running", checkpoint: { ...cp, busy } };
							}, context);
							return await runtime.sleep(runtime.now() + compactor.busyBackoff(busy), context);
						}
						const errors = cp.errors + 1;
						if (errors >= MAX_ERRORS) return await settle(runtime, context, task.input, spend, { error: `${message} (after ${errors} tries)` });
						await runtime.commit(async (tx) => {
							const q = await tx.doc(QueueDoc);
							spend(q);
							q.retries += 1;
							q.lastError = message;
							return { status: "running", checkpoint: { ...cp, errors } };
						}, context);
						return await runtime.sleep(runtime.now() + compactor.backoff(errors), context);
					}
					const text = textOf(reply as never);
					const calls = cp.calls + 1;
					const replies = text === "" || utf8Bytes(text) <= NODE_TEXT_MAX ? cp.replies : [...cp.replies, text];
					if (text !== "" && utf8Bytes(text) <= NODE_TEXT_MAX) return await settle(runtime, context, task.input, spend, { text, calls });
					if (calls >= MAX_CALLS) {
						if (replies.length === 0) return await settle(runtime, context, task.input, spend, { error: "the compactor returned no text" });
						return await settle(runtime, context, task.input, spend, { text: clauseCut(shortest(replies)), calls });
					}
					await runtime.commit(async (tx) => {
						const q = await tx.doc(QueueDoc);
						spend(q);
						q.retries += 1;
						return { status: "running", checkpoint: { ...cp, calls, replies } };
					}, context);
				} catch (error) {
					runtime.signal.throwIfAborted();
					await fail(runtime, context, task.input, error instanceof Error ? error.message : String(error));
				}
			},
		},
		abort: async (task, runtime, context) => {
			await settle(runtime, context, task.input, () => {}, { error: "the build was aborted" });
		},
	});
}

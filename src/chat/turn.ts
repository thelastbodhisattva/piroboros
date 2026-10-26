import { randomUUID } from "node:crypto";
import { AgentDoc, configure, ctx, defineDoc, isIdle, ROOT, submitInput, submitNote, submitSteer, submitTurn, LiveDoc, type Conversation, type Extension, type HarnessType, type SubmissionRecord } from "../durable.ts";
import { hasAuth, type Models } from "../models.ts";
import { splitModelRef } from "../config.ts";
import type { GateResult } from "./compactor.ts";
import { CursorDoc } from "./log.ts";
import { PlanDoc } from "./plan.ts";
import { applyView, planAdvance, TurnStateDoc, ViewDoc } from "./tree.ts";
import { nextWindowStart, type CompactorLabel } from "./view.ts";

// turnLoop (D2), minimal form. `piroboros.pending` is the only entry point for user messages. This loop is
// the only caller of root.submit. Each fresh turn is a head marker followed by one input; a busy root takes
// user items as steers with no marker. Every step is idempotent by requestId, so a crash replays safely.

export type PendingItem = {
	id: string;
	source: "user" | "conclave";
	member: string | null;
	text: string;
	at: number;
};

export const PendingDoc = defineDoc<{ items: PendingItem[] }>({
	scope: "session",
	kind: "piroboros.pending",
	version: 1,
	initial: () => ({ items: [] }),
	migrate: (_value, fromVersion) => {
		throw new Error(`unsupported piroboros.pending v${fromVersion}`);
	},
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export type TurnStatus =
	| { kind: "idle" }
	| { kind: "unconfigured" }
	| { kind: "login_required"; provider: string }
	| { kind: "error"; message: string }
	/** The provider or model failed this turn. The text was restored for a resend. */
	| { kind: "turn_failed"; model: string; message: string }
	/** The turn ended on purpose with a named reason (H3: stuck). The text is kept, because resending it would repeat the loop. */
	| { kind: "stopped"; reason: "stuck"; message: string }
	/** The gate gave up (too slow, or the breaker is open); the turn runs with placeholders. */
	| { kind: "compactor_degraded"; message: string }
	/** A plain line for the user, such as "Conclave resumed: Nytheria". */
	| { kind: "notice"; message: string };

export interface TurnSettings {
	main?: string;
	thinking: string;
	cwd: string;
}

export interface TurnLoopDeps {
	harness: HarnessType;
	root: Conversation;
	models: Models;
	/** Read on every pass, so /model and /reload apply at the next turn commit. */
	settings(): TurnSettings;
	onStatus?(status: TurnStatus): void;
	/** Text of a user item whose input was aborted or withdrawn, to put back in the input box. */
	onRestore?(text: string, itemIds: string[]): void;
	onReport?(error: unknown): void;
	now?(): number;
	/** The compact loop, which indexes the log before each turn. */
	index?: { indexNow(): Promise<void> };
	compactor?(): CompactorLabel;
	/** The gate (D7): resolves when every leaf below T is built, or says why the turn goes on without them. */
	gate?(T: number, signal: AbortSignal): Promise<GateResult>;
	/** The named reason a run was stopped on purpose (H3), taken once; undefined when the abort came from the user. */
	takeStop?(): string | undefined;
	/** Text of instructions.md, or undefined. It renders as the `instructions` section. */
	instructions?(): string | undefined;
	/** True while a Conclave pipeline is live. Its report items then stay pending and are delivered together once it ends. */
	holdReports?(): Promise<boolean>;
	/** Called once per fresh turn before the note step. Returns the memory snapshot for `cwd`, or undefined when there is none. */
	memory?(cwd: string): { hash: string; ids: readonly string[]; content: string } | undefined;
	/**
	 * The root's code-defined extension selection. The turn commit compares it with the stored one and applies it in
	 * that commit when they differ, so a chat that was written by an older build is migrated once, at its first turn.
	 */
	selection?: readonly Extension[];
}

export async function enqueueMessage(harness: HarnessType, text: string, source: PendingItem["source"] = "user", member?: string, now = Date.now()): Promise<string> {
	const id = randomUUID();
	await harness.commit(async (tx) => {
		const doc = await tx.doc(PendingDoc);
		doc.items.push({ id, source, member: member ?? null, text, at: now });
	}, ctx);
	return id;
}

const contentFor = (items: readonly PendingItem[]) => items.map((item) => ({ type: "text" as const, text: item.source === "conclave" ? `[${item.member ?? "member"}] report\n${item.text}` : item.text }));

/** F3: added after the reports of a turn that holds no user item, so the model knows the guard's rule before it calls a tool. */
export const REPORT_ONLY_NOTE = "[piroboros] This turn holds only member reports, so writes and commands are blocked until the user replies. Summarize the reports for the user and say what they can do next: /conclave approve hands a reviewed plan to Vesperia, and any reply from the user lifts the block.";

/** How many settled turns whenSettled can still answer for. */
export const SETTLED_KEEP = 256;

export class TurnLoop {
	private readonly deps: TurnLoopDeps;
	private dirty = false;
	private running: Promise<void> | undefined;
	private stopped = true;
	/** Aborted by stop(), so a gate that is waiting ends at once. */
	private halt = new AbortController();
	private unsubscribe: (() => void) | undefined;
	private readonly settled = new Map<string, Promise<SubmissionRecord | undefined>>();

	constructor(deps: TurnLoopDeps) {
		this.deps = deps;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.halt = new AbortController();
		// The listener only sets a flag; it never calls Session APIs.
		this.unsubscribe = this.deps.harness.subscribeCommits(() => this.wake());
		this.wake();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.halt.abort();
		this.unsubscribe?.();
		await this.running;
	}

	wake(): void {
		if (this.stopped) return;
		this.dirty = true;
		if (this.running === undefined) {
			this.running = Promise.resolve().then(() => this.drain()).finally(() => {
				this.running = undefined;
				if (this.dirty && !this.stopped) this.wake();
			});
		}
	}

	/** Resolves with the settled input record of the turn that consumed `itemId`. */
	whenSettled(itemId: string): Promise<SubmissionRecord | undefined> | undefined {
		return this.settled.get(itemId);
	}

	private async drain(): Promise<void> {
		while (this.dirty && !this.stopped) {
			this.dirty = false;
			try {
				await this.pass();
			} catch (error) {
				if (this.isCloseError(error)) continue;
				this.deps.onReport?.(error);
				this.deps.onStatus?.({ kind: "error", message: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	/** Closing the runtime rejects the waits of a running turn with this error; it is not a failure of the turn. */
	private isCloseError(error: unknown): boolean {
		return this.stopped && error instanceof Error && error.message === "Harness is closed";
	}

	private async removeItems(ids: readonly string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.deps.harness.commit(async (tx) => {
			const doc = await tx.doc(PendingDoc);
			const keep = doc.items.filter((item) => !ids.includes(item.id));
			doc.items.splice(0, doc.items.length, ...keep);
		}, ctx);
	}

	/** Step 1: items whose input already exists were submitted by an earlier pass. */
	private async consumed(items: readonly PendingItem[]): Promise<Array<{ ids: string[]; record: SubmissionRecord; texts: string[] }>> {
		return this.deps.harness.commit(async (tx) => {
			const out: Array<{ ids: string[]; record: SubmissionRecord; texts: string[] }> = [];
			const claimed = new Set<string>();
			for (const item of items) {
				if (claimed.has(item.id)) continue;
				const record = await tx.submissionByRequest(ROOT, `msg:${item.id}`);
				if (record === undefined) continue;
				let ids = [item.id];
				const marker = await tx.submissionByRequest(ROOT, `turn:${item.id}`);
				if (marker !== undefined && marker.type === "write" && "entry" in marker && marker.entry !== undefined) {
					const entry = await tx.entry(marker.entry);
					const listed = (entry?.data as { items?: Array<{ id: string }> } | undefined)?.items;
					if (Array.isArray(listed)) ids = listed.map((entry2) => entry2.id);
				}
				for (const id of ids) claimed.add(id);
				out.push({ ids, record, texts: items.filter((candidate) => ids.includes(candidate.id) && candidate.source === "user").map((candidate) => candidate.text) });
			}
			return out;
		}, ctx);
	}

	private async pass(): Promise<void> {
		const { harness, root, models } = this.deps;
		const settings = this.deps.settings();
		if (settings.main === undefined) {
			this.deps.onStatus?.({ kind: "unconfigured" });
			return;
		}
		const snapshot = await harness.snapshot(PendingDoc, ctx);
		const all = [...(snapshot?.items ?? [])];
		// Held reports stay pending while their pipeline is live; user items go through as usual and never pull them in.
		const held = all.length > 0 && all.some((item) => item.source === "conclave") && (await this.deps.holdReports?.()) === true;
		const items = held ? all.filter((item) => item.source === "user") : all;
		if (items.length === 0) return;

		const done = await this.consumed(items);
		if (done.length > 0) {
			await this.removeItems(done.flatMap((entry) => entry.ids));
			for (const entry of done) {
				if (entry.record.status === "unanswered" && entry.texts.length > 0) this.deps.onRestore?.(entry.texts.join("\n"), entry.ids);
			}
			this.dirty = true;
			return;
		}

		const live = await harness.snapshot(LiveDoc, ROOT, ctx);
		if (live?.run !== undefined) {
			// Busy: user items steer the running turn with no marker. Conclave reports wait for idle.
			for (const item of items.filter((candidate) => candidate.source === "user")) {
				const submission = await submitSteer(root, contentFor([item]), `msg:${item.id}`);
				this.track([item], submission.wait(ctx), settings.main);
				await this.removeItems([item.id]);
				// A user steer ends a report-only turn (F3).
				if ((await harness.snapshot(TurnStateDoc, ctx))?.reportOnly === true) await harness.commit(async (tx) => { (await tx.doc(TurnStateDoc)).reportOnly = false; }, ctx);
			}
			return;
		}
		if (!(await isIdle(harness))) return;

		// 3a. Auth precheck: nothing is written when the model cannot authenticate.
		const { provider, modelId } = splitModelRef(settings.main);
		if (!(await hasAuth(models, provider))) {
			this.deps.onStatus?.({ kind: "login_required", provider });
			return;
		}
		const first = items[0]!;
		// 3b. Memory note: one write per change of the snapshot hash. It joins the log before the index commit, so the
		// index numbers it as a message in this turn. The request id keeps a replay after a crash from writing it twice.
		let note: ReturnType<NonNullable<TurnLoopDeps["memory"]>>;
		try {
			note = this.deps.memory?.(settings.cwd);
		} catch (error) {
			// A snapshot that cannot be read costs the note, never the turn.
			this.deps.onReport?.(error);
		}
		const before0 = await harness.snapshot(TurnStateDoc, ctx);
		const noteHash = note?.hash ?? "";
		const noted = note !== undefined && noteHash !== (before0?.noteHash ?? "");
		if (note !== undefined && noted) await submitNote(root, { at: (this.deps.now ?? Date.now)(), hash: note.hash, ids: note.ids, content: note.content }, `note:${note.hash}:${before0?.notes ?? 0}`);
		// 3c. Index commit: everything the root has logged so far becomes numbered messages.
		await this.deps.index?.indexNow();
		// 3d. Gate (D7): wait for the leaves the view needs, within gateTimeoutMs. A compactor that is not configured or
		// is disabled has no gate. A slow or failing one degrades the view to placeholders and the turn goes on. Nothing is
		// written while waiting, so a crash here leaves the items in `pending`.
		const label = this.deps.compactor?.() ?? "not configured";
		const cursor = await harness.snapshot(CursorDoc, ctx);
		const T = cursor?.T ?? 0;
		const gated = label === "configured" ? await this.deps.gate?.(T, this.halt.signal) : undefined;
		if (this.stopped) return;
		if (gated?.kind === "degraded") this.deps.onStatus?.({ kind: "compactor_degraded", message: gated.message });
		const before = await harness.snapshot(ViewDoc, ctx);
		const plan = await planAdvance(harness, before, T);
		// 3e. Turn commit: documents only. The view advances one message at a time up to T. A replay of the same
		// items keeps the original start time, so the marker and the turn block agree.
		const ids = items.map((item) => item.id);
		const instructions = this.deps.instructions?.();
		// H5: a plan lasts one user turn, so the turn commit clears the previous one.
		const hadPlan = ((await harness.snapshot(PlanDoc, ROOT, ctx))?.items.length ?? 0) > 0;
		const at = await root.commit(async (tx) => {
			const state = await tx.doc(TurnStateDoc);
			const replay = state.itemIds.length === ids.length && state.itemIds.every((id, k) => id === ids[k]);
			const when = replay ? state.at : (this.deps.now ?? Date.now)();
			await applyView(tx, before, plan);
			if (hadPlan) (await tx.doc(PlanDoc, ROOT)).items.splice(0);
			const windowStart = nextWindowStart(plan.lines, state.windowStart, label);
			state.itemIds = ids;
			state.cwd = settings.cwd;
			state.at = when;
			state.T = plan.T;
			state.windowStart = windowStart;
			state.compactor = label;
			// F3: a turn made only of Conclave reports may not write until the user sends something.
			state.reportOnly = !items.some((item) => item.source === "user");
			state.noteHash = noteHash;
			if (noted) state.notes = (state.notes ?? 0) + 1;
			// Migration: a stored selection that differs from the code's is replaced here, in the same configure as the rest.
			const agent = await tx.doc(AgentDoc, ROOT);
			const stored = agent.extensions;
			// An absent field means "keep"; null clears it. Null is sent only when something is stored, so an unchanged state adds no write.
			const clear = instructions === undefined && agent.instructions !== undefined;
			const names = this.deps.selection?.map((extension) => extension.name);
			const migrate = names !== undefined && (!Array.isArray(stored) || stored.join(",") !== names.join(","));
			await configure(tx, ROOT, { model: { provider, modelId }, thinkingLevel: settings.thinking as never, cwd: settings.cwd, ...(clear ? { instructions: null } : instructions === undefined ? {} : { instructions }), ...(migrate ? { extensions: this.deps.selection! } : {}) });
			return when;
		}, ctx);
		// 3f. Marker, asserted done.
		await submitTurn(root, { at, cwd: settings.cwd, items: items.map((item) => ({ id: item.id, source: item.source, member: item.member })) }, `turn:${first.id}`);
		// 3g. The input.
		const reportOnly = !items.some((item) => item.source === "user");
		const submission = await submitInput(root, [...contentFor(items), ...(reportOnly ? [{ type: "text" as const, text: REPORT_ONLY_NOTE }] : [])], `msg:${first.id}`);
		this.track(items, submission.wait(ctx), settings.main);
		// 3h. Remove what this turn consumed.
		await this.removeItems(items.map((item) => item.id));
	}

	private track(items: readonly PendingItem[], settled: Promise<SubmissionRecord>, model: string | undefined): void {
		const promise: Promise<SubmissionRecord | undefined> = settled.then(
			(record) => {
				const taken = this.deps.takeStop?.(); // taken on every settlement, so a reason left by a run that did not abort cannot reach a later abort
					const stop = record.status === "unanswered" && record.reason === "aborted" ? taken : undefined;
				if (stop !== undefined) {
					// H3: a named stop, not a failure. The turn's work stays in the chat, so the text is not put back.
					this.deps.onStatus?.({ kind: "stopped", reason: "stuck", message: stop });
				} else if (record.status === "unanswered") {
					const texts = items.filter((item) => item.source === "user").map((item) => item.text);
					if (texts.length > 0) this.deps.onRestore?.(texts.join("\n"), items.map((item) => item.id));
					// An abort or withdrawal is the user's own action. Anything else is a failed turn and is reported.
					if (record.reason !== "aborted" && record.reason !== "withdrawn") this.deps.onStatus?.({ kind: "turn_failed", model: model ?? "unknown model", message: failureText(record) });
				} else if (record.status === "done") this.deps.onStatus?.({ kind: "idle" });
				return record;
			},
			(error: unknown) => {
				if (!this.isCloseError(error)) this.deps.onReport?.(error);
				return undefined;
			},
		);
		for (const item of items) this.settled.set(item.id, promise);
		// Most turns are never asked about (the TUI does not), so consuming cannot be the only way out. Oldest entries go first.
		for (const id of this.settled.keys()) {
			if (this.settled.size <= SETTLED_KEEP) break;
			this.settled.delete(id);
		}
	}
}

/** Text of a failed turn: the provider detail when there is one, else the settlement reason. */
export function failureText(record: { reason?: string; detail?: unknown }): string {
	const detail = record.detail;
	if (typeof detail === "string" && detail.length > 0) return detail;
	if (detail !== undefined && detail !== null) return JSON.stringify(detail);
	return record.reason ?? "the turn failed";
}

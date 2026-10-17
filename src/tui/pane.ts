import { createElement, useEffect, useState, type ReactElement } from "react";
import { Box } from "ink";
import { ctx, LiveDoc, recentEntries } from "../durable.ts";
import type { Runtime } from "../runtime.ts";
import type { Progress, ProgressRow } from "../conclave/pipeline.ts";
import { redactSensitive } from "../redact.ts";
import { rowsOf } from "./sanitize.ts";
import { tailOf, thinkingBlocksOf } from "./thinking/state.ts";
import type { ThinkingSourceBlock } from "./thinking/types.ts";
import { thinkingLines, type ThinkingView } from "./thinking/view.ts";
import stringWidth from "string-width";
import { CONCLAVE_MEMBERS } from "../config.ts";
import { panelFrame, type PanelData } from "./panel.ts";
import { THEME } from "./theme.ts";
import { clip, spanLine, wrap, type FrameLine, type Span } from "./viewport.ts";

// The Conclave pane (P5b). It is built from committed state: Conclave.progress() for the members, the running member's
// last entries and the committed partial of its current answer for the stream. Nothing here runs unless a pipeline
// exists, and the child text is bounded: at most CHILD_ENTRIES entries are read, at most CHILD_LINES lines are shown,
// and each line is cut to CLIP characters.

/** From this many columns the pane sits to the right of the chat. Below it the pane goes under the chat at full width. */
export const SIDE_BY_SIDE_MIN_COLUMNS = 100;
export const CHILD_ENTRIES = 12;
export const CHILD_LINES = { side: 10, stacked: 4 } as const;
const CLIP = 200;
const THROTTLE_MS = 250;

export interface PaneModel extends Progress {
	/** The running member's recent lines, oldest first. */
	child: string[];
	/** Thinking blocks of the member's newest response. A finished response is cut to its trailing 32,000 code points (D23); the live partial is whole, and StepMemo parses its tail. */
	thinking?: { id: string; live: boolean; blocks: ThinkingSourceBlock[] };
}

type Block = { type?: string; text?: string; name?: string; arguments?: unknown };
const oneLine = (text: string): string => {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.slice(0, CLIP);
};

const ARGUMENT_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "name"];

/** A tool call as its name and one short argument. The argument is the first string among the usual keys, else the first string value, redacted and cut to 60. */
export function toolCallParts(block: { name?: string; arguments?: unknown }): { name: string; arg?: string } {
	const name = block.name ?? "?";
	const args = block.arguments;
	if (args === null || typeof args !== "object" || Array.isArray(args)) return { name };
	const record = args as Record<string, unknown>;
	const value = ARGUMENT_KEYS.map((key) => record[key]).find((v) => typeof v === "string") ?? Object.values(record).find((v) => typeof v === "string");
	const flat = typeof value === "string" ? redactSensitive(value.replace(/\s+/gu, " ").trim()) : "";
	return flat === "" ? { name } : { name, arg: [...flat].slice(0, 60).join("") };
}

/** A tool call as one short phrase: `[tool bash: npm run build]`. */
export function toolCallText(block: { name?: string; arguments?: unknown }): string {
	const { name, arg } = toolCallParts(block);
	return arg === undefined ? `[tool ${name}]` : `[tool ${name}: ${arg}]`;
}

export const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? (content as Block[]).map((block) => (block?.type === "text" ? block.text ?? "" : block?.type === "toolCall" ? ` ${toolCallText(block)} ` : "")).join("") : "";
};

const capped = (blocks: ThinkingSourceBlock[]): ThinkingSourceBlock[] => blocks.map((block) => ({ ...block, text: tailOf(block.text) }));

/** Lines of the member's recent entries, oldest first, the committed partial of the answer being written, and its newest thinking. */
async function childView(rt: Runtime, conv: number): Promise<{ lines: string[]; thinking?: PaneModel["thinking"] }> {
	const child = await rt.harness.conversation(conv as never, ctx);
	if (child === undefined) return { lines: [] };
	const lines: string[] = [];
	let thinking: PaneModel["thinking"];
	for (const entry of (await recentEntries(child, CHILD_ENTRIES)).slice().reverse()) {
		const message = (entry.model as Array<{ role?: string; content?: unknown; toolName?: string }> | undefined)?.[0];
		if (message === undefined || message.role === "user") continue;
		const text = oneLine(textOf(message.content));
		if (text !== "") lines.push(message.role === "toolResult" ? `${message.toolName ?? "tool"} result: ${text}` : text);
		if (message.role === "assistant") {
			const blocks = thinkingBlocksOf(message);
			thinking = blocks.length === 0 ? undefined : { id: String(entry.id), live: false, blocks: capped(blocks) };
		}
	}
	const generation = (await rt.harness.snapshot(LiveDoc, conv as never, ctx))?.generation;
	const partial = generation?.message as { content?: unknown } | undefined;
	const live = oneLine(textOf(partial?.content));
	if (live !== "") lines.push(`${live} (writing)`);
	const liveBlocks = thinkingBlocksOf(partial);
	// The live text is not cut here: StepMemo keys on the whole length and parses only its own tail, so the steps keep moving past the cap.
	if (generation !== undefined && liveBlocks.length > 0) thinking = { id: `live:${generation.attempt}`, live: true, blocks: liveBlocks };
	return { lines, ...(thinking === undefined ? {} : { thinking }) };
}

export async function readPane(rt: Runtime): Promise<PaneModel | undefined> {
	const progress = await rt.conclave.progress();
	if (progress === undefined) return undefined;
	if (progress.active === undefined) return { ...progress, child: [] };
	const view = await childView(rt, progress.active.conv);
	return { ...progress, child: view.lines, ...(view.thinking === undefined ? {} : { thinking: view.thinking }) };
}

/**
 * Follows the pipeline. The task graph watch reports when a pipeline task starts or ends; while one is live, commits
 * also refresh the pane so the child stream moves. With no pipeline the commit listener does nothing.
 */
export function usePane(rt: Runtime): PaneModel | undefined {
	const [model, setModel] = useState<PaneModel | undefined>(undefined);
	useEffect(() => {
		let alive = true;
		let scheduled = false;
		let active = false;
		let last = "";
		const refresh = async (): Promise<void> => {
			scheduled = false;
			if (!alive) return;
			try {
				const next = await readPane(rt);
				if (!alive) return;
				active = next?.live === true;
				const key = JSON.stringify(next ?? null);
				if (key !== last) { last = key; setModel(next); }
			} catch {
				// the session closed while a refresh was in flight
			}
		};
		const schedule = (): void => { if (!scheduled) { scheduled = true; setTimeout(() => { void refresh(); }, THROTTLE_MS).unref(); } };
		const stopCommits = rt.harness.subscribeCommits(() => { if (active) schedule(); });
		let watch: Awaited<ReturnType<Runtime["harness"]["watchTaskGraph"]>> | undefined;
		void rt.harness.watchTaskGraph(ctx).then((handle) => {
			if (!alive) { void handle.stop(); return; }
			watch = handle;
			handle.start(async () => { schedule(); });
		}).catch(() => {});
		void refresh();
		return () => { alive = false; stopCommits(); void watch?.stop(); };
	}, [rt]);
	return model;
}

const COLORS: Record<ProgressRow["state"], string | undefined> = { waiting: undefined, running: THEME.warn, done: THEME.ok, partial: THEME.warn, blocked: THEME.error, failed: THEME.error, "awaiting approve": THEME.accentText, "not run": undefined };
/** The framed pane colors every state, waiting and not run included. */
const STATE_COLORS: Record<ProgressRow["state"], string> = { waiting: THEME.muted, running: THEME.accentText, done: THEME.ok, partial: THEME.warn, blocked: THEME.error, failed: THEME.error, "awaiting approve": THEME.accentText, "not run": THEME.muted };

/** A pipeline is shown in full while it is live, waiting for approval, or stopped with a failed member. Otherwise it collapses to its outcome. */
export const paneVisible = (model: PaneModel): boolean => model.live || model.rows.some((row) => row.state === "awaiting approve" || row.state === "failed" || row.state === "partial" || row.state === "blocked");

/** The pane. `stacked` is the narrow layout: the same rows, fewer stream lines. A pipeline that ended without a failure collapses to its outcome. */
export function ConclavePane({ model, width, maxRows, stacked, thinking, framed }: { model: PaneModel; width: number; maxRows: number; stacked: boolean; thinking?: ThinkingView; framed?: boolean }): ReactElement {
	return createElement(Box, { flexDirection: "column" }, ...rowsOf(paneLines(model, width, maxRows, thinking, stacked, framed), "p"));
}

/** What the user can do next, by the state of the pipeline. */
function paneHint(model: PaneModel): string {
	if (model.live) return "/conclave cancel stops it";
	if (model.rows.some((row) => row.state === "awaiting approve")) return "/conclave approve runs Vesperia";
	return model.mode === "execute" ? "/conclave approve runs Vesperia again" : "/conclave <task> starts a new review";
}

/** The progress bar of the framed pane: filled cells for the members that are done, and the count. */
function progressRow(model: PaneModel, w: number): FrameLine {
	const done = model.rows.filter((row) => row.state === "done").length;
	const cells = Math.max(4, w - 6);
	const filled = model.rows.length === 0 ? 0 : Math.round((done / model.rows.length) * cells);
	return spanLine([{ text: "━".repeat(filled), color: THEME.accent }, { text: "─".repeat(cells - filled), color: THEME.border }, { text: ` ${done}/${model.rows.length}`, color: THEME.muted }], w);
}

type Part = "stream" | "thinking" | "header" | "progress" | "idle" | "done" | "hint" | "other" | "running" | "title";
/** Rows leave in this order when the pane has too few. Inside a part: stream and done rows leave oldest first, hints last first, thinking and the rest from the bottom. */
const DROP_ORDER: readonly Part[] = ["stream", "thinking", "header", "progress", "idle", "done", "hint", "other", "running", "title"];
const FROM_TOP = new Set<Part>(["stream", "done"]);

/**
 * The pane as rows of at most `width` columns, in at most `maxRows` rows. A pipeline that ended without a failure
 * collapses to its title and outcome (the outcome stays when there is room for one row). Otherwise it is the title, the
 * members, the running member's thinking and stream, and a hint; rows leave in DROP_ORDER until the rest fits.
 * Framed (P18): the title has a diamond, a progress bar follows it, and each member row is a colored dot, the name and a right-aligned state word.
 */
export function paneLines(model: PaneModel, width: number, maxRows: number, thinking?: ThinkingView, stacked = false, framed = false): FrameLine[] {
	if (maxRows <= 0) return [];
	const w = Math.max(1, width);
	const titleText = `Conclave ${model.mode === "review" ? "review" : "execution"}`;
	const title: FrameLine = { text: clip(framed ? `◆ ${titleText}` : titleText, w), bold: true };
	if (!paneVisible(model)) {
		const outcome: FrameLine = { text: clip(model.outcome === "" ? "ended" : model.outcome, w), dim: true };
		return maxRows >= 2 ? [title, outcome] : [outcome];
	}
	const limit = stacked ? CHILD_LINES.stacked : CHILD_LINES.side;
	const items: Array<{ part: Part; line: FrameLine }> = [{ part: "title", line: title }];
	if (framed) items.push({ part: "progress", line: progressRow(model, w) });
	for (const row of model.rows) {
		const part: Part = row.state === "running" ? "running" : row.state === "done" ? "done" : row.state === "waiting" || row.state === "not run" ? "idle" : "other";
		if (framed) {
			const color = STATE_COLORS[row.state];
			const left = `● ${row.name}${row.detail === undefined ? "" : ` (${row.detail})`}`;
			const gap = Math.max(1, w - stringWidth(left) - stringWidth(row.state));
			items.push({ part, line: spanLine([{ text: "● ", color }, { text: row.name }, ...(row.detail === undefined ? [] : [{ text: ` (${row.detail})`, color: THEME.muted }]), { text: " ".repeat(gap) }, { text: row.state, color }], w) });
			continue;
		}
		items.push({ part, line: { text: clip(`${row.name}: ${row.state}${row.detail === undefined ? "" : ` (${row.detail})`}`, w), ...(COLORS[row.state] === undefined ? {} : { color: COLORS[row.state]! }), ...(part === "idle" ? { dim: true } : {}) } });
	}
	const stream = model.child.slice(-limit);
	if (model.active !== undefined && (stream.length > 0 || thinking !== undefined)) {
		items.push({ part: "header", line: framed ? { text: clip(`▸ ${model.active.name}`, w), bold: true, color: THEME.accentText } : { text: clip(`${model.active.name}:`, w), bold: true } });
		if (thinking !== undefined) for (const line of thinkingLines(thinking, w, { truncate: true, maxRows: limit })) items.push({ part: "thinking", line });
		for (const text of stream) items.push({ part: "stream", line: { text: clip(text, w), dim: true } });
	}
	for (const text of wrap(paneHint(model), w)) items.push({ part: "hint", line: { text, dim: true } });
	while (items.length > maxRows) {
		const part = DROP_ORDER.find((p) => items.some((item) => item.part === p))!;
		const at = FROM_TOP.has(part) ? items.findIndex((item) => item.part === part) : items.map((item) => item.part).lastIndexOf(part);
		items.splice(at, 1);
	}
	return items.map((item) => item.line);
}

/* --- pills, and the right panel of the framed side-by-side layout (P19) --------------------------------------------------- */

export type PillState = ProgressRow["state"] | "idle";
const LIGHT = "#FFFFFF";
const DARK = "#1A1A1A";
/** Background and text color of a pill, by state. */
const PILL_COLORS: Record<PillState, { bg: string; color: string }> = {
	running: { bg: THEME.accent, color: LIGHT }, "awaiting approve": { bg: THEME.accent, color: LIGHT },
	done: { bg: THEME.ok, color: DARK }, failed: { bg: THEME.error, color: DARK }, blocked: { bg: THEME.error, color: DARK }, partial: { bg: THEME.warn, color: DARK },
	waiting: { bg: THEME.border, color: LIGHT }, "not run": { bg: THEME.border, color: LIGHT }, idle: { bg: THEME.border, color: LIGHT },
};

/** A state as a badge: its word with a space on each side. `short` swaps the two long words (`awaiting approve` is `approve`, `not run` is `idle`). */
export function pill(state: PillState, short = false): Span {
	const word = short ? (state === "awaiting approve" ? "approve" : state === "not run" ? "idle" : state) : state;
	return { text: ` ${word} `, ...PILL_COLORS[state] };
}

/** `45s`, `2m 14s`, `1h 03m`. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The seat of each progress row: the seats in CONCLAVE_MEMBERS order, and the final-plan row is Samaela's second run. */
export function seatsOf(rows: readonly ProgressRow[]): string[] {
	let next = 0;
	return rows.map((row) => (row.name.endsWith(" (final plan)") ? "samaela" : CONCLAVE_MEMBERS[next++] ?? row.name));
}

export interface UsageInput {
	input?: number;
	output?: number;
	cacheRead: number;
	cacheWrite: number;
	contextWindow?: number;
}

export interface RightPanelInput {
	model?: PaneModel;
	session: PanelData;
	usage?: UsageInput;
	/** Seat name to its description. */
	describe: Record<string, string>;
	thinking?: ThinkingView;
	/** The local HH:MM of an epoch time in ms. */
	formatTime: (ms: number) => string;
}

type RPart = "title" | "progress" | "session" | "member" | "row2" | "desc" | "header" | "thinking" | "stream" | "hint" | "actTitle" | "actEvent" | "actDetail" | "rule" | "useTitle" | "useRow" | "useContext";
interface RItem { part: RPart; line: FrameLine; running?: boolean; kind?: "idle" | "done" | "other" | "running"; tag?: string }

/** Rows leave in this order when the panel has too few. A step takes one row at a time, from the bottom unless `top`. */
const R_STEPS: ReadonlyArray<{ match: (item: RItem) => boolean; top?: boolean }> = [
	{ match: (i) => i.part === "desc" && i.running !== true },
	{ match: (i) => i.part === "actDetail" },
	{ match: (i) => i.part === "actEvent" },
	{ match: (i) => i.part === "stream", top: true },
	{ match: (i) => i.part === "thinking" },
	{ match: (i) => i.part === "rule" },
	{ match: (i) => i.part === "row2" && i.running !== true },
	{ match: (i) => i.part === "hint" },
	{ match: (i) => i.part === "desc" },
	{ match: (i) => i.part === "row2" },
	{ match: (i) => i.part === "useRow" },
	{ match: (i) => i.part === "useContext" },
	{ match: (i) => i.part === "useTitle" },
	{ match: (i) => i.part === "session" },
	{ match: (i) => i.part === "progress" },
	{ match: (i) => i.part === "header" },
	{ match: (i) => i.part === "member" && i.kind === "idle" },
	{ match: (i) => i.part === "member" && i.kind === "done", top: true },
	{ match: (i) => i.part === "member" && i.kind === "other" },
	{ match: (i) => i.part === "member" && i.kind === "running" },
	{ match: (i) => i.part === "title" },
];

/** A title leaves with its last event, and a rule stays only between two rows that are not rules: never first, last or doubled. */
function tidy(items: RItem[]): RItem[] {
	const live = items.some((item) => item.part === "actEvent") ? items : items.filter((item) => item.part !== "actTitle");
	const out: RItem[] = [];
	live.forEach((item, k) => {
		if (item.part !== "rule" || (out.length > 0 && out.at(-1)!.part !== "rule" && live[k + 1] !== undefined && live[k + 1]!.part !== "rule")) out.push(item);
	});
	return out;
}

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * The right box of the framed side-by-side layout, in at most `maxRows` rows of at most `width` columns: the title, the progress row (or the
 * session rows), a block per member (name and pill, a muted row of duration, turn and detail, the description), the running member's thinking
 * and stream, the hint, Recent Activity and Resource Usage. Rows leave in R_STEPS order. `usage` says whether the Input row and the Read row
 * (with the Cache row) survived: the input strip and the cache counts of the status row give way to them.
 */
export function rightPanelLines(input: RightPanelInput, width: number, maxRows: number): { lines: FrameLine[]; usage: { input: boolean; cache: boolean } } {
	const none = { lines: [], usage: { input: false, cache: false } };
	if (maxRows <= 0) return none;
	const w = Math.max(1, width);
	const { model } = input;
	const visible = model !== undefined && paneVisible(model);
	let items: RItem[] = [];
	const add = (part: RPart, line: FrameLine, extra: Partial<RItem> = {}): void => { items.push({ part, line, ...extra }); };
	const rule = (): void => { add("rule", spanLine([{ text: "─".repeat(w), color: THEME.border }], w)); };
	const title = (text: string): FrameLine => spanLine([{ text, bold: true }], w);
	add("title", title(visible ? `◆ Conclave ${model.mode === "review" ? "review" : "execution"}` : "◆ Session"));
	if (visible) add("progress", progressRow(model, w));
	else for (const line of panelFrame(input.session, w).slice(1)) add("session", line);

	// Members: one block per seat. Without a visible pipeline every seat is idle.
	const seats = visible ? seatsOf(model.rows) : [...CONCLAVE_MEMBERS];
	const members = visible ? model.rows : CONCLAVE_MEMBERS.map((seat): ProgressRow => ({ name: seat[0]!.toUpperCase() + seat.slice(1), state: "waiting" }));
	rule();
	members.forEach((row, k) => {
		const state: PillState = visible ? row.state : "idle";
		const running = state === "running";
		const kind = running ? "running" : state === "done" ? "done" : state === "waiting" || state === "not run" || state === "idle" ? "idle" : "other";
		let badge = pill(state);
		if (2 + stringWidth(row.name) + 1 + stringWidth(badge.text) > w) badge = pill(state, true);
		const room = Math.max(1, w - 2 - 1 - stringWidth(badge.text));
		const name = stringWidth(row.name) > room ? clip(row.name, room) : row.name;
		const gap = Math.max(1, w - 2 - stringWidth(name) - stringWidth(badge.text));
		add("member", spanLine([{ text: "● ", color: STATE_COLORS[row.state] }, { text: name }, { text: " ".repeat(gap) }, badge], w), { running, kind });
		const turn = running && model?.active?.name === row.name && model.active.turns !== undefined && model.active.maxTurns !== undefined ? `turn ${Math.min(model.active.turns + 1, model.active.maxTurns)} of ${model.active.maxTurns}` : undefined;
		const parts = [
			...(turn === undefined ? [] : [turn]),
			...(running && row.start !== undefined ? [`since ${input.formatTime(row.start)}`] : []),
			...(!running && row.start !== undefined && row.end !== undefined ? [formatDuration(row.end - row.start)] : []),
			...(visible && row.detail !== undefined ? [row.detail] : []),
		];
		if (parts.length > 0) add("row2", spanLine([{ text: `  ${parts.join(" · ")}`, color: THEME.muted }], w), { running });
		const description = input.describe[seats[k] ?? ""];
		if (description !== undefined && description !== "") add("desc", spanLine([{ text: `  ${clip(description, Math.max(1, w - 2))}`, color: THEME.muted }], w), { running });
	});

	// The running member's thinking and stream, then the hint.
	if (visible) {
		if (model.active !== undefined && (model.child.length > 0 || input.thinking !== undefined)) {
			add("header", { text: clip(`▸ ${model.active.name}`, w), bold: true, color: THEME.accentText });
			if (input.thinking !== undefined) for (const line of thinkingLines(input.thinking, w, { truncate: true, maxRows: CHILD_LINES.side })) add("thinking", line);
			for (const text of model.child.slice(-CHILD_LINES.side)) add("stream", { text: clip(text, w), dim: true });
		}
		for (const text of wrap(paneHint(model), w)) add("hint", { text, dim: true });
	}

	// Recent Activity: starts and ends, newest first (an end before a start at the same time, then seat order), two rows each.
	// Without a timed run the section still shows, with one muted row that leaves like an event.
	{
		const events = (model?.rows ?? [])
			.flatMap((row, k) => [...(row.start === undefined ? [] : [{ ms: row.start, end: false, k, row }]), ...(row.end === undefined ? [] : [{ ms: row.end, end: true, k, row }])])
			.sort((a, b) => b.ms - a.ms || (a.end === b.end ? a.k - b.k : a.end ? -1 : 1))
			.slice(0, 8);
		rule();
		add("actTitle", title("◆ Recent Activity"));
		if (events.length === 0) add("actEvent", spanLine([{ text: "no conclave run yet", color: THEME.muted }], w));
		for (const { ms, end, row } of events) {
			const state = end ? row.state : "running";
			add("actEvent", spanLine([{ text: input.formatTime(ms), color: THEME.muted }, { text: "  " }, { text: row.name }, { text: " → ", color: THEME.muted }, { text: state, color: STATE_COLORS[state] }], w));
			const detail = !end ? "started" : state === "done" ? row.verdict : row.detail ?? row.verdict;
			if (detail !== undefined && detail !== "") add("actDetail", spanLine([{ text: `       ${detail}`, color: THEME.muted }], w));
		}
	}

	// Resource Usage: the last reply of the main chat.
	const { usage } = input;
	if (usage !== undefined) {
		const prompt = (usage.input ?? 0) + usage.cacheRead + usage.cacheWrite;
		const row = (label: string, value: string, tag: string): void => add("useRow", spanLine([{ text: label.padEnd(8), color: THEME.muted }, { text: value }], w), { tag });
		rule();
		add("useTitle", title("◆ Resource Usage"));
		if (usage.input !== undefined) row("Input", `${NUMBER.format(usage.input)} tokens`, "input");
		if (usage.output !== undefined) row("Output", `${NUMBER.format(usage.output)} tokens`, "output");
		row("Read", `${NUMBER.format(usage.cacheRead)} tokens`, "read");
		if (prompt > 0) row("Cache", `${Math.round((usage.cacheRead / prompt) * 100)}%`, "cache");
		if (usage.contextWindow !== undefined && usage.contextWindow > 0) {
			const percent = Math.round(((prompt + (usage.output ?? 0)) / usage.contextWindow) * 100);
			const filled = Math.min(10, Math.max(0, percent > 0 ? Math.max(1, Math.round(percent / 10)) : 0));
			add("useContext", spanLine([{ text: "Context ", color: THEME.muted }, { text: `${percent}%` }, { text: " " }, { text: "━".repeat(filled), color: THEME.accent }, { text: "─".repeat(10 - filled), color: THEME.border }], w));
		}
	}

	items = tidy(items);
	while (items.length > maxRows) {
		const step = R_STEPS.find((s) => items.some(s.match));
		const at = step === undefined ? items.length - 1 : step.top === true ? items.findIndex(step.match) : items.map(step.match).lastIndexOf(true);
		items.splice(at, 1);
		items = tidy(items);
	}
	return { lines: items.map((item) => item.line), usage: { input: items.some((item) => item.tag === "input"), cache: items.some((item) => item.tag === "read") } };
}

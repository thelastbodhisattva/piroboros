import stringWidth from "string-width";
import { sanitizeTerminal } from "./sanitize.ts";
import { THEME } from "./theme.ts";

// Pure layout helpers for the setup screens. Nothing here touches Ink or the terminal.

const segmenter = new Intl.Segmenter();

/** Split `text` after the longest run of whole characters that fits `width` columns; `force` takes one character even when it is wider. */
function takeColumns(text: string, width: number, force = false): [string, string] {
	let used = 0;
	let head = "";
	for (const { segment } of segmenter.segment(text)) {
		const w = stringWidth(segment);
		if (used + w > width && !(force && head === "")) break;
		used += w;
		head += segment;
	}
	return [head, text.slice(head.length)];
}

/**
 * Word-wrap text to `width` columns. Long words are split. Text is sanitized first so control characters cannot change the layout.
 * Indentation and runs of spaces are kept; only the space at a break is dropped. A tab is 4 spaces. Rows after the first repeat
 * the indentation when it is under half the width.
 */
export function wrap(text: string, width: number): string[] {
	const w = Math.max(1, width);
	const out: string[] = [];
	for (const raw of sanitizeTerminal(text).split("\n")) {
		const paragraph = raw.replace(/\t/gu, "    ");
		const lead = /^ */u.exec(paragraph)![0];
		const indent = lead.length * 2 < w ? lead : "";
		const parts = paragraph.slice(lead.length).split(/( +)/u); // words and the space runs between them, alternating
		let line = indent;
		let filled = false;
		for (let i = 0; i < parts.length; i += 2) {
			let rest = parts[i]!;
			if (rest === "") continue;
			let gap = i === 0 ? "" : parts[i - 1]!;
			if (filled && stringWidth(line) + gap.length + stringWidth(rest) > w) { out.push(line); line = indent; filled = false; }
			if (!filled) gap = "";
			while (stringWidth(line) + stringWidth(rest) > w) {
				const [head, more] = takeColumns(rest, Math.max(1, w - stringWidth(line)), true);
				if (more === "") { rest = head; break; } // a wide character wider than the line
				out.push(line + head);
				line = indent;
				rest = more;
			}
			line += gap + rest;
			filled = true;
		}
		out.push(filled ? line : "");
	}
	return out;
}

/** The last columns of `text` that fit `width`, with newlines shown as spaces. The input row uses it so a long draft shows its end. */
export function tail(text: string, width: number): string {
	const parts = [...segmenter.segment(sanitizeTerminal(text).replace(/\n/gu, " "))].map((part) => part.segment);
	let used = 0;
	let from = parts.length;
	while (from > 0) {
		const w = stringWidth(parts[from - 1]!);
		if (used + w > width) break;
		used += w;
		from -= 1;
	}
	return parts.slice(from).join("");
}

/** Cut one line to `width` columns, ending in an ellipsis when it was shortened. */
export function clip(line: string, width: number): string {
	const text = sanitizeTerminal(line).replace(/\n/gu, " ");
	if (stringWidth(text) <= width) return text;
	return width <= 1 ? takeColumns(text, width)[0] : `${takeColumns(text, width - 1)[0]}…`;
}

/** Case-insensitive substring filter on the label. */
export function filterByLabel<T extends { label: string }>(items: readonly T[], filter: string): T[] {
	const needle = filter.toLowerCase();
	return needle === "" ? [...items] : items.filter((item) => item.label.toLowerCase().includes(needle));
}

export interface Window {
	offset: number;
	start: number;
	end: number;
}

/** Keep `index` inside a window of `height` rows starting at `offset`. `end` is exclusive. */
export function windowFor(total: number, index: number, offset: number, height: number): Window {
	const h = Math.max(1, height);
	let o = Math.min(Math.max(0, offset), Math.max(0, total - h));
	if (index < o) o = index;
	else if (index >= o + h) o = index - h + 1;
	o = Math.min(Math.max(0, o), Math.max(0, total - h));
	return { offset: o, start: total === 0 ? 0 : o, end: Math.min(total, o + h) };
}

/** "12-30 of 45", or "no matches". */
export function indicator(start: number, end: number, total: number): string {
	return total === 0 ? "no matches" : `${start + 1}-${end} of ${total}`;
}

/** A run of a row with its own style. The span texts joined are the row's `text`. */
export interface Span {
	text: string;
	color?: string;
	/** A background color (a pill badge). It changes no width. */
	bg?: string;
	bold?: boolean;
}

/** `text` without its last whole character (a grapheme: an emoji or a letter with a mark goes at once). */
export function dropLast(text: string): string {
	const parts = [...segmenter.segment(text)];
	return parts.slice(0, -1).map((part) => part.segment).join("");
}

export interface FrameLine {
	text: string;
	dim?: boolean;
	bold?: boolean;
	color?: string;
	/** When present the row is drawn from the spans, and `text` (their joined text) is what width math reads. */
	spans?: Span[];
}

/** The spans of a row: its own, or one span with the row's style (dim is the muted color). */
export function spansOf(line: FrameLine): Span[] {
	if (line.spans !== undefined) return line.spans;
	const color = line.color ?? (line.dim === true ? THEME.muted : undefined);
	return [{ text: line.text, ...(color === undefined ? {} : { color }), ...(line.bold === true ? { bold: true } : {}) }];
}

/**
 * Cut spans to `width` columns exactly as clip() cuts their joined text, and give the ellipsis to the span where the cut lands.
 * Each span is sanitized first, so offsets match what is drawn. Spans are only made at boundaries the caller chooses
 * (label, gap, value), so a cluster never straddles two spans and the cut can be mapped back by length.
 */
export function spanRow(spans: readonly Span[], width: number): Span[] {
	const clean = spans.map((span) => ({ ...span, text: sanitizeTerminal(span.text).replace(/\n/gu, " ") }));
	const text = clean.map((span) => span.text).join("");
	if (stringWidth(text) <= width) return clean;
	const head = takeColumns(text, width <= 1 ? width : width - 1)[0];
	const ellipsis = width <= 1 ? "" : "…";
	const out: Span[] = [];
	let left = head.length;
	for (const span of clean) {
		if (left <= 0) break;
		const piece = span.text.slice(0, left);
		left -= piece.length;
		if (piece !== "") out.push({ ...span, text: piece });
	}
	if (ellipsis === "") return out;
	const last = out.at(-1) ?? clean[0];
	if (last === undefined) return [];
	if (out.length === 0) out.push({ ...last, text: "" });
	out[out.length - 1] = { ...out[out.length - 1]!, text: out[out.length - 1]!.text + ellipsis };
	return out;
}

/** A row drawn from spans, cut to `width`. */
export function spanLine(spans: readonly Span[], width: number): FrameLine {
	const cut = spanRow(spans, width);
	return { text: cut.map((span) => span.text).join(""), spans: cut };
}

/** What the frame would like to show, in rows. Arrays hold the rows of each item, oldest first. */
export interface Want {
	picker: number;
	alerts: number;
	notes: number[];
	standing: number[];
	queued: number;
	hint: number;
	pane: number;
	stacked: boolean;
	/** Rows of box borders and the header, taken right after the input and status rows. 0 when the frame is not boxed. */
	chrome?: number;
	/** The live rows at the bottom of the chat box: 0 or 2, taken all or nothing after the pane. */
	live?: number;
}

export interface Alloc {
	input: number;
	status: number;
	chat: number;
	picker: number;
	alerts: number;
	notes: number[];
	standing: number[];
	queued: number;
	hint: number;
	/** Rows of the pane under the chat; 0 when the pane is beside it. */
	pane: number;
	/** The live rows inside the chat box (a rule and a status row), 0 when there is no room. */
	live: number;
}

/**
 * Split the terminal height between the parts of the frame. The frame is at most `rows - 1` lines, because Ink clears a
 * Windows console when a frame is as tall as the terminal. Each step takes what it wants from what is left, in this
 * order: input, status, the chrome (header and box borders), a reserve of 3 chat rows, the command list, alerts (2 at most), replies (newest first), standing
 * rows, queued items (3 at most), the key hint (only with 3 spare rows), then the chat takes the rest.
 */
export function allocate(rows: number, want: Want): Alloc {
	let left = Math.max(0, rows - 1);
	const take = (n: number, cap = Number.POSITIVE_INFINITY): number => { const got = Math.max(0, Math.min(n, cap, left)); left -= got; return got; };
	const input = take(1);
	const status = take(1);
	take(want.chrome ?? 0);
	const reserve = take(3);
	const picker = take(want.picker);
	const alerts = take(want.alerts, 2);
	const notes = want.notes.map(() => 0);
	for (let i = want.notes.length - 1; i >= 0; i -= 1) notes[i] = take(want.notes[i]!);
	const standing = want.standing.map((n) => take(n));
	const queued = take(want.queued, 3);
	const hint = left >= 3 ? take(Math.min(1, want.hint)) : 0;
	let chat = reserve + left;
	let pane = 0;
	if (want.stacked && chat - 6 >= 2) {
		pane = Math.min(want.pane, chat - 6);
		if (pane >= 2) chat -= pane + 1;
		else pane = 0;
	}
	// The live rows come after the pane and keep the chat at 4 rows or more.
	let live = 0;
	if ((want.live ?? 0) >= 2 && chat >= 6) { live = 2; chat -= 2; }
	return { input, status, chat, picker, alerts, notes, standing, queued, hint, pane, live };
}

export interface ChatWindow {
	start: number;
	end: number;
	/** Rows above the bottom that the view is scrolled, clamped. */
	offset: number;
	/** Rows hidden above and below the shown rows. */
	earlier: number;
	newer: number;
	/** The top row is the indicator, not chat. */
	indicator: boolean;
}

/** Which of `total` chat rows show in `height` rows when the view is `offset` rows above the bottom. At height 2 or more the top row is the indicator. */
export function chatWindow(total: number, height: number, offset: number): ChatWindow {
	if (total <= height) return { start: 0, end: total, offset: 0, earlier: 0, newer: 0, indicator: false };
	const indicator = height >= 2;
	const content = Math.max(0, indicator ? height - 1 : height);
	const o = Math.min(Math.max(0, offset), total - content);
	const end = total - o;
	const start = Math.max(0, end - content);
	return { start, end, offset: o, earlier: start, newer: o, indicator };
}

/** The indicator row of a chat that is longer than its space. */
export function chatIndicator(earlier: number, newer: number): string {
	const count = (n: number, word: string): string => `${n} ${word} ${n === 1 ? "line" : "lines"}`;
	if (newer === 0) return `${count(earlier, "earlier")}, PgUp scrolls`;
	return earlier === 0 ? `${count(newer, "newer")}, End returns` : `${count(earlier, "earlier")}, ${count(newer, "newer")}, End returns`;
}

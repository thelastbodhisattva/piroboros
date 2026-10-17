// The view (D5): the list of tree nodes that covers the whole chat, oldest first. Everything here is pure, so the
// merge order can be checked against the push oracle and a crash cannot leave a half-applied rule.
//
// A line is [level, index, text]. Line (l, i) covers the 2^l messages from i * 2^l on and is shown as
// `id+n|text`. A null text is a leaf that has no node yet; it is shown as a placeholder and never as text.

export const VIEW_MAX = 128_000;
export const VIEW_TARGET = 64_000;
export const WINDOW_MAX = 128_000;
export const WINDOW_TARGET = 96_000;
export const NODE_TEXT_MAX = 512;
export const LINES_PER_BLOCK = 4;
export const BANNER_WARN_BYTES = 64_000;
export const BANNER_ESCALATE_BYTES = 512_000;
export const PLACEHOLDER = "(not summarized yet: zoom it)";

export type Line = [level: number, index: number, text: string | null];

export interface ViewState {
	lines: Line[];
	/** Counted bytes of every line. */
	bytes: number;
	/** Messages the view covers. */
	T: number;
	/** A batch could not reach the target because parents were unbuilt; keep merging at every message. */
	shrinking: boolean;
	/** Counts batches. The compaction view merges when this changes. */
	batchSeq: number;
}

export const emptyView = (): ViewState => ({ lines: [], bytes: 0, T: 0, shrinking: false, batchSeq: 0 });
export const cloneView = (view: ViewState): ViewState => ({ ...view, lines: view.lines.map((line) => [...line] as Line) });

export interface Nodes {
	/** Text of the built node (level, index), or undefined when it is not built. */
	get(level: number, index: number): string | undefined;
}

export const lineFirst = (line: Line): number => line[1] * 2 ** line[0];
export const lineSize = (line: Line): number => 2 ** line[0];

/** The line as the model reads it, newline included. */
export const lineText = (line: Line): string => `${lineFirst(line)}+${lineSize(line)}|${(line[2] ?? PLACEHOLDER).replace(/\n/gu, " ")}\n`;
export const lineBytes = (line: Line): number => Buffer.byteLength(lineText(line));
export const utf8Bytes = (text: string): number => Buffer.byteLength(text);

function replaceLine(view: ViewState, at: number, count: number, ...lines: Line[]): void {
	for (let k = at; k < at + count; k += 1) view.bytes -= lineBytes(view.lines[k]!);
	view.lines.splice(at, count, ...lines);
	for (const line of lines) view.bytes += lineBytes(line);
}

/**
 * Index of the left line of the most due mergeable pair, or -1. Sibling lines (l, i) and (l, i + 1) with i even
 * are a pair; its due value is (T - last) / 2^l, where `last` is the pair's last message. Ties go to the oldest
 * pair. Only a pair whose parent is built can merge.
 */
export function mostDue(view: ViewState, nodes: Nodes): number {
	const candidates: Array<[at: number, due: number]> = [];
	for (let k = 0; k + 1 < view.lines.length; k += 1) {
		const [l, i] = view.lines[k]!;
		const next = view.lines[k + 1]!;
		if (next[0] !== l || i % 2 !== 0 || next[1] !== i + 1) continue;
		const last = (i + 2) * 2 ** l - 1;
		candidates.push([k, (view.T - last) / 2 ** l]);
	}
	candidates.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	for (const [k] of candidates) {
		const [l, i] = view.lines[k]!;
		if (nodes.get(l + 1, i / 2) !== undefined) return k;
	}
	return -1;
}

/** Merge the most due pair into its parent. False when no pair can merge. */
export function mergeOnce(view: ViewState, nodes: Nodes): boolean {
	const k = mostDue(view, nodes);
	if (k < 0) return false;
	const [l, i] = view.lines[k]!;
	replaceLine(view, k, 2, [l + 1, i / 2, nodes.get(l + 1, i / 2)!]);
	return true;
}

/** Fill leaves that were unbuilt when they were appended and have a node now. A one-time cache break at each. */
export function fillLeaves(view: ViewState, nodes: Nodes): void {
	view.lines.forEach((line, k) => {
		if (line[2] !== null) return;
		const text = nodes.get(line[0], line[1]);
		if (text !== undefined) replaceLine(view, k, 1, [line[0], line[1], text]);
	});
}

/** One batch: merge until the view is at most the target, or no pair can merge, which sets `shrinking`. */
export function shrink(view: ViewState, nodes: Nodes, max = VIEW_MAX, target = VIEW_TARGET): void {
	if (!view.shrinking && view.bytes > max) view.batchSeq += 1;
	while (view.bytes > target && mergeOnce(view, nodes));
	view.shrinking = view.bytes > target;
}

/** Append the leaf of the next message and, when the view is over the maximum or still shrinking, merge. */
export function pushMessage(view: ViewState, nodes: Nodes, max = VIEW_MAX, target = VIEW_TARGET): void {
	const line: Line = [0, view.T, nodes.get(0, view.T) ?? null];
	replaceLine(view, view.lines.length, 0, line);
	view.T += 1;
	if (view.bytes > max || view.shrinking) shrink(view, nodes, max, target);
}

/** Advance the view to cover `T` messages, one message at a time (M5a). */
export function advanceTo(view: ViewState, T: number, nodes: Nodes, max = VIEW_MAX, target = VIEW_TARGET): void {
	fillLeaves(view, nodes);
	while (view.T < T) pushMessage(view, nodes, max, target);
}

/* --- window (unconfigured compactor) --------------------------------------------------------------------------- */

export type CompactorLabel = "not configured" | "disabled" | "configured";

export const earlierLine = (firstId: number, label: string): string => `0+${firstId}|(earlier history not summarized: compactor ${label}; zoom ids < ${firstId})\n`;

const firstAtOrAfter = (lines: readonly Line[], start: number): number => {
	let lo = 0;
	let hi = lines.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (lineFirst(lines[mid]!) < start) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

/**
 * The first message id of the rendered window. It holds until the window (with the one line that stands for
 * everything before it) would pass 128,000 bytes, then jumps forward on a line boundary until it is at most
 * 96,000. A compactor that is configured never windows.
 */
export function nextWindowStart(lines: readonly Line[], previous: number, label: CompactorLabel): number {
	if (label === "configured") return 0;
	let p = firstAtOrAfter(lines, previous);
	if (p >= lines.length) return previous;
	let bytes = 0;
	for (let k = p; k < lines.length; k += 1) bytes += lineBytes(lines[k]!);
	const earlier = (k: number): number => (k > 0 ? utf8Bytes(earlierLine(lineFirst(lines[k]!), label)) : 0);
	if (bytes + earlier(p) <= WINDOW_MAX) return previous;
	let best = lines.length - 1;
	bytes = 0;
	for (let k = lines.length - 1; k >= p; k -= 1) {
		bytes += lineBytes(lines[k]!);
		if (bytes + earlier(k) > WINDOW_TARGET) break;
		best = k;
	}
	p = best;
	return lineFirst(lines[p]!);
}

/** The lines the model reads: the window, preceded by one line for everything before it. */
export function renderLines(lines: readonly Line[], windowStart: number, label: CompactorLabel): string[] {
	const p = label === "configured" ? 0 : firstAtOrAfter(lines, windowStart);
	const out = lines.slice(p).map(lineText);
	if (p > 0 && p < lines.length) out.unshift(earlierLine(lineFirst(lines[p]!), label));
	return out;
}

/**
 * The view as text blocks (D21): full blocks of four lines counted from the start of the list, then one tail block
 * with the partial trailing lines and the closing tag. The tail is the only block that changes when a line is
 * appended, and it is the block that carries no cache mark.
 */
export function viewBlocks(rendered: readonly string[]): string[] {
	const full = Math.floor(rendered.length / LINES_PER_BLOCK);
	const blocks: string[] = [];
	for (let j = 0; j < full; j += 1) blocks.push(`${j === 0 ? "<chat>\n" : ""}${rendered.slice(j * LINES_PER_BLOCK, (j + 1) * LINES_PER_BLOCK).join("")}`);
	blocks.push(`${full === 0 ? "<chat>\n" : ""}${rendered.slice(full * LINES_PER_BLOCK).join("")}</chat>`);
	return blocks;
}

/** The persistent banner for a view that is growing without a compactor. */
export function viewBanner(label: CompactorLabel, docBytes: number): string | undefined {
	if (label === "configured" || docBytes <= BANNER_WARN_BYTES) return undefined;
	if (docBytes > BANNER_ESCALATE_BYTES) return `compactor ${label}: the chat view has grown to ${Math.round(docBytes / 1000)} KB and the model sees only the newest ${WINDOW_MAX / 1000} KB of it; run piroboros setup to add a compactor`;
	return `compactor ${label}: history beyond the window is only reachable by zoom`;
}

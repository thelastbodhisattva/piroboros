import { THEME } from "../theme.ts";
import { spanLine, wrap, type FrameLine, type Span } from "../viewport.ts";
import { pickCollapsedStep, selectSummarySteps } from "./select.ts";
import type { DerivedThinkingStep, ThinkingSourceBlock, ThinkingStepsMode } from "./types.ts";

// The thinking panel. thinkingRows() is what the panel says for a message in a mode. thinkingLines() wraps those rows
// to a width, so the app can count them; wrap and clip sanitize the text (D17) and the app draws every row through safe().

export const INDICATOR = {
	waiting: "Waiting for thinking content",
	none: "No thinking content supplied",
	hidden: "Reasoning is hidden by the provider",
} as const;

export interface ThinkingRow {
	key: string;
	text: string;
	dim?: boolean;
	color?: typeof THEME.error | typeof THEME.ok;
	truncate?: boolean;
}

export interface ThinkingView {
	/** Thinking blocks of the message, from `thinkingBlocksOf`. */
	blocks: readonly ThinkingSourceBlock[];
	/** Steps derived from them, from `StepMemo.steps`. */
	steps: readonly DerivedThinkingStep[];
	/** True for the live partial of a response that is still being written. */
	streaming: boolean;
	mode: ThinkingStepsMode;
	/** Thinking level `off`, or a model without reasoning: nothing is shown. */
	suppressed?: boolean;
}

const colorOf = (step: DerivedThinkingStep): ThinkingRow["color"] => (step.role === "error" ? THEME.error : step.role === "verify" ? THEME.ok : undefined);

/** Expanded text, normalized: trailing blanks trimmed on each line and runs of blank lines folded into one. */
const bodyLines = (body: string): string[] => body.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""));

export function thinkingRows(view: ThinkingView, maxRows = Number.POSITIVE_INFINITY): ThinkingRow[] {
	if (view.suppressed === true) return [];
	const rows: ThinkingRow[] = [];
	const hidden = view.blocks.some((block) => block.redacted === true);
	if (hidden) rows.push({ key: "hidden", text: INDICATOR.hidden, dim: true });
	const steps = view.steps as DerivedThinkingStep[];
	if (steps.length === 0) {
		if (!hidden) rows.push({ key: "none", text: view.streaming ? INDICATOR.waiting : INDICATOR.none, dim: true });
		return rows.slice(0, maxRows);
	}
	const activeId = view.streaming ? steps[steps.length - 1]!.id : undefined;
	if (view.mode === "collapsed") {
		const step = pickCollapsedStep(steps, activeId)!;
		rows.push({ key: "c", text: `│ Thinking ${step.icon} ${step.summary}`, truncate: true, ...(colorOf(step) === undefined ? {} : { color: colorOf(step)! }) });
		return rows.slice(0, maxRows);
	}
	rows.push({ key: "h", text: `┆ Thinking Steps · ${view.mode === "summary" ? "Summary" : "Expanded"}`, dim: true });
	const shown = view.mode === "summary" ? selectSummarySteps(steps, activeId) : steps;
	shown.forEach((step, i) => {
		const last = i === shown.length - 1;
		const color = colorOf(step);
		rows.push({ key: `s${step.id}`, text: `${last ? "└─" : "├─"} ${step.icon} ${step.summary}`, ...(color === undefined ? {} : { color }) });
		if (view.mode === "expanded") bodyLines(step.body).forEach((line, j) => rows.push({ key: `b${step.id}-${j}`, text: `${last ? "   " : "│  "}${line}`, dim: true }));
	});
	return rows.slice(0, maxRows);
}

/** The tree gutters. A wrapped row repeats the gutter of its step, and 3 spaces sit under the last step. */
const GUTTER: Record<string, string> = { "├─ ": "│  ", "└─ ": "   ", "│  ": "│  ", "   ": "   " };

/**
 * The panel for one message as rows of at most `width` columns, ready to draw. Collapsed and `truncate` rows are cut to
 * one row each; the others wrap, and wrapped rows keep the gutter. Nothing when the panel is suppressed.
 */
export function thinkingLines(view: ThinkingView, width: number, options: { truncate?: boolean; maxRows?: number } = {}): FrameLine[] {
	const out: FrameLine[] = [];
	const w = Math.max(4, width);
	for (const row of thinkingRows(view, options.maxRows)) {
		const style = { ...(row.dim === true ? { dim: true } : {}), ...(row.color === undefined ? {} : { color: row.color }) };
		// The gutter characters are muted, the step text keeps its own color.
		const color = row.color ?? (row.dim === true ? THEME.muted : undefined);
		const body = (text: string): Span => ({ text, ...(color === undefined ? {} : { color }) });
		const gutterSpan = (text: string): Span => ({ text, color: THEME.muted });
		if (row.truncate === true || options.truncate === true) {
			const glyph = /^(?:├─|└─|│)/u.exec(row.text)?.[0] ?? "";
			out.push({ ...spanLine([...(glyph === "" ? [] : [gutterSpan(glyph)]), body(row.text.slice(glyph.length))], w), ...style });
			continue;
		}
		const lead = row.text.slice(0, 3);
		const gutter = GUTTER[lead];
		if (gutter === undefined) { for (const text of wrap(row.text, w)) out.push({ text, spans: [body(text)], ...style }); continue; }
		wrap(row.text.slice(3), w - 3).forEach((text, i) => { const g = i === 0 ? lead : gutter; out.push({ text: g + text, spans: [gutterSpan(g), body(text)], ...style }); });
	}
	return options.maxRows === undefined ? out : out.slice(0, options.maxRows);
}

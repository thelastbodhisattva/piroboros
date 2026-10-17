import type { PickEntry } from "./commands.ts";
import { THEME } from "./theme.ts";
import { clip, indicator, windowFor, type FrameLine } from "./viewport.ts";

// Layout of the command list shown above the input. Pure: the same inputs give the same lines.

export const PICKER_MAX_ROWS = 8;

/**
 * The lines of the list in at most `maxLines` rows: a window of entries that keeps the selection in view, plus an
 * "n-m of total" line when the list is longer than the rows. Every line is at most `cols - 1` wide. Returns the new scroll offset.
 */
export function buildPicker(list: readonly PickEntry[], index: number, offset: number, cols: number, maxLines: number): { lines: FrameLine[]; offset: number } {
	const width = Math.max(10, cols - 1);
	const height = list.length <= maxLines ? Math.max(1, maxLines) : Math.max(1, maxLines - 1);
	const selected = Math.min(Math.max(0, index), Math.max(0, list.length - 1));
	const win = windowFor(list.length, selected, offset, height);
	const labelWidth = Math.min(Math.max(...list.map((entry) => [...entry.label].length), 0), Math.floor(width / 2));
	const lines: FrameLine[] = [];
	for (let i = win.start; i < win.end; i += 1) {
		const entry = list[i]!;
		const label = `${entry.label}${entry.disabled === undefined ? "" : ` (unavailable: ${entry.disabled})`}`;
		const text = `${i === selected ? ">" : " "} ${[...label].length >= labelWidth || entry.detail === undefined ? label : label.padEnd(labelWidth)}${entry.detail === undefined ? "" : `  ${entry.detail}`}`;
		lines.push({ text: clip(text, width), ...(i === selected ? { color: THEME.accentText, bold: true } : { dim: entry.disabled !== undefined || entry.hint === true }) });
	}
	if (list.length > height && maxLines >= 2) lines.push({ text: clip(indicator(win.start, win.end, list.length), width), dim: true });
	return { lines, offset: win.offset };
}

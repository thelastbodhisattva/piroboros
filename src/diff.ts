/** Line cells (before lines times after lines) that lineDiff will fill; a bigger pair is shown as a whole replacement. */
export const LCS_CELLS = 250_000;

/**
 * A line diff of two texts as `+`, `-` and two-space lines, with at most `context` unchanged lines kept around each
 * change. Equal texts give "". Texts too large for the table (LCS_CELLS) give every old line removed, then every new line added.
 */
export function lineDiff(before: string, after: string, context = 2): string {
	const a = before.split("\n");
	const b = after.split("\n");
	if (before === after) return "";
	const rows: string[] = [];
	if (a.length * b.length > LCS_CELLS) {
		rows.push(...a.map((line) => `- ${line}`), ...b.map((line) => `+ ${line}`));
		return rows.join("\n");
	}
	// ponytail: full table, bounded by LCS_CELLS; Myers' O(ND) diff if skill bodies ever grow past a few hundred lines
	const w = b.length + 1;
	const table = new Uint16Array((a.length + 1) * w);
	for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) { rows.push(`  ${a[i]}`); i += 1; j += 1; }
		else if (j < b.length && (i === a.length || table[i * w + j + 1]! >= table[(i + 1) * w + j]!)) { rows.push(`+ ${b[j]}`); j += 1; }
		else { rows.push(`- ${a[i]}`); i += 1; }
	}
	// Keep only the changed lines and `context` lines around them; a gap is marked once.
	const keep = rows.map((row) => row[0] !== " ");
	const out: string[] = [];
	let gap = false;
	rows.forEach((row, k) => {
		let near = false;
		for (let d = -context; d <= context && !near; d += 1) near = keep[k + d] === true;
		if (near) { gap = false; out.push(row); } else if (!gap) { gap = true; out.push("  [unchanged lines]"); }
	});
	return out.join("\n");
}

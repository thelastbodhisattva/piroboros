/** Line cells (unchanged-prefix-and-suffix-trimmed old lines times new lines) that diffChunks will fill; a bigger pair is refused. */
export const LCS_CELLS = 4_000_000;

export type DiffOp = " " | "-" | "+";

/**
 * The edit script from `a` to `b`, one op per step in order: " " keeps the next line of both, "-" drops the next line of `a`,
 * "+" adds the next line of `b`. The common prefix and suffix are kept without a table; the middle gets a dense LCS in a
 * Uint32Array. A middle over LCS_CELLS cells gives null (the caller decides what a refusal means).
 */
export function diffChunks(a: string[], b: string[]): DiffOp[] | null {
	let lo = 0;
	while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
	let ea = a.length;
	let eb = b.length;
	while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea -= 1; eb -= 1; }
	const n = ea - lo;
	const m = eb - lo;
	if (n * m > LCS_CELLS) return null;
	const ops: DiffOp[] = new Array<DiffOp>(lo).fill(" ");
	// ponytail: dense table, bounded by LCS_CELLS (16 MB); Myers' O(ND) diff if a changed middle ever needs to be bigger
	const w = m + 1;
	const t = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) t[i * w + j] = a[lo + i] === b[lo + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[lo + i] === b[lo + j]) { ops.push(" "); i += 1; j += 1; }
		else if (j < m && (i === n || t[i * w + j + 1]! >= t[(i + 1) * w + j]!)) { ops.push("+"); j += 1; }
		else { ops.push("-"); i += 1; }
	}
	for (let k = ea; k < a.length; k += 1) ops.push(" ");
	return ops;
}

/**
 * A line diff of two texts as `+`, `-` and two-space lines, with at most `context` unchanged lines kept around each
 * change. Equal texts give "". Texts too large for diffChunks give every old line removed, then every new line added.
 */
export function lineDiff(before: string, after: string, context = 2): string {
	const a = before.split("\n");
	const b = after.split("\n");
	if (before === after) return "";
	const ops = diffChunks(a, b);
	if (!ops) return [...a.map((line) => `- ${line}`), ...b.map((line) => `+ ${line}`)].join("\n");
	let i = 0;
	let j = 0;
	const rows = ops.map((op) => {
		if (op === "+") return `+ ${b[j++]}`;
		if (op === "-") return `- ${a[i++]}`;
		j += 1;
		return `  ${a[i++]}`;
	});
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

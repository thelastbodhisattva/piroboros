// How a member's final text becomes the item posted to the root (D16, Elaria M6). A report up to `max` code points is
// posted whole; a longer one keeps its first 60% and its last 35% of `max` (2,400 and 1,400 at the default 4,000) with
// one marker between them. When the first Verdict line of the full text lies in the omitted part (it starts before the kept tail and does not end inside the kept head), one line `Verdict: <value as written> (from the omitted part)` follows the marker, so verdictOf still finds it; that line does not count against `max`. A Verdict line that straddles the head cut is dropped from the head whole and restated the same way. The marker spells out "code points omitted" and has no ellipsis glyphs, which differs on purpose from PLAN.md D16. Every item carries exactly one pointer to the member's whole chat. Cuts are made on code
// points, so a character outside the basic plane is never split into lone surrogates.

export const REPORT_MAX = 4_000;
/** The final-plan seat is the executor's only brief, so it may exceed a reviewer's cap. */
export const FINAL_PLAN_MAX = 12_000;
export const pointer = (name: string): string => `full: zoom("${name}")`;

export const cutSizes = (max: number): { head: number; tail: number } => ({ head: Math.floor(max * 0.6), tail: Math.floor(max * 0.35) });

export function formatReport(name: string, text: string, max = REPORT_MAX): string {
	const points = Array.from(text);
	if (points.length <= max) return `${text}\n${pointer(name)}`;
	const { head, tail } = cutSizes(max);
	let kept = points.slice(0, head).join("");
	const m = VERDICT.exec(text);
	// A first Verdict line that starts in the head but ends after it is cut off at its line start, so no cut copy of it stays.
	if (m !== null && m.index < kept.length && m.index + m[0].length > kept.length) kept = text.slice(0, m.index);
	const tailText = points.slice(points.length - tail).join("");
	const omitted = points.length - Array.from(kept).length - tail;
	// By position: a first Verdict line that does not end inside the kept head and starts before the tail gets restated after the marker, before the tail.
	const verdict = m !== null && m.index + m[0].length > kept.length && m.index < text.length - tailText.length ? `\nVerdict: ${m[1]!.trim()} (from the omitted part)` : "";
	return `${kept}\n[${omitted} code points omitted; ${pointer(name)}]${verdict}\n${tailText}`;
}

const VERDICT = /^[\s*_#>-]*verdict[\s*_]*:[\s*_]*(.+)$/imu;

/** The first Verdict line of a report, anywhere in it, lower case; undefined when there is none. The scan is linear and a report is at most a few thousand characters. */
export function verdictOf(text: string): string | undefined {
	return VERDICT.exec(text)?.[1]?.trim().toLowerCase();
}

/** True when a reviewer's verdict asks for changes or sends the plan back, or a report gives no verdict at all (it cannot be trusted to mean proceed), so Samaela writes the final plan. */
export function needsConsolidation(texts: readonly string[]): boolean {
	return texts.some((text) => {
		const verdict = verdictOf(text);
		return verdict === undefined || verdict.startsWith("proceed with changes") || verdict.startsWith("send back");
	});
}

/** A report that says the member did not finish. `reason` is one of: no report, turn limit, idle, stuck, cancelled, error. */
export function failedReport(name: string, reason: string, detail?: string): string {
	const extra = detail === undefined || detail.trim() === "" ? "" : `: ${detail.trim().replace(/\s+/gu, " ").slice(0, 300)}`;
	const head = reason === "no report" ? "FAILED: no report produced" : `FAILED (${reason})`;
	return `${head}${extra}\n${pointer(name)}`;
}

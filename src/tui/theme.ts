// The palette. Body text sets no color and uses the terminal default (white, set with OSC 10 in main.ts).
// Labels, state words and the picker selection use accentText; borders, bars and the prompt use accent.
// Contrast on #1A1A1A: accent 2.27 (decoration only), accentText 4.87, muted 5.18, ok 9.85, warn 9.36, error 5.85.

export const ACCENT_TEXT = "#EC4D73";

export const THEME = {
	accent: "#A4133C",
	accentText: ACCENT_TEXT,
	muted: "#8C8C8C",
	border: "#3A3A3A",
	ok: "#3DDC97",
	warn: "#E5B84B",
	error: "#FF5C7A",
} as const;

/**
 * The terminal default colors as OSC 10 (foreground) and OSC 11 (background), and the sequences that reset them.
 * Undefined when there is no terminal, or colors are off: the same rule as bin/piroboros.mjs (NO_COLOR with FORCE_COLOR unset,
 * or FORCE_COLOR 0 or false, which chalk reads as level 0).
 */
export function themeSequences(env: NodeJS.ProcessEnv, tty: boolean): { start: string; end: string } | undefined {
	if (!tty || env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false") return undefined;
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "" && env.FORCE_COLOR === undefined) return undefined;
	const osc = (body: string): string => `\u{1B}]${body}\u{7}`;
	return { start: `${osc("10;rgb:ff/ff/ff")}${osc("11;rgb:1a/1a/1a")}`, end: `${osc("110")}${osc("111")}` };
}

import { createElement, type ReactElement } from "react";
import { Text, type TextProps } from "ink";
import { THEME } from "./theme.ts";
import type { FrameLine } from "./viewport.ts";

// The one render boundary. Every string that came from a model, a tool, a provider or a file passes
// through sanitizeTerminal() before it reaches the terminal, and Ink's Text is used only here.
// Fail-visible: a control character is shown as a placeholder instead of being dropped, so an attempt
// to drive the terminal is noticeable. ESC is shown as the symbol U+241B, other controls as U+XXXX.

const hex = (code: number): string => `⟦U+${code.toString(16).toUpperCase().padStart(4, "0")}⟧`;

// C0 except tab and newline, DEL, C1, bidi controls, zero-width and format characters, and tag characters.
// A zero-width joiner passes only between two pictographs (a modifier or variation selector may precede it); anywhere else it is marked.
const UNSAFE = /[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F-\u009F\u{AD}\u{61C}\u{200B}\u{200C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}]|[\u{E0000}-\u{E007F}]|(?<!\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u{200D}|\u{200D}(?!\p{Extended_Pictographic})/gu;

export function sanitizeTerminal(text: string): string {
	return text
		.replace(/\r\n?/gu, "\n")
		.replace(/\u001B/gu, "␛")
		.replace(UNSAFE, (char) => hex(char.codePointAt(0)!));
}

export interface SafeTextProps extends Omit<TextProps, "children"> {
	children: string | number | readonly (string | number)[];
}

/** Renders text after sanitizing it. Pass strings only; nested elements are not accepted. */
export function SafeText({ children, ...props }: SafeTextProps): ReactElement {
	const text = Array.isArray(children) ? children.join("") : String(children);
	return createElement(Text, props, sanitizeTerminal(text));
}

/**
 * An OAuth URL is shown and opened only when it parses as https, or as http on a loopback host. Only the
 * parsed `href` is passed to the launcher, never the original string.
 */
export function safeAuthUrl(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.username !== "" || url.password !== "") return undefined;
	if (url.protocol === "https:") return url.href;
	if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/u.test(url.hostname))) return url.href;
	return undefined;
}

/** One Text per frame row, each drawn on a single row: an empty row is a space (an empty Text may take no row), and a row that is too wide is cut. */
export function rowsOf(lines: readonly FrameLine[], prefix: string): ReactElement[] {
	return lines.map((line, i) => {
		const key = `${prefix}${i}`;
		if (line.text === "") return safe(" ", { key, wrap: "truncate-end" });
		// One outer Text decides the truncation; the span Texts nest inside it and carry only a color and bold.
		if (line.spans !== undefined) return createElement(Text, { key, wrap: "truncate-end" }, ...line.spans.map((span, j) => createElement(Text, { key: j, ...(span.color === undefined ? {} : { color: span.color }), ...(span.bg === undefined ? {} : { backgroundColor: span.bg }), ...(span.bold === true ? { bold: true } : {}) }, sanitizeTerminal(span.text))));
		const color = line.color ?? (line.dim === true ? THEME.muted : undefined);
		return safe(line.text, { key, wrap: "truncate-end", ...(line.bold === true ? { bold: true } : {}), ...(color === undefined ? {} : { color }) });
	});
}

/** createElement helper: `safe(text, props)` is Text with sanitized content. */
export function safe(text: string, props: Omit<TextProps, "children"> & { key?: string } = {}): ReactElement {
	return createElement(Text, props, sanitizeTerminal(text));
}

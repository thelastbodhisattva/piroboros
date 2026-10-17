import { statSync } from "node:fs";
import stringWidth from "string-width";
import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import { Box, render, useApp, useCursor, useInput, usePaste, useStdout } from "ink";
import { ctx, LiveDoc, recentEntries, ROOT, SessionFailed } from "../durable.ts";
import type { Runtime } from "../runtime.ts";
import type { MemoryStatus } from "../memory/host.ts";
import { PendingDoc, type TurnStatus } from "../chat/turn.ts";
import { statusText } from "../chat/status.ts";
import { isStuckStop, STUCK_STOP_CODE } from "../chat/stuck.ts";
import { ViewDoc } from "../chat/tree.ts";
import { viewBanner } from "../chat/view.ts";
import { COMMANDS, suggest, unknownCommand, type LoginOption, type ModelOption, type PickEntry } from "./commands.ts";
import { skillsReport } from "../skills.ts";
import { runSettings, SECURITY_CONFIRM } from "./settings.ts";
import { route, type Keys, type Owner } from "./keys.ts";
import { ConclavePane, formatDuration, paneLines, paneVisible, pill, rightPanelLines, seatsOf, SIDE_BY_SIDE_MIN_COLUMNS, textOf, toolCallParts, toolCallText, usePane, type PillState } from "./pane.ts";
import { panelLines, SessionPanel, type PanelData } from "./panel.ts";
import { buildPicker, PICKER_MAX_ROWS } from "./picker.ts";
import { rowsOf } from "./sanitize.ts";
import { applyOverlay, buildFrame, createSetupDriver, type SetupDriver } from "./setup.ts";
import { THEME } from "./theme.ts";
import { allocate, chatIndicator, chatWindow, clip, dropLast, spanLine, spanRow, spansOf, tail, wrap, type FrameLine, type Span } from "./viewport.ts";
import { runLogin, SetupCancelled, type SetupIO } from "../setup.ts";
import { modelChoices, providerChoices, resolveModel } from "../models.ts";
import { redactSensitive } from "../redact.ts";
import { checkPath } from "../guard.ts";
import { apply, loadRun, plan, preview } from "../undo.ts";
import { CONCLAVE_MEMBERS, securityChanges, THINKING_LEVELS, withDefaults } from "../config.ts";
import { searchKey, VERSION, type SearchProvider } from "../web.ts";
import { parseThinkingMode } from "./thinking/parse.ts";
import { thinkingBlocksOf } from "./thinking/state.ts";
import type { ThinkingSourceBlock } from "./thinking/types.ts";
import { thinkingLines, type ThinkingView } from "./thinking/view.ts";

// Split UI: the chat on the left, the Conclave pane on the right once a pipeline exists (under the chat in a
// narrow terminal, see pane.ts), queued items, banners, the status line and the input box. The UI renders committed state only.

export interface LastResponse {
	provider: string;
	model: string;
	responseModel?: string;
	cacheRead: number;
	cacheWrite: number;
	/** Usage of the reply, for the stat strip; 0 when it is absent. */
	input?: number;
	output?: number;
}

/** Provider bodies are often JSON. Show the message inside, and keep the text short. */
export function friendlyError(raw: string, max = 240): string {
	let text = raw.trim();
	const start = text.indexOf("{");
	if (start >= 0) {
		try {
			const parsed = JSON.parse(text.slice(start)) as { message?: unknown; error?: { message?: unknown } | string };
			const inner = typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : undefined;
			if (inner !== undefined) text = `${text.slice(0, start).trim()} ${inner}`.trim();
		} catch {
			// Cut-off JSON (a clipped report line, more braces opened than closed): take the message string that is there.
			const json = text.slice(start);
			const cut = (json.match(/\{/gu)?.length ?? 0) > (json.match(/\}/gu)?.length ?? 0) ? /"message"\s*:\s*"((?:[^"\\]|\\.)*)/u.exec(json)?.[1] : undefined;
			if (cut !== undefined) {
				let inner = cut;
				try { inner = JSON.parse(`"${cut}"`) as string; } catch { /* the cut fell inside an escape; keep it as is */ }
				text = `${text.slice(0, start).trim()} ${inner}`.trim();
			}
		}
	}
	text = text.replace(/\s+/gu, " ");
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const ERROR_HINT = "use /model to switch models, or /login to sign in";

/** The next step for a failed turn, from what the provider said. Anything unrecognized gets the general hint. */
export function errorHint(message: string): string {
	if (/\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b|fetch failed/iu.test(message)) return "Could not reach the provider. Check the network, or use /model to pick another.";
	if (/\b(401|403)\b/u.test(message)) return "Use /login to sign in again.";
	if (/\b429\b|rate limit/iu.test(message)) return "Wait a moment, then send again.";
	if (/\b404\b|unavailable/iu.test(message)) return "Use /model to pick another model.";
	return ERROR_HINT;
}

export interface StatusInput {
	main?: string;
	last?: LastResponse;
	compactor: "not configured" | "disabled" | "configured";
	thinking: string;
	failed?: string;
	busy?: boolean;
	memory?: Pick<MemoryStatus, "pendingSync" | "quarantined" | "proposed">;
}

/** The parts of the status line, before they are joined. Each flag leaves its part out when false. */
export function statusParts(input: StatusInput, opts: { cache?: boolean; compactor?: boolean; thinking?: boolean } = {}): string[] {
	const parts: string[] = [];
	if (input.busy === true) parts.push("working (Esc stops)");
	else if (input.failed !== undefined) parts.push(`ERROR ${friendlyError(input.failed, 60)}`);
	if (input.last !== undefined) {
		const used = `${input.last.provider}/${input.last.model}`;
		parts.push(input.last.responseModel !== undefined && input.last.responseModel !== input.last.model ? `${used} → ${input.last.responseModel}` : used);
		if (opts.cache !== false) parts.push(`cache read ${input.last.cacheRead} write ${input.last.cacheWrite}`);
	} else parts.push(input.main ?? "no model set");
	if (opts.compactor !== false) parts.push(`compactor: ${input.compactor}`);
	if (opts.thinking !== false) parts.push(`thinking: ${input.thinking}`);
	if (input.memory?.pendingSync) parts.push("vault: sync pending");
	if ((input.memory?.quarantined ?? 0) > 0) parts.push(`memory quarantined: ${input.memory!.quarantined}`);
	if ((input.memory?.proposed ?? 0) > 0) parts.push(`memory proposed: ${input.memory!.proposed}`);
	return parts;
}

/** What the status line drops, in order, until it fits. */
const STATUS_STAGES = [[true, true, true], [false, true, true], [false, false, true], [false, false, false]] as const;

/**
 * The status line. With a width it drops the cache counts, then the compactor, then the thinking level until it fits, and
 * clips what is left. While a turn runs it starts with `working (Esc stops)` and shows no error from an earlier turn.
 * `cache: false` never shows the cache counts (the stat strip shows them).
 */
export function formatStatus(input: StatusInput, width?: number, opts: { cache?: boolean } = {}): string {
	const build = (cache: boolean, compactor: boolean, thinking: boolean): string => statusParts(input, { cache: cache && opts.cache !== false, compactor, thinking }).join("  |  ");
	if (width === undefined) return build(true, true, true);
	for (const [cache, compactor, thinking] of STATUS_STAGES) {
		if (cache && opts.cache === false) continue;
		const text = build(cache, compactor, thinking);
		if (stringWidth(text) <= width) return text;
	}
	return clip(build(false, false, false), width);
}

/** The status row of the framed layout: the parts that fit, muted, joined by an accent bar. */
function statusSpans(input: StatusInput, width: number, cache: boolean): Span[] {
	const spans = (parts: string[]): Span[] => parts.flatMap((part, i) => [...(i === 0 ? [] : [{ text: " │ ", color: THEME.accent }]), { text: part, color: THEME.muted }]);
	for (const [withCache, compactor, thinking] of STATUS_STAGES) {
		if (withCache && !cache) continue;
		const row = spans(statusParts(input, { cache: withCache, compactor, thinking }));
		if (stringWidth(row.map((span) => span.text).join("")) <= width) return row;
	}
	return spanRow(spans(statusParts(input, { cache: false, compactor: false, thinking: false })), width);
}

const COUNT = (n: number): string => (n < 1000 ? String(n) : `${(Math.round(n / 100) / 10).toFixed(1)}k`);

/** The stat strip of the last good reply: IN, OUT, CACHE (cache read of the prompt) and CTX (prompt and output of the window). Undefined without a reply. */
export function statsOf(last: LastResponse | undefined, contextWindow?: number): Span[] | undefined {
	if (last === undefined) return undefined;
	const input = last.input ?? 0;
	const output = last.output ?? 0;
	const prompt = input + last.cacheRead + last.cacheWrite;
	const stats: Array<[string, string]> = [["IN", COUNT(input)], ["OUT", COUNT(output)]];
	if (prompt > 0) stats.push(["CACHE", `${Math.round((last.cacheRead / prompt) * 100)}%`]);
	if (contextWindow !== undefined && contextWindow > 0) stats.push(["CTX", `${Math.round(((prompt + output) / contextWindow) * 100)}%`]);
	return stats.flatMap(([label, value], i) => [...(i === 0 ? [] : [{ text: " │ ", color: THEME.accent }]), { text: `${label} `, color: THEME.muted }, { text: value }]);
}

/** The dot and words at the right of the header. A running turn wins; then the status; anything else is ready. */
export function headerWords(running: boolean, status: TurnStatus): { color: string; words: string } {
	if (running) return { color: THEME.accent, words: "working (Esc stops)" };
	switch (status.kind) {
		case "unconfigured": return { color: THEME.error, words: "no model set" };
		case "login_required": return { color: THEME.error, words: "login required" };
		case "turn_failed": return { color: THEME.error, words: `ERROR ${friendlyError(status.message, 40)}` };
		case "error": return { color: THEME.error, words: "error" };
		case "stopped": return { color: THEME.error, words: "stopped" };
		default: return { color: THEME.ok, words: "ready" };
	}
}

/** What the header drops, in order, until it fits: the version, the member count, the Conclave count. The state words are clipped last. */
const HEADER_STAGES = [[true, true, true], [false, true, true], [false, false, true], [false, false, false]] as const;

/** The header row: the name and version at the left, the state, the member count and the Conclave count (while a pipeline is live) at the right. */
export function headerRow(running: boolean, status: TurnStatus, conclave: { done: number; total: number } | undefined, width: number): FrameLine {
	const { color, words } = headerWords(running, status);
	const size = (spans: Span[]): number => stringWidth(spans.map((span) => span.text).join(""));
	const build = (version: boolean, members: boolean, count: boolean): { left: Span[]; right: Span[] } => ({
		left: [{ text: "◆ ", color: THEME.accent }, { text: "piroboros", color: THEME.accentText, bold: true }, ...(version ? [{ text: `  v${VERSION}`, color: THEME.muted }] : [])],
		right: [{ text: "● ", color }, { text: words }, ...(members ? [{ text: " │ ", color: THEME.accent }, { text: `${CONCLAVE_MEMBERS.length} members`, color: THEME.muted }] : []), ...(count && conclave !== undefined ? [{ text: `  conclave ${conclave.done}/${conclave.total}`, color: THEME.muted }] : [])],
	});
	const stage = HEADER_STAGES.find(([version, members, count]) => { const { left, right } = build(version, members, count); return size(left) + 2 + size(right) <= width; }) ?? HEADER_STAGES.at(-1)!;
	const { left, right } = build(stage[0], stage[1], stage[2]);
	return spanLine([...left, { text: " ".repeat(Math.max(2, width - size(left) - size(right))) }, ...right], width);
}

/** A full-width rule in the border color. */
const ruleLine = (width: number): FrameLine => spanLine([{ text: "─".repeat(width), color: THEME.border }], width);

/** The local HH:MM of an epoch time in ms. */
const clock = (ms: number): string => { const at = new Date(ms); return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`; };

/** The row of the input in the frame: the rows built above it, plus the top border of the input box when framed. */
export function inputRowIndex(parts: readonly number[], framed: boolean): number {
	return parts.reduce((sum, rows) => sum + rows, 0) + (framed ? 1 : 0);
}

export interface Line {
	key: string;
	role: "user" | "assistant" | "tool" | "system" | "error" | "hint" | "report";
	text: string;
	/** Assistant lines: the thinking blocks of the entry, for the thinking panel. Absent on an entry with only tool calls. */
	thinking?: ThinkingSourceBlock[];
	/** Reports: the member that wrote it, and whether the report says the member did not finish. */
	member?: string;
	failed?: boolean;
	/** Tool results: shown in at most 3 rows. */
	bounded?: boolean;
	/** Assistant lines, for the framed layout: the text without the tool calls, and the calls apart. `text` keeps both. */
	body?: string;
	calls?: Array<{ name: string; arg?: string }>;
	/** Tool errors: the tool, and the error text without the `tool error (x): ` prefix. */
	toolName?: string;
	detail?: string;
}

type Entry = Awaited<ReturnType<typeof recentEntries>>[number];
type Block = { type?: string; text?: string; name?: string; arguments?: unknown };

export function linesOf(entries: readonly Entry[]): Line[] {
	const out: Line[] = [];
	// The marker entry before a user entry says which of its blocks are Conclave reports.
	let marker: Array<{ source?: unknown; member?: unknown } | null> | undefined;
	for (const entry of entries.slice().reverse()) {
		if (entry.kind === "piroboros.turn") {
			const items = (entry.data as { items?: unknown } | undefined)?.items;
			marker = Array.isArray(items) ? (items as typeof marker) : [];
			continue;
		}
		const message = (entry.model as Array<{ role?: string; content?: unknown; toolName?: string; isError?: boolean }> | undefined)?.[0];
		if (message === undefined) continue;
		const failed = message as { role?: string; stopReason?: string; errorMessage?: string; provider?: string; model?: string };
		if (failed.role === "assistant" && failed.stopReason === "error") {
			out.push({ key: `${entry.id}e`, role: "error", text: `error: ${failed.provider ?? "?"}/${failed.model ?? "?"}: ${friendlyError(failed.errorMessage ?? "the provider returned an error")}` });
			out.push({ key: `${entry.id}h`, role: "hint", text: errorHint(failed.errorMessage ?? "") });
			continue;
		}
		if (isStuckStop(entry)) {
			out.push({ key: `${entry.id}s`, role: "error", text: `stopped (${STUCK_STOP_CODE}): the same call kept failing, so the turn was ended` });
			continue;
		}
		const content = message.content;
		const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]).filter((block) => block !== null && typeof block === "object") : [];
		const textOnly = blocks.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("");
		if (message.role === "user") {
			const items = marker;
			marker = undefined;
			let user: string[] = [];
			let firstUser = true;
			const flush = (at: number): void => {
				if (user.length > 0) out.push({ key: firstUser ? String(entry.id) : `${entry.id}u${at}`, role: "user", text: user.join("\n") });
				if (user.length > 0) firstUser = false;
				user = [];
			};
			blocks.forEach((block, k) => {
				const text = block.type === "text" ? block.text ?? "" : "";
				if (text === "") return;
				const item = items?.[k];
				if (item?.source !== "conclave") { user.push(text); return; }
				flush(k);
				const named = /^\[([^\]\n]*)\] report\n?/u.exec(text);
				const member = typeof item.member === "string" ? item.member : named?.[1] ?? "member";
				const body = named === null ? text : text.slice(named[0].length);
				const [first = "", ...rest] = body.split("\n");
				out.push({ key: `${entry.id}:${k}`, role: "report", member, failed: first.startsWith("FAILED"), text: (first.startsWith("FAILED") ? [friendlyError(first), ...rest] : [first, ...rest]).join("\n") });
			});
			flush(blocks.length);
			continue;
		}
		if (message.role === "toolResult") {
			if (textOnly.length === 0) continue;
			if (message.isError === true) {
				const detail = textOnly.replace(/<\/?harness>/gu, "").trim().replace(/^\[error\] ?/u, "");
				out.push({ key: String(entry.id), role: "error", bounded: true, text: `tool error (${message.toolName ?? "tool"}): ${detail}`, toolName: message.toolName ?? "tool", detail });
			} else out.push({ key: String(entry.id), role: "tool", bounded: true, text: textOnly });
			continue;
		}
		const callBlocks = blocks.filter((block) => block.type === "toolCall");
		const calls = callBlocks.map((block) => toolCallText(block));
		const text = message.role === "assistant" ? [textOnly, ...calls].filter((part) => part !== "").join("\n") : textOnly;
		if (text.length === 0) continue;
		const thinking = message.role === "assistant" ? thinkingBlocksOf(message) : undefined;
		out.push({ key: String(entry.id), role: message.role === "assistant" ? "assistant" : "system", text, ...(message.role === "assistant" ? { body: textOnly, calls: callBlocks.map((block) => toolCallParts(block)) } : {}), ...(thinking === undefined || (textOnly === "" && thinking.length === 0) ? {} : { thinking }) });
	}
	return out;
}

export function lastResponseOf(entries: readonly Entry[]): LastResponse | undefined {
	for (const entry of entries) {
		const message = (entry.model as Array<Record<string, unknown>> | undefined)?.[0];
		// An errored reply carries zero usage; the status and the stat strip show the last good one.
		if (message?.role !== "assistant" || message.stopReason === "error") continue;
		const usage = (message.usage ?? {}) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		return {
			provider: String(message.provider ?? ""),
			model: String(message.model ?? ""),
			...(typeof message.responseModel === "string" ? { responseModel: message.responseModel } : {}),
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			input: usage.input ?? 0,
			output: usage.output ?? 0,
		};
	}
	return undefined;
}

const IDLE_KEYS = "Enter sends, / commands, PgUp scrolls, Ctrl+T thinking, Ctrl+C exits";
const RUNNING_KEYS = "Esc or Ctrl+C stops the turn, PgUp scrolls";
const ASSISTANT_LABEL = "◆ piroboros";
const INDENT = "  ";
const moreText = (n: number): string => `(${n} more ${n === 1 ? "line" : "lines"})`;

/** A row moved right by the indent of a framed entry. */
const indented = (line: FrameLine): FrameLine => ({ text: INDENT + line.text, spans: [{ text: INDENT }, ...spansOf(line)] });

/** Tool output: 3 rows at most. Each source line is cut to 6 widths, and the rest is counted. */
function capRows(source: string, width: number): { rows: string[]; more: number } {
	const sourceLines = source.replace(/\s+$/u, "").split("\n");
	const rows: string[] = [];
	let whole = 0;
	for (const text of sourceLines) {
		const wrapped = wrap([...text].slice(0, 6 * width).join(""), width);
		if (rows.length + wrapped.length > 3) { rows.push(...wrapped.slice(0, 3 - rows.length)); break; }
		rows.push(...wrapped);
		whole += 1;
	}
	return { rows, more: whole < sourceLines.length ? sourceLines.length - whole : 0 };
}

/**
 * The group a framed line belongs to, which decides its label row. You, piroboros (replies, tool calls, tool results and tool
 * errors) and each report are groups. Errors, system lines and hints have none and never change the current group.
 */
export function groupOf(line: Line): string | undefined {
	if (line.role === "user") return "user";
	if (line.role === "assistant" || line.role === "tool" || (line.role === "error" && line.bounded === true)) return "assistant";
	return line.role === "report" ? `report:${line.key}` : undefined;
}

/**
 * Which framed lines start a group (a label row), and which of those are user labels (a blank row before them), plus the group
 * the chat ends in. A label row comes when the group differs from that of the last line that has one.
 */
export function labelPlan(lines: readonly Line[]): { marks: Array<{ label: boolean; blank: boolean }>; group: string | undefined } {
	let group: string | undefined;
	const marks = lines.map((line) => {
		const next = groupOf(line);
		const label = next !== undefined && next !== group;
		if (next !== undefined) group = next;
		return { label, blank: label && line.role === "user" };
	});
	return { marks, group };
}

/**
 * The rows of one entry in the framed layout: an optional divider row (a rule across the chat) and label row, the thinking rows (already indented), then the
 * body indented by 2. `width` is the inner width of the chat box. The text of every row stays one span per piece the app chooses.
 * A report's label ends with a pill (done or failed, or the `badge` state) and, when the app has one for it, the `(2m 14s)` duration: render only, never stored.
 */
export function framedRows(line: Line, { label, blank, width, thinking = [], badge }: { label: boolean; blank: boolean; width: number; thinking?: FrameLine[]; badge?: { state?: PillState; duration?: string } }): FrameLine[] {
	const rows: FrameLine[] = [];
	if (blank) rows.push(ruleLine(width));
	const report: Span[] = [{ text: `◆ ${line.member ?? "member"} report`, color: THEME.accentText, bold: true }, { text: "  " }, pill(badge?.state ?? (line.failed === true ? "failed" : "done")), ...(badge?.duration === undefined ? [] : [{ text: `  (${badge.duration})`, color: THEME.muted }])];
	if (label) rows.push(spanLine(line.role === "user" ? [{ text: "● ", color: THEME.accent }, { text: "You", bold: true }] : line.role === "report" ? report : [{ text: ASSISTANT_LABEL, color: THEME.accentText, bold: true }], width));
	const body = Math.max(1, width - 2);
	const indent = (text: string, color?: string): FrameLine[] => wrap(text, body).map((row) => ({ text: INDENT + row, ...(color === undefined ? {} : { color }) }));
	if (line.role === "error" && line.bounded !== true) return [...rows, ...wrap(`✗ ${line.text}`, width).map((text) => ({ text, color: THEME.error }))];
	if (line.role === "system") return [...rows, ...wrap(`system: ${line.text}`, width).map((text) => ({ text }))];
	if (line.role === "hint") return [...rows, ...indent(line.text, THEME.muted)];
	if (line.role === "tool") {
		const capped = capRows(line.text, body);
		return [...rows, ...capped.rows.map((row) => ({ text: INDENT + row, color: THEME.muted })), ...(capped.more > 0 ? [{ text: INDENT + moreText(capped.more), color: THEME.muted }] : [])];
	}
	if (line.role === "error") {
		// A tool error: the cross and the tool in bold, then the error text, in at most 3 rows.
		const head = `✗ ${line.toolName ?? "tool"}  `;
		const capped = capRows(head + (line.detail ?? line.text), body);
		const errorRows = capped.rows.map((row, i): FrameLine => (i === 0 && row.startsWith(head)
			? spanLine([{ text: INDENT }, { text: "✗ ", color: THEME.error }, { text: line.toolName ?? "tool", color: THEME.error, bold: true }, { text: `  ${row.slice(head.length)}`, color: THEME.error }], width)
			: { text: INDENT + row, color: THEME.error }));
		return [...rows, ...errorRows, ...(capped.more > 0 ? [{ text: INDENT + moreText(capped.more), color: THEME.error }] : [])];
	}
	if (line.role === "assistant") {
		rows.push(...thinking);
		const text = line.body ?? line.text;
		if (text !== "") rows.push(...indent(text));
		for (const call of line.calls ?? []) rows.push(spanLine([{ text: INDENT }, { text: "▸ ", color: THEME.accent }, { text: call.name, bold: true }, ...(call.arg === undefined ? [] : [{ text: "  " }, { text: call.arg, color: THEME.muted }])], width));
		return rows;
	}
	return [...rows, ...indent(line.text)];
}

export { unknownCommand };

const MODE_WORDS = "collapsed, summary or expanded";

/** /thinking-steps [mode] sets the session mode; /thinking-steps global <mode|clear> writes settings.json and sets the session mode too. */
function thinkingStepsCommand(rt: Runtime, args: string[]): string {
	if (args.length === 0) return `thinking steps: ${rt.thinking.mode()}`;
	if (args[0] === "global") {
		const value = args[1]?.toLowerCase() === "clear" ? "clear" : args[1] === undefined ? undefined : parseThinkingMode(args[1]);
		if (args.length !== 2 || value === undefined) return "usage: /thinking-steps global <collapsed|summary|expanded|clear>";
		try {
			rt.thinking.setGlobal(value);
		} catch (error) {
			return `thinking steps not saved: ${error instanceof Error ? error.message : String(error)}`;
		}
		return value === "clear" ? `global thinking steps cleared; this session shows ${rt.thinking.mode()}` : `global thinking steps set to ${value}`;
	}
	const mode = args.length === 1 ? parseThinkingMode(args[0]!) : undefined;
	if (mode === undefined) return `unknown mode; use ${MODE_WORDS}`;
	rt.thinking.set(mode);
	return `thinking steps: ${mode} for this session`;
}

/** Runs a sequence of overlay questions; the chat screen provides it. */
export type Flow = <T>(run: (io: SetupIO, signal: AbortSignal) => Promise<T>) => Promise<T>;

/** A flow's reply: a cancelled flow and a failed one both end as text, never as an unhandled rejection, and nothing secret-shaped is shown. */
const settled = (run: Promise<string>, cancelled: string): Promise<string> =>
	run.then(redactSensitive, (error: unknown) => (error instanceof SetupCancelled ? cancelled : redactSensitive(`failed: ${error instanceof Error ? error.message : String(error)}`)));

const NEEDS_CHAT = (name: string): string => `/${name} needs the chat screen`;

/** Whether a search provider has no key, reading auth.json only when its mtime or the provider changed (a login rewrites it). */
export function missingKeyCheck(authPath: string, env: NodeJS.ProcessEnv = process.env): (provider: SearchProvider) => boolean {
	let stamp: string | undefined;
	let missing = false;
	return (provider) => {
		let mtime = "none";
		try { mtime = String(statSync(authPath).mtimeMs); } catch { /* no auth.json yet */ }
		const next = `${provider}:${mtime}`;
		if (next !== stamp) { stamp = next; missing = searchKey(provider, authPath, env) === undefined; }
		return missing;
	};
}

/** /conclave undo: list what it would do, ask, then restore the pre-images of the last Vesperia run. */
async function undoCommand(rt: Runtime, ask: (question: string) => Promise<boolean>): Promise<string> {
	if (await rt.conclave.live()) return "undo not run: a pipeline is running; /conclave cancel stops it";
	const home = rt.guard.config().home;
	const folder = loadRun(home);
	if (folder === undefined) return "nothing to undo";
	const allowed = (path: string, cwd: string): boolean => checkPath(path, cwd, rt.guard.config()).allowed;
	if (!(await ask(`${preview(plan(home, folder, allowed), folder.bash)}\nRestore these files?`))) return "undo cancelled; nothing was changed";
	const result = apply(home, folder, allowed);
	if (result.restored) await rt.conclave.markRestored(folder.run);
	return result.text;
}

/** Slash commands handled in the UI. Returns the reply text, or undefined when the text is chat for the model. */
export function runCommand(rt: Runtime, text: string, ask?: (question: string) => Promise<boolean>, flow?: Flow): string | Promise<string> | undefined {
	if (!text.startsWith("/")) return undefined;
	const unknown = unknownCommand(text, rt.skills.state().skills, rt.skills.state().declined.map((skill) => skill.name));
	if (unknown !== undefined) return unknown;
	const [name = "", ...rest] = text.slice(1).split(/\s+/u);
	if (name === "model") {
		const ref = rest[0];
		if (ref === undefined) return `main model: ${rt.settings().main ?? "not set"}`;
		const checked = rt.checkMain(ref);
		if (!checked.ok) return `model not changed: ${checked.error}`;
		const write = (): string => {
			const result = rt.setMain(ref);
			return result.ok ? `main model set to ${ref}; it applies at the next turn` : `model not changed: ${result.error}`;
		};
		const lines = securityChanges(rt.stored(), { set: { main: ref } });
		if (lines.length === 0) return write();
		if (ask === undefined) return "model not changed: this change needs a confirmation, which only the chat screen can ask";
		return ask(`${lines.join("\n")}\n${SECURITY_CONFIRM}`).then((yes) => (yes ? write() : "model not changed"));
	}
	if (name === "login") {
		if (flow === undefined) return NEEDS_CHAT(name);
		const target = rest[0];
		return settled(flow((io, signal) => runLogin(rt.setupEnv(), io, signal, target === undefined ? {} : { target })).then((result) => {
			if (result.status === "signed-in") rt.loop.wake();
			return result.message;
		}), "login cancelled");
	}
	if (name === "settings") {
		if (flow === undefined) return NEEDS_CHAT(name);
		return settled(flow((io, signal) => runSettings(rt, io, signal, rest.filter((word) => word !== "").join(" "))), "settings not changed");
	}
	if (name === "reload") {
		const question = (changes: string): Promise<boolean> => ask!(`These files changed outside piroboros:\n${changes}\nAccept the changes and reload?`);
		// Skills are rescanned whatever the settings reload said, with their own question for new or changed project skills.
		const skillsNote = async (): Promise<string> => {
			rt.skills.rescan();
			const asked = ask === undefined ? undefined : await rt.skills.review(ask);
			const scan = rt.skills.state();
			const counts = [scan.skills.length > 0 ? `${scan.skills.length} loaded` : "", scan.issues.length > 0 ? `${scan.issues.length} skipped` : "", scan.pending.length > 0 ? `${scan.pending.length} project skills not answered` : ""].filter((part) => part !== "").join(", ");
			return [asked, counts === "" ? undefined : `skills: ${counts} (see /skills)`].filter((line) => line !== undefined).join("\n");
		};
		return rt.reload(ask === undefined ? undefined : question).then(async (result) => {
			const reply = !result.ok ? (result.declined ? `settings not reloaded: ${result.error}` : `settings not reloaded, the previous configuration is kept: ${result.error}`) : result.warnings === undefined ? "settings reloaded" : `settings reloaded\n${result.warnings.map((warning) => `warning: ${warning}`).join("\n")}`;
			const skills = await skillsNote();
			return skills === "" ? reply : `${reply}\n${skills}`;
		});
	}
	if (name === "status") return statusText(rt.harness, rt.root, rt.compactor.state().label, rt.compactor);
	if (name === "conclave") {
		// cancel, approve, status and undo are whole-line subcommands; anything else is the task text.
		const sub = rest.length === 1 ? rest[0] : undefined;
		if (sub === "cancel") return rt.conclave.cancel();
		if (sub === "status") return rt.conclave.status();
		if (sub === "undo") return ask === undefined ? "undo not run: this needs a confirmation, which only the chat screen can ask" : undoCommand(rt, ask);
		const started = sub === "approve" ? rt.conclave.approve() : rt.conclave.start(text.slice("/conclave".length));
		return started.then((result) => (result.ok ? result.message : `not started: ${result.error}`));
	}
	if (name === "skills") return skillsReport(rt.skills.state(), COMMANDS.map((command) => command.name));
	if (name === "akashic") return rt.akashic(rest.join(" "));
	if (name === "thinking-steps") return thinkingStepsCommand(rt, rest);
	return undefined;
}

export interface StatusBus {
	get(): TurnStatus;
	set(status: TurnStatus): void;
	/** Put text back in the input box (aborted or failed turn). */
	restore(text: string): void;
	takeRestore(): string | undefined;
	subscribe(listener: () => void): () => void;
}

export function createStatusBus(): StatusBus {
	let current: TurnStatus = { kind: "idle" };
	let restored: string | undefined;
	const listeners = new Set<() => void>();
	const notify = (): void => { for (const listener of listeners) listener(); };
	return {
		get: () => current,
		set: (status) => { current = status; notify(); },
		restore: (text) => { restored = text; notify(); },
		takeRestore: () => { const text = restored; restored = undefined; return text; },
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
	};
}

/** `overlay` is the question overlay the app owns; tests (and later flows) may pass their own to drive it. */
export function App({ rt, banners, bus, overlay }: { rt: Runtime; banners: string[]; bus: StatusBus; overlay?: SetupDriver }): ReactElement {
	const app = useApp();
	const [entries, setEntries] = useState<Entry[]>([]);
	const [pending, setPending] = useState<Array<{ text: string; source: string; member: string | null }>>([]);
	const [running, setRunning] = useState(false);
	const [viewBytes, setViewBytes] = useState(0);
	const [compactorNote, setCompactorNote] = useState<string | undefined>(undefined);
	const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | undefined>(undefined);
	const [status, setStatus] = useState<TurnStatus>(bus.get());
	// The response being written: its attempt and the committed partial message (D23 reads thinking from it).
	const [live, setLive] = useState<{ attempt: number; message: unknown } | undefined>(undefined);
	const [, setModeTick] = useState(0);
	const busy = useRef(false);
	const [notes, setNotes] = useState<string[]>([]);
	const [webKeyMissing, setWebKeyMissing] = useState(false);
	const note = (reply: string): void => setNotes((list) => [...list, reply].slice(-5));
	const { stdout } = useStdout();
	// Every render sets the real terminal cursor (a position, or undefined to hide it): Ink keeps only a position set since the last render.
	const { setCursorPosition } = useCursor();
	const sizeOf = (): { columns: number; rows: number } => ({ columns: (stdout as { columns?: number }).columns ?? 80, rows: (stdout as { rows?: number }).rows ?? 24 });
	const [size, setSize] = useState(sizeOf());
	const { columns, rows: screenRows } = size;
	useEffect(() => {
		const onResize = (): void => { setSize(sizeOf()); syncRef.current(); };
		stdout.on("resize", onResize);
		return () => { stdout.off("resize", onResize); };
	}, [stdout]);

	// One input handler for the whole app. ownerRef is set synchronously (when the overlay opens or closes and when the
	// text changes), never through isActive, which switches one render late: a secret typed or pasted in that gap would reach the chat.
	const [driver] = useState(() => overlay ?? createSetupDriver());
	const flows = useRef(new Set<AbortController>());
	const ownerRef = useRef<Owner>("chat");
	const valueRef = useRef("");
	const restoredRef = useRef<string | undefined>(undefined);
	const dismissedRef = useRef(false);
	const indexRef = useRef(0);
	const offsetRef = useRef(0);
	const lastCtrlC = useRef(0);
	// Chat scroll: rows above the bottom, the chat height of the last render (a page is two rows less), and the width and
	// row count of the render before, so a view that was scrolled keeps its place while new rows arrive.
	const scrollRef = useRef(0);
	const heightRef = useRef(3);
	const seenRef = useRef({ width: 0, total: 0 });
	/** The text in the input was typed or pasted since the last Ctrl+C or send; restored text is not a draft. */
	const typedRef = useRef(false);
	const rowCache = useRef(new Map<string, FrameLine[]>());
	const syncRef = useRef<() => void>(() => {});
	const [, repaint] = useState(0);
	const modelOptions = (): ModelOption[] => rt.models.getProviders().flatMap((provider) => modelChoices(rt.models, provider.id, "main").map((choice) => ({ ref: choice.ref, ...(choice.check.ok ? {} : { disabled: choice.check.reason ?? "rejected" }) })));
	const loginOptions = (): LoginOption[] => providerChoices(rt.models).map((provider) => ({ id: provider.id, name: provider.name }));
	// Under 7 rows the frame has no room for the list (see allocate), so the chat keeps the keys.
	const listNow = (): PickEntry[] => (dismissedRef.current || sizeOf().rows < 7 ? [] : suggest(valueRef.current, valueRef.current.startsWith("/model ") ? modelOptions() : [], valueRef.current.startsWith("/login ") ? loginOptions() : [], rt.skills.state().skills));
	const sync = (): void => { ownerRef.current = driver.state().request !== undefined ? "overlay" : listNow().length > 0 ? "picker" : "chat"; };
	syncRef.current = sync;
	/** Any change of the text reopens a dismissed list and selects its first entry. */
	const setValue = (text: string): void => {
		valueRef.current = text;
		dismissedRef.current = false;
		indexRef.current = 0;
		offsetRef.current = 0;
		sync();
		repaint((n) => n + 1);
	};
	/** A flow is a sequence of overlay questions. It gets an AbortController that is aborted when it ends, is cancelled, or the app exits. */
	const refreshRef = useRef<() => void>(() => {});
	// Every notice a flow shows goes through redactSensitive. The sign-in address is not text: it was checked by safeAuthUrl and is shown whole.
	const flowIo: SetupIO = { ...driver.io, notify: (kind, message) => driver.io.notify(kind, redactSensitive(message)) };
	const runFlow: Flow = async (flow) => {
		const controller = new AbortController();
		flows.current.add(controller);
		try {
			return await flow(flowIo, controller.signal);
		} finally {
			flows.current.delete(controller);
			controller.abort();
			driver.reset();
			refreshRef.current();
		}
	};
	const cancelFlows = (): void => {
		for (const controller of flows.current) controller.abort();
		driver.cancelAll();
	};
	// The /reload question: the changed files are notices (full text, scrollable), the last line is the confirm.
	const ask = (question: string): Promise<boolean> => runFlow(async (io) => {
		const lines = question.split("\n");
		if (lines.length > 1) io.notify("info", lines.slice(0, -1).join("\n"));
		return io.confirm(lines[lines.length - 1]!, false);
	}).catch((error: unknown) => {
		if (error instanceof SetupCancelled) return false;
		throw error;
	});
	// A failed session is reported by runApp through rt.fatal; any other rejection becomes a notice instead of a crash.
	const failure = (error: unknown): void => { if (!(error instanceof SessionFailed)) note(error instanceof Error ? error.message : String(error)); };
	const onSubmit = (text: string): void => {
		const reply = runCommand(rt, text, ask, runFlow);
		if (reply === undefined) {
			setNotes([]);
			void rt.send(text).catch(failure);
		} else {
			if (typeof reply === "string") note(reply);
			else void reply.then(note, failure);
			if (unknownCommand(text, rt.skills.state().skills, rt.skills.state().declined.map((skill) => skill.name)) !== undefined) setValue(text);
		}
	};
	const submit = (override?: string): void => {
		const text = (override ?? valueRef.current).trim();
		if (text.length === 0) return;
		scrollRef.current = 0;
		typedRef.current = false;
		setValue("");
		onSubmit(text);
	};
	useInput((input, key) => {
		const list = listNow();
		const state = { busy: busy.current, now: Date.now(), lastCtrlC: lastCtrlC.current, draft: ownerRef.current !== "overlay" && valueRef.current !== "" && typedRef.current };
		const routed = route(ownerRef.current, input, key as Keys, state, driver.state().request?.kind, valueRef.current, list[Math.min(indexRef.current, list.length - 1)]);
		if (key.ctrl && input === "c") { lastCtrlC.current = state.now; typedRef.current = false; }
		if (routed.to === "overlay") { applyOverlay(driver, routed.action, Math.max(1, sizeOf().rows - 8)); return; }
		if (routed.to === "picker") {
			const action = routed.action;
			if (action.t === "move") { indexRef.current = Math.min(Math.max(0, indexRef.current + action.delta), Math.max(0, list.length - 1)); repaint((n) => n + 1); }
			else if (action.t === "complete") setValue(action.value);
			else if (action.t === "dismiss") { dismissedRef.current = true; sync(); repaint((n) => n + 1); }
			else if (action.t === "submit") submit(action.text);
			return;
		}
		const action = routed.action;
		if (action.t === "exit") { cancelFlows(); app.exit(); }
		else if (action.t === "abort") void rt.root.abort(ctx).catch(failure);
		else if (action.t === "cycle") note(`thinking steps: ${rt.thinking.cycle()}`);
		else if (action.t === "level") {
			const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf((rt.settings().thinking ?? "medium") as never) + 1) % THINKING_LEVELS.length]!;
			const result = rt.updateSettings({ set: { thinking: next } });
			note(result.ok ? `thinking: ${next}; it applies at the next turn` : `thinking not changed: ${result.error}`);
		}
		else if (action.t === "submit") submit();
		else if (action.t === "clear") setValue("");
		else if (action.t === "scroll") {
			scrollRef.current = action.to === "end" ? 0 : Math.max(0, scrollRef.current + (action.to === "up" ? 1 : -1) * Math.max(1, heightRef.current - 2));
			repaint((n) => n + 1);
		} else if (action.t === "backspace") { typedRef.current = true; setValue(dropLast(valueRef.current)); }
		else if (action.t === "insert") { typedRef.current = true; setValue(valueRef.current + action.text); }
	});
	usePaste((text) => {
		if (ownerRef.current === "overlay") applyOverlay(driver, { t: "type", text: text.replace(/[\r\n]+/gu, "") }, 1);
		else { typedRef.current = true; setValue(valueRef.current + text); }
	});
	useEffect(() => driver.subscribe(() => { sync(); repaint((n) => n + 1); }), [driver]);
	useEffect(() => () => cancelFlows(), []);
	useEffect(() => rt.thinking.subscribe(() => setModeTick((n) => n + 1)), [rt]);
	// Project skills seen for the first time (or changed): one question once the screen is up. Until it is answered the index holds user skills only.
	useEffect(() => { void rt.skills.review(ask).then((reply) => { if (reply !== undefined) note(reply); }, failure); }, [rt]);

	useEffect(() => bus.subscribe(() => {
		setStatus(bus.get());
		const text = bus.takeRestore();
		if (text === undefined) return;
		// A steer and its turn are restored one after the other, the later message first: put each new text before the one restored a moment ago, unless the user has typed since.
		setValue(restoredRef.current !== undefined && valueRef.current === restoredRef.current ? `${text}\n${valueRef.current}` : text);
		restoredRef.current = valueRef.current;
	}), [bus]);
	useEffect(() => {
		let alive = true;
		let scheduled = false;
		const keyMissing = missingKeyCheck(rt.paths.auth);
		const refresh = async (): Promise<void> => {
			scheduled = false;
			if (!alive) return;
			try {
				const list = await recentEntries(rt.root, 60);
				const live = await rt.harness.snapshot(LiveDoc, ROOT, ctx);
				const doc = await rt.harness.snapshot(PendingDoc, ctx);
				const view = await rt.harness.snapshot(ViewDoc, ctx);
				if (!alive) return;
				setViewBytes(view?.bytes ?? 0);
				setCompactorNote(await rt.compactor.note());
				setMemoryStatus(rt.memoryStatus());
				const web = withDefaults(rt.settings()).web;
				setWebKeyMissing(web.provider !== undefined && keyMissing(web.provider));
				busy.current = live?.run !== undefined;
				setRunning(busy.current);
				setLive(live?.generation === undefined ? undefined : { attempt: live.generation.attempt, message: live.generation.message });
				setEntries([...list]);
				setPending((doc?.items ?? []).map((item) => ({ text: item.text, source: item.source, member: item.member })));
			} catch {
				// the session closed while a refresh was in flight
			}
		};
		const stop = rt.harness.subscribeCommits(() => { if (!scheduled) { scheduled = true; setTimeout(() => { void refresh(); }, 100); } });
		refreshRef.current = () => { void refresh(); };
		void refresh();
		return () => { alive = false; refreshRef.current = () => {}; stop(); };
	}, [rt]);

	const pane = usePane(rt);
	const settings = rt.settings();
	const label = rt.compactor.state().label;
	const growing = viewBanner(label, viewBytes);
	const frameWidth = Math.max(10, columns - 1);
	// The framed layout (P18): a header row, a chat box, a right box and an input box. Under 60 columns or 16 rows the P17 layout is drawn.
	const framed = screenRows >= 16 && columns >= 60;
	// Tall: a rule under the header and the title row of the chat box (2 more rows of chrome).
	const tall = framed && screenRows >= 24;
	// Standing rows: one row each. Alerts: the row for the status kind, then what to do next (2 rows at most).
	const standing: FrameLine[] = [...(growing === undefined ? [] : [growing]), ...(compactorNote === undefined ? [] : [compactorNote]), ...banners].map((text) => ({ text: clip(text, frameWidth), color: THEME.warn }));
	const alerts: FrameLine[] = [];
	const alert = (text: string, color?: string): void => { alerts.push({ text: clip(text, frameWidth), ...(color === undefined ? { dim: true } : { color }) }); };
	if (status.kind === "login_required") alert(`login required for ${status.provider}: use /login`, THEME.error);
	if (status.kind === "unconfigured") alert("no main model is set: use /model or /login", THEME.error);
	if (status.kind === "stopped" && !running) { alert(status.message, THEME.error); alert("Send a new message to continue."); }
	if (status.kind === "compactor_degraded") alert(status.message, THEME.warn);
	if (status.kind === "notice") alert(status.message, THEME.warn);
	if (status.kind === "error") alert(`error: ${status.message}`, THEME.error);
	if (status.kind === "turn_failed" && !running && restoredRef.current !== undefined && valueRef.current === restoredRef.current) alert("Your message is back in the input. Press Enter to send it again.");
	// The thinking panel (D23): a level of off, or a model without reasoning, hides it. Only the visible lines are derived.
	const mainModel = settings.main === undefined ? undefined : resolveModel(rt.models, settings.main);
	const suppressed = (settings.thinking ?? "medium") === "off" || mainModel?.reasoning === false;
	const mode = rt.thinking.mode();
	const lastReply = lastResponseOf(entries);
	const statusInput: StatusInput = { main: settings.main, last: lastReply, compactor: label, thinking: settings.thinking ?? "medium", busy: running, ...(memoryStatus === undefined ? {} : { memory: memoryStatus }), ...(status.kind === "turn_failed" ? { failed: status.message } : {}) };
	const statusText = formatStatus(statusInput, frameWidth);
	// An open overlay replaces the chat and the pane, and the input line is hidden. State keeps updating underneath.
	// The frame plus the one-line status stays under the terminal height, and no line is wider than the terminal.
	if (driver.state().request !== undefined) {
		setCursorPosition(undefined);
		const frame = buildFrame(driver.state(), columns, screenRows - 1);
		return createElement(Box, { flexDirection: "column" }, ...rowsOf(frame, "o"), ...rowsOf([{ text: clip(statusText, frameWidth), dim: true }], "status"));
	}
	// Wide terminal: the right column is always there, with fixed widths, and shows the Conclave pane while a run is on
	// screen and the session panel otherwise. Narrow terminal: the chat alone, and the pane under it while a pipeline exists.
	// Framed, every outer width adds up to columns - 1; a box takes 4 columns for its borders and padding.
	const sideBySide = columns >= SIDE_BY_SIDE_MIN_COLUMNS;
	const leftWidth = Math.floor(columns * 0.7) - 1;
	const rightWidth = columns - leftWidth;
	const showPane = pane !== undefined && (!sideBySide || paneVisible(pane));
	const innerWidth = frameWidth - 4;
	const chatWidth = framed ? (sideBySide ? leftWidth - 4 : innerWidth) : sideBySide ? leftWidth : frameWidth;
	const sideWidth = framed ? frameWidth - leftWidth - 4 : rightWidth - 2;
	const paneThinking: ThinkingView | undefined = pane?.thinking === undefined || pane.active === undefined ? undefined : { blocks: pane.thinking.blocks, steps: rt.thinking.memo.steps(pane.active.conv, pane.thinking.id, pane.thinking.blocks, pane.thinking.live), streaming: pane.thinking.live, mode };

	// Chat rows: each entry wrapped to the chat width, cached by what decides its rows. The live partial is never cached.
	const cache = new Map<string, FrameLine[]>();
	const thinkingOf = (id: string, blocks: ThinkingSourceBlock[], streaming: boolean): FrameLine[] => {
		const rows = thinkingLines({ blocks, steps: rt.thinking.memo.steps(ROOT, id, blocks, streaming), streaming, mode, suppressed }, framed ? chatWidth - 2 : chatWidth);
		return framed ? rows.map(indented) : rows;
	};
	const rowsOfLine = (line: Line, label: boolean, blank: boolean, badge?: { state?: PillState; duration?: string }): FrameLine[] => {
		if (framed) return framedRows(line, { label, blank, width: chatWidth, ...(badge === undefined ? {} : { badge }), ...(line.thinking === undefined || suppressed ? {} : { thinking: thinkingOf(line.key, line.thinking, false) }) });
		if (line.role === "error" && line.bounded !== true) return wrap(line.text, chatWidth).map((text) => ({ text, color: THEME.error }));
		if (line.role === "hint") return wrap(line.text, chatWidth).map((text) => ({ text, dim: true }));
		const prefix = line.role === "user" ? "you" : line.role === "assistant" ? "piroboros" : line.role === "report" ? `${line.member ?? "member"} report` : line.role;
		const source = line.role === "error" ? line.text : `${prefix}: ${line.text}`;
		const style = line.role === "error" ? { color: THEME.error } : line.role === "user" ? { color: THEME.accentText } : {};
		let body: FrameLine[];
		if (line.bounded === true) {
			const capped = capRows(source, chatWidth);
			body = capped.rows.map((row) => ({ text: row, ...style }));
			if (capped.more > 0) body.push({ text: moreText(capped.more), dim: true });
		} else body = wrap(source, chatWidth).map((text) => ({ text, ...style }));
		return line.thinking === undefined || suppressed ? body : [...thinkingOf(line.key, line.thinking, false), ...body];
	};
	const chatRows: FrameLine[] = entries.length >= 60 ? [{ text: "(older history not shown)", dim: true }] : [];
	const lines = linesOf(entries);
	const { marks, group } = framed ? labelPlan(lines) : { marks: lines.map(() => ({ label: false, blank: false })), group: undefined };
	// Report labels end with a pill and, for the newest report of a member whose run has ended, its duration. Render only: no line or document stores them.
	const newestReport = new Map<string, number>();
	lines.forEach((line, i) => { if (line.role === "report") newestReport.set(line.member ?? "member", i); });
	const paneSeats = pane === undefined ? [] : seatsOf(pane.rows);
	const badgeOf = (line: Line, i: number): { state?: PillState; duration?: string } | undefined => {
		if (!framed || line.role !== "report" || newestReport.get(line.member ?? "member") !== i) return undefined;
		const k = pane?.rows.findIndex((row) => row.name === line.member) ?? -1;
		const row = k < 0 ? undefined : pane!.rows[k];
		if (row?.end === undefined) return undefined;
		const waiting = pending.some((item) => item.source === "conclave" && item.member === line.member);
		const ended = paneSeats[k] === "vesperia" && (row.state === "done" || row.state === "partial" || row.state === "blocked" || row.state === "failed");
		return { ...(ended ? { state: row.state } : {}), ...(waiting || row.start === undefined ? {} : { duration: formatDuration(row.end - row.start) }) };
	};
	for (const [i, line] of lines.entries()) {
		const { label: labeled } = marks[i]!;
		// The first line of the chat has no rule above it, so what the cache holds never depends on the scroll.
		const blank = marks[i]!.blank && i > 0;
		const badge = badgeOf(line, i);
		const key = `${line.key}|${line.text.length}|${chatWidth}|${mode}|${suppressed}|${framed}|${labeled}|${blank}|${badge?.state ?? ""}|${badge?.duration ?? ""}`;
		const rows = rowCache.current.get(key) ?? rowsOfLine(line, labeled, blank, badge);
		cache.set(key, rows);
		chatRows.push(...rows);
	}
	rowCache.current = cache;
	if (live !== undefined) {
		const liveRows: FrameLine[] = [];
		if (!suppressed) liveRows.push(...thinkingOf(`live:${live.attempt}`, thinkingBlocksOf(live.message), true));
		const writing = textOf((live.message as { content?: unknown } | undefined)?.content).replace(/\s+/gu, " ").trim();
		if (framed) {
			if (writing !== "") liveRows.push(...wrap(`${writing} (writing)`, chatWidth - 2).map((text) => ({ text: `  ${text}`, color: THEME.muted })));
			// No live rows, no live label; the label follows the last committed group, so committing the message adds none.
			if (liveRows.length > 0 && group !== "assistant") liveRows.unshift(spanLine([{ text: ASSISTANT_LABEL, color: THEME.accentText, bold: true }], chatWidth));
		} else if (writing !== "") liveRows.push(...wrap(`piroboros: ${writing} (writing)`, chatWidth).map((text) => ({ text, dim: true })));
		chatRows.push(...liveRows);
	}

	// Everything else the frame can show, then the split of the rows.
	const list = listNow();
	const queuedItems = pending.map((item) => ({ text: item.source === "conclave" ? `(queued) report from ${item.member ?? "member"}` : `(queued) ${item.text.split("\n")[0]}`, dim: true }));
	const noteRows = notes.map((text) => wrap(text, framed ? frameWidth - 2 : frameWidth));
	const paneStacked = !sideBySide && showPane;
	const alloc = allocate(screenRows, {
		picker: Math.min(list.length, PICKER_MAX_ROWS + 1),
		alerts: alerts.length,
		notes: noteRows.map((lines) => lines.length),
		standing: standing.map(() => 1),
		queued: queuedItems.length,
		// Framed, the keys sit in the input box.
		hint: !framed && valueRef.current === "" && ownerRef.current === "chat" ? 1 : 0,
		pane: paneStacked ? paneLines(pane!, framed ? innerWidth : frameWidth, 99, paneThinking, true, framed).length : 0,
		stacked: paneStacked,
		chrome: framed ? (tall ? 7 : 5) : 0,
		live: framed && (running || pane?.live === true) ? 2 : 0,
	});

	// The chat view: which rows show, where the view sits (see chatWindow), and the indicator row.
	let offset = scrollRef.current;
	if (offset > 0 && seenRef.current.width === chatWidth) offset += chatRows.length - seenRef.current.total;
	const win = chatWindow(chatRows.length, alloc.chat, scrollRef.current > 0 ? Math.max(1, offset) : 0);
	scrollRef.current = win.offset;
	heightRef.current = alloc.chat;
	seenRef.current = { width: chatWidth, total: chatRows.length };
	const shown: FrameLine[] = [...(win.indicator ? [{ text: chatIndicator(win.earlier, win.newer), dim: true }] : []), ...chatRows.slice(win.start, win.end)];
	const queued: FrameLine[] = alloc.queued < queuedItems.length && alloc.queued > 0 ? [...queuedItems.slice(0, alloc.queued - 1), { text: `(+${queuedItems.length - alloc.queued + 1} more queued)`, dim: true }] : queuedItems.slice(0, alloc.queued);

	const web = withDefaults(settings).web;
	const panelData: PanelData = { main: settings.main, thinking: settings.thinking ?? "medium", viewBytes, compactor: label, memory: memoryStatus, web: { enabled: web.enabled, provider: web.provider, keyMissing: webKeyMissing }, outcome: pane !== undefined && !paneVisible(pane) ? pane.outcome : undefined };
	// Framed, the chat box holds the title row (tall), the chat, the queued items, padding, and the live rows at its bottom.
	const runningRow = pane?.live === true ? pane.rows.find((row) => row.state === "running") : undefined;
	const waitingFor = runningRow === undefined ? "Waiting for the Conclave" : `Waiting for ${runningRow.name}${pane!.active?.turns === undefined || pane!.active.maxTurns === undefined ? "" : ` (turn ${Math.min(pane!.active.turns + 1, pane!.active.maxTurns)} of ${pane!.active.maxTurns})`}`;
	const liveRows: FrameLine[] = alloc.live === 0 ? [] : [ruleLine(chatWidth), spanLine([{ text: running ? "piroboros is working" : waitingFor, color: THEME.muted }], chatWidth)];
	const titleRows: FrameLine[] = tall ? [spanLine([{ text: ASSISTANT_LABEL, color: THEME.accentText, bold: true }, { text: `  (${settings.main ?? "no model set"})`, color: THEME.muted }], chatWidth)] : [];
	const padRows: FrameLine[] = liveRows.length === 0 ? [] : Array.from({ length: Math.max(0, alloc.chat + alloc.queued - shown.length - queued.length) }, () => ({ text: "" }));
	const leftRows = [...rowsOf(titleRows, "T"), ...rowsOf(shown, "c"), ...rowsOf(queued, "q"), ...rowsOf(padRows, "g"), ...rowsOf(liveRows, "v")];
	const box = { borderStyle: "round", paddingX: 1, overflow: "hidden", flexShrink: 0, flexDirection: "column" } as const;
	const boxHeight = alloc.chat + alloc.queued + (alloc.pane > 0 ? alloc.pane + 1 : 0) + alloc.live + (tall ? 1 : 0) + 2;
	// The right box of the framed side-by-side layout: the same height as the chat box.
	const contextWindow = lastReply === undefined ? undefined : resolveModel(rt.models, `${lastReply.provider}/${lastReply.model}`)?.contextWindow;
	const panel = framed && sideBySide ? rightPanelLines({ ...(pane === undefined ? {} : { model: pane }), session: panelData, ...(lastReply === undefined ? {} : { usage: { ...lastReply, ...(contextWindow === undefined ? {} : { contextWindow }) } }), describe: pane?.descriptions ?? {}, ...(paneThinking === undefined ? {} : { thinking: paneThinking }), formatTime: clock }, sideWidth, boxHeight - 2) : undefined;
	const body = framed
		? sideBySide
			? createElement(
				Box,
				{ key: "panes", flexDirection: "row" },
				createElement(Box, { key: "left", ...box, borderColor: THEME.border, width: leftWidth, height: boxHeight }, ...leftRows),
				createElement(Box, { key: "right", ...box, borderColor: THEME.border, width: frameWidth - leftWidth, height: boxHeight }, ...rowsOf(panel!.lines, "r")),
			)
			: createElement(Box, { key: "panes", ...box, borderColor: THEME.border, width: frameWidth, height: boxHeight }, ...leftRows, ...(alloc.pane === 0 ? [] : [...rowsOf([{ text: "─".repeat(innerWidth), dim: true }], "m"), createElement(ConclavePane, { key: "pane", model: pane!, width: innerWidth, maxRows: alloc.pane, stacked: true, framed: true, ...(paneThinking === undefined ? {} : { thinking: paneThinking }) })]))
		: sideBySide
		? createElement(
			Box,
			{ key: "panes", flexDirection: "row" },
			createElement(Box, { key: "left", flexDirection: "column", width: leftWidth, flexShrink: 0 }, ...leftRows),
			createElement(Box, { key: "right", flexDirection: "column", width: rightWidth, flexShrink: 0, paddingLeft: 1 }, showPane ? createElement(ConclavePane, { model: pane!, width: rightWidth - 2, maxRows: alloc.chat + alloc.queued, stacked: false, ...(paneThinking === undefined ? {} : { thinking: paneThinking }) }) : createElement(SessionPanel, { data: panelData, width: rightWidth - 2, maxRows: alloc.chat + alloc.queued })),
		)
		: createElement(Box, { key: "panes", flexDirection: "column" }, ...leftRows, ...(alloc.pane === 0 ? [] : [...rowsOf([{ text: "" }], "m"), createElement(ConclavePane, { key: "pane", model: pane!, width: frameWidth, maxRows: alloc.pane, stacked: true, ...(paneThinking === undefined ? {} : { thinking: paneThinking }) })]));

	// Replies, newest last. A reply that does not fit ends with the count of the rows left out.
	// A reply is green in the P17 layout; framed it sits behind an accent gutter in the default color.
	const noteLine = (text: string): FrameLine => (framed ? { text: `│ ${text}`, spans: [{ text: "│ ", color: THEME.accent }, { text }] } : { text, color: THEME.ok });
	const noteFrame: FrameLine[] = noteRows.flatMap((lines, i) => {
		const given = alloc.notes[i] ?? 0;
		if (given >= lines.length) return lines.map(noteLine);
		if (given === 0) return [];
		const more = lines.length - (given - 1);
		return [...lines.slice(0, given - 1).map(noteLine), { text: moreText(more), dim: true }];
	});
	const selected = Math.min(indexRef.current, Math.max(0, list.length - 1));
	const picker = alloc.picker === 0 ? { lines: [], offset: 0 } : buildPicker(list, selected, offsetRef.current, columns, alloc.picker);
	offsetRef.current = picker.offset;
	const hint: FrameLine[] = alloc.hint === 0 ? [] : [{ text: clip(`keys: ${running ? RUNNING_KEYS : IDLE_KEYS}`, frameWidth), dim: true }];
	const common = [
		...rowsOf(standing.slice(0, alloc.standing.filter((n) => n > 0).length), "s"),
		...rowsOf(noteFrame, "n"),
		...rowsOf(alerts.slice(0, alloc.alerts), "a"),
	];
	const standingShown = alloc.standing.filter((n) => n > 0).length;
	const alertsShown = alerts.slice(0, alloc.alerts).length;
	const value = valueRef.current;
	if (!framed) {
		// The cursor row: every row built above the input. The body is as tall as its taller column, or the chat and the pane under it.
		const maxRows = alloc.chat + alloc.queued;
		const bodyRows = sideBySide
			? Math.max(leftRows.length, showPane ? paneLines(pane!, rightWidth - 2, maxRows, paneThinking, false).length : panelLines(panelData, rightWidth - 2).slice(0, Math.max(0, maxRows)).length)
			: leftRows.length + (alloc.pane === 0 ? 0 : 1 + paneLines(pane!, frameWidth, alloc.pane, paneThinking, true).length);
		const shownTail = tail(value, columns - 3);
		const y = inputRowIndex([bodyRows, Math.min(standingShown, standing.length), noteFrame.length, alertsShown, alloc.status === 0 ? 0 : 1, picker.lines.length, hint.length], false);
		setCursorPosition(alloc.input === 0 ? undefined : { x: 2 + stringWidth(shownTail), y });
		return createElement(
			Box,
			{ flexDirection: "column" },
			body,
			...common,
			...(alloc.status === 0 ? [] : rowsOf([{ text: statusText, dim: true }], "t")),
			...rowsOf(picker.lines, "k"),
			...rowsOf(hint, "h"),
			...(alloc.input === 0 ? [] : rowsOf([{ text: `> ${shownTail}` }], "i")),
		);
	}
	// The stat strip sits at the right of the input row. An empty input keeps its whole placeholder, so the strip needs room for both;
	// typed text keeps 22 columns. The cache counts show in the status row exactly when the strip is hidden.
	const stripSpans = statsOf(lastReply, contextWindow);
	const stripWidth = stripSpans === undefined ? 0 : stringWidth(stripSpans.map((span) => span.text).join(""));
	const placeholder = running ? RUNNING_KEYS : IDLE_KEYS;
	// The strip gives way to the Input row of the right panel, when that row is on screen.
	const showStrip = stripSpans !== undefined && panel?.usage.input !== true && (value === "" ? 2 + stringWidth(placeholder) + 2 + stripWidth <= innerWidth : innerWidth - 2 - stripWidth - 2 >= 22);
	const room = innerWidth - 2 - (showStrip ? stripWidth + 2 : 0);
	const left: Span[] = [{ text: "> ", color: THEME.accent }, value === "" ? { text: clip(placeholder, room), color: THEME.muted } : { text: tail(value, room) }];
	const used = 2 + stringWidth(left[1]!.text);
	const inputRow = spanLine([...left, ...(showStrip ? [{ text: " ".repeat(innerWidth - used - stripWidth) }, ...stripSpans!] : [])], innerWidth);
	// The cache counts show in the status row unless the strip or the Read and Cache rows of the right panel show them.
	const statusRow = spanLine(statusSpans({ ...statusInput, busy: false, failed: undefined }, frameWidth, !showStrip && panel?.usage.cache !== true), frameWidth);
	// The cursor sits after the typed text, at the start of the placeholder when the input is empty: border, padding, "> ", then the text.
	const y = inputRowIndex([1, tall ? 1 : 0, boxHeight, Math.min(standingShown, standing.length), noteFrame.length, alertsShown, alloc.status === 0 ? 0 : 1, picker.lines.length], true);
	setCursorPosition({ x: 4 + (value === "" ? 0 : stringWidth(left[1]!.text)), y });
	return createElement(
		Box,
		{ flexDirection: "column" },
		...rowsOf([headerRow(running, status, pane?.live === true ? { done: pane.rows.filter((row) => row.state === "done").length, total: pane.rows.length } : undefined, frameWidth)], "H"),
		...(tall ? rowsOf([ruleLine(frameWidth)], "R") : []),
		body,
		...common,
		...(alloc.status === 0 ? [] : rowsOf([statusRow], "t")),
		...rowsOf(picker.lines, "k"),
		createElement(Box, { key: "input", borderStyle: "round", borderColor: THEME.accent, paddingX: 1, width: frameWidth, height: 3, overflow: "hidden", flexShrink: 0 }, ...rowsOf([inputRow], "i")),
	);
}

export async function runApp(rt: Runtime, banners: string[], bus: StatusBus, io: { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream } = {}): Promise<{ failed: unknown } | undefined> {
	const app = render(createElement(App, { rt, banners, bus }), { exitOnCtrlC: false, stdout: io.stdout, stdin: io.stdin, patchConsole: false });
	// A failed durable session leaves nothing to type into: unmount and hand the storage error to the caller.
	const outcome = await Promise.race([app.waitUntilExit().then(() => undefined), rt.fatal.then((failed) => ({ failed }))]);
	if (outcome !== undefined) {
		app.unmount();
		await app.waitUntilExit().catch(() => {});
	}
	return outcome;
}

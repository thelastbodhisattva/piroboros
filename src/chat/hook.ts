import { ctx, GenerationTask, hook } from "../durable.ts";
import type { Message, TextContent } from "../models.ts";
import { PlanDoc, planBlock, type PlanItem } from "./plan.ts";
import { TurnStateDoc, ViewDoc, type TurnState } from "./tree.ts";
import { renderLines, viewBlocks, type Line } from "./view.ts";

// The beforeRequest hook (D1, D21): request = [tools][static system][view][per-turn state + new message(s)]
// [current-turn entries]. The view is inserted into the first user message as separate text blocks, so the
// stored transcript never holds it. The hook reads committed documents only, so a rerun gives the same bytes.

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `2026-10-11 14:03:22 UTC+02:00`, in the local zone, with the offset that applied at that moment. */
export function formatDate(ms: number): string {
	const d = new Date(ms);
	const offset = -d.getTimezoneOffset();
	const sign = offset < 0 ? "-" : "+";
	const abs = Math.abs(offset);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export const turnBlock = (turn: Pick<TurnState, "at" | "cwd">): string => `<turn>${formatDate(turn.at)}; cwd: ${turn.cwd}</turn>`;

/** Insert the view and the per-turn block into the first user message. Undefined when there is no user message. */
export function insertView(messages: readonly Message[], lines: readonly Line[], turn: TurnState | undefined, plan: readonly PlanItem[] = []): readonly Message[] | undefined {
	const at = messages.findIndex((message) => message.role === "user");
	if (at < 0) return undefined;
	const first = messages[at] as Extract<Message, { role: "user" }>;
	const rendered = renderLines(lines, turn?.windowStart ?? 0, turn?.compactor ?? "configured");
	const text = (value: string): TextContent => ({ type: "text", text: value });
	const own = typeof first.content === "string" ? [text(first.content)] : first.content;
	const content = [...viewBlocks(rendered).map(text), ...(turn === undefined ? [] : [text(turnBlock(turn))]), ...(plan.length === 0 ? [] : [text(planBlock(plan))]), ...own];
	const out = messages.slice();
	out[at] = { ...first, content };
	return out;
}

export const viewHook = hook(GenerationTask, {
	async beforeRequest(request, api) {
		const view = await api.snapshot(ViewDoc, ctx);
		const turn = await api.snapshot(TurnStateDoc, ctx);
		const plan = await api.snapshot(PlanDoc, api.conversationId, ctx);
		const messages = insertView(request.messages, (view?.lines ?? []) as Line[], turn as TurnState | undefined, (plan?.items ?? []) as PlanItem[]);
		return messages === undefined ? undefined : { messages };
	},
});

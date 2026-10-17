import { AgentDoc, ctx, GenerationTask, hook } from "../durable.ts";
import { estimateTokens, type Message, type ToolResultMessage } from "../models.ts";

// The budget hook (D8, H1), selected last in every conversation. It works on the request only: stored entries,
// the index, the view and zoom never see a stub. The room is what is left of the context after the system prompt,
// the tools and the first user message (which holds the view); the view is never shrunk for this.
//
//  - From 60% of the room: every bulky tool output older than the last two tool rounds of the current turn is
//    replaced by a short stub, in one pass.
//  - Above 85% of the room: the oldest tool outputs are elided, whatever their size, down to 60%. The newest
//    round always stays.
//
// Both are functions of the raw messages, and raw messages only grow within a turn, so a result that is stubbed
// stays stubbed in every later request of the turn.

export const BULKY_CHARS = 1_000;
export const KEEP_ROUNDS = 2;
export const STAGE_TRIM = 0.6;
export const STAGE_ELIDE = 0.85;
/** Tokens kept free for the answer's framing, as in the context rule. */
export const RESERVE_TOKENS = 2_000;

export const trimStub = (chars: number): string => `[output trimmed: ${chars} chars; re-run the tool if needed]`;
export const elideStub = (chars: number): string => `[output elided to fit context: ${chars} chars; re-run the tool or zoom the latest echo lines]`;

const textChars = (message: ToolResultMessage): number => message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
const withText = (message: ToolResultMessage, text: string): ToolResultMessage => ({ ...message, content: [{ type: "text", text }] });
const isStub = (message: ToolResultMessage): boolean => message.content.length === 1 && message.content[0]!.type === "text" && /^\[output (?:trimmed|elided)/u.test(message.content[0]!.text);

/** `limit` is the request's token limit: contextWindow - maxTokens - 2,000. */
export function applyBudget(messages: readonly Message[], limit: number): readonly Message[] {
	const first = messages.findIndex((message) => message.role === "user");
	if (first < 0) return messages;
	let fixed = 0;
	for (let k = 0; k <= first; k += 1) fixed += estimateTokens(messages[k]!);
	const room = limit - fixed;
	let used = 0;
	// round number of each tool result: the index of the assistant message with tool calls that it answers
	const roundOf = new Map<number, number>();
	let rounds = 0;
	for (let k = first + 1; k < messages.length; k += 1) {
		const message = messages[k]!;
		used += estimateTokens(message);
		if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")) rounds += 1;
		else if (message.role === "toolResult" && rounds > 0) roundOf.set(k, rounds);
	}
	if (used < STAGE_TRIM * room) return messages;

	const out = messages.slice();
	const replace = (k: number, text: string): void => {
		const before = out[k] as ToolResultMessage;
		const after = withText(before, text);
		used += estimateTokens(after) - estimateTokens(before);
		out[k] = after;
	};
	const results = [...roundOf.keys()];
	for (const k of results) {
		const message = out[k] as ToolResultMessage;
		if (roundOf.get(k)! > rounds - KEEP_ROUNDS || isStub(message)) continue;
		if (textChars(message) >= BULKY_CHARS) replace(k, trimStub(textChars(message)));
	}
	if (used > STAGE_ELIDE * room) {
		for (const k of results) {
			if (used <= STAGE_TRIM * room) break;
			const message = out[k] as ToolResultMessage;
			if (roundOf.get(k) === rounds) continue;
			const chars = textChars(message);
			if (isStub(message) || chars <= elideStub(chars).length) continue;
			replace(k, elideStub(chars));
		}
	}
	return out;
}

export const budgetHook = hook(GenerationTask, {
	async beforeRequest(request, api) {
		const ref = (await api.snapshot(AgentDoc, api.conversationId, ctx))?.model;
		const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
		if (model === undefined) return undefined;
		const messages = applyBudget(request.messages, model.contextWindow - model.maxTokens - RESERVE_TOKENS);
		return messages === request.messages ? undefined : { messages };
	},
});

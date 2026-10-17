import { CompactionTask, defineExtension, hook, section, type Extension } from "../durable.ts";
import { budgetHook } from "./budget.ts";
import { viewHook } from "./hook.ts";
import { planTool } from "./plan.ts";
import { CHAT_PROMPT, VIEWTOOLS_LEGEND } from "./prompt.ts";
import { createStuckHooks } from "./stuck.ts";
import { dateTool, zoomTool } from "./tools.ts";

// The extensions of D12 that belong to the chat design. The tool set and every section are static, so the system
// prompt and the tool declarations are byte-identical from turn to turn.

/** zoom, date and the view legend. Root and children. */
export const viewtools: Extension = defineExtension({
	name: "viewtools",
	tools: [zoomTool, dateTool] as never,
	sections: [section("view", () => VIEWTOOLS_LEGEND)],
});

/** The full prompt, the view insertion and the compaction decline. Root only. */
export const chat: Extension = defineExtension({
	name: "chat",
	sections: [section("chat", () => CHAT_PROMPT, { tag: false })],
	hooks: [viewHook, hook(CompactionTask, { beforeCompact: () => ({ decline: true as const }) })],
});

/** Last in every conversation: the staged trimming of the current turn. */
export const budget: Extension = defineExtension({
	name: "budget",
	hooks: [budgetHook],
});

/** The plan tool (H5). Left out of the selection when settings.planning is false. */
export const planning: Extension = defineExtension({
	name: "planning",
	tools: [planTool] as never,
});

/** Stuck detection (H3), with its own streak state. One per runtime. */
export function createStuck(onStop: (conversationId: number, message: string) => void): Extension & { endRun: () => void } {
	const { hooks, endRun } = createStuckHooks(onStop);
	return Object.assign(defineExtension({ name: "stuck", hooks }), { endRun });
}

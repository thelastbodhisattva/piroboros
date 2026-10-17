import { Type } from "typebox";
import { ctx, defineDoc, defineTool } from "../durable.ts";

// The plan tool (H5). The plan lives in a conversation document, is shown to the model in the per-turn block of
// each request (hook.ts), and is never part of the stored transcript or the index except as the tool call that
// set it, which the index skips. It lasts one user turn: the turn commit clears it.

export type PlanItem = { text: string; status: "pending" | "in_progress" | "done" };
type PlanState = { items: PlanItem[] };

export const PlanDoc = defineDoc<PlanState>({
	scope: "conversation",
	history: "latest",
	fork: "current",
	kind: "piroboros.plan",
	version: 1,
	initial: () => ({ items: [] }),
	migrate: (_value, fromVersion) => { throw new Error(`unsupported piroboros.plan v${fromVersion}`); },
});

export const PLAN_MAX_ITEMS = 20;
export const PLAN_MAX_TEXT = 200;
const STATUSES = ["pending", "in_progress", "done"] as const;

/** The code names the failure; the text after it is for the model. */
export class PlanError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

/** Exactly one item is in_progress while work remains; a finished plan has none. */
export function validatePlan(items: ReadonlyArray<{ text?: unknown; status?: unknown }>): PlanItem[] {
	if (items.length === 0) throw new PlanError("plan_empty", "give at least one item");
	if (items.length > PLAN_MAX_ITEMS) throw new PlanError("plan_too_long", `at most ${PLAN_MAX_ITEMS} items; got ${items.length}`);
	const out: PlanItem[] = items.map((item, k) => {
		const text = typeof item.text === "string" ? item.text.trim() : "";
		if (text === "" || text.length > PLAN_MAX_TEXT) throw new PlanError("plan_bad_item", `item ${k + 1} needs text of 1 to ${PLAN_MAX_TEXT} characters`);
		if (!(STATUSES as readonly unknown[]).includes(item.status)) throw new PlanError("plan_bad_status", `item ${k + 1} has status ${JSON.stringify(item.status)}; use ${STATUSES.join(", ")}`);
		return { text, status: item.status as PlanItem["status"] };
	});
	const active = out.filter((item) => item.status === "in_progress").length;
	const finished = out.every((item) => item.status === "done");
	if (finished ? active !== 0 : active !== 1) throw new PlanError("plan_in_progress", `exactly one item must be in_progress while work remains; found ${active}`);
	return out;
}

export const planBlock = (items: readonly PlanItem[]): string => `<plan>\n${items.map((item, k) => `${k + 1}. [${item.status}] ${item.text}`).join("\n")}\n</plan>`;

export const planTool = defineTool({
	name: "plan",
	description: "Set the plan for this request: the whole list each time. One item is in_progress while work remains. The current plan is shown to you with every message.",
	parameters: Type.Object({
		items: Type.Array(Type.Object({
			text: Type.String(),
			status: Type.String({ description: "pending, in_progress or done" }),
		})),
	}),
	replay: "safe",
	async execute(args, api) {
		const items = validatePlan(args.items);
		await api.commit(async (tx) => {
			const doc = await tx.doc(PlanDoc, api.conversationId);
			doc.items.splice(0, doc.items.length, ...items);
		}, ctx);
		const done = items.filter((item) => item.status === "done").length;
		return { output: [{ type: "text" as const, text: `plan saved: ${done} of ${items.length} done` }] };
	},
});

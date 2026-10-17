import { createHash } from "node:crypto";
import { GenerationTask, hook, ROOT, ToolTask } from "../durable.ts";

// Stuck detection (H3), per conversation. A streak is consecutive executed tool calls with the same name and
// byte-identical arguments. The 5th gets a reminder appended to its result, once per streak. The 8th failing
// call of a streak gets the diagnostic code "stuck"; when its round is finished, `onStop` is told and the owner
// ends the run (the runtime aborts the conversation and the turn loop reports the named reason).
// Why not the tool result's `terminate` control: a tool that throws settles as failed and its control is
// dropped, and the file tools throw. Why not throw from a hook: the scheduler reports hook errors and goes on.
// Guard denials never reach afterTool, so they neither count nor break a streak. Calls refused by schema
// validation never reach it either. The streak lives in memory, so a restart starts a new one.
// ponytail: not reset at a turn boundary; the stop clears it, and a repeat of 5 identical calls across turns only costs one reminder.

export const STUCK_REMIND_AT = 5;
export const STUCK_STOP_AT = 8;
/** Conversations whose streak is remembered at once; far more than ever run together. */
export const STUCK_MAX_CONVERSATIONS = 64;
/** Diagnostic code on the result that ended the turn. */
export const STUCK_STOP_CODE = "stuck";
export const STUCK_REMINDER_CODE = "stuck-reminder";

/** Tool rounds one root run may make; the 256th ends it. Seats are capped by their own maxTurns. */
export const ROOT_MAX_ROUNDS = 256;
export const roundLimitText = (rounds: number): string => `stopped (round limit): the run made ${rounds} tool rounds without finishing.`;

export const stuckReminder = (count: number): string => `The same call has been made ${count} times in a row. Change your approach: read the result, try different arguments or another tool, or tell the user what blocks you.`;
export const stuckStopText = (name: string, count: number): string => `stopped (stuck): ${name} was called ${count} times in a row with the same arguments and failed each time.`;

/** True when an entry is the result that stopped a turn for being stuck. */
export function isStuckStop(entry: { data?: unknown }): boolean {
	const list = (entry.data as { diagnostics?: unknown } | undefined)?.diagnostics;
	return Array.isArray(list) && list.some((d) => (d as { code?: unknown } | null)?.code === STUCK_STOP_CODE);
}

/** `onStop(conversationId, message)` must end that conversation's run. Members report `FAILED (stuck)` from it. `endRun` resets the root's round count. */
export function createStuckHooks(onStop: (conversationId: number, message: string) => void) {
	// One entry per conversation that made a call, newest last. Nothing marks a child's run as over, so the map is capped: the oldest entry goes first.
	const streaks = new Map<number, { signature: string; count: number; fails: number }>();
	const stops = new Map<number, string>();
	// Every tool round of a run is its own GenerationTask, so rounds are counted per run, not per taskId. The owner calls endRun when the root run ends.
	let rounds = 0;
	const endRun = (): void => { rounds = 0; };
	const hooks = [
		hook(ToolTask, {
			afterTool(call, result, api) {
				if (result.diagnostics?.some((d) => d.code === "blocked")) return undefined;
				const id = api.conversationId as number;
				// A digest, not the arguments: a write call carries a whole file.
				const signature = createHash("sha256").update(`${call.name}\0${JSON.stringify(call.arguments ?? {})}`).digest("hex");
				const before = streaks.get(id);
				const streak = before?.signature === signature ? before : { signature, count: 0, fails: 0 };
				streak.count += 1;
				streak.fails = result.isError ? streak.fails + 1 : 0;
				streaks.delete(id);
				streaks.set(id, streak);
				if (streaks.size > STUCK_MAX_CONVERSATIONS) streaks.delete(streaks.keys().next().value as number);
				if (streak.fails >= STUCK_STOP_AT) {
					streaks.delete(id);
					const message = stuckStopText(call.name, streak.fails);
					stops.set(id, message);
					return { ...result, isError: true, diagnostics: [...(result.diagnostics ?? []), { severity: "error" as const, code: STUCK_STOP_CODE, message }] };
				}
				if (streak.count === STUCK_REMIND_AT) return { ...result, diagnostics: [...(result.diagnostics ?? []), { severity: "warn" as const, code: STUCK_REMINDER_CODE, message: stuckReminder(streak.count) }] };
				return undefined;
			},
		}),
		hook(GenerationTask, {
			afterTools(_assistant, _results, api) {
				const id = api.conversationId as number;
				if (id === (ROOT as number)) {
					rounds += 1;
					if (rounds >= ROOT_MAX_ROUNDS && !stops.has(id)) stops.set(id, roundLimitText(rounds));
				}
				const message = stops.get(id);
				if (message === undefined) return;
				stops.delete(id);
				if (id === (ROOT as number)) endRun();
				onStop(id, message);
			},
		}),
	];
	return { hooks, endRun };
}

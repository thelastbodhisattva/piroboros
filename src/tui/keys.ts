import { COMMANDS, type PickEntry } from "./commands.ts";
import { overlayKey, type OverlayAction } from "./setup.ts";

// Key rules of the chat app. Each function maps one key to an action and touches nothing; the single input
// handler in app.ts applies the action. Which function sees a key depends on the owner: the overlay while a
// request is open, the command list while one is shown, the chat otherwise.

export type Owner = "chat" | "picker" | "overlay";

export interface Keys {
	upArrow: boolean; downArrow: boolean; leftArrow: boolean; rightArrow: boolean; pageUp: boolean; pageDown: boolean; home: boolean; end: boolean;
	return: boolean; escape: boolean; backspace: boolean; delete: boolean; tab: boolean; ctrl: boolean; meta: boolean;
}

export type ChatAction =
	| { t: "none" }
	| { t: "exit" }
	| { t: "abort" }
	| { t: "clear" }
	| { t: "cycle" }
	/** Ctrl+T: the next main-model thinking level, written to settings.json. */
	| { t: "level" }
	| { t: "submit" }
	| { t: "backspace" }
	/** PgUp and PgDn move the chat view a page; End goes back to the newest line. */
	| { t: "scroll"; to: "up" | "down" | "end" }
	| { t: "insert"; text: string };

export interface ChatState {
	/** True while a turn is running; decides what Ctrl+C does. */
	busy: boolean;
	now: number;
	/** Time of the previous Ctrl+C, 0 when there was none. */
	lastCtrlC: number;
	/** The input holds text the user typed or pasted (not text restored after a stop), and the overlay is not open. */
	draft: boolean;
}

export const DOUBLE_CTRL_C_MS = 2_000;

/**
 * While a turn runs, Ctrl+C stops it, and a second press within two seconds exits. When idle it clears a typed draft,
 * and exits when there is none.
 */
export function ctrlC(state: ChatState): "exit" | "abort" | "clear" {
	if (state.busy) return state.now - state.lastCtrlC < DOUBLE_CTRL_C_MS ? "exit" : "abort";
	return state.draft ? "clear" : "exit";
}

export function chatKey(input: string, key: Keys, state: ChatState): ChatAction {
	if (key.ctrl && input === "c") return { t: ctrlC(state) };
	if (key.escape) return { t: "abort" };
	if (key.pageUp) return { t: "scroll", to: "up" };
	if (key.pageDown) return { t: "scroll", to: "down" };
	if (key.end) return { t: "scroll", to: "end" };
	if (key.meta && input.toLowerCase() === "t") return { t: "cycle" };
	if (key.ctrl && input === "t") return { t: "level" };
	if (key.return) return { t: "submit" };
	if (key.backspace || key.delete) return { t: "backspace" };
	if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) return { t: "insert", text: input };
	return { t: "none" };
}

export type PickerAction =
	| { t: "move"; delta: 1 | -1 }
	| { t: "complete"; value: string }
	| { t: "dismiss" }
	/** Run the input as typed, or `text` when the entry is a command that takes no argument. */
	| { t: "submit"; text?: string }
	| { t: "none" };

/**
 * What Enter does with the highlighted entry. A command with no argument hint runs. A typed prefix of a longer name
 * completes to "/name ". An exact name runs. At the second level only enumerated choices complete, and an entry that
 * equals the text, or any /conclave text, is submitted as typed so a task is never turned into "approve".
 */
export function enterAction(value: string, entry: PickEntry | undefined): PickerAction {
	if (entry === undefined || entry.hint === true || entry.disabled !== undefined) return { t: "submit" };
	if (!/\s/u.test(value)) {
		const info = COMMANDS.find((command) => `/${command.name}` === entry.label);
		if (COMMANDS.some((command) => value === `/${command.name}`) || (entry.args === true && value === entry.label)) return { t: "submit" };
		return info?.args === undefined && entry.args !== true ? { t: "submit", text: entry.label } : { t: "complete", value: entry.complete };
	}
	if (/^\/conclave\s/u.test(value) || entry.complete === value) return { t: "submit" };
	return { t: "complete", value: entry.complete };
}

/** Keys of the command list. Returns "none" for a key the list does not use, which then goes to the chat rules. */
export function pickerKey(value: string, entry: PickEntry | undefined, key: Keys): PickerAction {
	if (key.upArrow) return { t: "move", delta: -1 };
	if (key.downArrow) return { t: "move", delta: 1 };
	if (key.escape) return { t: "dismiss" };
	if (key.tab) return entry === undefined || entry.hint === true || entry.disabled !== undefined ? { t: "none" } : { t: "complete", value: entry.complete };
	if (key.return) return enterAction(value, entry);
	return { t: "none" };
}

export type Route =
	| { to: "overlay"; action: OverlayAction }
	| { to: "picker"; action: PickerAction }
	| { to: "chat"; action: ChatAction };

/**
 * The single entry point for a key. Ctrl+C always has its chat meaning. Otherwise the owner decides: the overlay
 * takes every key, the command list takes the keys it uses and passes the rest to the chat.
 */
export function route(owner: Owner, input: string, key: Keys, state: ChatState, requestKind: Parameters<typeof overlayKey>[0], value: string, entry: PickEntry | undefined): Route {
	if (key.ctrl && input === "c") return { to: "chat", action: chatKey(input, key, state) };
	if (owner === "overlay") return { to: "overlay", action: overlayKey(requestKind, input, key) };
	if (owner === "picker") {
		const action = pickerKey(value, entry, key);
		if (action.t !== "none" || key.tab) return { to: "picker", action };
	}
	return { to: "chat", action: chatKey(input, key, state) };
}

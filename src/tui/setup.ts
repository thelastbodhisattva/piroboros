import { spawn } from "node:child_process";
import { createElement, useEffect, useState, type ReactElement } from "react";
import { Box, render, useInput, useStdout } from "ink";
import { SetupCancelled, runSetup, type Option, type SetupEnv, type SetupIO, type SetupResult } from "../setup.ts";
import { rowsOf } from "./sanitize.ts";
import { THEME } from "./theme.ts";
import { clip, filterByLabel, indicator, windowFor, wrap, type FrameLine } from "./viewport.ts";

// Thin Ink layer over setup.ts. It renders one request at a time (choose, masked secret, text or confirm)
// in a viewport that never exceeds the terminal height. Long lists scroll and filter as you type. Long
// notices scroll. Secret input is masked at render time, so a frame never holds the secret.

type Request =
	| { kind: "choose"; title: string; options: readonly Option[]; filter: string; index: number; offset: number; resolve(id: string): void; reject(error: Error): void }
	| { kind: "secret" | "text"; message: string; value: string; resolve(value: string): void; reject(error: Error): void }
	| { kind: "confirm"; message: string; value: boolean; resolve(value: boolean): void; reject(error: Error): void };

interface State {
	request: Request | undefined;
	log: Array<{ kind: "info" | "warn" | "error"; text: string }>;
	/** Scroll position of the notice area: lines hidden at the bottom. 0 shows the newest. */
	scrollUp: number;
}

export interface SetupDriver {
	io: SetupIO;
	state(): State;
	subscribe(listener: () => void): () => void;
	cancelAll(): void;
	/** Pick the highlighted option, or answer the current question. */
	submit(): void;
	/** Esc: clear the filter first, cancel on the next press. */
	escape(): void;
	/** Tell the listeners that the request was edited in place. */
	touch(): void;
	/** Forget the notices of a flow that ended. */
	reset(): void;
}

export function openBrowserArgv(href: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
	if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", href] };
	if (platform === "darwin") return { command: "open", args: [href] };
	return { command: "xdg-open", args: [href] };
}

export function launchBrowser(href: string): void {
	const { command, args } = openBrowserArgv(href);
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// The address is also shown on screen, so the user can open it by hand.
	}
}

export const visibleOptions = (r: Extract<Request, { kind: "choose" }>): Option[] => filterByLabel(r.options, r.filter);

/** `onCancel` runs when Ctrl+C or Esc finds no open question, so a wait with nothing to answer can still be cancelled. */
export function createSetupDriver(launch: (href: string) => void = launchBrowser, onCancel?: () => void): SetupDriver {
	let state: State = { request: undefined, log: [], scrollUp: 0 };
	const listeners = new Set<() => void>();
	const set = (next: Partial<State>): void => {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};
	const ask = <T>(make: (resolve: (value: T) => void, reject: (error: Error) => void) => Request): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			set({ scrollUp: 0, request: make((value) => { set({ request: undefined }); resolve(value); }, (error) => { set({ request: undefined }); reject(error); }) });
		});
	const io: SetupIO = {
		choose: (title, options, defaultId) => {
			const index = Math.max(0, options.findIndex((option) => option.id === defaultId));
			return ask<string>((resolve, reject) => ({ kind: "choose", title, options, filter: "", index, offset: 0, resolve, reject }));
		},
		// An abort rejects only the request it was made for, never a later one.
		secret: (message, signal) => {
			const pending = ask<string>((resolve, reject) => ({ kind: "secret", message, value: "", resolve, reject }));
			const mine = state.request;
			signal.addEventListener("abort", () => { if (state.request === mine) mine?.reject(new SetupCancelled()); }, { once: true });
			return pending;
		},
		text: (message, signal, _placeholder, initial) => {
			const pending = ask<string>((resolve, reject) => ({ kind: "text", message, value: initial ?? "", resolve, reject }));
			const mine = state.request;
			signal.addEventListener("abort", () => { if (state.request === mine) mine?.reject(new SetupCancelled()); }, { once: true });
			return pending;
		},
		confirm: (message, defaultValue) => ask<boolean>((resolve, reject) => ({ kind: "confirm", message, value: defaultValue, resolve, reject })),
		notify: (kind, text) => set({ scrollUp: 0, log: [...state.log, { kind, text }].slice(-40) }),
		openUrl: (href, instructions) => {
			set({ scrollUp: 0, log: [...state.log, { kind: "info" as const, text: `Open this address to sign in: ${href}${instructions ? `\n${instructions}` : ""}` }].slice(-40) });
			launch(href);
		},
	};
	return {
		io,
		state: () => state,
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		cancelAll: () => { onCancel?.(); state.request?.reject(new SetupCancelled()); },
		submit: () => {
			const r = state.request;
			if (r === undefined) return;
			if (r.kind === "choose") {
				const option = visibleOptions(r)[r.index];
				if (option !== undefined && option.disabled === undefined) r.resolve(option.id);
			} else r.resolve(r.value as never);
		},
		escape: () => {
			const r = state.request;
			if (r?.kind === "choose" && r.filter !== "") { r.filter = ""; r.index = 0; r.offset = 0; set({}); return; }
			if (r === undefined) onCancel?.();
			else r.reject(new SetupCancelled());
		},
		touch: () => set({}),
		reset: () => set({ log: [], scrollUp: 0 }),
	};
}

/* --- keys ---------------------------------------------------------------------------------------------------- */

export type OverlayAction =
	| { t: "none" }
	| { t: "escape" }
	| { t: "submit" }
	| { t: "move"; to: "up" | "down" | "pageUp" | "pageDown" | "home" | "end" }
	| { t: "type"; text: string }
	| { t: "backspace" }
	| { t: "answer"; yes: boolean };

interface KeyInfo {
	upArrow: boolean; downArrow: boolean; pageUp: boolean; pageDown: boolean; home: boolean; end: boolean;
	return: boolean; escape: boolean; backspace: boolean; delete: boolean; tab: boolean; ctrl: boolean; meta: boolean;
}

/** What a key means for the open request. Pure. Ctrl+C is not handled here: each caller keeps its own meaning for it. */
export function overlayKey(kind: Request["kind"] | undefined, input: string, key: KeyInfo): OverlayAction {
	if (kind === undefined) return { t: "none" };
	if (key.escape) return { t: "escape" };
	const to = key.upArrow ? "up" : key.downArrow ? "down" : key.pageUp ? "pageUp" : key.pageDown ? "pageDown" : key.home ? "home" : key.end ? "end" : undefined;
	if (to !== undefined) return { t: "move", to };
	if (kind === "confirm" && !key.return) {
		if (input === "y" || input === "Y") return { t: "answer", yes: true };
		if (input === "n" || input === "N") return { t: "answer", yes: false };
		return { t: "none" };
	}
	if (key.return) return { t: "submit" };
	if (key.backspace || key.delete) return { t: "backspace" };
	if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) return { t: "type", text: input };
	return { t: "none" };
}

/** Apply an overlayKey action to the driver. `page` is the number of rows a PgUp or PgDn moves. */
export function applyOverlay(driver: SetupDriver, action: OverlayAction, page: number): void {
	const state = driver.state();
	const r = state.request;
	if (r === undefined || action.t === "none") return;
	if (action.t === "escape") { driver.escape(); return; }
	if (action.t === "submit") { driver.submit(); return; }
	if (action.t === "answer") {
		if (r.kind === "confirm") { r.value = action.yes; driver.submit(); }
		return;
	}
	if (r.kind === "choose") {
		const last = Math.max(0, visibleOptions(r).length - 1);
		if (action.t === "move") {
			r.index = action.to === "up" ? Math.max(0, r.index - 1) : action.to === "down" ? Math.min(last, r.index + 1) : action.to === "pageUp" ? Math.max(0, r.index - page) : action.to === "pageDown" ? Math.min(last, r.index + page) : action.to === "home" ? 0 : last;
		} else {
			r.filter = action.t === "backspace" ? r.filter.slice(0, -1) : r.filter + action.text;
			r.index = 0;
			r.offset = 0;
		}
	} else if (action.t === "move") {
		// Scrolling the notices works for every other kind of request.
		const delta = action.to === "up" ? 1 : action.to === "down" ? -1 : action.to === "pageUp" ? page : action.to === "pageDown" ? -page : 0;
		state.scrollUp = action.to === "home" ? Number.MAX_SAFE_INTEGER : action.to === "end" ? 0 : Math.max(0, state.scrollUp + delta);
	} else if (r.kind !== "confirm") r.value = action.t === "backspace" ? r.value.slice(0, -1) : r.value + action.text;
	driver.touch();
}

/* --- layout -------------------------------------------------------------------------------------------- */

/** A secret shows as this mask once something is typed, so a frame never holds the secret or its length. */
const SECRET_MASK = "********";
const HINT_CHOOSE ="Up/Down move  PgUp/PgDn/Home/End jump  type to filter  Enter pick  Esc clear/cancel";
const HINT_OTHER = "Up/Down/PgUp/PgDn/Home/End scroll  Enter confirm  Esc cancel";

/**
 * Build the visible lines for the current request. The result never has more than `rows - 1` lines and no
 * line is wider than `cols - 1` columns. The long list (or the long notice text) takes the space that is
 * left after the title, the filter line and the two footer lines.
 */
export function buildFrame(state: State, cols: number, rows: number): FrameLine[] {
	const width = Math.max(10, cols - 1);
	const avail = Math.max(6, rows - 1);
	const request = state.request;
	const logLines: FrameLine[] = state.log.flatMap((entry) => wrap(entry.text, width).map((text) => ({ text, color: entry.kind === "error" ? THEME.error : entry.kind === "warn" ? THEME.warn : undefined })));
	const out: FrameLine[] = [];
	const footer = (indicatorText: string, hint: string): FrameLine[] => [{ text: clip(indicatorText, width), dim: true }, { text: clip(hint, width), dim: true }];

	if (request?.kind === "choose") {
		const title = wrap(request.title, width).slice(0, 2).map((text) => ({ text, bold: true }));
		const logCap = Math.max(0, Math.min(Math.floor(avail / 4), avail - title.length - 4));
		const shown = logCap === 0 ? [] : logLines.slice(Math.max(0, logLines.length - logCap - state.scrollUp), logLines.length - state.scrollUp).slice(-logCap);
		const list = visibleOptions(request);
		const filterLine: FrameLine = { text: clip(request.filter === "" ? "Filter: (type to search)" : `Filter: ${request.filter}`, width), dim: request.filter === "" };
		const height = Math.max(1, avail - shown.length - title.length - 1 - 2);
		const index = Math.min(request.index, Math.max(0, list.length - 1));
		const win = windowFor(list.length, index, request.offset, height);
		request.offset = win.offset;
		request.index = index;
		out.push(...shown, ...title, filterLine);
		for (let i = win.start; i < win.end; i += 1) {
			const option = list[i]!;
			out.push({ text: clip(`${i === index ? ">" : " "} ${option.label}${option.disabled ? ` (unavailable: ${option.disabled})` : ""}`, width), ...(i === index ? { color: THEME.accentText, bold: true } : { dim: option.disabled !== undefined }) });
		}
		out.push(...footer(indicator(win.start, win.end, list.length), HINT_CHOOSE));
		return out.slice(0, avail);
	}

	const pinned: FrameLine[] = [];
	if (request?.kind === "secret" || request?.kind === "text") {
		const shown = request.kind === "secret" ? (request.value === "" ? "" : SECRET_MASK) : request.value;
		const tail = [...shown].slice(-(width - 3)).join("");
		pinned.push(...wrap(request.message, width).slice(0, 2).map((text) => ({ text, bold: true })), { text: `> ${tail}` });
	}
	else if (request?.kind === "confirm") pinned.push(...wrap(`${request.message} [${request.value ? "Y/n" : "y/N"}]`, width).slice(0, 3).map((text) => ({ text, bold: true })));
	const height = Math.max(1, avail - pinned.length - 2);
	const total = logLines.length;
	const end = Math.max(Math.min(height, total), total - state.scrollUp);
	const start = Math.max(0, end - height);
	out.push(...logLines.slice(start, end), ...pinned);
	out.push(...footer(total > height ? indicator(start, end, total) : "", request === undefined ? "" : HINT_OTHER));
	return out.slice(0, avail);
}

/* --- Ink view ---------------------------------------------------------------------------------------------- */

export function SetupView({ driver }: { driver: SetupDriver }): ReactElement {
	const [, force] = useState(0);
	const { stdout: rawStdout } = useStdout();
	const stdout = rawStdout as unknown as NodeJS.WriteStream;
	const [size, setSize] = useState({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
	useEffect(() => driver.subscribe(() => force((n) => n + 1)), [driver]);
	useEffect(() => {
		const onResize = (): void => setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
		stdout.on("resize", onResize);
		return () => { stdout.off("resize", onResize); };
	}, [stdout]);

	useInput((input, key) => {
		if (key.ctrl && input === "c") { driver.cancelAll(); return; }
		applyOverlay(driver, overlayKey(driver.state().request?.kind, input, key), Math.max(1, size.rows - 8));
	});

	const lines = buildFrame(driver.state(), size.cols, size.rows);
	return createElement(Box, { flexDirection: "column" }, ...rowsOf(lines, "l"));
}

export interface SetupTuiOptions {
	stdout?: NodeJS.WriteStream;
	stdin?: NodeJS.ReadStream;
	launch?: (href: string) => void;
}

/** Run the wizard in the terminal. Resolves when setup finishes or is cancelled. */
export async function runSetupTui(env: SetupEnv, options: SetupTuiOptions = {}): Promise<SetupResult> {
	const controller = new AbortController();
	const driver = createSetupDriver(options.launch, () => controller.abort());
	const app = render(createElement(SetupView, { driver }), { exitOnCtrlC: false, stdout: options.stdout, stdin: options.stdin, patchConsole: false });
	// A sign-in that waits for a callback has no question open, so a cancel there ends the wait through the signal.
	const cancelled = new Promise<SetupResult>((resolve) => controller.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true }));
	try {
		const run = runSetup(env, driver.io, controller.signal);
		run.catch(() => {});
		return await Promise.race([run, cancelled]);
	} finally {
		controller.abort();
		app.unmount();
	}
}

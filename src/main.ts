import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync, writeSync } from "node:fs";
import { basename, resolve } from "node:path";
import { FileCredentialStore } from "./auth.ts";
import {
	checkIntegrity, ConfigError, describeIntegrity, ensureHome, getDeviceId, homeOutsideProfileWarning, homePaths, isModelRef, readSettings, recordIntegrity, recordUnrecorded, resolveHome, splitModelRef, type IntegrityReport,
} from "./config.ts";
import { acquireLock, EXIT_LOCK_BUSY, LockBusyError } from "./lock.ts";
import { createAppModels, customProviders, hasAuth, resolveModel, type MutableModels } from "./models.ts";
import { openRuntime } from "./runtime.ts";
import { runSetupTui } from "./tui/setup.ts";
import { createStatusBus, ERROR_HINT, friendlyError, runApp } from "./tui/app.ts";
import { failureText } from "./chat/turn.ts";
import { sanitizeTerminal } from "./tui/sanitize.ts";
import { themeSequences } from "./tui/theme.ts";
import { SETUP_HINT, SetupError } from "./setup.ts";
import { recentEntries, SessionFailed, type Storage } from "./durable.ts";

// Command line entry. Exit codes: 0 success, 1 runtime failure or cancel, 2 missing requirement or no main
// model, 3 another process holds the lock, 4 login required, 5 config files changed outside piroboros.

export const EXIT = { ok: 0, failure: 1, requirement: 2, busy: EXIT_LOCK_BUSY, login: 4, tamper: 5, turnFailed: 6 } as const;

/** The one line printed when the durable session fails: the storage error that caused it, and how to recover. */
export function storageFailureLine(error: unknown): string {
	const cause = error instanceof SessionFailed && error.cause !== undefined ? error.cause : error;
	return `piroboros: the chat database failed (${cause instanceof Error ? cause.message : String(cause)}); nothing more was saved. Start piroboros again to continue from the last saved state.\n`;
}

export interface MainDeps {
	env?: NodeJS.ProcessEnv;
	profile?: string;
	cwd?: string;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	/** True when output goes to a terminal; terminal output is sanitized. */
	isTTY?: boolean;
	models?: MutableModels;
	/** Test seam for --print: a ready durable storage instead of the chat database file. */
	storage?: Storage;
	/** Ask a yes/no question on the terminal; default reads stdin. */
	ask?: (question: string) => Promise<boolean>;
	/** Test seam for the interactive start: replaces the terminal UI. */
	app?: typeof runApp;
}

export const USAGE = [
	"usage: piroboros [command]",
	"",
	"  (no command)            start the terminal UI",
	"  setup                   guided setup",
	"  --print <message>       send one message, print the answer, and exit",
	"      --model <p/m>       use this model for this run only",
	"  --backup <file>         write a copy of the chat database",
	"  --help                  show this text",
	"",
	"exit codes: 0 ok, 1 failure, 2 missing requirement or no main model, 3 another process is running,",
	"            4 login required, 5 config files changed outside piroboros, 6 the model failed the turn",
].join("\n");

function parse(argv: readonly string[]): { command: "tui" | "setup" | "print" | "backup" | "help"; message?: string; model?: string; file?: string; error?: string } {
	const args = [...argv];
	let model: string | undefined;
	const at = args.indexOf("--model");
	if (at >= 0) {
		model = args[at + 1];
		args.splice(at, 2);
	}
	if (args.length === 0) return { command: "tui", model };
	if (args[0] === "--help" || args[0] === "-h") return { command: "help" };
	if (args[0] === "setup") return { command: "setup" };
	if (args[0] === "--print") return args[1] === undefined ? { command: "help", error: "--print needs a message" } : { command: "print", message: args.slice(1).join(" "), model };
	if (args[0] === "--backup") return args[1] === undefined ? { command: "help", error: "--backup needs a file path" } : { command: "backup", file: args[1] };
	return { command: "help", error: `unknown argument: ${args[0]}` };
}

async function defaultAsk(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y/iu.test((await rl.question(`${question} [y/N] `)).trim());
	} finally {
		rl.close();
	}
}

/** Show the files that changed outside piroboros and ask. On yes the new state is recorded, so the checked write accepts it. */
export async function acceptConfigChanges(home: string, integrity: IntegrityReport, ask: (question: string) => Promise<boolean>, err: (text: string) => void): Promise<boolean> {
	if (!integrity.tampered) return true;
	err(`config files changed outside piroboros:\n${describeIntegrity(integrity)}\n`);
	if (!(await ask("Accept these changes and continue?"))) return false;
	recordIntegrity(home);
	return true;
}

/** The terminal window title: "piroboros - <working folder>". Control and format characters are removed, so a folder name cannot end the title sequence. */
export function windowTitle(cwd: string): string {
	const folder = basename(resolve(cwd)).replace(/[\p{Cc}\p{Cf}]/gu, "");
	return folder === "" ? "piroboros" : `piroboros - ${folder}`;
}

/**
 * Sets the blinking bar cursor (DECSCUSR 5) and, when colors are on, the terminal's default colors (OSC 10 and 11), each in one write, and
 * returns the function that resets them (DECSCUSR 0, OSC 110 and 111), or undefined without a terminal. The cursor shape is set under NO_COLOR too.
 * The reset runs once: when the app ends, at process exit, and on SIGTERM, SIGHUP and SIGBREAK (which exit with 1,
 * as a default kill does, without releasing the lock; the OS frees it). A hard kill resets nothing.
 */
export function applyTheme(env: NodeJS.ProcessEnv, tty: boolean, write: (text: string) => void = (text) => writeSync(1, text)): (() => void) | undefined {
	if (!tty) return undefined;
	const colors = themeSequences(env, tty);
	const sequences = { start: `\u{1B}[5 q${colors?.start ?? ""}`, end: `\u{1B}[0 q${colors?.end ?? ""}` };
	let done = false;
	const reset = (): void => {
		if (done) return;
		done = true;
		try { write(sequences.end); } catch { /* the terminal is gone */ }
	};
	process.once("exit", reset);
	const onSignal = (): void => { reset(); process.exit(1); };
	for (const signal of ["SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.once(signal, onSignal);
	try { write(sequences.start); } catch { /* the terminal is gone */ }
	return reset;
}

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
	const env = deps.env ?? process.env;
	const tty = deps.isTTY ?? Boolean(process.stdout.isTTY);
	const clean = (text: string): string => (tty ? sanitizeTerminal(text) : text);
	const out = (text: string): void => (deps.stdout ?? ((s: string) => process.stdout.write(s)))(clean(text));
	const err = (text: string): void => (deps.stderr ?? ((s: string) => process.stderr.write(s)))(clean(text));
	const ask = deps.ask ?? defaultAsk;

	const parsed = parse(argv);
	if (parsed.command === "help") {
		if (parsed.error) err(`piroboros: ${parsed.error}\n`);
		out(`${USAGE}\n`);
		return parsed.error ? EXIT.requirement : EXIT.ok;
	}

	let home: string;
	try {
		home = resolveHome(env, deps.profile);
		ensureHome(home, env);
	} catch (error) {
		err(`piroboros: ${error instanceof Error ? error.message : String(error)}\n`);
		return EXIT.requirement;
	}
	const paths = homePaths(home);

	let lock;
	try {
		lock = acquireLock(paths.lock);
	} catch (error) {
		if (error instanceof LockBusyError) {
			err(`piroboros: ${error.message}\n`);
			return EXIT.busy;
		}
		throw error;
	}
	try {
		recordUnrecorded(home);
		const integrity = checkIntegrity(home);
		const store = new FileCredentialStore(paths.auth, paths.authLock, (message) => err(`piroboros: ${message}\n`));
		const models = deps.models ?? createAppModels(store);
		const warning = homeOutsideProfileWarning(home, deps.profile);
		const custom = customProviders(models, home);

		if (parsed.command === "backup") {
			if (!existsSync(paths.chat)) { err("piroboros: there is no chat database to back up yet\n"); return EXIT.failure; }
			const target = resolve(parsed.file!);
			if (existsSync(target)) { err(`piroboros: ${target} already exists; choose a new file name\n`); return EXIT.failure; }
			const db = new DatabaseSync(paths.chat);
			try {
				db.prepare("VACUUM INTO ?").run(target);
			} catch (error) {
				rmSync(target, { force: true });
				err(`piroboros: backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
				return EXIT.failure;
			} finally {
				db.close();
			}
			out(`backup written to ${target}\n`);
			return EXIT.ok;
		}

		// An invalid models.json is not fatal: start without custom providers and say why.
		const loaded = custom.reload();
		const modelsProblem = loaded.ok ? undefined : `${loaded.error}\ncustom providers are not loaded; fix the file and use /reload`;
		if (modelsProblem !== undefined && parsed.command !== "tui") err(`piroboros: ${modelsProblem}\n`);
		const modelsWarnings = loaded.ok ? loaded.warnings ?? [] : [];
		if (parsed.command !== "tui") for (const warning of modelsWarnings) err(`warning: ${warning}\n`);

		// A hand-edited config file is shown and accepted (or not) before anything may write to it; interactive startup and setup do the same.
		const acceptChanges = (): Promise<boolean> => acceptConfigChanges(home, integrity, ask, err);

		if (parsed.command === "setup") {
			if (warning) err(`warning: ${warning}\n`);
			if (!(await acceptChanges())) return EXIT.tamper;
			try {
				const result = await runSetupTui({ home, models, store, deviceId: () => getDeviceId(home), existing: readSettings(home), env, custom });
				if (result.status === "cancelled") { err("setup cancelled; no settings were written\n"); return EXIT.failure; }
				out("setup complete\n");
				return EXIT.ok;
			} catch (error) {
				if (error instanceof SetupError) { err(`piroboros: ${error.message}\n`); return error.exitCode; }
				throw error;
			}
		}

		// --print and the TUI both read settings and check integrity first.
		if (integrity.tampered && parsed.command === "print") {
			err(`piroboros: config files changed outside piroboros:\n${describeIntegrity(integrity)}\nstart piroboros interactively to review and accept the change\n`);
			return EXIT.tamper;
		}

		if (parsed.command === "print") {
			const settings = readSettings(home);
			const ref = parsed.model ?? settings.main;
			if (ref === undefined) { err(`piroboros: no main model is set; ${SETUP_HINT}\n`); return EXIT.requirement; }
			if (!isModelRef(ref)) { err('piroboros: the model must be written as "provider/model"\n'); return EXIT.requirement; }
			if (resolveModel(models, ref) === undefined) { err(`piroboros: unknown model ${ref}\n`); return EXIT.requirement; }
			if (!(await hasAuth(models, splitModelRef(ref).provider))) { err("piroboros: login required: piroboros setup or /login <id>\n"); return EXIT.login; }
			const rt = await openRuntime({ home, models, customProviders: custom, cwd: deps.cwd, profile: deps.profile, env, main: ref, storage: deps.storage, onReport: (m) => err(`piroboros: ${m}\n`) });
			// No terminal to ask: project skills that were never answered stay out, and nothing is recorded.
			const unanswered = rt.skills.state().pending.length;
			if (unanswered > 0) err(`piroboros: ${unanswered} project skills not loaded (no terminal to ask)\n`);
			// Both the failing send and rt.fatal report the same failure, so the line is printed once.
			let printed = false;
			const storageFailed = (error: unknown): number => { if (!printed) { printed = true; err(storageFailureLine(error)); } return EXIT.failure; };
			const answer = async (): Promise<number> => {
				try {
					const id = await rt.send(parsed.message!);
					const record = await (await waitFor(() => rt.loop.whenSettled(id)));
					if (record?.status === "unanswered") {
						err(`error: ${ref}: ${friendlyError(failureText(record))}\n${ERROR_HINT}\n`);
						return EXIT.turnFailed;
					}
					if (record?.status !== "done") { err("piroboros: the turn did not complete\n"); return EXIT.failure; }
					const entries = await recentEntries(rt.root, 10);
					const last = entries.find((entry) => (entry.model as Array<{ role?: string }> | undefined)?.[0]?.role === "assistant");
					const content = (last?.model as Array<{ content?: Array<{ type?: string; text?: string }> }> | undefined)?.[0]?.content ?? [];
					out(`${content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("")}\n`);
					return EXIT.ok;
				} catch (error) {
					if (error instanceof SessionFailed) return storageFailed(error);
					throw error;
				}
			};
			try {
				// A failed session never settles the turn, so the wait is raced against the failure.
				return await Promise.race([answer(), rt.fatal.then(storageFailed)]);
			} finally {
				await rt.close();
			}
		}

		// Interactive
		if (!(await acceptChanges())) return EXIT.tamper;
		// --model decides this run, as with --print. An unusable override is refused; it is not a reason to open setup.
		if (parsed.model !== undefined) {
			if (!isModelRef(parsed.model)) { err('piroboros: the model must be written as "provider/model"\n'); return EXIT.requirement; }
			if (resolveModel(models, parsed.model) === undefined) { err(`piroboros: unknown model ${parsed.model}\n`); return EXIT.requirement; }
		}
		const configured = parsed.model ?? readSettings(home).main;
		if (configured === undefined || resolveModel(models, configured) === undefined) {
			if (configured !== undefined) err(`piroboros: the main model ${configured} is not available${modelsProblem === undefined ? "" : `:\n${modelsProblem}`}\nopening setup\n`);
			const result = await runSetupTui({ home, models, store, deviceId: () => getDeviceId(home), existing: readSettings(home), env, custom });
			if (result.status === "cancelled") return EXIT.failure;
		}
		const bus = createStatusBus();
		const rt = await openRuntime({ home, models, customProviders: custom, cwd: deps.cwd, profile: deps.profile, env, ...(parsed.model === undefined ? {} : { main: parsed.model }), onStatus: (s) => bus.set(s), onRestore: (text) => bus.restore(text), onReport: (m) => bus.set({ kind: "error", message: m }) });
		let resetTheme: (() => void) | undefined;
		try {
			const banners: string[] = [];
			if (warning) banners.push(warning);
			if (modelsProblem !== undefined) banners.push(modelsProblem);
			banners.push(...modelsWarnings);
			const compactor = rt.compactor.state();
			if (compactor.label === "not configured") banners.push("compactor: not configured");
			else if (compactor.label === "disabled") banners.push(`compactor disabled: ${compactor.reason ?? "no reason recorded"}`);
			if (deps.app === undefined && process.stdout.isTTY) {
				process.stdout.write(`\u{1B}]0;${windowTitle(deps.cwd ?? process.cwd())}\u{7}`);
				resetTheme = applyTheme(env, true);
			}
			const outcome = await (deps.app ?? runApp)(rt, banners, bus);
			if (outcome !== undefined) { err(storageFailureLine(outcome.failed)); return EXIT.failure; }
		} finally {
			resetTheme?.();
			await rt.close();
		}
		return EXIT.ok;
	} catch (error) {
		if (error instanceof ConfigError) { err(`piroboros: ${error.message}\n`); return EXIT.requirement; }
		throw error;
	} finally {
		lock.release();
	}
}

async function waitFor<T>(get: () => Promise<T> | undefined, timeoutMs = 600_000): Promise<Promise<T>> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = get();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error("timed out waiting for the turn to start");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

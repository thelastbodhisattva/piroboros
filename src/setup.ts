import { BASH_HINT, findBash } from "./shell.ts";
import { probeSearch } from "./search.ts";
import { spawnSync } from "node:child_process";
import { THINKING_STEP_MODES, ensureHome, homePaths, mergeSettings, recordIntegrity, splitModelRef, unsetSettings, ConfigError, type Settings } from "./config.ts";
import {
	MODELS_JSON_EXAMPLE, apiKeyEnvName, contextCheck, hasAuth, loginAndStore, modelChoices, providerChoices, type AuthEvent, type AuthInteraction, type AuthPrompt, type AuthType, type CredentialStore, type CustomProviders, type ModelRole, type Models, type ProviderChoice, type ProviderMethod,
} from "./models.ts";
import { safeAuthUrl } from "./tui/sanitize.ts";
import { SEARCH_KEYS, isUsableKey, searchKey, type SearchProvider } from "./web.ts";

// Guided setup (D24). The flow is a sequence of steps that talk to the user only through SetupIO, so the
// Ink layer and the tests drive the same code. Nothing is written to settings.json until the summary step
// is confirmed, and then in one merged write. Credentials stored by a completed login stay if the user cancels.

export const EXIT_SETUP_REQUIREMENT = 2;

export class SetupCancelled extends Error {
	constructor() {
		super("setup cancelled");
		this.name = "SetupCancelled";
	}
}

export class SetupError extends Error {
	readonly exitCode = EXIT_SETUP_REQUIREMENT;
	constructor(message: string) {
		super(message);
		this.name = "SetupError";
	}
}

export interface Option {
	id: string;
	label: string;
	/** A disabled option is listed with its reason and cannot be picked. */
	disabled?: string;
}

export interface SetupIO {
	/** Pick one option. Resolves with its id. Rejects with SetupCancelled on Esc or Ctrl+C. */
	choose(title: string, options: readonly Option[], defaultId?: string): Promise<string>;
	/** Masked entry. */
	secret(message: string, signal: AbortSignal): Promise<string>;
	/** `initial` is the starting text of the entry, which the user can edit. */
	text(message: string, signal: AbortSignal, placeholder?: string, initial?: string): Promise<string>;
	confirm(message: string, defaultValue: boolean): Promise<boolean>;
	/** Informational lines, warnings and errors. The caller sanitizes at render time. */
	notify(kind: "info" | "warn" | "error", message: string): void;
	/** Show and open a login URL that already passed safeAuthUrl(). */
	openUrl(href: string, instructions?: string): void;
}

export interface SetupEnv {
	home: string;
	models: Models;
	store: CredentialStore;
	deviceId: () => string;
	existing: Settings;
	nodeVersion?: string;
	/** Soft-check probes; return true when the program starts. */
	hasProgram?: (name: string) => boolean;
	/** Why fff cannot be used, or undefined when it can. */
	fffStatus?: () => Promise<string | undefined>;
	env?: NodeJS.ProcessEnv;
	/** models.json handle; the "create models.json" option reloads through it. */
	custom?: CustomProviders;
}

export type SetupResult = { status: "done"; settings: Settings } | { status: "cancelled" };

const MIN_NODE = [26, 5, 0] as const;

export function nodeAtLeast(version: string, min: readonly [number, number, number] = MIN_NODE): boolean {
	const [major = 0, minor = 0, patch = 0] = version.replace(/^v/u, "").split(".").map(Number);
	if (major !== min[0]) return major > min[0];
	if (minor !== min[1]) return minor > min[1];
	return patch >= min[2];
}

function programExists(name: string): boolean {
	if (name === "bash") return findBash() !== undefined;
	const result = spawnSync(name, ["--version"], { stdio: "ignore", windowsHide: true });
	return result.error === undefined;
}

export const isLoopbackHost = (host: string): boolean => host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/u.test(host);

function hostOf(baseUrl: string | undefined): string | undefined {
	if (baseUrl === undefined) return undefined;
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
}

/** Step 1. Hard checks stop setup with exit code 2; soft checks only warn. */
export async function checkRequirements(env: SetupEnv, io: SetupIO): Promise<void> {
	const version = env.nodeVersion ?? process.versions.node;
	if (!nodeAtLeast(version)) throw new SetupError(`Node ${MIN_NODE.join(".")} or newer is required (found ${version}).`);
	try {
		ensureHome(env.home, env.env);
	} catch (error) {
		throw new SetupError(error instanceof ConfigError ? error.message : `the home directory is not writable: ${(error as Error).message}`);
	}
	const has = env.hasProgram ?? programExists;
	if (!has("bash")) throw new SetupError(`bash was not found. piroboros runs every shell command through bash (Git Bash on Windows). ${BASH_HINT}`);
	io.notify("info", `Data directory: ${env.home}`);
	if (!has("git")) io.notify("warn", "git was not found. The memory vault needs it.");
	if (!has("rg")) io.notify("warn", "rg (ripgrep) was not found. Exact search needs it, and file search falls back to it when the fff library cannot load.");
	// Soft: without fff the find and grep tools use ripgrep, and without both they return an error.
	const fff = await (env.fffStatus ?? defaultFffStatus)();
	if (fff === undefined) io.notify("info", "File search: fff is available.");
	else io.notify("warn", `File search: fff is unavailable (${fff}). find and grep use ripgrep${has("rg") ? "" : ", which is also missing, so they will return an error"}.`);
}

/** The reason fff cannot be used, or undefined when it can. */
async function defaultFffStatus(): Promise<string | undefined> {
	const status = await probeSearch();
	return status.fff.ok ? undefined : status.fff.reason;
}

/** Adapts SetupIO to the interaction object pi-ai login flows expect. */
function interactionFor(io: SetupIO, signal: AbortSignal): AuthInteraction {
	return {
		signal,
		async prompt(prompt: AuthPrompt): Promise<string> {
			const aborted = prompt.signal ?? signal;
			switch (prompt.type) {
				case "select":
					return io.choose(prompt.message, prompt.options.map((option) => ({ id: option.id, label: option.description ? `${option.label} (${option.description})` : option.label })));
				case "secret":
					return io.secret(prompt.message, aborted);
				case "text":
				case "manual_code":
					return io.text(prompt.message, aborted, prompt.placeholder);
			}
		},
		notify(event: AuthEvent): void {
			switch (event.type) {
				case "auth_url": {
					const href = safeAuthUrl(event.url);
					if (href === undefined) {
						io.notify("error", "The sign-in address was refused because it is not an https address. Nothing was opened.");
						throw new Error("the provider returned an unsafe sign-in address");
					}
					io.openUrl(href, event.instructions);
					return;
				}
				case "device_code":
					io.notify("info", `Open ${event.verificationUri} and enter the code ${event.userCode}.`);
					return;
				case "info":
				case "progress":
					io.notify("info", event.message);
			}
		},
	};
}

export type Entry = { id: string; label: string; provider: ProviderChoice; method: ProviderMethod };

export function entriesFor(models: Models): Entry[] {
	const out: Entry[] = [];
	for (const provider of providerChoices(models)) for (const method of provider.methods) out.push({ id: `${provider.id}|${method.type}`, label: method.label, provider, method });
	return out;
}

const MODELS_JSON = "models-json";

/** Show where models.json goes and an example, then wait until the user asks for a reload (or goes back). */
async function addCustomProvider(env: SetupEnv, io: SetupIO): Promise<void> {
	const path = homePaths(env.home).models;
	io.notify("info", `Create ${path} with the providers you want, for example:\n${MODELS_JSON_EXAMPLE}\nThe API key is read from the environment variable <ID>_API_KEY (for example my-llm becomes MY_LLM_API_KEY, with every other character replaced by an underscore), or you can enter it here when you pick the provider.`);
	for (;;) {
		const choice = await io.choose("models.json", [{ id: "reload", label: "I saved the file, reload it" }, { id: "back", label: "Back" }], "reload");
		if (choice === "back") return;
		const result = env.custom?.reload() ?? { ok: false as const, error: "custom providers are not available in this run" };
		if (!result.ok) {
			io.notify("error", result.error);
			continue;
		}
		recordIntegrity(env.home, ["models"]);
		io.notify("info", result.ids.length === 0 ? `${path} lists no providers.` : `Loaded: ${result.ids.map((id) => `${id} (${apiKeyEnvName(id)})`).join(", ")}`);
		return;
	}
}

/**
 * Sign in to one provider method and check that the credential resolves. Returns false after telling the user why not.
 * An existing credential counts as signed in unless `force` asks for a new login. SetupCancelled passes through.
 */
export async function signIn(env: Pick<SetupEnv, "models" | "store" | "deviceId">, io: SetupIO, entry: Entry, signal: AbortSignal, options: { force?: boolean } = {}): Promise<boolean> {
	if (options.force !== true && (await hasAuth(env.models, entry.provider.id))) return true;
	if (!entry.method.interactive) {
		io.notify("error", `${entry.provider.name} has no sign-in step. Set its API key in the environment and try again.`);
		return false;
	}
	try {
		await loginAndStore(env.models, env.store, entry.provider.id, entry.method.type as AuthType, interactionFor(io, signal), env.deviceId);
	} catch (error) {
		if (error instanceof SetupCancelled) throw error;
		io.notify("error", `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
	if (!(await hasAuth(env.models, entry.provider.id))) {
		io.notify("error", "Sign-in finished but the credential does not resolve. Try again.");
		return false;
	}
	return true;
}

/**
 * Pick a provider and model, signing in when the provider does not already resolve. Returns the model ref.
 * `keep` offers the current value on a re-run. `skipLabel` renames the skip option, for callers where it means a reset.
 */
export async function pickModel(env: SetupEnv, io: SetupIO, role: ModelRole, title: string, keep: string | undefined, allowSkip: boolean, signal: AbortSignal, skipLabel = "Skip"): Promise<string | "skip" | "keep"> {
	for (;;) {
		const entries = entriesFor(env.models);
		const options: Option[] = [];
		if (keep !== undefined) options.push({ id: "keep", label: `Keep ${keep}` });
		if (allowSkip) options.push({ id: "skip", label: skipLabel });
		const ready = new Set<string>();
		for (const entry of entries) {
			const resolved = await hasAuth(env.models, entry.provider.id);
			if (resolved) ready.add(entry.provider.id);
			options.push({ id: entry.id, label: `${entry.label}${resolved ? " [ready]" : ""}` });
		}
		options.push({ id: MODELS_JSON, label: "Add a custom provider (create models.json)" });
		const defaultId = keep === undefined ? undefined : "keep";
		const picked = await io.choose(title, options, defaultId);
		if (picked === "keep") return "keep";
		if (picked === "skip") return "skip";
		if (picked === MODELS_JSON) {
			await addCustomProvider(env, io);
			continue;
		}
		const entry = entries.find((candidate) => candidate.id === picked)!;

		if (!(await signIn(env, io, entry, signal))) continue;

		const choices = modelChoices(env.models, entry.provider.id, role);
		if (choices.length === 0) {
			io.notify("error", `${entry.provider.name} lists no models.`);
			continue;
		}
		const modelOptions: Option[] = choices.map((choice) => ({ id: choice.ref, label: choice.model.name ?? choice.ref, ...(choice.check.ok ? {} : { disabled: choice.check.reason }) }));
		const firstOk = choices.find((choice) => choice.check.ok)?.ref;
		for (;;) {
			const model = await io.choose(`Model for ${entry.provider.name}`, modelOptions, firstOk);
			const chosen = choices.find((choice) => choice.ref === model);
			if (chosen !== undefined && chosen.check.ok) return chosen.ref;
			io.notify("error", chosen?.check.reason ?? "That model cannot be used.");
		}
	}
}

export function resolveBaseHost(models: Models, ref: string): string | undefined {
	const { provider, modelId } = splitModelRef(ref);
	return hostOf(models.getModel(provider, modelId)?.baseUrl);
}

/** True when a key for the search provider is stored or set in its environment variable. */
export const hasSearchKey = (env: Pick<SetupEnv, "home" | "env">, provider: SearchProvider): boolean => searchKey(provider, homePaths(env.home).auth, env.env ?? process.env) !== undefined;

/**
 * Ask for a web search key and store it in auth.json; it is never printed. A key that is already stored or set is kept
 * unless `force` asks for a new one. Returns true when a key is in place afterwards.
 */
export async function webKeyStep(env: Pick<SetupEnv, "home" | "env" | "store">, io: SetupIO, provider: SearchProvider, signal: AbortSignal, options: { force?: boolean } = {}): Promise<boolean> {
	const names = SEARCH_KEYS[provider];
	io.notify("info", `Queries are sent to ${names.label}, which may keep them under its own terms. You use your own ${names.label} key and accept its terms.`);
	if (options.force !== true && hasSearchKey(env, provider)) {
		io.notify("info", `A ${names.label} key is already stored or set in ${names.env}; it is kept.`);
		return true;
	}
	for (;;) {
		const key = (await io.secret(`${names.label} API key`, signal)).trim();
		if (isUsableKey(key)) {
			await env.store.modify(names.auth, async () => ({ type: "api_key", key }));
			return true;
		}
		io.notify("error", "That is not a usable key (8 to 512 printable characters, no spaces). Try again.");
	}
}

/** The optional web search step. Returns the chosen provider, or undefined for off. */
export async function pickWebSearch(env: SetupEnv, io: SetupIO, signal: AbortSignal): Promise<SearchProvider | undefined> {
	const picked = await io.choose("Web search for the Vaelia seat (optional)", [
		{ id: "off", label: "Off" },
		{ id: "tinyfish", label: "TinyFish (recommended, free tier)" },
		{ id: "exa", label: "Exa (paid per search, monthly free credit)" },
	], "off");
	if (picked !== "tinyfish" && picked !== "exa") return undefined;
	await webKeyStep(env, io, picked, signal);
	return picked;
}

export type LoginResult = { status: "signed-in" | "web-key" | "unchanged" | "failed"; message: string };

/**
 * /login: pick a provider (or web-tinyfish, web-exa), pick the method when the provider has an OAuth and an API key
 * method, then sign in. `target` skips the provider pick. A provider that already resolves is signed in again only after
 * the user agrees, or when `force` is set. Never runs the wizard.
 */
export async function runLogin(env: SetupEnv, plain: SetupIO, signal: AbortSignal, options: { target?: string; force?: boolean } = {}): Promise<LoginResult> {
	// The notices of a flow disappear when it ends, so the last error is kept for the result.
	let lastError = "";
	const io: SetupIO = { ...plain, notify: (kind, message) => { if (kind === "error") lastError = message; plain.notify(kind, message); } };
	const failed = (what: string): LoginResult => ({ status: "failed", message: lastError === "" ? what : `${what}: ${lastError}` });
	const providers = providerChoices(env.models);
	let target = options.target;
	if (target === undefined) {
		const choices: Option[] = [];
		for (const provider of providers) choices.push({ id: provider.id, label: `${provider.name}${(await hasAuth(env.models, provider.id)) ? " [ready]" : ""}` });
		for (const name of ["tinyfish", "exa"] as const) choices.push({ id: `web-${name}`, label: `${SEARCH_KEYS[name].label} web search key${hasSearchKey(env, name) ? " [ready]" : ""}` });
		target = await io.choose("Sign in to", choices);
	}
	const web = /^web-(tinyfish|exa)$/u.exec(target);
	if (web !== null) {
		const provider = web[1] as SearchProvider;
		const label = SEARCH_KEYS[provider].label;
		const force = options.force === true || (hasSearchKey(env, provider) && (await io.confirm(`A ${label} key is already stored or set. Enter a new one?`, false)));
		if (hasSearchKey(env, provider) && !force) return { status: "unchanged", message: `${label} key kept` };
		return (await webKeyStep(env, io, provider, signal, { force })) ? { status: "web-key", message: `${label} key stored` } : failed(`${label} key not stored`);
	}
	const provider = providers.find((candidate) => candidate.id === target);
	if (provider === undefined) return failed(`unknown provider ${target}; use /login to see the list, or /reload after editing models.json`);
	let method = provider.methods[0]!;
	if (provider.methods.length > 1) {
		const pickedMethod = await io.choose(`How do you want to sign in to ${provider.name}?`, provider.methods.map((candidate) => ({ id: candidate.type, label: candidate.label })));
		method = provider.methods.find((candidate) => candidate.type === pickedMethod) ?? method;
	}
	const entry: Entry = { id: `${provider.id}|${method.type}`, label: method.label, provider, method };
	const force = options.force === true || ((await hasAuth(env.models, provider.id)) && (await io.confirm(`${provider.name} already has a credential. Sign in again?`, false)));
	if (!force && (await hasAuth(env.models, provider.id))) return { status: "unchanged", message: `${provider.name} kept as it is` };
	return (await signIn(env, io, entry, signal, { force })) ? { status: "signed-in", message: `signed in to ${provider.name}` } : failed(`sign-in to ${provider.name} did not finish`);
}

/** Run the wizard. Throws SetupError for a missing hard requirement; returns `cancelled` and writes nothing on cancel. */
export async function runSetup(env: SetupEnv, io: SetupIO, signal: AbortSignal = new AbortController().signal): Promise<SetupResult> {
	try {
		// Step 1
		await checkRequirements(env, io);
		if (!(await io.confirm("Continue with setup?", true))) throw new SetupCancelled();

		// Step 2: compactor
		let compactor: Settings["compactor"] | undefined;
		const existingCompactor = env.existing.compactor?.model;
		const compactorPick = await pickModel(env, io, "compactor", "Compactor model (summarizes old chat in the background)", existingCompactor, true, signal);
		if (compactorPick === "keep") compactor = undefined;
		else if (compactorPick === "skip") {
			io.notify("warn", "compactor: not configured");
			compactor = undefined;
		} else {
			const host = resolveBaseHost(env.models, compactorPick);
			let allow = false;
			if (host !== undefined && !isLoopbackHost(host)) allow = await io.confirm(`The compactor will send chat text to ${host}. Allow it?`, false);
			compactor = allow || (host !== undefined && isLoopbackHost(host)) ? { enabled: true, model: compactorPick, allowThirdParty: allow } : undefined;
			if (compactor === undefined) io.notify("warn", existingCompactor === undefined ? "compactor: not configured" : `compactor: kept ${existingCompactor}`);
		}

		// Step 3: main
		const mainPick = await pickModel(env, io, "main", "Main model", env.existing.main, false, signal);
		const main = mainPick === "keep" ? env.existing.main! : (mainPick as string);

		// Step 4: optional values (Enter accepts the default)
		const defaultMember = env.existing.conclave?.defaultModel ?? main;
		const memberOptions: Option[] = [{ id: "main", label: `Same as main (${main})` }];
		if (defaultMember !== main) memberOptions.push({ id: "current", label: `Keep ${defaultMember}` });
		const memberPick = await io.choose("Conclave default model", memberOptions, defaultMember === main ? "main" : "current");
		const conclaveDefault = memberPick === "current" ? defaultMember : main;
		const stepsPick = await io.choose("Thinking display", THINKING_STEP_MODES.map((mode) => ({ id: mode, label: mode })), env.existing.tui?.thinkingSteps ?? "summary");

		// Step 5: optional web search for the Vaelia seat. Off changes nothing; a provider turns web access on.
		const webProvider = await pickWebSearch(env, io, signal);

		// Step 6: summary and one write
		const patch: Settings = { main, tui: { thinkingSteps: stepsPick } };
		if (webProvider !== undefined) patch.web = { enabled: true, search: { provider: webProvider } };
		if (compactor !== undefined) patch.compactor = compactor;
		if (conclaveDefault !== main) patch.conclave = { defaultModel: conclaveDefault };
		const lines = [`main: ${main}`, `compactor: ${compactor?.model ?? env.existing.compactor?.model ?? "not configured"}`, `conclave default: ${conclaveDefault}`, `thinking display: ${stepsPick}`, ...(webProvider === undefined ? [] : [`web search: ${webProvider}`])];
		io.notify("info", lines.join("\n"));
		if (!(await io.confirm("Write these settings?", true))) throw new SetupCancelled();
		let settings = mergeSettings(env.home, patch);
		if (conclaveDefault === main && settings.conclave?.defaultModel !== undefined) settings = unsetSettings(env.home, "conclave.defaultModel");
		return { status: "done", settings };
	} catch (error) {
		if (error instanceof SetupCancelled) return { status: "cancelled" };
		throw error;
	}
}

/** Used by --print and the TUI when no main model is set. */
export const SETUP_HINT = 'run "piroboros setup" first';

export { contextCheck };

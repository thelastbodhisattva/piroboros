import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { canonicalize, isInside, samePath, segments } from "./paths.ts";

// Home directory, config files, settings schema and config integrity. Every filesystem path piroboros
// owns is derived from the validated home returned by resolveHome().

export class ConfigError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ConfigError";
		this.code = code;
	}
}

/* --- home -------------------------------------------------------------------------------------------- */

export interface HomePaths {
	home: string;
	auth: string;
	authLock: string;
	settings: string;
	models: string;
	instructions: string;
	deviceId: string;
	lock: string;
	chat: string;
	integrity: string;
	skillsTrust: string;
	telemetry: string;
}

export function homePaths(home: string): HomePaths {
	return {
		home,
		auth: join(home, "auth.json"),
		authLock: join(home, "auth.lock.sqlite"),
		settings: join(home, "settings.json"),
		models: join(home, "models.json"),
		instructions: join(home, "instructions.md"),
		deviceId: join(home, "device-id"),
		lock: join(home, "lock.sqlite"),
		chat: join(home, "chat.sqlite"),
		integrity: join(home, "config-integrity.json"),
		skillsTrust: join(home, "skills-trust.json"),
		telemetry: join(home, "telemetry.sqlite"),
	};
}

/** The home piroboros would use with no override. Tests must never touch it. */
export function defaultHome(profile: string = homedir()): string {
	return join(profile, ".piroboros");
}

/**
 * Validate and canonicalize the home directory once. It must be absolute, must not be a filesystem root or
 * the profile root, and must not be, contain or sit inside the profile's `.ssh` directory.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env, profile: string = homedir()): string {
	const raw = env.PIROBOROS_HOME !== undefined && env.PIROBOROS_HOME !== "" ? env.PIROBOROS_HOME : defaultHome(profile);
	if (!isAbsolute(raw)) throw new ConfigError("home_invalid", `PIROBOROS_HOME must be an absolute path (got a relative path)`);
	let home: string;
	try {
		home = canonicalize(raw);
	} catch (error) {
		throw new ConfigError("home_invalid", `PIROBOROS_HOME cannot be used: ${(error as Error).message}`);
	}
	if (parse(home).root === home) throw new ConfigError("home_invalid", "PIROBOROS_HOME must not be a filesystem root");
	const profileRoot = canonicalize(profile);
	if (samePath(home, profileRoot)) throw new ConfigError("home_invalid", "PIROBOROS_HOME must not be the profile directory");
	const ssh = canonicalize(join(profile, ".ssh"));
	if (isInside(home, ssh)) throw new ConfigError("home_invalid", "PIROBOROS_HOME must not contain the .ssh directory");
	if (segments(home).includes(".ssh")) throw new ConfigError("home_invalid", "PIROBOROS_HOME must not be inside a .ssh directory");
	return home;
}

/** Refuses to run automated tests against the real default home. */
export function assertNotRealHomeInTests(home: string, env: NodeJS.ProcessEnv = process.env, profile: string = homedir()): void {
	const underTest = env.NODE_TEST_CONTEXT !== undefined || env.PIROBOROS_TEST === "1";
	if (underTest && samePath(home, canonicalize(defaultHome(profile)))) throw new ConfigError("test_real_home", "refusing to run tests against the real PIROBOROS_HOME");
}

export function ensureHome(home: string, env: NodeJS.ProcessEnv = process.env): void {
	assertNotRealHomeInTests(home, env);
	try {
		mkdirSync(home, { recursive: true });
		if (!statSync(home).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new ConfigError("home_unwritable", `PIROBOROS_HOME is not usable: ${(error as Error).message}`);
	}
}

/* --- JSON files ---------------------------------------------------------------------------------------- */

/** Read a JSON file. Missing file: undefined. A UTF-8 BOM is tolerated. A parse failure names the file. */
export function readJsonFile(path: string): unknown {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8").replace(/^\u{FEFF}/u, "");
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ConfigError("json_invalid", `${path} is not valid JSON: ${(error as Error).message}`);
	}
}

/** Write JSON without a BOM through a temp file and rename, retrying on EPERM (Windows virus scanners). */
export function writeJsonFile(path: string, value: unknown, mode = 0o600): void {
	writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function writeTextAtomic(path: string, text: string, mode = 0o600): void {
	const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, text, { encoding: "utf8", mode });
	let lastError: unknown;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			renameSync(tmp, path);
			return;
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EBUSY") break;
			const until = Date.now() + 20 * (attempt + 1);
			while (Date.now() < until) { /* short synchronous backoff; the file is small */ }
		}
	}
	throw lastError;
}

/* --- device id ------------------------------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A stable installation id. Created with the exclusive flag and read back, so two processes racing on the
 * first run agree. A file that is not a UUID is a named error rather than a silent replacement.
 */
export function getDeviceId(home: string): string {
	const path = homePaths(home).deviceId;
	if (!existsSync(path)) {
		try {
			writeFileSync(path, `${randomUUID()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const value = readFileSync(path, "utf8").trim();
	if (!UUID.test(value)) throw new ConfigError("device_id_corrupt", `${path} does not hold a valid device id; delete the file to create a new one`);
	return value;
}

/* --- settings schema -------------------------------------------------------------------------------------- */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const THINKING_STEP_MODES = ["collapsed", "summary", "expanded"] as const;
export const CONCLAVE_MEMBERS = ["samaela", "nytheria", "elaria", "raskreia", "avaritia", "vaelia", "astrelia", "vesperia"] as const;

export interface Settings {
	main?: string;
	thinking?: string;
	compactor?: { enabled?: boolean; model?: string; thinking?: string; maxConcurrent?: number; allowThirdParty?: boolean };
	/** The learning loop (P27c). Off until a model is set. */
	learning?: { model?: string; thinking?: string; everyTurns?: number; allowThirdParty?: boolean };
	conclave?: {
		defaultModel?: string;
		maxTurns?: number;
		idleTimeoutMs?: number;
		reportMaxChars?: number;
		members?: Record<string, { model?: string; thinking?: string; maxTurns?: number; idleTimeoutMs?: number }>;
	};
	gateTimeoutMs?: number;
	cacheRetention?: "short" | "long";
	shellEnvAllow?: string[];
	shellTimeoutMs?: number;
	/** deny: more protected roots. allow: project folders opened inside a deny root (P27f). */
	guard?: { deny?: string[]; allow?: string[] };
	/** Vesperia's Workspaces (P27d1). `enabled: false` runs her in place as 0.2.0 did; `nested` decides a project that is a repository subfolder, a worktree or a submodule. Both apply at the next /conclave approve. */
	workspace?: { enabled?: boolean; nested?: "ask" | "copy" | "inplace"; confine?: "auto" | "none"; network?: boolean };
	tui?: { thinkingSteps?: string };
	/** The plan tool (H5). Default true; false removes the tool and its injection at the next start. */
	planning?: boolean;
	/** Local request and task timings in telemetry.sqlite. Default true; false stops recording at the next start. */
	telemetry?: boolean;
	/** Web access for the Vaelia seat only (P8a). Off unless enabled is true. */
	web?: { enabled?: boolean; maxFetches?: number; maxSearches?: number; search?: { provider?: "tinyfish" | "exa" }; allowHosts?: string[]; queryHosts?: string[] };
}

export const SETTINGS_DEFAULTS = {
	thinking: "medium",
	compactor: { enabled: true, thinking: "off", maxConcurrent: 8, allowThirdParty: false },
	learning: { thinking: "low", everyTurns: 10, allowThirdParty: false },
	conclave: { maxTurns: 64, idleTimeoutMs: 600_000, reportMaxChars: 4_000 },
	gateTimeoutMs: 120_000,
	cacheRetention: "short",
	shellEnvAllow: [] as string[],
	shellTimeoutMs: 600_000,
	tui: { thinkingSteps: "summary" },
	telemetry: true,
	workspace: { enabled: true, nested: "ask", confine: "auto", network: true },
	web: { enabled: false, maxFetches: 10, maxSearches: 5 },
} as const;

/** A host name for web.allowHosts and web.queryHosts: lower case DNS labels, no scheme, port, path or wildcard. */
export const WEB_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

export class SettingsError extends ConfigError {
	readonly issues: string[];
	constructor(issues: string[]) {
		super("settings_invalid", `settings.json is invalid:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
		this.issues = issues;
	}
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

export function isModelRef(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}
export function splitModelRef(ref: string): { provider: string; modelId: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** Validate settings. Unknown keys are rejected with the key path named. Throws SettingsError listing every issue. */
export function validateSettings(value: unknown): Settings {
	const issues: string[] = [];
	if (!isObj(value)) throw new SettingsError(["the file must hold a JSON object"]);
	const known = (obj: Obj, allowed: readonly string[], path: string): void => {
		for (const key of Object.keys(obj)) if (!allowed.includes(key)) issues.push(`${path ? `${path}.` : ""}${key}: unknown key`);
	};
	const check = {
		ref: (v: unknown, path: string): void => { if (v !== undefined && !isModelRef(v)) issues.push(`${path}: must be "provider/model"`); },
		level: (v: unknown, path: string): void => { if (v !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(v)) issues.push(`${path}: must be one of ${THINKING_LEVELS.join(", ")}`); },
		bool: (v: unknown, path: string): void => { if (v !== undefined && typeof v !== "boolean") issues.push(`${path}: must be true or false`); },
		int: (v: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): void => {
			if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)) issues.push(`${path}: must be an integer from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`}`);
		},
	};
	known(value, ["main", "thinking", "compactor", "learning", "conclave", "gateTimeoutMs", "cacheRetention", "shellEnvAllow", "shellTimeoutMs", "guard", "workspace", "tui", "planning", "telemetry", "web"], "");
	check.ref(value.main, "main");
	check.level(value.thinking, "thinking");
	if (value.compactor !== undefined) {
		if (!isObj(value.compactor)) issues.push("compactor: must be an object");
		else {
			known(value.compactor, ["enabled", "model", "thinking", "maxConcurrent", "allowThirdParty"], "compactor");
			check.bool(value.compactor.enabled, "compactor.enabled");
			check.ref(value.compactor.model, "compactor.model");
			check.level(value.compactor.thinking, "compactor.thinking");
			check.int(value.compactor.maxConcurrent, "compactor.maxConcurrent", 1, 8);
			check.bool(value.compactor.allowThirdParty, "compactor.allowThirdParty");
		}
	}
	if (value.learning !== undefined) {
		if (!isObj(value.learning)) issues.push("learning: must be an object");
		else {
			known(value.learning, ["model", "thinking", "everyTurns", "allowThirdParty"], "learning");
			check.ref(value.learning.model, "learning.model");
			check.level(value.learning.thinking, "learning.thinking");
			check.int(value.learning.everyTurns, "learning.everyTurns", 3, 100);
			check.bool(value.learning.allowThirdParty, "learning.allowThirdParty");
		}
	}
	if (value.conclave !== undefined) {
		if (!isObj(value.conclave)) issues.push("conclave: must be an object");
		else {
			known(value.conclave, ["defaultModel", "maxTurns", "idleTimeoutMs", "reportMaxChars", "members"], "conclave");
			check.ref(value.conclave.defaultModel, "conclave.defaultModel");
			check.int(value.conclave.maxTurns, "conclave.maxTurns", 1);
			check.int(value.conclave.idleTimeoutMs, "conclave.idleTimeoutMs", 1_000);
			check.int(value.conclave.reportMaxChars, "conclave.reportMaxChars", 1_000);
			if (value.conclave.members !== undefined) {
				if (!isObj(value.conclave.members)) issues.push("conclave.members: must be an object");
				else {
					for (const [name, member] of Object.entries(value.conclave.members)) {
						const path = `conclave.members.${name}`;
						if (!(CONCLAVE_MEMBERS as readonly string[]).includes(name)) { issues.push(`${path}: unknown member (expected one of ${CONCLAVE_MEMBERS.join(", ")})`); continue; }
						if (!isObj(member)) { issues.push(`${path}: must be an object`); continue; }
						known(member, ["model", "thinking", "maxTurns", "idleTimeoutMs"], path);
						check.ref(member.model, `${path}.model`);
						check.level(member.thinking, `${path}.thinking`);
						check.int(member.maxTurns, `${path}.maxTurns`, 1);
						check.int(member.idleTimeoutMs, `${path}.idleTimeoutMs`, 1_000);
					}
				}
			}
		}
	}
	check.int(value.gateTimeoutMs, "gateTimeoutMs", 1);
	if (value.cacheRetention !== undefined && value.cacheRetention !== "short" && value.cacheRetention !== "long") issues.push('cacheRetention: must be "short" or "long"');
	if (value.shellEnvAllow !== undefined && !(Array.isArray(value.shellEnvAllow) && value.shellEnvAllow.every((item) => typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_()]*$/u.test(item)))) issues.push("shellEnvAllow: must be an array of environment variable names");
	check.int(value.shellTimeoutMs, "shellTimeoutMs", 1_000);
	if (value.planning !== undefined && typeof value.planning !== "boolean") issues.push("planning: must be true or false");
	if (value.telemetry !== undefined && typeof value.telemetry !== "boolean") issues.push("telemetry: must be true or false");
	if (value.guard !== undefined) {
		if (!isObj(value.guard)) issues.push("guard: must be an object");
		else {
			known(value.guard, ["deny", "allow"], "guard");
			if (value.guard.deny !== undefined && !(Array.isArray(value.guard.deny) && value.guard.deny.every((item) => typeof item === "string" && isAbsolute(item)))) issues.push("guard.deny: must be an array of absolute paths");
			// Structural only: the profile-dependent rules (allowEntryProblem) run on save and at use, so a settings.json moved between machines still loads.
			const { allow, deny } = value.guard;
			if (allow !== undefined && !(Array.isArray(allow) && allow.every((item) => typeof item === "string" && isAbsolute(item)))) issues.push("guard.allow: must be an array of absolute paths");
			else if (Array.isArray(allow) && Array.isArray(deny) && allow.some((item: string) => deny.some((root) => typeof root === "string" && isAbsolute(root) && samePath(resolve(root), resolve(item))))) issues.push("guard.allow: an entry equals a guard.deny entry");
		}
	}
	if (value.workspace !== undefined) {
		if (!isObj(value.workspace)) issues.push("workspace: must be an object");
		else {
			known(value.workspace, ["enabled", "nested", "confine", "network"], "workspace");
			check.bool(value.workspace.enabled, "workspace.enabled");
			check.bool(value.workspace.network, "workspace.network");
			if (value.workspace.confine !== undefined && !["auto", "none"].includes(value.workspace.confine as string)) issues.push('workspace.confine: must be "auto" or "none"');
			if (value.workspace.nested !== undefined && !["ask", "copy", "inplace"].includes(value.workspace.nested as string)) issues.push('workspace.nested: must be "ask", "copy" or "inplace"');
		}
	}
	if (value.web !== undefined) {
		if (!isObj(value.web)) issues.push("web: must be an object");
		else {
			known(value.web, ["enabled", "maxFetches", "maxSearches", "search", "allowHosts", "queryHosts"], "web");
			check.bool(value.web.enabled, "web.enabled");
			check.int(value.web.maxFetches, "web.maxFetches", 1, 100);
			check.int(value.web.maxSearches, "web.maxSearches", 1, 100);
			if (value.web.search !== undefined) {
				if (!isObj(value.web.search)) issues.push("web.search: must be an object");
				else {
					known(value.web.search, ["provider"], "web.search");
					const provider = value.web.search.provider;
					if (provider !== undefined && provider !== "tinyfish" && provider !== "exa") issues.push('web.search.provider: must be "tinyfish" or "exa"');
				}
			}
			for (const key of ["allowHosts", "queryHosts"] as const) {
				const list = value.web[key];
				if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string" && WEB_HOST.test(item)))) issues.push(`web.${key}: must be an array of lower case host names such as "docs.example.org" (no scheme, port or path)`);
			}
		}
	}
	if (value.tui !== undefined) {
		if (!isObj(value.tui)) issues.push("tui: must be an object");
		else {
			known(value.tui, ["thinkingSteps"], "tui");
			if (value.tui.thinkingSteps !== undefined && !(THINKING_STEP_MODES as readonly unknown[]).includes(value.tui.thinkingSteps)) issues.push(`tui.thinkingSteps: must be one of ${THINKING_STEP_MODES.join(", ")}`);
		}
	}
	if (issues.length > 0) throw new SettingsError(issues);
	return value as Settings;
}

/** Settings with defaults applied (read only; the file keeps only what the user or the wizard wrote). */
export function withDefaults(settings: Settings) {
	return {
		main: settings.main,
		thinking: settings.thinking ?? SETTINGS_DEFAULTS.thinking,
		compactor: { ...SETTINGS_DEFAULTS.compactor, ...settings.compactor },
		learning: { ...SETTINGS_DEFAULTS.learning, ...settings.learning },
		conclave: { ...SETTINGS_DEFAULTS.conclave, ...settings.conclave },
		gateTimeoutMs: settings.gateTimeoutMs ?? SETTINGS_DEFAULTS.gateTimeoutMs,
		cacheRetention: settings.cacheRetention ?? SETTINGS_DEFAULTS.cacheRetention,
		shellEnvAllow: settings.shellEnvAllow ?? [],
		shellTimeoutMs: settings.shellTimeoutMs ?? SETTINGS_DEFAULTS.shellTimeoutMs,
		guardDeny: settings.guard?.deny ?? [],
		guardAllow: settings.guard?.allow ?? [],
		workspace: { ...SETTINGS_DEFAULTS.workspace, ...settings.workspace },
		planning: settings.planning ?? true,
		telemetry: settings.telemetry ?? SETTINGS_DEFAULTS.telemetry,
		web: {
			enabled: settings.web?.enabled ?? SETTINGS_DEFAULTS.web.enabled,
			maxFetches: settings.web?.maxFetches ?? SETTINGS_DEFAULTS.web.maxFetches,
			maxSearches: settings.web?.maxSearches ?? SETTINGS_DEFAULTS.web.maxSearches,
			provider: settings.web?.search?.provider,
			allowHosts: settings.web?.allowHosts ?? ([] as string[]),
			queryHosts: settings.web?.queryHosts ?? ([] as string[]),
		},
		thinkingSteps: settings.tui?.thinkingSteps ?? SETTINGS_DEFAULTS.tui.thinkingSteps,
	};
}

/** `compactor: not configured` means no model; `compactor: disabled` means enabled is false. */
export function compactorStatus(settings: Settings): "not configured" | "disabled" | "configured" {
	if (settings.compactor?.model === undefined) return "not configured";
	return settings.compactor.enabled === false ? "disabled" : "configured";
}

export function readSettings(home: string): Settings {
	const raw = readJsonFile(homePaths(home).settings);
	return raw === undefined ? {} : validateSettings(raw);
}

function mergeDeep(base: Obj, patch: Obj): Obj {
	const out: Obj = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		out[key] = isObj(value) && isObj(out[key]) ? mergeDeep(out[key] as Obj, value) : value;
	}
	return out;
}

export const SETTINGS_CHANGED = "settings.json changed outside piroboros; run /reload first";

/**
 * The only settings write. It refuses when the file is not what piroboros last wrote (or was never recorded),
 * then applies `edit`, validates, writes atomically and records the hash of the string it wrote.
 */
function checkedWrite(home: string, edit: (current: Obj) => Obj, profile: string): Settings {
	const path = homePaths(home).settings;
	let text: string | undefined;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (text !== undefined && readIntegrity(home).settings?.sha256 !== sha(text)) throw new ConfigError("settings_changed", SETTINGS_CHANGED);
	let current: unknown;
	try {
		current = text === undefined ? undefined : JSON.parse(text.replace(/^\u{FEFF}/u, ""));
	} catch (error) {
		throw new ConfigError("json_invalid", `${path} is not valid JSON: ${(error as Error).message}`);
	}
	const merged = checkAllow(validateSettings(edit(isObj(current) ? current : {})), isObj(current) ? (current as Settings) : undefined, profile, home);
	const written = `${JSON.stringify(merged, null, 2)}\n`;
	writeTextAtomic(path, written, 0o600);
	const record = readIntegrity(home);
	record.settings = recordOf("settings", written);
	writeJsonFile(homePaths(home).integrity, record);
	return merged;
}

/** The pi agent dir: PI_CODING_AGENT_DIR when it is set and absolute, otherwise <profile>/.pi/agent. */
export function piAgentDir(profile: string, env: NodeJS.ProcessEnv = process.env): string {
	const set = env.PI_CODING_AGENT_DIR;
	return set !== undefined && isAbsolute(set) ? resolve(set) : join(profile, ".pi", "agent");
}

/**
 * Why `entry` may not be a guard.allow entry, or undefined. Lexical after path.resolve (no filesystem access): it must be
 * at or inside <agent dir>/extensions, or strictly inside a guard.deny root, and never at or inside the piroboros home,
 * ~/.ssh or ~/.claude. The guard repeats the check at use and adds the link test.
 */
export function allowEntryProblem(entry: string, deny: readonly string[], profile: string, home: string): string | undefined {
	if (!isAbsolute(entry)) return "must be an absolute path";
	const at = resolve(entry);
	if ([home, join(profile, ".ssh"), join(profile, ".claude")].some((root) => isInside(resolve(root), at))) return "must not be inside the piroboros data directory, ~/.ssh or ~/.claude";
	if (deny.some((root) => samePath(resolve(root), at))) return "equals a guard.deny entry";
	if (isInside(join(piAgentDir(profile), "extensions"), at)) return undefined;
	return deny.some((root) => isInside(resolve(root), at)) ? undefined : "must be at or inside the pi extensions folder, or strictly inside a guard.deny root";
}

/** `settings` unchanged, or a SettingsError naming each guard.allow entry that is new in it (against `before`) and fails allowEntryProblem. Old entries stay so any other key can still be saved. */
function checkAllow(settings: Settings, before: Settings | undefined, profile: string, home: string): Settings {
	const old = before?.guard?.allow ?? [];
	const issues = (settings.guard?.allow ?? []).filter((entry) => !old.includes(entry)).flatMap((entry) => {
		const problem = allowEntryProblem(entry, settings.guard?.deny ?? [], profile, home);
		return problem === undefined ? [] : [`guard.allow: ${entry} ${problem}`];
	});
	if (issues.length > 0) throw new SettingsError(issues);
	return settings;
}

/** Merges only the patched keys through the checked write. */
export function mergeSettings(home: string, patch: Settings, profile: string = profileDir()): Settings {
	return checkedWrite(home, (current) => mergeDeep(current, patch as Obj), profile);
}

function unsetPath(obj: Obj, parts: string[]): Obj {
	const [head, ...rest] = parts;
	if (head === undefined || !(head in obj)) return obj;
	const out = { ...obj };
	if (rest.length === 0) delete out[head];
	else if (isObj(out[head])) {
		const child = unsetPath(out[head] as Obj, rest);
		if (Object.keys(child).length === 0) delete out[head];
		else out[head] = child;
	}
	return out;
}

/** Removes one key by its dotted path, such as "tui.thinkingSteps", and any parent object left empty. */
export function unsetSettings(home: string, path: string, profile: string = profileDir()): Settings {
	return checkedWrite(home, (current) => unsetPath(current, path.split(".")), profile);
}

export type SettingsChange = { set: Settings } | { unset: string };

/** The settings a change would produce, validated. Throws SettingsError when the result is invalid. Nothing is written. */
export function previewSettings(current: Settings, change: SettingsChange, profile: string = profileDir(), home: string = process.env.PIROBOROS_HOME || defaultHome(profile)): Settings {
	return checkAllow(validateSettings("unset" in change ? unsetPath(current as Obj, change.unset.split(".")) : mergeDeep(current as Obj, change.set as Obj)), current, profile, home);
}

/** The value at a dotted path such as "web.search.provider", or undefined. */
export function getSetting(settings: unknown, path: string): unknown {
	let at: unknown = settings;
	for (const part of path.split(".")) at = isObj(at) ? at[part] : undefined;
	return at;
}

/** The patch that sets one dotted path: ("web.maxFetches", 3) gives { web: { maxFetches: 3 } }. */
export function settingPatch(path: string, value: unknown): Settings {
	return path.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value) as Settings;
}

/* --- config integrity (F5) -------------------------------------------------------------------------------- */

const FILES = ["settings", "models", "instructions", "skills-trust"] as const;
type IntegrityFile = (typeof FILES)[number];

interface IntegrityRecord {
	sha256: string;
	/** Security-relevant keys at the time of the last piroboros write, for the diff shown on mismatch. */
	keys?: Record<string, unknown>;
}

function fileFor(home: string, name: IntegrityFile): string {
	const paths = homePaths(home);
	return name === "settings" ? paths.settings : name === "models" ? paths.models : name === "skills-trust" ? paths.skillsTrust : paths.instructions;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function securityKeys(settings: unknown): Record<string, unknown> {
	if (!isObj(settings)) return {};
	// Only members that have a model: a member with just a thinking level or a limit is not a security change.
	const withModel = isObj(settings.conclave) && isObj(settings.conclave.members) ? Object.entries(settings.conclave.members).flatMap(([name, member]) => (isObj(member) && member.model !== undefined ? [[name, member.model] as const] : [])) : [];
	const members = withModel.length === 0 ? undefined : Object.fromEntries(withModel);
	return {
		main: settings.main,
		"compactor.model": isObj(settings.compactor) ? settings.compactor.model : undefined,
		"compactor.allowThirdParty": isObj(settings.compactor) ? settings.compactor.allowThirdParty : undefined,
		"learning.model": isObj(settings.learning) ? settings.learning.model : undefined,
		"learning.allowThirdParty": isObj(settings.learning) ? settings.learning.allowThirdParty : undefined,
		"conclave.defaultModel": isObj(settings.conclave) ? settings.conclave.defaultModel : undefined,
		"conclave.members.models": members,
		shellEnvAllow: settings.shellEnvAllow,
		shellTimeoutMs: settings.shellTimeoutMs,
		"guard.deny": isObj(settings.guard) ? settings.guard.deny : undefined,
		"guard.allow": isObj(settings.guard) ? settings.guard.allow : undefined,
		// Whether Vesperia writes live files directly (in place) is a trust decision.
		"workspace.enabled": isObj(settings.workspace) ? settings.workspace.enabled : undefined,
		"workspace.nested": isObj(settings.workspace) ? settings.workspace.nested : undefined,
		"workspace.confine": isObj(settings.workspace) ? settings.workspace.confine : undefined,
		"workspace.network": isObj(settings.workspace) ? settings.workspace.network : undefined,
		"web.enabled": isObj(settings.web) ? settings.web.enabled : undefined,
		"web.maxFetches": isObj(settings.web) ? settings.web.maxFetches : undefined,
		"web.maxSearches": isObj(settings.web) ? settings.web.maxSearches : undefined,
		"web.search.provider": isObj(settings.web) && isObj(settings.web.search) ? settings.web.search.provider : undefined,
		"web.allowHosts": isObj(settings.web) ? settings.web.allowHosts : undefined,
		"web.queryHosts": isObj(settings.web) ? settings.web.queryHosts : undefined,
	};
}

function readIntegrity(home: string): Partial<Record<IntegrityFile, IntegrityRecord>> {
	try {
		const raw = readJsonFile(homePaths(home).integrity);
		return isObj(raw) ? (raw as Partial<Record<IntegrityFile, IntegrityRecord>>) : {};
	} catch {
		return {};
	}
}

function recordOf(name: IntegrityFile, text: string): IntegrityRecord {
	let keys: Record<string, unknown> | undefined;
	if (name === "settings") { try { keys = securityKeys(JSON.parse(text.replace(/^\u{FEFF}/u, ""))); } catch { keys = undefined; } }
	return { sha256: sha(text), ...(keys ? { keys } : {}) };
}

/** `key: old -> new` lines for the keys that differ between two security-key maps. */
function diffKeys(before: Record<string, unknown> | undefined, after: Record<string, unknown>): string[] {
	const lines: string[] = [];
	for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after)])) {
		const a = JSON.stringify(before?.[key]);
		const b = JSON.stringify(after[key]);
		if (a !== b) lines.push(`${key}: ${a ?? "unset"} -> ${b ?? "unset"}`);
	}
	return lines;
}

/** The security-relevant changes between two settings objects, as `key: old -> new` lines. */
export function diffSecurityKeys(before: unknown, after: unknown): string[] {
	return diffKeys(securityKeys(before), securityKeys(after));
}

/** The keys a chat command must confirm before it changes them. They are the keys of securityKeys(), the single source. */
export const SECURITY_KEYS: readonly string[] = Object.keys(securityKeys({}));

/** The security-relevant changes `change` would make to `current`, as `key: old -> new` lines. Every chat write path asks about a non-empty result. */
export function securityChanges(current: Settings, change: SettingsChange): string[] {
	return diffSecurityKeys(current, previewSettings(current, change));
}

/* --- the settings table ---------------------------------------------------------------------------------- */

export type SettingType = "enum" | "bool" | "int" | "ref" | "list";
/** When a changed value takes effect: the next turn, right away, the next Conclave run, the next start, or never (read nowhere yet). */
export type SettingApplies = "turn" | "now" | "run" | "start";

export interface SettingField {
	path: string;
	type: SettingType;
	/** enum: the allowed values. */
	values?: readonly string[];
	/** int: the inclusive range. */
	min?: number;
	max?: number;
	/** ref: the context rule the model must meet. */
	role?: "main" | "compactor";
	/** list: what one entry is. */
	entry?: "env" | "host" | "path";
	security: boolean;
	applies: SettingApplies;
}

const field = (path: string, type: SettingType, applies: SettingApplies, extra: Partial<SettingField> = {}): SettingField => ({
	path, type, applies, security: SECURITY_KEYS.includes(path) || /^conclave\.members\.[a-z]+\.model$/u.test(path), ...extra,
});

/** Every leaf key of settings.json (66). A test checks it against validateSettings, securityKeys and the defaults. */
export const SETTING_FIELDS: readonly SettingField[] = [
	field("main", "ref", "turn", { role: "main" }),
	field("thinking", "enum", "turn", { values: THINKING_LEVELS }),
	field("compactor.enabled", "bool", "now"),
	field("compactor.model", "ref", "now", { role: "compactor" }),
	field("compactor.thinking", "enum", "now", { values: THINKING_LEVELS }),
	field("compactor.maxConcurrent", "int", "now", { min: 1, max: 8 }),
	field("compactor.allowThirdParty", "bool", "now"),
	field("learning.model", "ref", "now", { role: "main" }),
	field("learning.thinking", "enum", "now", { values: THINKING_LEVELS }),
	field("learning.everyTurns", "int", "now", { min: 3, max: 100 }),
	field("learning.allowThirdParty", "bool", "now"),
	field("conclave.defaultModel", "ref", "run", { role: "main" }),
	field("conclave.maxTurns", "int", "run", { min: 1 }),
	field("conclave.idleTimeoutMs", "int", "run", { min: 1_000 }),
	field("conclave.reportMaxChars", "int", "run", { min: 1_000 }),
	...CONCLAVE_MEMBERS.flatMap((name) => [
		field(`conclave.members.${name}.model`, "ref", "run", { role: "main" }),
		field(`conclave.members.${name}.thinking`, "enum", "run", { values: THINKING_LEVELS }),
		field(`conclave.members.${name}.maxTurns`, "int", "run", { min: 1 }),
		field(`conclave.members.${name}.idleTimeoutMs`, "int", "run", { min: 1_000 }),
	]),
	field("gateTimeoutMs", "int", "turn", { min: 1 }),
	field("cacheRetention", "enum", "turn", { values: ["short", "long"] }),
	field("shellEnvAllow", "list", "now", { entry: "env" }),
	field("shellTimeoutMs", "int", "now", { min: 1_000 }),
	field("guard.deny", "list", "now", { entry: "path" }),
	field("guard.allow", "list", "now", { entry: "path" }),
	field("workspace.enabled", "bool", "run"),
	field("workspace.nested", "enum", "run", { values: ["ask", "copy", "inplace"] }),
	field("workspace.confine", "enum", "run", { values: ["auto", "none"] }),
	field("workspace.network", "bool", "run"),
	field("tui.thinkingSteps", "enum", "now", { values: THINKING_STEP_MODES }),
	field("planning", "bool", "start"),
	field("telemetry", "bool", "start"),
	field("web.enabled", "bool", "run"),
	field("web.maxFetches", "int", "now", { min: 1, max: 100 }),
	field("web.maxSearches", "int", "now", { min: 1, max: 100 }),
	field("web.search.provider", "enum", "run", { values: ["tinyfish", "exa"] }),
	field("web.allowHosts", "list", "now", { entry: "host" }),
	field("web.queryHosts", "list", "now", { entry: "host" }),
];

/** The default of a key, or undefined when it has none (the key then means "not set"). */
export function settingDefault(path: string): unknown {
	return path === "planning" ? true : getSetting(SETTINGS_DEFAULTS, path);
}

/** Record the current hash (and security-relevant keys) of the named files. Called after piroboros writes them. */
export function recordIntegrity(home: string, names: readonly IntegrityFile[] = FILES): void {
	const record = readIntegrity(home);
	for (const name of names) {
		const path = fileFor(home, name);
		if (!existsSync(path)) { delete record[name]; continue; }
		record[name] = recordOf(name, readFileSync(path, "utf8"));
	}
	writeJsonFile(homePaths(home).integrity, record);
}

export interface IntegrityChange {
	file: IntegrityFile;
	/** Security-relevant key changes (settings only), as `key: old -> new` lines. */
	lines: string[];
}

export interface IntegrityReport {
	/** True when a recorded file differs from its recorded hash. */
	tampered: boolean;
	changes: IntegrityChange[];
}

/**
 * Compare each config file with the hash recorded at piroboros's last write. A file with no record is
 * treated as unrecorded, not tampered: it is recorded by the caller after the first successful load.
 */
export function checkIntegrity(home: string): IntegrityReport {
	const record = readIntegrity(home);
	const changes: IntegrityChange[] = [];
	for (const name of FILES) {
		const entry = record[name];
		const path = fileFor(home, name);
		if (entry === undefined) continue;
		const present = existsSync(path);
		const text = present ? readFileSync(path, "utf8") : "";
		if (present && sha(text) === entry.sha256) continue;
		const lines: string[] = [];
		if (!present) lines.push("file was removed");
		else if (name === "settings") {
			let now: Record<string, unknown> = {};
			try { now = securityKeys(JSON.parse(text.replace(/^\u{FEFF}/u, ""))); } catch { lines.push("file no longer parses as JSON"); }
			lines.push(...diffKeys(entry.keys, now));
			if (lines.length === 0) lines.push("other keys changed");
		} else lines.push("content changed");
		changes.push({ file: name, lines });
	}
	return { tampered: changes.length > 0, changes };
}

/** The changes as text, one block per file. */
export function describeIntegrity(report: IntegrityReport): string {
	return report.changes.map((change) => `${change.file}:\n${change.lines.map((line) => `  ${line}`).join("\n")}`).join("\n");
}

/**
 * What /reload has to ask about: everything checkIntegrity reports, plus files that exist but were never recorded.
 * At startup an unrecorded file is recorded silently. A file that appears while piroboros runs was not written by
 * piroboros, so it needs the same confirmation as an edit.
 */
export function reloadChanges(home: string): IntegrityReport {
	const report = checkIntegrity(home);
	const record = readIntegrity(home);
	for (const name of FILES) {
		if (record[name] === undefined && existsSync(fileFor(home, name))) report.changes.push({ file: name, lines: ["file was added outside piroboros"] });
	}
	return { tampered: report.changes.length > 0, changes: report.changes };
}

/** Record files that exist but have no record yet (first run, or a hand-written settings.json). */
export function recordUnrecorded(home: string): void {
	const record = readIntegrity(home);
	const missing = FILES.filter((name) => record[name] === undefined && existsSync(fileFor(home, name)));
	if (missing.length > 0) recordIntegrity(home, missing);
}

/**
 * Warning text when the home lies outside the user profile, where other local accounts may be able to
 * read auth.json. piroboros only warns; it does not change permissions.
 */
export function homeOutsideProfileWarning(home: string, profile: string = homedir()): string | undefined {
	return isInside(canonicalize(profile), home) ? undefined : "The data directory is outside your user profile, so auth.json may be readable by other local users. Move it into your profile or restrict access yourself.";
}

/** The user profile directory. The only place besides the guard that asks the operating system for it. */
export function profileDir(): string {
	return homedir();
}

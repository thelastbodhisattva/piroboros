import { CONCLAVE_MEMBERS, SETTING_FIELDS, SettingsError, getSetting, previewSettings, securityChanges, settingDefault, settingPatch, type SettingApplies, type SettingField, type SettingsChange } from "../config.ts";
import { DEFAULT_MAX_TURNS } from "../conclave/pipeline.ts";
import type { Runtime } from "../runtime.ts";
import { hasSearchKey, isLoopbackHost, pickModel, resolveBaseHost, webKeyStep, type Option, type SetupIO } from "../setup.ts";
import { SEARCH_KEYS, type SearchProvider } from "../web.ts";

// /settings: browse the keys of settings.json, edit one by its type, and save through rt.updateSettings (the checked
// write). A change to a security-relevant key shows its old and new value and asks first. The same question guards /model.

export const SECURITY_CONFIRM = "Apply this change to security-relevant settings?";

const RESET = "__reset";
const ADD = "__add";

const APPLIES: Record<SettingApplies, string> = {
	turn: "applies at the next turn",
	now: "applies right away",
	run: "applies at the next Conclave run",
	start: "applies at the next start",
};

const FIELD_HELP: Record<string, string> = {
	cacheRetention: ' "short" keeps the prompt cache for about 5 minutes. "long" keeps it for an hour and costs more per cache write, so it pays off when you pause longer than 5 minutes between turns.',
};

const ENTRY_HELP = { env: "an environment variable name such as GIT_SSH_COMMAND", host: 'a lower case host name such as "docs.example.org"', path: "an absolute path" } as const;

const MEMBER = /^conclave\.members\.([a-z]+)$/u;

function show(value: unknown): string {
	if (value === undefined) return "not set";
	if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
	return typeof value === "string" ? value : JSON.stringify(value);
}

// conclave.maxTurns has no single default: the seat decides (pipeline.ts).
const MAX_TURNS = "conclave.maxTurns";
const SEAT_DEFAULT = `per-seat default (${DEFAULT_MAX_TURNS.other}; Vesperia ${DEFAULT_MAX_TURNS.vesperia})`;

/** The value a key has now, or its default marked as such, or "not set". */
function valueText(settings: unknown, path: string): string {
	const value = getSetting(settings, path);
	if (value !== undefined) return show(value);
	if (path === MAX_TURNS) return SEAT_DEFAULT;
	const fallback = settingDefault(path);
	if (fallback !== undefined) return `${show(fallback)} (default)`;
	return SETTING_FIELDS.find((f) => f.path === path)?.type === "list" ? "none (default)" : "not set";
}

const fieldOption = (rt: Runtime, f: SettingField, label = f.path): Option => ({ id: f.path, label: `${label}  ${valueText(rt.settings(), f.path)}${f.security ? "  [asks first]" : ""}` });

function keyOptions(rt: Runtime): Option[] {
	const out: Option[] = [];
	const seen = new Set<string>();
	for (const f of SETTING_FIELDS) {
		const member = /^conclave\.members\.([a-z]+)\./u.exec(f.path)?.[1];
		if (member === undefined) out.push(fieldOption(rt, f));
		else if (!seen.has(member)) {
			seen.add(member);
			out.push({ id: `conclave.members.${member}`, label: `conclave.members.${member}  model ${valueText(rt.settings(), `conclave.members.${member}.model`)}, then limits` });
		}
	}
	return out;
}

const memberFields = (name: string): SettingField[] => SETTING_FIELDS.filter((f) => f.path.startsWith(`conclave.members.${name}.`));

async function memberField(rt: Runtime, io: SetupIO, name: string): Promise<SettingField> {
	const fields = memberFields(name);
	const picked = await io.choose(`conclave.members.${name}`, fields.map((f) => fieldOption(rt, f, f.path.slice(`conclave.members.${name}.`.length))));
	return fields.find((f) => f.path === picked)!;
}

/** A hint for a key that does not exist: the keys that contain the text, or a pointer to the list. */
function unknownKey(arg: string): string {
	const near = SETTING_FIELDS.map((f) => f.path).filter((path) => path.toLowerCase().includes(arg.toLowerCase())).slice(0, 5);
	return `unknown setting ${arg}; ${near.length === 0 ? "use /settings to browse the keys" : `did you mean ${near.join(", ")}?`}`;
}

/** One question at a time; returns the reply text for the chat. Esc anywhere cancels with SetupCancelled. */
export async function runSettings(rt: Runtime, io: SetupIO, signal: AbortSignal, arg: string): Promise<string> {
	if (rt.settings().main !== rt.stored().main) io.notify("info", `This run uses ${rt.settings().main ?? "no main model"} from --model. settings.json holds ${rt.stored().main ?? "no main model"}; a change to main is saved there and applies when piroboros starts without --model.`);
	let f: SettingField | undefined;
	if (arg === "") {
		const picked = await io.choose("Settings (type to filter)", keyOptions(rt));
		const member = MEMBER.exec(picked)?.[1];
		f = member === undefined ? SETTING_FIELDS.find((candidate) => candidate.path === picked) : await memberField(rt, io, member);
	} else {
		const member = MEMBER.exec(arg)?.[1];
		f = member !== undefined && (CONCLAVE_MEMBERS as readonly string[]).includes(member) ? await memberField(rt, io, member) : SETTING_FIELDS.find((candidate) => candidate.path === arg);
		if (f === undefined) return unknownKey(arg);
	}
	return editField(rt, io, signal, f!);
}

/** Why the change would be refused (the text names the key and the allowed range), or undefined when it is valid. */
function problemWith(rt: Runtime, change: SettingsChange): string | undefined {
	try {
		previewSettings(rt.stored(), change);
		return undefined;
	} catch (error) {
		if (!(error instanceof SettingsError)) throw error;
		return error.issues.join("\n");
	}
}

async function editField(rt: Runtime, io: SetupIO, signal: AbortSignal, f: SettingField): Promise<string> {
	const stored = getSetting(rt.stored(), f.path);
	const fallback = f.path === MAX_TURNS ? undefined : settingDefault(f.path);
	const resetLabel = `Reset to default (${f.path === MAX_TURNS ? SEAT_DEFAULT : fallback === undefined ? (f.type === "list" ? "none" : "not set") : show(fallback)})`;
	io.notify("info", `${f.path}: now ${valueText(rt.settings(), f.path)}. The value ${APPLIES[f.applies]}.${FIELD_HELP[f.path] ?? ""}${f.security ? " It is security-relevant, so saving asks first." : ""}`);
	const unset: SettingsChange = { unset: f.path };
	const setTo = (value: unknown): SettingsChange => ({ set: settingPatch(f.path, value) });

	if (f.type === "enum" || f.type === "bool") {
		const values = f.type === "bool" ? ["true", "false"] : [...(f.values ?? [])];
		const current = stored === undefined ? undefined : String(stored);
		const picked = await io.choose(`Set ${f.path}`, [...values.map((value) => ({ id: value, label: value === current ? `${value} (current)` : value })), { id: RESET, label: resetLabel }], current ?? (fallback === undefined ? undefined : String(fallback)));
		if (picked === RESET) return commit(rt, io, f, unset);
		const value = f.type === "bool" ? picked === "true" : picked;
		if (f.path === "web.search.provider" && !hasSearchKey(rt.setupEnv(), picked as SearchProvider)) {
			const label = SEARCH_KEYS[picked as SearchProvider].label;
			if (await io.confirm(`No ${label} key is stored or set in ${SEARCH_KEYS[picked as SearchProvider].env}. Enter one now?`, true)) await webKeyStep(rt.setupEnv(), io, picked as SearchProvider, signal);
			else io.notify("warn", `Search stays unavailable until a ${label} key is stored (/login web-${picked}).`);
		}
		return commit(rt, io, f, setTo(value));
	}

	if (f.type === "int") {
		for (;;) {
			const answer = (await io.text(`${f.path}: a whole number${f.min === undefined ? "" : ` from ${f.min}`}${f.max === undefined ? "" : ` to ${f.max}`}, or "default" to reset`, signal, undefined, stored === undefined ? (fallback === undefined ? "" : String(fallback)) : String(stored))).trim();
			if (answer === "") return `${f.path} not changed`;
			if (answer.toLowerCase() === "default") return commit(rt, io, f, unset);
			const change = setTo(/^-?\d+$/u.test(answer) ? Number(answer) : answer);
			const problem = problemWith(rt, change);
			if (problem === undefined) return commit(rt, io, f, change);
			io.notify("error", problem);
		}
	}

	if (f.type === "ref") {
		const picked = await pickModel(rt.setupEnv(), io, f.role ?? "main", `Model for ${f.path}`, typeof stored === "string" ? stored : undefined, true, signal, resetLabel);
		if (picked === "keep") return `${f.path} not changed`;
		if (picked === "skip") return commit(rt, io, f, unset);
		let change = setTo(picked);
		if (f.path === "compactor.model") {
			const host = resolveBaseHost(rt.models, picked);
			if (host !== undefined && !isLoopbackHost(host)) {
				if (!(await io.confirm(`The compactor will send chat text to ${host}. Allow it?`, false))) return `${f.path} not changed`;
				change = { set: { compactor: { model: picked, allowThirdParty: true } } };
			}
		}
		return commit(rt, io, f, change);
	}

	// list: entries are removed by picking them, so commas and spaces in paths are safe.
	const current = Array.isArray(stored) ? (stored as string[]) : [];
	const picked = await io.choose(`${f.path} (${current.length} ${current.length === 1 ? "entry" : "entries"}); pick one to remove it`, [
		...current.map((entry, i) => ({ id: `rm:${i}`, label: `Remove ${entry}` })),
		{ id: ADD, label: "Add an entry" },
		{ id: RESET, label: resetLabel },
	]);
	if (picked === RESET) return commit(rt, io, f, unset);
	if (picked.startsWith("rm:")) {
		const rest = current.filter((_, i) => `rm:${i}` !== picked);
		return commit(rt, io, f, rest.length === 0 ? unset : setTo(rest));
	}
	for (;;) {
		const entry = (await io.text(`New entry for ${f.path}: ${ENTRY_HELP[f.entry ?? "env"]}`, signal)).trim();
		if (entry === "") return `${f.path} not changed`;
		const change = setTo([...current, entry]);
		const problem = problemWith(rt, change);
		if (problem === undefined) return commit(rt, io, f, change);
		io.notify("error", problem);
	}
}

/** Confirm a security-relevant change, then write it through the checked write. */
async function commit(rt: Runtime, io: SetupIO, f: SettingField, change: SettingsChange): Promise<string> {
	let lines: string[];
	try {
		lines = securityChanges(rt.stored(), change);
	} catch (error) {
		if (error instanceof SettingsError) return `${f.path} not saved: ${error.issues.join("; ")}`;
		throw error;
	}
	if (lines.length > 0) {
		io.notify("warn", lines.join("\n"));
		if (!(await io.confirm(SECURITY_CONFIRM, false))) return `${f.path} not changed`;
	}
	const result = rt.updateSettings(change);
	if (!result.ok) return `${f.path} not saved: ${result.error}`;
	const what = "unset" in change ? "reset to default" : `set to ${show(getSetting(change.set, f.path))}`;
	return `${f.path} ${what}; the value ${APPLIES[f.applies]}${result.note === undefined ? "" : `. Note: ${result.note}`}`;
}

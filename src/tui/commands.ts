// The slash commands: the single table, the parser, the "did you mean" check and the suggestion list for the
// picker above the input. All pure; the Ink layer and runCommand call them.

import { CONCLAVE_MEMBERS, SETTING_FIELDS } from "../config.ts";

export interface CommandInfo {
	name: string;
	description: string;
	/** Argument hint. A command without one runs as soon as it is chosen. */
	args?: string;
}

export const COMMANDS: readonly CommandInfo[] = [
	{ name: "model", description: "show or set the main model", args: "[provider/model]" },
	{ name: "reload", description: "reload settings.json and models.json" },
	{ name: "login", description: "sign in to a provider", args: "[provider]" },
	{ name: "settings", description: "show or change a setting", args: "[key]" },
	{ name: "status", description: "show the chat and compactor status" },
	{ name: "conclave", description: "run the review pipeline on a task", args: "<task> | approve | cancel | status | undo | merge | discard | retry" },
	{ name: "akashic", description: "memory status, accept and vault", args: "[status | accept | vault ...]" },
	{ name: "thinking-steps", description: "choose how thinking steps are shown", args: "[mode | global <mode | clear>]" },
	{ name: "skills", description: "list the skills the chat can use" },
	{ name: "learn", description: "the learning loop: status, proposals, undo", args: "[now | accept <name> | reject <name|all> | undo <name> | retry | skip]" },
	{ name: "telemetry", description: "model requests, latency and cost of the last 24 hours" },
];

/** A loaded skill, as the command table sees it. */
export interface SkillCommand {
	name: string;
	description: string;
}

/** The skills that are commands: a name that starts with a letter, and no built-in command of the same name (that one wins). */
const commandSkills = (skills: readonly SkillCommand[]): SkillCommand[] => skills.filter((skill) => /^[a-z]/u.test(skill.name) && !COMMANDS.some((command) => command.name === skill.name));

export interface ParsedSlash {
	name: string;
	rest: string;
}

/**
 * A message is a command when it is a slash followed by lowercase letters or hyphens and then the end of the text
 * or whitespace: "/model", "/model x/y". A name with a digit counts only when it is a loaded skill ("/v2" and
 * "/42 is the answer" are chat). Anything else that starts with a slash, such as "/srv/data/file", "/ " or
 * "/Model", is chat. The name may be one that does not exist (a typo).
 */
export function parseSlash(text: string, skills: readonly SkillCommand[] = []): ParsedSlash | undefined {
	const match = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/u.exec(text);
	if (match === null) return undefined;
	if (/[0-9]/u.test(match[1]!) && !commandSkills(skills).some((skill) => skill.name === match[1])) return undefined;
	return { name: match[1]!, rest: match[2] ?? "" };
}

function distance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
		row = next;
	}
	return row[b.length]!;
}

/**
 * The message for a command name that does not exist, with the closest known name when one is near. Loaded skills are
 * commands; a name in `declined` (a project skill the user said no to) gets its own reply.
 */
export function unknownCommand(text: string, skills: readonly SkillCommand[] = [], declined: readonly string[] = []): string | undefined {
	const name = parseSlash(text, skills)?.name;
	if (name === undefined) return undefined;
	const known = [...COMMANDS.map((command) => command.name), ...commandSkills(skills).map((skill) => skill.name)];
	if (known.includes(name)) return undefined;
	if (declined.includes(name)) return "project skill declined; /reload asks again after it changes";
	const near = known.map((candidate) => ({ known: candidate, d: distance(name, candidate) })).sort((a, b) => a.d - b.d)[0]!;
	return `unknown command /${name}${near.d <= 2 && near.d < name.length ? `; did you mean /${near.known}?` : ""}`;
}

export interface PickEntry {
	/** The whole input after this entry is completed. */
	complete: string;
	label: string;
	detail?: string;
	/** Shown with its reason and never completed. */
	disabled?: string;
	/** An argument hint with nothing to complete. */
	hint?: true;
	/** The entry takes arguments (a skill): Enter completes it instead of running it. */
	args?: true;
}

export interface ModelOption {
	ref: string;
	disabled?: string;
}

/** A provider /login can sign in to: its id and its display name. */
export interface LoginOption {
	id: string;
	name: string;
}

const WEB_LOGINS: readonly LoginOption[] = [{ id: "web-tinyfish", name: "TinyFish web search key" }, { id: "web-exa", name: "Exa web search key" }];

const MODES = ["collapsed", "summary", "expanded"] as const;
const VAULT = ["status", "init", "sync", "commit", "push", "import", "accept"] as const;

/** Prefix-matching choices for the last word of the input; `more` names the choices that open another level. */
function words(lead: string, typed: string, choices: readonly string[], more: readonly string[] = []): PickEntry[] {
	const needle = typed.toLowerCase();
	return choices.filter((choice) => choice.startsWith(needle)).map((choice) => ({ complete: `${lead}${choice}${more.includes(choice) ? " " : ""}`, label: choice }));
}

/**
 * The suggestions for the current input, a pure function of the text. The first word is matched by prefix. Models
 * are matched by substring. `models` is the list the caller got from the model registry.
 */
export function suggest(value: string, models: readonly ModelOption[] = [], logins: readonly LoginOption[] = [], skills: readonly SkillCommand[] = []): PickEntry[] {
	if (!value.startsWith("/")) return [];
	if (!/\s/u.test(value)) {
		const prefix = value.slice(1);
		if (!/^[a-z0-9-]*$/u.test(prefix)) return [];
		const commands = COMMANDS.filter((command) => command.name.startsWith(prefix)).map((command) => ({ complete: `/${command.name} `, label: `/${command.name}`, detail: `${command.description}${command.args === undefined ? "" : `  ${command.args}`}` }));
		// Skills follow the built-ins, each with its description and a request hint.
		return [...commands, ...commandSkills(skills).filter((skill) => skill.name.startsWith(prefix)).map((skill): PickEntry => ({ complete: `/${skill.name} `, label: `/${skill.name}`, detail: `${skill.description}  [request]`, args: true }))];
	}
	const match = /^\/([a-z-]+)\s+([\s\S]*)$/u.exec(value);
	if (match === null) return [];
	const name = match[1]!;
	const arg = match[2]!;
	const tokens = arg.split(/\s+/u);
	const lead = `/${name} ${tokens.slice(0, -1).join(" ")}${tokens.length > 1 ? " " : ""}`;
	const last = tokens[tokens.length - 1]!;
	if (name === "model") {
		if (tokens.length > 1) return [];
		const needle = arg.toLowerCase();
		return models.filter((model) => model.ref.toLowerCase().includes(needle)).map((model) => ({ complete: `/model ${model.ref}`, label: model.ref, ...(model.disabled === undefined ? {} : { disabled: model.disabled }) }));
	}
	if (name === "conclave") return tokens.length > 1 ? [] : words(lead, last, ["approve", "cancel", "status", "undo", "merge", "discard", "retry"]);
	if (name === "thinking-steps") {
		if (tokens.length === 1) return words(lead, last, [...MODES, "global"], ["global"]);
		return tokens.length === 2 && tokens[0] === "global" ? words(lead, last, [...MODES, "clear"]) : [];
	}
	if (name === "learn") return tokens.length > 1 ? [] : words(lead, last, ["now", "accept", "reject", "undo", "retry", "skip"]);
	if (name === "akashic") {
		if (tokens.length === 1) return words(lead, last, ["status", "accept", "vault"], ["vault"]);
		return tokens.length === 2 && tokens[0] === "vault" ? words(lead, last, VAULT) : [];
	}
	if (tokens.length > 1) return [];
	const needle = arg.toLowerCase();
	// Providers and keys are matched by substring, like models.
	if (name === "login") return [...logins, ...WEB_LOGINS].filter((login) => login.id.toLowerCase().includes(needle) || login.name.toLowerCase().includes(needle)).map((login) => ({ complete: `/login ${login.id}`, label: login.id, detail: login.name }));
	if (name === "settings") {
		// Member keys are listed only once the text names a member and goes on past its dot.
		const deep = /^conclave\.members\.[a-z]+\./u.test(needle);
		const keys = deep ? SETTING_FIELDS : SETTING_FIELDS.filter((f) => !f.path.startsWith("conclave.members."));
		const members = deep ? [] : CONCLAVE_MEMBERS.map((member) => ({ path: `conclave.members.${member}`, detail: "model and limits of this member" }));
		return [...keys.map((f) => ({ path: f.path, detail: `${f.type}${f.security ? ", asks first" : ""}` })), ...members].filter((key) => key.path.toLowerCase().includes(needle)).map((key) => ({ complete: `/settings ${key.path}`, label: key.path, detail: key.detail }));
	}
	return [];
}

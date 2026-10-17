import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONCLAVE_MEMBERS, THINKING_LEVELS } from "../config.ts";

// Loads the Conclave definitions that ship in the repository: agents/<name>.md and skills/conclave/SKILL.md.
// Everything is validated before any member starts, and every failure is a named ConclaveDefError.
//
// Frontmatter keys: name, display_name, description, thinking, tools. A `model:` key is rejected, because the
// model is a provider and cost choice that belongs to the user's settings, while reasoning depth is a property of
// the role. Only vesperia may list write, edit, bash, akashic_memory or mnemosia_submit_feedback; the reviewers
// may read memory through mnemosia_brief.

export const KNOWN_TOOLS = ["read", "write", "edit", "bash", "find", "grep", "zoom", "date", "plan", "akashic_memory", "mnemosia_brief", "mnemosia_submit_feedback"] as const;
export const WRITER_TOOLS = ["write", "edit", "bash", "akashic_memory", "mnemosia_submit_feedback"] as const;
const KEYS = ["name", "display_name", "description", "thinking", "tools"] as const;
const SKILL_KEYS = ["name", "description"] as const;

export type DefErrorCode = "missing_file" | "bad_frontmatter" | "unknown_key" | "model_key" | "bad_value" | "unknown_tool" | "reviewer_writes" | "missing_skill";

export class ConclaveDefError extends Error {
	readonly code: DefErrorCode;
	readonly file: string;
	constructor(code: DefErrorCode, file: string, message: string) {
		super(`${file}: ${message}`);
		this.code = code;
		this.file = file;
	}
}

export interface AgentDef {
	/** Lowercase seat name, the file name without `.md`. */
	name: string;
	/** Name shown in reports and used by zoom("Name"). */
	displayName: string;
	description: string;
	/** Reasoning depth for the role; settings.conclave.members.<name>.thinking overrides it. */
	thinking?: string;
	tools: string[];
	/** The agent file after its frontmatter. */
	body: string;
	file: string;
}

export interface Definitions {
	agents: Map<string, AgentDef>;
	/** The conclave skill, without its frontmatter. */
	skill: string;
}

/** The repository root, where agents/ and skills/ live. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function split(text: string, file: string): { meta: Map<string, string>; body: string } {
	const lines = text.replace(/^\u{FEFF}/u, "").replace(/\r\n?/gu, "\n").split("\n");
	if (lines[0]?.trim() !== "---") throw new ConclaveDefError("bad_frontmatter", file, "the file must start with a --- frontmatter block");
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) throw new ConclaveDefError("bad_frontmatter", file, "the frontmatter block is not closed with ---");
	const meta = new Map<string, string>();
	for (const [offset, line] of lines.slice(1, end).entries()) {
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) throw new ConclaveDefError("bad_frontmatter", file, `frontmatter line ${offset + 2} is not "key: value"`);
		const key = line.slice(0, colon).trim();
		if (meta.has(key)) throw new ConclaveDefError("bad_frontmatter", file, `the key ${key} appears twice`);
		meta.set(key, line.slice(colon + 1).trim().replace(/^(["'])(.*)\1$/u, "$2"));
	}
	return { meta, body: lines.slice(end + 1).join("\n").trim() };
}

function checkKeys(meta: Map<string, string>, allowed: readonly string[], file: string): void {
	for (const key of meta.keys()) {
		if (key === "model") throw new ConclaveDefError("model_key", file, "the model: key is not allowed; set the model in settings.json (conclave.defaultModel or conclave.members.<name>.model)");
		if (!allowed.includes(key)) throw new ConclaveDefError("unknown_key", file, `unknown frontmatter key ${key}; allowed keys are ${allowed.join(", ")}`);
	}
}

export function parseAgent(text: string, file: string): AgentDef {
	const { meta, body } = split(text, file);
	checkKeys(meta, KEYS, file);
	const name = basename(file).replace(/\.md$/iu, "");
	const need = (key: string): string => {
		const value = meta.get(key);
		if (value === undefined || value === "") throw new ConclaveDefError("bad_value", file, `the ${key}: key is required`);
		return value;
	};
	if (need("name") !== name) throw new ConclaveDefError("bad_value", file, `name: ${meta.get("name")} does not match the file name ${name}`);
	if (!(CONCLAVE_MEMBERS as readonly string[]).includes(name)) throw new ConclaveDefError("bad_value", file, `${name} is not a Conclave seat (${CONCLAVE_MEMBERS.join(", ")})`);
	const thinking = meta.get("thinking");
	if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new ConclaveDefError("bad_value", file, `thinking: must be one of ${THINKING_LEVELS.join(", ")}`);
	const tools = need("tools").replace(/^\[(.*)\]$/u, "$1").split(",").map((tool) => tool.trim()).filter((tool) => tool !== "");
	for (const tool of tools) if (!(KNOWN_TOOLS as readonly string[]).includes(tool)) throw new ConclaveDefError("unknown_tool", file, `unknown tool ${tool}; known tools are ${KNOWN_TOOLS.join(", ")}`);
	if (name !== "vesperia") for (const tool of tools) if ((WRITER_TOOLS as readonly string[]).includes(tool)) throw new ConclaveDefError("reviewer_writes", file, `${name} is read-only and may not list ${tool}`);
	if (body === "") throw new ConclaveDefError("bad_value", file, "the file has no instructions after the frontmatter");
	return { name, displayName: need("display_name"), description: need("description"), ...(thinking === undefined ? {} : { thinking }), tools, body, file };
}

/** All eight agents and the skill. Throws ConclaveDefError for the first problem found. */
export function loadDefinitions(root = REPO_ROOT): Definitions {
	const skillFile = join(root, "skills", "conclave", "SKILL.md");
	if (!existsSync(skillFile)) throw new ConclaveDefError("missing_skill", "skills/conclave/SKILL.md", "the conclave skill is missing");
	const skillParts = split(readFileSync(skillFile, "utf8"), "skills/conclave/SKILL.md");
	checkKeys(skillParts.meta, SKILL_KEYS, "skills/conclave/SKILL.md");
	if (skillParts.body === "") throw new ConclaveDefError("missing_skill", "skills/conclave/SKILL.md", "the conclave skill is empty");
	const agents = new Map<string, AgentDef>();
	for (const name of CONCLAVE_MEMBERS) {
		const file = join(root, "agents", `${name}.md`);
		const label = `agents/${name}.md`;
		if (!existsSync(file)) throw new ConclaveDefError("missing_file", label, "the agent file is missing");
		agents.set(name, parseAgent(readFileSync(file, "utf8"), label));
	}
	return { agents, skill: skillParts.body };
}

/** The instructions a member runs with: its own text, then the shared skill. */
export const instructionsFor = (agent: AgentDef, skill: string): string => `${agent.body}\n\n${skill}`;

/** Find a seat by its name or the first word of its display name, ignoring case. */
export function findAgent(agents: ReadonlyMap<string, AgentDef>, query: string): AgentDef | undefined {	const key = query.trim().toLowerCase();
	for (const agent of agents.values()) if (agent.name === key || agent.displayName.split(/\s+/u)[0]!.toLowerCase() === key) return agent;
	return undefined;
}

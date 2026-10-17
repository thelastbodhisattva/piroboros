import { createProvider, envApiKeyAuth, InMemoryCredentialStore, StringEnum } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { AuthEvent, AuthInteraction, AuthOperationOptions, AuthPrompt, AuthType, Credential, CredentialInfo, CredentialStore, LoginOptions, Model, ModelThinkingLevel, Models, MutableModels, Provider, AssistantMessage, Api, Message, ToolResultMessage, UserMessage, TextContent, ImageContent } from "@earendil-works/pi-ai";
import { ConfigError, homePaths, isModelRef, readJsonFile, splitModelRef } from "./config.ts";

// The only module that imports pi-ai at runtime. Everything else reaches providers, credentials and
// model catalogs through this file, so a pi-ai version bump is one edit plus the contract tests.

export type { AuthEvent, AuthInteraction, AuthOperationOptions, AuthPrompt, AuthType, AssistantMessage, Credential, CredentialInfo, CredentialStore, LoginOptions, Model, ModelThinkingLevel, Models, MutableModels, Provider };
export type { Message, ToolResultMessage, UserMessage, TextContent, ImageContent };
export type AnyModel = Model<Api>;
/** A string enum schema without anyOf, which every provider accepts. Re-exported for the memory tools (D18 seam). */
export { StringEnum };
/** Estimated tokens of one message, including a system message's tool declarations. */
export const estimateTokens = (message: Message): number => estimateMessageTokens(message);

/* --- cache marks (D21) --------------------------------------------------------------------------------------- */

type Block = { type?: string; text?: string; cache_control?: unknown };

/**
 * Rearrange the cache marks of an Anthropic Messages payload. pi-ai marks the identity block, the system text, the
 * last tool and the last user block. Marks go on the system text (which covers the tools, since tools come first),
 * the last full view block, and the last user block: three of the four allowed. The block that holds the closing
 * `</chat>` stays unmarked, because it changes whenever a line is appended. Does nothing when no mark is present
 * (cache retention off).
 */
export function markCache(payload: unknown): void {
	const p = payload as { system?: unknown; tools?: unknown; messages?: Array<{ role?: string; content?: unknown }> } | null;
	if (p === null || typeof p !== "object") return;
	const system = Array.isArray(p.system) ? (p.system as Block[]) : [];
	const template = [...system].reverse().find((block) => block.cache_control !== undefined)?.cache_control;
	if (template === undefined) return;
	system.slice(0, -1).forEach((block) => { delete block.cache_control; });
	if (Array.isArray(p.tools)) for (const tool of p.tools as Block[]) delete tool.cache_control;
	const content = p.messages?.[0]?.content;
	if (!Array.isArray(content)) return;
	const tail = (content as Block[]).findIndex((block) => block.type === "text" && typeof block.text === "string" && block.text.endsWith("</chat>"));
	if (tail > 0) (content as Block[])[tail - 1]!.cache_control = template;
}

/** Wrap a provider so its Anthropic Messages requests go through markCache. Other providers are returned as they are. */
function withCacheMarks(provider: Provider): Provider {
	if (!provider.getModels().some((model) => model.api === "anthropic-messages")) return provider;
	const wrap = <O extends { onPayload?: (payload: unknown, model: never) => unknown } | undefined>(options: O): O => ({
		...options,
		onPayload: async (payload: unknown, model: { api?: string }) => {
			const replaced = await options?.onPayload?.(payload, model as never);
			const next = replaced ?? payload;
			if (model.api === "anthropic-messages") markCache(next);
			return next;
		},
	}) as O;
	return { ...provider, stream: (model, context, options) => provider.stream(model, context, wrap(options) as never), streamSimple: (model, context, options) => provider.streamSimple(model, context, wrap(options) as never) } as Provider;
}

/**
 * Every environment variable a built-in provider's API-key auth looks up. pi-ai does not export its env-key
 * table, so each provider's own `auth.apiKey.resolve` runs once against a recording context.
 */
async function builtinEnvNames(): Promise<ReadonlySet<string>> {
	const names = new Set<string>();
	const noop: unknown = new Proxy(() => undefined, { get: (_t, key) => (key === "env" ? async (name: string) => { names.add(name); return undefined; } : async () => undefined) });
	for (const provider of builtinModels({ credentials: new InMemoryCredentialStore() }).getProviders()) {
		await (provider as Provider).auth.apiKey?.resolve({ ctx: noop, credential: undefined, signal: new AbortController().signal } as never).catch(() => undefined);
	}
	return names;
}
const BUILTIN_ENV_NAMES = await builtinEnvNames();

/** All built-in providers, with credentials resolved through the given store. */
export function createAppModels(credentials: CredentialStore, extra: readonly Provider[] = []): MutableModels {
	const models = builtinModels({ credentials });
	for (const provider of models.getProviders()) models.setProvider(withCacheMarks(provider));
	for (const provider of extra) models.setProvider(provider);
	return models;
}

/** `<ID>_API_KEY` with every character outside A-Z and 0-9 replaced by an underscore. Provider ids never contain `/`. */
export function apiKeyEnvName(providerId: string): string {
	return `${providerId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}_API_KEY`;
}

/* --- context rule (D24) -------------------------------------------------------------------------------- */

export const MAIN_MIN_TURN_TOKENS = 72_000;
export const COMPACTOR_MIN_TOKENS = 24_000;
const SYSTEM_RESERVE = 2_000;

export type ModelRole = "main" | "compactor";

export interface ContextCheck {
	ok: boolean;
	reason?: string;
}

/**
 * Main and member models need contextWindow - maxTokens - 2,000 >= 72,000. The compactor needs
 * contextWindow - maxTokens >= 24,000. A model that fails is listed as disabled, with the reason.
 */
export function contextCheck(model: { contextWindow: number; maxTokens: number }, role: ModelRole): ContextCheck {
	if (role === "compactor") {
		const room = model.contextWindow - model.maxTokens;
		return room >= COMPACTOR_MIN_TOKENS ? { ok: true } : { ok: false, reason: `context window ${model.contextWindow} minus max output ${model.maxTokens} leaves ${room} tokens; the compactor needs at least ${COMPACTOR_MIN_TOKENS}` };
	}
	const room = model.contextWindow - model.maxTokens - SYSTEM_RESERVE;
	return room >= MAIN_MIN_TURN_TOKENS ? { ok: true } : { ok: false, reason: `context window ${model.contextWindow} minus max output ${model.maxTokens} minus ${SYSTEM_RESERVE} leaves ${room} tokens; at least ${MAIN_MIN_TURN_TOKENS} are required` };
}

/* --- custom providers (models.json) --------------------------------------------------------------------- */

export const CUSTOM_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

export interface ModelsIssue {
	path: string;
	code: "shape" | "unknown_key" | "provider_id" | "provider_reserved" | "env_name_clash" | "model_field" | "base_url" | "base_url_anthropic_v1" | "base_url_openai_v1" | "context_too_small";
	message: string;
}

export class ModelsFileError extends ConfigError {
	readonly issues: ModelsIssue[];
	constructor(issues: ModelsIssue[]) {
		super("models_invalid", `models.json is invalid:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n")}`);
		this.issues = issues;
	}
}

export interface CustomModel {
	id: string;
	name: string;
	api: (typeof CUSTOM_APIS)[number];
	baseUrl: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Passed to pi-ai unchanged: how the wire format sends reasoning and other provider quirks. */
	compat?: Record<string, unknown>;
	/** Provider value per piroboros thinking level; `null` marks a level the model does not accept. */
	thinkingLevelMap?: Partial<Record<(typeof THINKING_MAP_LEVELS)[number], string | null>>;
}

const THINKING_MAP_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface CustomProviderDef {
	name: string;
	models: CustomModel[];
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Why a base URL breaks the convention for its API, or undefined when it is fine. `warn` problems do not stop the
 * file from loading: an OpenAI-style server may use another path, for example Gemini's /v1beta/openai.
 */
function baseUrlProblem(api: CustomModel["api"], raw: string): { code: ModelsIssue["code"]; message: string; warn?: true } | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { code: "base_url", message: `${JSON.stringify(raw)} is not a valid URL` };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return { code: "base_url", message: "must start with https:// or http://" };
	if (url.username !== "" || url.password !== "") return { code: "base_url", message: "must not contain a user name or password; use the API key instead" };
	const path = url.pathname.replace(/\/+$/u, "");
	if (api === "anthropic-messages" && path.endsWith("/v1")) return { code: "base_url_anthropic_v1", message: `anthropic-messages needs the host root, because the client adds /v1/messages itself; remove the trailing /v1 (use ${url.origin}${path.slice(0, -3)})` };
	if (api !== "anthropic-messages" && !path.endsWith("/v1")) return { code: "base_url_openai_v1", warn: true, message: `${api} base URLs usually end in /v1, for example ${url.origin}/v1; check that the server expects this path` };
	return undefined;
}

/**
 * Validate models.json: `{ "providers": { "<id>": { "name"?, "models": [ ... ] } } }`. Every problem is
 * collected and names its path. `reserved` holds ids that custom providers may not take (the built-in ones).
 * Problems that do not stop the load are appended to `warnings` when given.
 */
export function validateModelsFile(value: unknown, reserved: ReadonlySet<string> = new Set(), warnings?: ModelsIssue[]): Record<string, CustomProviderDef> {
	const issues: ModelsIssue[] = [];
	const add = (path: string, code: ModelsIssue["code"], message: string): void => { issues.push({ path, code, message }); };
	const unknown = (obj: Obj, allowed: readonly string[], path: string): void => {
		for (const key of Object.keys(obj)) if (!allowed.includes(key)) add(`${path}.${key}`, "unknown_key", "unknown key");
	};
	if (!isObj(value)) throw new ModelsFileError([{ path: "(file)", code: "shape", message: "must hold a JSON object" }]);
	for (const key of Object.keys(value)) if (key !== "providers") add(key, "unknown_key", "unknown key");
	if (!isObj(value.providers)) add("providers", "shape", 'must be an object keyed by provider id, for example {"providers":{"my-llm":{"models":[...]}}}');
	const out: Record<string, CustomProviderDef> = {};
	const envNames = new Map<string, string>();
	// Ids compare case-insensitively, and a custom id may not read a built-in provider's key variable either.
	const reservedLower = new Set([...reserved].map((r) => r.toLowerCase()));
	const reservedEnv = new Set([...reserved].map(apiKeyEnvName).concat([...BUILTIN_ENV_NAMES]));
	for (const [id, provider] of Object.entries(isObj(value.providers) ? value.providers : {})) {
		const at = `providers.${id}`;
		if (id === "" || id.includes("/")) { add(at, "provider_id", 'a provider id must not be empty or contain "/"'); continue; }
		const env = apiKeyEnvName(id);
		if (reservedLower.has(id.toLowerCase()) || reservedEnv.has(env)) { add(at, "provider_reserved", "this id belongs to a built-in provider or reads its key variable; choose another"); continue; }
		const clash = envNames.get(env);
		if (clash !== undefined) { add(at, "env_name_clash", `${clash} and ${id} would both read ${env}; rename one`); continue; }
		envNames.set(env, id);
		if (!isObj(provider)) { add(at, "shape", "must be an object"); continue; }
		unknown(provider, ["name", "models"], at);
		if (provider.name !== undefined && (typeof provider.name !== "string" || provider.name === "")) add(`${at}.name`, "model_field", "must be a non-empty string");
		if (!Array.isArray(provider.models) || provider.models.length === 0) { add(`${at}.models`, "shape", "must be a non-empty array"); continue; }
		const models: CustomModel[] = [];
		const seen = new Set<string>();
		provider.models.forEach((raw: unknown, index) => {
			const m = `${at}.models[${index}]`;
			if (!isObj(raw)) { add(m, "shape", "must be an object"); return; }
			unknown(raw, ["id", "name", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens", "compat", "thinkingLevelMap"], m);
			let ok = true;
			const bad = (field: string, message: string): void => { add(`${m}.${field}`, "model_field", message); ok = false; };
			if (typeof raw.id !== "string" || raw.id === "") bad("id", "is required and must be a non-empty string");
			else if (seen.has(raw.id)) bad("id", `duplicate model id ${raw.id}`);
			else seen.add(raw.id);
			if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name === "")) bad("name", "must be a non-empty string");
			if (!(CUSTOM_APIS as readonly unknown[]).includes(raw.api)) bad("api", `is required and must be one of ${CUSTOM_APIS.join(", ")}`);
			if (typeof raw.baseUrl !== "string") bad("baseUrl", "is required and must be a string");
			else if ((CUSTOM_APIS as readonly unknown[]).includes(raw.api)) {
				const problem = baseUrlProblem(raw.api as CustomModel["api"], raw.baseUrl);
				if (problem?.warn) warnings?.push({ path: `${m}.baseUrl`, code: problem.code, message: problem.message });
				else if (problem !== undefined) { add(`${m}.baseUrl`, problem.code, problem.message); ok = false; }
			}
			if (raw.reasoning !== undefined && typeof raw.reasoning !== "boolean") bad("reasoning", "must be true or false");
			// ponytail: compat keys are not checked one by one, because the set belongs to the pi-ai version; pi-ai ignores unknown ones.
			if (raw.compat !== undefined && !isObj(raw.compat)) bad("compat", "must be an object");
			const map = raw.thinkingLevelMap;
			if (map !== undefined && !(isObj(map) && Object.entries(map).every(([level, value]) => (THINKING_MAP_LEVELS as readonly string[]).includes(level) && (value === null || (typeof value === "string" && value !== ""))))) bad("thinkingLevelMap", `must map ${THINKING_MAP_LEVELS.join(", ")} to a non-empty string or null`);
			if (map !== undefined && raw.reasoning !== true) bad("thinkingLevelMap", 'needs "reasoning": true, because the map is only used for reasoning models');
			if (raw.input !== undefined && !(Array.isArray(raw.input) && raw.input.length > 0 && raw.input.every((kind) => kind === "text" || kind === "image"))) bad("input", 'must be a non-empty array of "text" and "image"');
			const cost = raw.cost;
			if (cost !== undefined && !(isObj(cost) && ["input", "output", "cacheRead", "cacheWrite"].every((k) => typeof cost[k] === "number" && (cost[k] as number) >= 0) && Object.keys(cost).length === 4)) bad("cost", "must be an object with the non-negative numbers input, output, cacheRead and cacheWrite");
			const posInt = (field: "contextWindow" | "maxTokens"): number | undefined => {
				const v = raw[field];
				if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
				bad(field, "is required and must be a positive integer");
				return undefined;
			};
			const contextWindow = posInt("contextWindow");
			const maxTokens = posInt("maxTokens");
			if (contextWindow !== undefined && maxTokens !== undefined) {
				const room = contextWindow - maxTokens;
				if (room < COMPACTOR_MIN_TOKENS) { add(`${m}.contextWindow`, "context_too_small", `${contextWindow} minus maxTokens ${maxTokens} leaves ${room} tokens; every role needs at least ${COMPACTOR_MIN_TOKENS}, and the main model needs ${MAIN_MIN_TURN_TOKENS + SYSTEM_RESERVE}`); ok = false; }
			}
			if (!ok) return;
			models.push({
				id: raw.id as string,
				name: (raw.name as string | undefined) ?? (raw.id as string),
				api: raw.api as CustomModel["api"],
				baseUrl: raw.baseUrl as string,
				reasoning: (raw.reasoning as boolean | undefined) ?? false,
				input: (raw.input as CustomModel["input"] | undefined) ?? ["text"],
				cost: (raw.cost as CustomModel["cost"] | undefined) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: contextWindow!,
				maxTokens: maxTokens!,
				...(raw.compat === undefined ? {} : { compat: raw.compat as Record<string, unknown> }),
				...(map === undefined ? {} : { thinkingLevelMap: map as CustomModel["thinkingLevelMap"] }),
			});
		});
		out[id] = { name: (provider.name as string | undefined) ?? id, models };
	}
	if (issues.length > 0) throw new ModelsFileError(issues);
	return out;
}

function buildProvider(id: string, def: CustomProviderDef): Provider {
	return withCacheMarks(createProvider({
		id,
		name: def.name,
		auth: { apiKey: envApiKeyAuth(`${def.name} API key`, [apiKeyEnvName(id)]) },
		models: def.models.map((m) => ({ ...m, provider: id })),
		api: { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi(), "anthropic-messages": anthropicMessagesApi() },
	}) as Provider);
}

/** The shortest valid models.json, shown by setup. A test validates it. */
export const MODELS_JSON_EXAMPLE = JSON.stringify({
	providers: { "my-llm": { models: [{ id: "chat", api: "openai-completions", baseUrl: "https://llm.example.com/v1", contextWindow: 200000, maxTokens: 16000 }] } },
}, null, 2);

export interface CustomProviders {
	/**
	 * Read and validate models.json, then register its providers and drop ones it no longer lists. On any
	 * error nothing changes: the previous providers stay registered.
	 */
	reload(): { ok: true; ids: string[]; warnings?: string[] } | { ok: false; error: string };
	/** Read and validate models.json without registering anything. */
	check(): { ok: true; ids: string[]; warnings?: string[] } | { ok: false; error: string };
}

export function customProviders(models: MutableModels, home: string): CustomProviders {
	let registered = new Set<string>();
	const load = () => {
		const builtIn = new Set(models.getProviders().map((p) => p.id).filter((id) => !registered.has(id)));
		const raw = readJsonFile(homePaths(home).models);
		const issues: ModelsIssue[] = [];
		const defs = validateModelsFile(raw === undefined ? { providers: {} } : raw, builtIn, issues);
		const warnings = issues.map((issue) => `models.json ${issue.path}: ${issue.message}`);
		return { defs, ids: Object.keys(defs), ...(warnings.length > 0 ? { warnings } : {}) };
	};
	const failure = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) });
	return {
		check() {
			try {
				const { defs: _defs, ...rest } = load();
				return { ok: true, ...rest };
			} catch (error) {
				return failure(error);
			}
		},
		reload() {
			try {
				const { defs, ...rest } = load();
				const next = Object.entries(defs).map(([id, def]) => buildProvider(id, def));
				for (const id of registered) if (!(id in defs)) models.deleteProvider(id);
				for (const provider of next) models.setProvider(provider);
				registered = new Set(Object.keys(defs));
				return { ok: true, ...rest };
			} catch (error) {
				return failure(error);
			}
		},
	};
}

/* --- provider and model choices ----------------------------------------------------------------------- */

export interface ProviderMethod {
	type: AuthType;
	/** Shown in the picker, e.g. "Anthropic (sign in)". */
	label: string;
	/** An api-key provider with no login step relies on ambient credentials only. */
	interactive: boolean;
}

export interface ProviderChoice {
	id: string;
	name: string;
	methods: ProviderMethod[];
}

/** Providers the wizard can offer: OAuth providers, and api-key providers that can ask for a key or already resolve. */
export function providerChoices(models: Models): ProviderChoice[] {
	const out: ProviderChoice[] = [];
	for (const provider of models.getProviders()) {
		const methods: ProviderMethod[] = [];
		const oauth = provider.auth.oauth;
		const apiKey = provider.auth.apiKey;
		const both = oauth !== undefined && apiKey !== undefined;
		if (oauth !== undefined) methods.push({ type: "oauth", label: `${provider.name} (sign in)`, interactive: true });
		if (apiKey !== undefined) methods.push({ type: "api_key", label: both ? `${provider.name} (API key)` : provider.name, interactive: apiKey.login !== undefined });
		if (methods.length > 0) out.push({ id: provider.id, name: provider.name, methods });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the provider's auth resolves now (a stored credential or ambient credentials). */
export async function hasAuth(models: Models, providerId: string): Promise<boolean> {
	try {
		const result = await models.getAuth(providerId);
		return result !== undefined;
	} catch {
		return false;
	}
}

export interface ModelChoice {
	ref: string;
	model: AnyModel;
	check: ContextCheck;
}

export function modelChoices(models: Models, providerId: string, role: ModelRole): ModelChoice[] {
	return models.getModels(providerId).map((model) => ({ ref: `${providerId}/${model.id}`, model, check: contextCheck(model, role) }));
}

export function resolveModel(models: Models, ref: string): AnyModel | undefined {
	if (!isModelRef(ref)) return undefined;
	const { provider, modelId } = splitModelRef(ref);
	return models.getModel(provider, modelId);
}

/** Run a login and persist the resulting credential through the store. */
export async function loginAndStore(models: Models, store: CredentialStore, providerId: string, type: AuthType, interaction: AuthInteraction, deviceId: () => string): Promise<void> {
	const credential = await models.login(providerId, type, interaction, { getDeviceId: deviceId, agentName: "piroboros" });
	await store.modify(providerId, async () => credential);
}

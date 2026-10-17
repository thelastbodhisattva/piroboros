import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FileCredentialStore } from "../auth.ts";
import { clauseCut, MAX_CALLS } from "../chat/compactor.ts";
import { CHAT_PROMPT, compactMergeTask, compactMessageTask, tooLongRetry } from "../chat/prompt.ts";
import { NODE_TEXT_MAX, utf8Bytes } from "../chat/view.ts";
import { ensureHome, homePaths, readSettings, resolveHome, withDefaults } from "../config.ts";
import { createAppModels, customProviders, hasAuth, resolveModel, type AnyModel, type CredentialStore, type Message, type Models } from "../models.ts";

// Compactor prompt tuning: runs the real compaction prompts over a synthetic corpus, scores the produced lines
// with fixed probes (no judge model) and keeps a candidate only if it beats the baseline on the held-out chats.
// It never edits src; a person applies a winning candidate to src/chat/prompt.ts.

export type Probe =
	| { type: "keep"; at: number; text: string }
	| { type: "correction"; at: number; old: string; fix: number; new: string };
export interface Chat { id: string; split: "dev" | "heldout"; messages: Array<{ kind: string; text: string }>; probes: Probe[] }
export interface Variant { name: string; messageTaskSuffix?: string; mergeTaskSuffix?: string }
/** One compactor request: the system prompt, the two user text blocks, and the earlier too-long replies. Returns the reply text. */
export type Ask = (system: string, blocks: [chat: string, task: string], replies: readonly string[]) => Promise<string>;
export interface Line { first: number; last: number; text: string }
/** [hits, probes] per probe type for one produced line. */
export interface LineScore { keep: [number, number]; correction: [number, number] }
export interface Summary { overall: number | null; keep: number | null; correction: number | null; lines: number }
export interface Split { dev: Summary; heldout: Summary }

/* --- corpus and candidates ---------------------------------------------------------------------------------- */

const jsonFiles = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => join(dir, name));

export function loadCorpus(dir: string): Chat[] {
	return jsonFiles(dir).map((file) => {
		const chat = JSON.parse(readFileSync(file, "utf8")) as Chat;
		if (typeof chat.id !== "string" || (chat.split !== "dev" && chat.split !== "heldout") || !Array.isArray(chat.messages) || !Array.isArray(chat.probes)) throw new Error(`${file}: not a chat (id, split, messages, probes)`);
		return chat;
	});
}

export function loadCandidates(dir: string): Variant[] {
	// The folder is empty or absent once its candidates have been applied to src/chat/prompt.ts.
	return (existsSync(dir) ? jsonFiles(dir) : []).map((file) => {
		const v = JSON.parse(readFileSync(file, "utf8")) as Variant;
		if (typeof v.name !== "string" || v.name === "" || v.name === "baseline") throw new Error(`${file}: a candidate needs a name other than baseline`);
		return v;
	});
}

/* --- scoring -------------------------------------------------------------------------------------------------- */

const MARKER = /\b(?:was|replaced|not|instead of)\b|\u{2192}/iu;

/** The new value is present, and the old one is absent or sits next to a replaced marker everywhere it appears. */
export function correctionHit(text: string, old: string, now: string): boolean {
	if (!text.includes(now)) return false;
	for (let at = text.indexOf(old); at >= 0; at = text.indexOf(old, at + 1)) {
		if (!MARKER.test(text.slice(Math.max(0, at - 24), at + old.length + 24))) return false;
	}
	return true;
}

/** Score one line against the probes whose source messages lie inside [first, last]. Undefined when none do. */
export function scoreLine(text: string, first: number, last: number, probes: readonly Probe[], missed?: Probe[]): LineScore | undefined {
	const score: LineScore = { keep: [0, 0], correction: [0, 0] };
	const inside = (i: number): boolean => i >= first && i <= last;
	for (const probe of probes) {
		if (probe.type === "keep" ? !inside(probe.at) : !(inside(probe.at) && inside(probe.fix))) continue;
		const hit = probe.type === "keep" ? text.includes(probe.text) : correctionHit(text, probe.old, probe.new);
		score[probe.type][1] += 1;
		if (hit) score[probe.type][0] += 1;
		else missed?.push(probe);
	}
	return score.keep[1] + score.correction[1] === 0 ? undefined : score;
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Hit rate per probe type and overall, each a mean over the lines that carry such probes. */
export function summarize(scores: readonly LineScore[]): Summary {
	const rate = (type: "keep" | "correction"): number | null => mean(scores.filter((s) => s[type][1] > 0).map((s) => s[type][0] / s[type][1]));
	return {
		overall: mean(scores.map((s) => (s.keep[0] + s.correction[0]) / (s.keep[1] + s.correction[1]))),
		keep: rate("keep"),
		correction: rate("correction"),
		lines: scores.length,
	};
}

/** Keep only if the held-out mean beats the baseline by the margin, dev does not drop, and no probe type drops on held-out. */
export function decide(base: Split, cand: Split, margin: number): { keep: boolean; reason: string } {
	const EPS = 1e-9;
	const n = (x: number | null): number => x ?? 0;
	const gain = n(cand.heldout.overall) - n(base.heldout.overall);
	const reject = (reason: string) => ({ keep: false, reason });
	if (gain + EPS < margin) return reject(`held-out gain ${gain.toFixed(3)} is below the margin ${margin}`);
	if (n(cand.dev.overall) + EPS < n(base.dev.overall)) return reject(`dev mean fell from ${n(base.dev.overall).toFixed(3)} to ${n(cand.dev.overall).toFixed(3)}`);
	for (const type of ["keep", "correction"] as const) {
		const was = base.heldout[type];
		const now = cand.heldout[type];
		if (was !== null && now !== null && now + EPS < was) return reject(`held-out ${type} rate fell from ${was.toFixed(3)} to ${now.toFixed(3)}`);
	}
	return { keep: true, reason: `held-out gain ${gain.toFixed(3)}, dev not lower, no probe type dropped` };
}

/* --- the tree ------------------------------------------------------------------------------------------------- */

// ponytail: the <chat> block lists the lines of the level being built that come before the node, uncapped; the
// compactor keeps the newest 32,000 bytes. The corpus chats are far below that, so the cap is not reproduced.
const view = (lines: readonly Line[]): string => `<chat>\n${lines.map((l) => `${l.first}+${l.last - l.first + 1}|${l.text.replace(/\n/gu, " ")}\n`).join("")}</chat>`;

/** One line, asked like the compactor asks: retries on a reply over 512 bytes, then the shortest reply cut at a clause. */
async function oneLine(ask: Ask, blocks: [string, string]): Promise<string> {
	const replies: string[] = [];
	for (let call = 1; call <= MAX_CALLS; call += 1) {
		const text = await ask(CHAT_PROMPT, blocks, replies);
		if (text !== "" && utf8Bytes(text) <= NODE_TEXT_MAX) return text;
		if (text !== "") replies.push(text);
	}
	return replies.length === 0 ? "" : clauseCut([...replies].sort((a, b) => utf8Bytes(a) - utf8Bytes(b))[0]!);
}

const suffixed = (task: string, suffix?: string): string => (suffix === undefined ? task : `${task}\n${suffix}`);

/** Compress every message, then merge adjacent lines pairwise, level by level. Returns every line produced. */
export async function compactChat(chat: Chat, variant: Variant, ask: Ask): Promise<Line[]> {
	const all: Line[] = [];
	let level: Line[] = [];
	for (const [i, m] of chat.messages.entries()) {
		const text = await oneLine(ask, [view(level), suffixed(compactMessageTask(i, m.kind, m.text), variant.messageTaskSuffix)]);
		level.push({ first: i, last: i, text });
	}
	all.push(...level);
	while (level.length > 1) {
		const prev = level;
		const pairs = Array.from({ length: Math.floor(prev.length / 2) }, (_, p) => [prev[2 * p]!, prev[2 * p + 1]!] as const);
		const merged = await Promise.all(pairs.map(async ([a, b], p) => {
			const one = (l: Line): string => `${l.first}+${l.last - l.first + 1}|${l.text.replace(/\n/gu, " ")}`;
			const task = compactMergeTask(`${a.first}+${a.last - a.first + 1}`, `${b.first}+${b.last - b.first + 1}`, a.first, b.last, one(a), one(b));
			return { first: a.first, last: b.last, text: await oneLine(ask, [view(prev.slice(0, 2 * p)), suffixed(task, variant.mergeTaskSuffix)]) };
		}));
		all.push(...merged);
		level = prev.length % 2 === 1 ? [...merged, prev[prev.length - 1]!] : merged;
	}
	return all;
}

export const callsFor = (chat: Chat): number => 2 * chat.messages.length - 1;

/* --- the real model call -------------------------------------------------------------------------------------- */

const textOf = (message: { content: Array<{ type: string; text?: string }> }): string => message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").replace(/\r\n?/gu, "\n").replace(/^\d+\+\d+\|/u, "").trim();
const cut = (text: string): string => Buffer.from(text).subarray(0, NODE_TEXT_MAX).toString("utf8").replace(/\u{FFFD}+$/u, "");
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Same request shape as the compactor (src/chat/compactor.ts, the ask phase), without the outbound scrub. */
export const REQUEST_TIMEOUT_MS = 300_000;

/** A request that outlives `timeoutMs` is aborted and counts as one failed attempt. */
export function makeAsk(models: Models, model: AnyModel, thinking: string, backoffMs = 2_000, timeoutMs = REQUEST_TIMEOUT_MS): Ask {
	return async (systemPrompt, [chat, task], replies) => {
		const stamp = Date.now();
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const messages: Message[] = [{ role: "user", content: [{ type: "text", text: chat }, { type: "text", text: task }], timestamp: stamp }];
		for (const reply of replies) {
			messages.push({ role: "assistant", content: [{ type: "text", text: reply }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "stop", timestamp: stamp } as Message);
			messages.push({ role: "user", content: [{ type: "text", text: tooLongRetry(utf8Bytes(reply), cut(reply)) }], timestamp: stamp });
		}
		for (let attempt = 1; ; attempt += 1) {
			const reply = await models.completeSimple(model, { systemPrompt, messages }, {
				maxTokens: model.maxTokens > 0 ? Math.min(model.maxTokens, 8_192) : 8_192,
				signal: AbortSignal.timeout(timeoutMs),
				...(thinking === "off" ? {} : { reasoning: thinking as never }),
			});
			if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return textOf(reply as never);
			// ponytail: three tries per request, then the run stops; a rerun starts over.
			if (attempt >= 3) throw new Error(reply.errorMessage ?? "the provider returned an error");
			await pause(backoffMs * attempt);
		}
	};
}

/** At most `max` requests in flight. After one request fails, every request not yet sent fails with the same error. */
export function limited(ask: Ask, max: number): Ask {
	let busy = 0;
	let failure: { error: unknown } | undefined;
	const waiting: Array<() => void> = [];
	return async (...args) => {
		if (busy >= max) await new Promise<void>((resolve) => waiting.push(resolve));
		else busy += 1;
		try {
			if (failure !== undefined) throw failure.error;
			return await ask(...args);
		} catch (error) {
			failure ??= { error };
			throw error;
		} finally {
			const next = waiting.shift();
			if (next) next();
			else busy -= 1;
		}
	};
}

/* --- the run -------------------------------------------------------------------------------------------------- */

export interface Miss { chat: string; first: number; last: number; line: string; probes: Array<{ type: Probe["type"]; text: string }> }
const MISSES_MAX = 40;
const MISS_LINE_MAX = 200;

export interface Report { variants: Array<{ name: string; /** Dev-split chats only: held-out lines must never appear here, or a proposer could fit the held-out set. */ misses: Miss[] } & Split>; verdicts: Array<{ name: string; keep: boolean; reason: string }>; calls: number; /** Set when a request failed: the rows then cover only the chats that finished, and there are no verdicts. */ failed?: string }

export async function runAll(chats: readonly Chat[], variants: readonly Variant[], repeats: number, ask: Ask, margin: number): Promise<Report> {
	let calls = 0;
	let failed: string | undefined;
	const counted: Ask = async (...args) => { calls += 1; return ask(...args); };
	const rows = await Promise.all(variants.map(async (variant) => {
		const scores: Record<Chat["split"], LineScore[]> = { dev: [], heldout: [] };
		const misses: Miss[] = [];
		await Promise.all(chats.flatMap((chat) => Array.from({ length: repeats }, async () => {
			try {
				for (const line of await compactChat(chat, variant, counted)) {
					const missed: Probe[] = [];
					const score = scoreLine(line.text, line.first, line.last, chat.probes, missed);
					if (!score) continue;
					scores[chat.split].push(score);
					// Invariant: only dev lines are kept as misses.
					if (chat.split === "dev" && missed.length > 0 && misses.length < MISSES_MAX) {
						misses.push({ chat: chat.id, first: line.first, last: line.last, line: line.text.slice(0, MISS_LINE_MAX), probes: missed.map((p) => ({ type: p.type, text: p.type === "keep" ? p.text : `${p.old} -> ${p.new}` })) });
					}
				}
			} catch (error) {
				failed ??= error instanceof Error ? error.message : String(error);
			}
		})));
		return { name: variant.name, misses, dev: summarize(scores.dev), heldout: summarize(scores.heldout) };
	}));
	if (failed !== undefined) return { variants: rows, verdicts: [], calls, failed };
	const base = rows[0]!;
	return { variants: rows, verdicts: rows.slice(1).map((row) => ({ name: row.name, ...decide(base, row, margin) })), calls };
}

const fmt = (x: number | null): string => (x === null ? "    -" : x.toFixed(3).padStart(5));

export function table(report: Report): string {
	const head = `${"variant".padEnd(16)} | dev: all  keep  corr | held-out: all  keep  corr`;
	const rows = report.variants.map((v) => `${v.name.padEnd(16)} |     ${fmt(v.dev.overall)} ${fmt(v.dev.keep)} ${fmt(v.dev.correction)} |           ${fmt(v.heldout.overall)} ${fmt(v.heldout.keep)} ${fmt(v.heldout.correction)}`);
	const verdicts = report.verdicts.map((v) => `${v.name}: ${v.keep ? "KEEP" : "REJECT"} (${v.reason})`);
	return [head, ...rows, "", ...verdicts, ""].join("\n");
}

/* --- command line --------------------------------------------------------------------------------------------- */

export interface Deps {
	env?: NodeJS.ProcessEnv;
	profile?: string;
	out?: (text: string) => void;
	err?: (text: string) => void;
	/** Replaces the app models (tests). */
	models?: Models;
	corpusDir?: string;
	candidatesDir?: string;
}

const USAGE = "usage: npm run tune:compactor -- [--dry-run] [--yes] [--model provider/id] [--repeats N] [--margin X] [--out file.json]";

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
	const out = deps.out ?? ((text: string) => void process.stdout.write(text));
	const err = deps.err ?? ((text: string) => void process.stderr.write(text));
	const env = deps.env ?? process.env;
	let values;
	try {
		({ values } = parseArgs({ args: argv, strict: true, options: { model: { type: "string" }, repeats: { type: "string" }, margin: { type: "string" }, out: { type: "string" }, "dry-run": { type: "boolean" }, yes: { type: "boolean" } } }));
	} catch (error) {
		err(`tune: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
		return 2;
	}
	const repeats = Number(values.repeats ?? 1);
	const margin = Number(values.margin ?? 0.02);
	if (!Number.isInteger(repeats) || repeats < 1 || !Number.isFinite(margin) || margin < 0) { err(`tune: --repeats must be a whole number of 1 or more and --margin a number of 0 or more\n${USAGE}\n`); return 2; }
	const dry = values["dry-run"] === true;

	const chats = loadCorpus(deps.corpusDir ?? join(import.meta.dirname, "corpus"));
	const variants: Variant[] = [{ name: "baseline" }, ...loadCandidates(deps.candidatesDir ?? join(import.meta.dirname, "candidates"))];
	const calls = chats.reduce((sum, chat) => sum + callsFor(chat), 0) * variants.length * repeats;

	let model: AnyModel | undefined;
	let models = deps.models;
	let ref: string | undefined;
	let thinking = "off";
	try {
		const home = resolveHome(env, deps.profile);
		const settings = readSettings(home);
		ref = values.model ?? settings.compactor?.model;
		thinking = withDefaults(settings).compactor.thinking;
		if (ref !== undefined) {
			if (models === undefined) {
				const paths = homePaths(home);
				if (!dry) ensureHome(home, env);
				// A dry run only looks the model up, so it gets no credential store and never opens auth.json or its lock.
				models = createAppModels(dry ? ({} as CredentialStore) : new FileCredentialStore(paths.auth, paths.authLock, (message) => err(`tune: ${message}\n`)));
				if (existsSync(paths.models)) {
					const loaded = customProviders(models as never, home).reload();
					if (!loaded.ok) err(`tune: models.json: ${loaded.error}\n`);
				}
			}
			model = resolveModel(models, ref);
		}
	} catch (error) {
		err(`tune: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}

	const where = model === undefined ? (ref === undefined ? "no model set" : `model ${ref} not found`) : `model ${ref} (thinking ${thinking})`;
	out(`${chats.length} chats (${chats.filter((c) => c.split === "dev").length} dev, ${chats.filter((c) => c.split === "heldout").length} held-out), ${variants.length} variants, ${repeats} repeat(s): ${calls} calls at least; a reply over ${NODE_TEXT_MAX} bytes adds retries. ${where}\n`);
	if (dry) { out("dry run: no request was sent\n"); return 0; }
	if (model === undefined || models === undefined) { err("tune: no compactor model: set compactor.model in settings.json or pass --model provider/id\n"); return 2; }
	if (!(await hasAuth(models, model.provider))) { err(`tune: login required for ${model.provider}: npm run setup\n`); return 4; }
	if (values.yes !== true) { err(`tune: this sends real requests to ${model.provider} and costs money; add --yes to run\n`); return 2; }

	// ponytail: six requests in flight; add a flag if a provider needs fewer.
	const report = await runAll(chats, variants, repeats, limited(makeAsk(models, model, thinking), 6), margin);
	const meta = { date: new Date().toISOString(), model: ref, thinking, repeats, margin, candidates: variants.slice(1) };
	if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify({ ...report, meta }, null, 2)}\n`);
	if (report.failed !== undefined) { err(`tune: a request failed, the run was stopped: ${report.failed.replace(/\s+/gu, " ").trim()}${values.out === undefined ? "" : ` (partial results in ${values.out})`}\n`); return 1; }
	out(`${table(report)}${report.calls} requests sent\n`);
	return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

import { readJsonFile, splitModelRef, type Settings } from "../config.ts";
import type { AnyModel } from "../models.ts";

// What may leave the machine for the compactor (F9, D19): which credential values to scrub, whether the recipient is
// local, and whether it counts as a third party. Everything here is re-evaluated on every compactor request.

const CREDENTIAL_ENV_NAME = /(?:_API_KEY|_TOKEN|_SECRET)$/iu;

/** String values of auth.json plus the values of `*_API_KEY`, `*_TOKEN` and `*_SECRET` variables, 8 or more characters each. */
export function collectLiterals(authPath: string, env: NodeJS.ProcessEnv): string[] {
	const out = new Set<string>();
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			if (value.length >= 8) out.add(value);
		} else if (Array.isArray(value)) value.forEach(walk);
		else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
	};
	walk(readJsonFile(authPath));
	for (const [name, value] of Object.entries(env)) if (CREDENTIAL_ENV_NAME.test(name) && value !== undefined && value.length >= 8) out.add(value);
	return [...out];
}

/**
 * Loopback means the hostname is exactly `localhost`, lies in 127.0.0.0/8, or is `::1`, and the URL carries no
 * userinfo. The URL parser first normalizes numeric forms (`127.1`, `0x7f.0.0.1`), so `127.0.0.1.evil.com`,
 * `localhost.evil.com` and `0.0.0.0` are not loopback. An unparseable URL is not loopback.
 */
export function isLoopbackUrl(value: string | undefined): boolean {
	if (value === undefined) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.username !== "" || url.password !== "") return false;
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]") return true;
	const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
	return parts !== null && parts[1] === "127" && parts.slice(1).every((part) => Number(part) <= 255);
}

/** Provider ids the user already trusts with the chat: main and every conclave member's model, from settings alone. */
export function usedProviders(settings: Settings): Set<string> {
	const refs = [settings.main, settings.conclave?.defaultModel, ...Object.values(settings.conclave?.members ?? {}).map((member) => member.model)];
	const out = new Set<string>();
	for (const ref of refs) if (typeof ref === "string" && ref.includes("/")) out.add(splitModelRef(ref).provider);
	return out;
}

const MEMO_MAX = 2_048;
const MEMO_CHUNK_MAX = 1_024;

/** Scrub results by chunk text; holds at most MEMO_MAX chunks (two generations of half that). */
export type ScrubMemo = { fresh: Map<string, string>; stale: Map<string, string> };
export const newScrubMemo = (): ScrubMemo => ({ fresh: new Map(), stale: new Map() });

/** A line that may continue into its neighbour: a rule can cross a newline only through `\s`, after a label, `:`, `=`, `Bearer`, `is`, `was` or `are`, or over blank lines. */
const endsOpen = (line: string): boolean => { const t = line.trimEnd(); return t === "" || /(?:[:=]|\bbearer|\b(?:is|was|are))$/iu.test(t.slice(-12)); };
const startsOpen = (line: string): boolean => { const s = line.trimStart(); return s === "" || s[0] === ":" || s[0] === "="; };

/**
 * `scrub` over `text`, one chunk at a time with `memo` (bounded, keyed by the chunk text) holding the results. A chunk is
 * one line, or the few lines joined where a rule could match across the newline; so the result equals `scrub(text)`. A text
 * that names a private key (a block, which spans lines) or a literal that holds a newline is scrubbed whole. The caller owns `memo`
 * and must use one memo per (literals, strict) pair. `memo` never holds more than MEMO_MAX chunks of MEMO_CHUNK_MAX characters.
 */
export function scrubLines(text: string, scrub: (text: string) => string, memo: ScrubMemo, literals: readonly string[]): string {
	if (/private key/iu.test(text) || literals.some((literal) => literal.includes("\n"))) return scrub(text);
	const one = (chunk: string): string => {
		if (chunk.length > MEMO_CHUNK_MAX) return scrub(chunk);
		const out = memo.fresh.get(chunk) ?? memo.stale.get(chunk) ?? scrub(chunk);
		if (!memo.fresh.has(chunk)) {
			memo.fresh.set(chunk, out);
			// Two generations instead of an LRU: no deletes (a Map that deletes oldest-first slows down), and a line in use survives a swap.
			if (memo.fresh.size >= MEMO_MAX / 2) {
				memo.stale = memo.fresh;
				memo.fresh = new Map();
			}
		}
		return out;
	};
	const lines: string[] = [];
	for (let at = 0; at < text.length || lines.length === 0;) {
		const nl = text.indexOf("\n", at);
		const end = nl < 0 ? text.length : nl + 1;
		lines.push(text.slice(at, end));
		at = end;
	}
	let out = "";
	let chunk = "";
	for (let k = 0; k < lines.length; k += 1) {
		chunk += lines[k];
		if (k + 1 === lines.length || (!endsOpen(lines[k]!) && !startsOpen(lines[k + 1]!))) {
			out += one(chunk);
			chunk = "";
		}
	}
	return out;
}

export type Outbound = { ok: true; strict: boolean } | { ok: false; reason: string };

/**
 * May the compactor send to this model? A third party is a provider no other role uses, at a non-loopback address.
 * It needs `compactor.allowThirdParty`. `strict` tells the scrub the recipient is a third party.
 */
export function outboundVerdict(settings: Settings, model: Pick<AnyModel, "provider" | "baseUrl"> | undefined): Outbound {
	if (model === undefined) return { ok: false, reason: "the compactor model is not available" };
	const third = !usedProviders(settings).has(model.provider) && !isLoopbackUrl(model.baseUrl);
	if (third && settings.compactor?.allowThirdParty !== true) return { ok: false, reason: `the compactor provider ${model.provider} is a third party (not main, not a conclave member, not local); set compactor.allowThirdParty to true to send the chat there` };
	return { ok: true, strict: third };
}

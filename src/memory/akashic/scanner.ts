// Ported from akashic-forge/store.ts @ f0a8ad4 (MIT; see NOTICE)
// The memory safety scanner (F1). It replaces the five threat patterns of the source. Every path that accepts or shows memory text goes through scanMemoryText:
// remember, update, vault import, the snapshot render and the mnemosia filters all call validateMemorySafety in
// store.ts, which calls this. The text is checked twice: the raw text for characters that hide or reorder text, and
// a normalized copy (NFKC, format characters removed, look-alike letters folded, whitespace collapsed) for the phrase rules.

import { CONFUSABLE_SOURCES } from "./confusables.ts";

/** Characters that hide or reorder text. Any of them in the raw text rejects it. */
const DANGEROUS_CHARACTERS = /[\u202A-\u202E\u2066-\u2069\u200B\u2060-\u2064\uFEFF\u00AD\u180E\u061C\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;
/** A joiner next to an ASCII letter splits a word without showing it. Joiners inside other scripts and emoji sequences are fine. */
const ASCII_JOINER = /[A-Za-z][\u200C\u200D]|[\u200C\u200D][A-Za-z]/u;

// Letters of other scripts that look like Latin ones (Cyrillic, Greek, Armenian, Cherokee, math and others). NFKC keeps
// them apart, so "ignore" spelled with a Cyrillic o would slip past every phrase rule. The scan folds them to Latin;
// the stored text is never changed. The table is Unicode's confusables data (confusables.ts), plus look-alikes it does
// not list. A capital that Unicode maps to "l" (it looks like a capital I) folds to "i", because the phrase rules match
// words case-insensitively.
const EXTRA_CONFUSABLES: ReadonlyArray<readonly [number, string]> = [
	// Cyrillic ve, ka, em, en, te; Greek epsilon, kappa, tau, chi
	[0x432, "b"], [0x43a, "k"], [0x43c, "m"], [0x43d, "h"], [0x442, "t"], [0x3b5, "e"], [0x3ba, "k"], [0x3c4, "t"], [0x3c7, "x"],
];
const CONFUSABLES = new Map<string, string>();
for (const [latin, sources] of Object.entries(CONFUSABLE_SOURCES)) {
	for (const hex of sources.split(" ")) {
		const char = String.fromCodePoint(Number.parseInt(hex, 16));
		CONFUSABLES.set(char, latin === "l" && char !== char.toLowerCase() ? "i" : latin);
	}
}
for (const [code, latin] of EXTRA_CONFUSABLES) if (!CONFUSABLES.has(String.fromCodePoint(code))) CONFUSABLES.set(String.fromCodePoint(code), latin);

export function normalizeForScan(raw: string): string {
	return raw.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/[^\x00-\x7f]/gu, (c) => CONFUSABLES.get(c) ?? c).replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ");
}

// A negation counts only when it sits directly in front of the verb ("never send"). "Never hesitate to send" is not negated.
const NEGATION = String.raw`(?<!\b(?:never|don'?t|do not|must not|should not|cannot|can'?t|without)\s+(?:ever\s+)?)`;
const SECRET = String.raw`(?:secrets?|credentials?|tokens?|passwords?|passwd|api[-_ ]?keys?|private keys?|auth\.json|\.env\b|ssh keys?|cookies?|session)`;
const TARGET = String.raw`(?:https?:\/\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|xyz|ru|cn|sh|app|ngrok|pastebin)\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|webhook|pastebin|ngrok|discord|telegram)`;
const KEY_FILES = String.raw`(?:authorized_keys|ssh config|id_rsa|private key)`;
// One character of a gap. A rule does not reach across the end of a sentence, but a period inside a word or a URL
// ("p.sh", "evil.example") is not one: only a period followed by a space or the end of the text stops the gap.
const GAP = String.raw`(?:[^.]|\.(?=\S))`;

/** Gap sizes of the phrase rules, exported so the edge-window tests are built from the same numbers. */
export const WINDOWS = { overrideLead: 60, overrideTail: 40, reveal: 60, exfil: 120, exfilBare: 60, exec: 160, keyFile: 100, standingLead: 80, standingTail: 60 } as const;

const RULES: ReadonlyArray<readonly [string, RegExp]> = [
	["override", new RegExp(String.raw`\b(?:ignore|disregard|override|bypass|forget|discard|skip|stop following|do not follow)\b${GAP}{0,${WINDOWS.overrideLead}}?\b(?:previous|prior|above|earlier|all|any|your|the|these|those|system|developer|safety|security|existing)\b${GAP}{0,${WINDOWS.overrideTail}}?\b(?:instructions?|rules?|prompts?|guidelines?|polic(?:y|ies)|directions|guardrails|restrictions|constraints|system message|developer message)\b`, "iu")],
	["reveal", new RegExp(String.raw`\b(?:reveal|print|show|output|repeat|leak|disclose|send|dump|display|echo|reproduce|tell me)\b${GAP}{0,${WINDOWS.reveal}}?\b(?:system prompt|developer message|hidden instructions?|chain[- ]of[- ]thought|your instructions)\b|\bjailbreak\b`, "iu")],
	["exfil-target", new RegExp(String.raw`\b(?:exfiltrate|steal|leak|dump|send|upload|post|email|forward|paste|include|append|curl|wget|iwr|irm|invoke-webrequest)\b${GAP}{0,${WINDOWS.exfil}}?\b${SECRET}${GAP}{0,${WINDOWS.exfil}}?${TARGET}|${TARGET}${GAP}{0,${WINDOWS.exfil}}?\b${SECRET}`, "iu")],
	["exfil", new RegExp(String.raw`${NEGATION}\b(?:exfiltrate|steal|leak|dump|send|upload|post)\b${GAP}{0,${WINDOWS.exfilBare}}?\b${SECRET}\b`, "iu")],
	["exec", new RegExp(String.raw`\b(?:curl|wget|invoke-webrequest|iwr|irm|invoke-expression|iex|downloadstring|certutil|bitsadmin)\b${GAP}{0,${WINDOWS.exec}}?(?:\b${SECRET}|\|\s*(?:sh|bash|iex|pwsh|powershell)\b)`, "iu")],
	["key-file", new RegExp(String.raw`\b${KEY_FILES}\b${GAP}{0,${WINDOWS.keyFile}}?${NEGATION}\b(?:write|append|install|download|execute|modify|upload|send|cat|copy)\b|${NEGATION}\b(?:write|append|install|add|modify|upload|send|cat|copy)\b${GAP}{0,${WINDOWS.keyFile}}?\b${KEY_FILES}\b`, "iu")],
	["role-hijack", /\b(?:you are now|from now on,? you|new (?:system )?instructions?:|developer mode|do anything now|act as (?:an? )?(?:unrestricted|root|admin|dan)\b)/iu],
	["delimiter", /<\/?\s*(?:akashic|system|assistant|developer|memory|chat|turn|tool|instructions?|im_start|im_end)[^>]*>|<\|[a-z_]+\|>|\[\/?(?:INST|SYSTEM)\]|(?:^|\.\s+)(?:system|assistant)\s*:/iu],
	["standing-exec", new RegExp(String.raw`\b(?:always|whenever|every time|before (?:answering|replying|responding)|on every (?:turn|request))\b${GAP}{0,${WINDOWS.standingLead}}?\b(?:run|execute|call|invoke)\b${GAP}{0,${WINDOWS.standingTail}}?\b(?:powershell|shell|bash|cmd|curl|iex|write|edit)\b`, "iu")],
];

/** The id of the rule that rejects `raw`, or undefined when the text is accepted. */
export function scanMemoryText(raw: string): string | undefined {
	if (DANGEROUS_CHARACTERS.test(raw)) return "hidden-character";
	if (ASCII_JOINER.test(raw)) return "ascii-joiner";
	const text = normalizeForScan(raw);
	for (const [id, rule] of RULES) if (rule.test(text)) return id;
	return undefined;
}

/** Hidden-character rejections have their own message; everything else is a phrase rule. */
export const isCharacterRule = (id: string): boolean => id === "hidden-character" || id === "ascii-joiner";

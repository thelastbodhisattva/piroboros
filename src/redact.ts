// Ported from akashic-forge/store.ts @ f0a8ad4 (MIT; see NOTICE)
// Pure credential scrub (no imports, no I/O). Re-exported by src/memory/akashic/store.ts.

export const REDACTION_MARKER = "[REDACTED]";

/** Remove common credentials before anything is persisted or injected. */
export function redactSensitive(value: string): string {
	const markerToken = "__AKASHIC_FORGE_REDACTED__";
	let result = value.replaceAll(REDACTION_MARKER, markerToken);
	result = result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, REDACTION_MARKER);
	result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTION_MARKER}`);
	result = result.replace(/([?&](?:api[_-]?key|api[_-]?token|access[_-]?token|password|secret|token)=)[^&#\s]+/gi, `$1${REDACTION_MARKER}`);
	result = result.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, REDACTION_MARKER);
	result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTION_MARKER);
	// GitHub tokens (fine-grained and classic) and JWT-shaped values such as the `"access":"eyJ..."` of an OAuth blob.
	result = result.replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/g, REDACTION_MARKER);
	result = result.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTION_MARKER);
	// URL userinfo credentials (CAPTURE1 entry precondition, Raskreia R1/R3 via Elaria E1): redact the
	// `user:password` portion of `scheme://user:pass@host`, keep scheme + host readable so URLs stay
	// searchable. Requires a colon inside the userinfo, so bare `user@host` (email-like) is untouched.
	// Anchored on `://` rather than on a scheme pattern, so a scheme of any length is covered and the scan stays linear.
	result = result.replace(/(:\/\/)[^\s\/@:]+:[^\s\/@]+@/g, `$1${REDACTION_MARKER}@`);
	// The value class excludes `[` too (G3/Raskreia one-char fix): the query-param pattern above
	// creates a fresh `[REDACTED]` mid-stream AFTER the pre-existing-marker swap protected it, and the
	// old class matched `[REDACTED` (stopping at the excluded `]`), re-redacting it into a stray
	// `password=[REDACTED]]`. Excluding `[` leaves the inserted marker alone. Accepted cost: a labeled
	// value literally starting with `[` is no longer redacted — vanishingly rare, over-redaction
	// direction only, never a leak.
	// The closing quote of a JSON label (`"password": "x"`) may sit between the label and the colon.
	result = result.replace(
		/(\b(?:api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|authorization|password|passwd|secret|token|private[-_ ]?key)\b["']?\s*[:=]\s*)(["']?)([^\s"',;}\]\[]{4,})/gi,
		`$1$2${REDACTION_MARKER}`,
	);
	// Environment-variable and connection-string labels that the word-boundary rule above cannot see, because `_`
	// joins them to the word: AWS_SECRET_ACCESS_KEY=..., AccountKey=.... The value must be 8 or more characters, so
	// constants such as `MAX_TOKENS = 72_000` in source text are left alone.
	result = result.replace(
		/(\b(?:[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|ACCOUNT_?KEY|PRIVATE_?KEY)[A-Z0-9_]*|(?:Account|SharedAccess)Key)\s*[:=]\s*)(["']?)([^\s"',;}\]\[]{8,})/g,
		`$1$2${REDACTION_MARKER}`,
	);
	// A phrase such as `the admin <label> is <value> for the box`: the value must hold a non-letter, so plain prose stays.
	result = result.replace(
		/(\b(?:password|passphrase|passwd)\b[^\n.]{0,40}?\b(?:is|was|are)\s+)(["']?)(?=[^\s"',;]*[^A-Za-z\s"',;])([^\s"',;]{6,})/gi,
		`$1$2${REDACTION_MARKER}`,
	);
	// Unlabeled high-entropy tokens (same entry precondition), deliberately CONSERVATIVE — the goal's
	// §15 retrieval targets include commit hashes and URLs, so this must never over-redact:
	//   - 32–64 chars, word-boundary delimited, mixed case WITH a digit (real secrets are; prose is not);
	//   - pure hex of any case is skipped (40-char commit hashes, digests, ids stay intact);
	//   - all-lower/all-upper runs are skipped (normal identifiers); contiguous base64 blobs longer
	//     than 64 chars never match (no interior word boundary), and `=`-padded base64 is skipped by
	//     checking the characters immediately after the candidate.
	// Residual false-positive posture (documented in the contract doc §10): an UNPADDED, unlabeled
	// 32–64-char mixed-case base64url fragment inside tool output would match. That window is kept
	// short on purpose; longer credential material is caught by the labeled/format patterns above.
	result = result.replace(/\b[A-Za-z0-9_-]{32,64}\b/g, (token: string, offset: number, full: string) => {
		if (/^[0-9a-f]+$/i.test(token)) return token;
		if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return token;
		if (/^={1,2}/.test(full.slice(offset + token.length, offset + token.length + 2))) return token;
		return REDACTION_MARKER;
	});
	return result.replaceAll(markerToken, REDACTION_MARKER);
}

/** Replace every occurrence of each literal value. Longest first, so a value that contains another is removed whole. */
export function redactLiterals(value: string, literals: readonly string[]): string {
	let result = value;
	for (const literal of [...new Set(literals)].filter((item) => item.length >= 8).sort((a, b) => b.length - a.length)) result = result.replaceAll(literal, REDACTION_MARKER);
	return result;
}

export interface OutboundScrub {
	/** Credential values that must never leave: auth.json values and the values of *_API_KEY, *_TOKEN, *_SECRET variables. */
	literals: readonly string[];
	/** For a third-party recipient: hex runs of 32 or more characters (digests, hashes, session ids) go too. */
	strict?: boolean;
}

/** The scrub for text that leaves the machine (F9): literal values first, then the patterns, then strict hex runs. */
export function redactOutbound(value: string, options: OutboundScrub): string {
	let result = redactSensitive(redactLiterals(value, options.literals));
	if (options.strict === true) result = result.replace(/\b[0-9a-fA-F]{32,}\b/g, REDACTION_MARKER);
	return result;
}

/** Redact string leaves before serializing, so redaction can never break the surrounding JSON. */
export function redactJsonValue(value: unknown): unknown {
	if (typeof value === "string") return redactSensitive(value);
	if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactJsonValue(item)]));
	return value;
}

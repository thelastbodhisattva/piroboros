// Ported from mnemosia/claims.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Deterministic claim extraction, normalization and deduplication (design §8, build-order step 6).
 *
 * This is the linchpin: it is the module that decides what "the corpus says X" means without an LLM
 * anywhere in the path. Three extraction paths exist, one per artifact shape, and no fifth is
 * synthesized to make the corpus look richer than it is:
 *
 *   1. curated memory      → one claim, CONFIRMED, governance columns carried across.
 *   2. compaction summary  → N claims via the heading grammar, capped at PROBABLE.
 *   3. raw event           → one degenerate whole-artifact OBSERVATION with an excerpt window.
 *
 * Path 3 is the one that would be most tempting to make clever. Splitting a 4KB tool transcript
 * into sentence-level "claims" would produce a large number of grammatically well-formed objects
 * that are not claims about anything, and every downstream signal (evidence strength, freshness,
 * conflict detection) would then be computed over noise while reporting the confidence of signal.
 * Mnemosia.txt §26 forbids exactly that kind of placeholder sophistication, so a raw event stays one
 * honest OBSERVATION that says "this artifact contains this passage", and its excerpt is the ±240
 * character window design §18 prices at roughly 120 tokens.
 *
 * **The summary certainty cap is the mechanism, not the aspiration.** Spec §4 requires that a
 * polished summary not outrank its raw evidence. That is enforced here by construction: every
 * summary-derived claim is capped at PROBABLE and every piece of its evidence is `derived`, so no
 * amount of downstream scoring can lift it to the CONFIRMED band that curated memory occupies.
 *
 * Nothing in this module imports from the foundations. It reads `ArtifactEnvelope` and writes
 * `Claim`, both of which are Mnemosia's own vocabulary.
 */

import { createHash } from "node:crypto";
import {
	SCHEMA_VERSION,
	scopeKey,
	type ConversationOrigin,
	type AkashicMemoryOrigin,
	type ArtifactEnvelope,
			type Certainty,
	type Claim,
	type ClaimType,
	type Evidence,
	type EvidenceDirectness,
	type EvidenceRelation,
	type LifecycleState,
	type Scope,
} from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Certainty algebra
 * ---------------------------------------------------------------------------------------------- */

/** A total order, so "certainty = max" in dedup and "capped at PROBABLE" are both arithmetic. */
export const CERTAINTY_RANK: Readonly<Record<Certainty, number>> = { CONFIRMED: 3, PROBABLE: 2, SPECULATIVE: 1, UNKNOWN: 0 };

export function maxCertainty(a: Certainty, b: Certainty): Certainty {
	return CERTAINTY_RANK[a] >= CERTAINTY_RANK[b] ? a : b;
}

/** Never raises; only lowers. Used to make the summary cap unbypassable rather than remembered. */
export function capCertainty(value: Certainty, ceiling: Certainty): Certainty {
	return CERTAINTY_RANK[value] <= CERTAINTY_RANK[ceiling] ? value : ceiling;
}

/**
 * The ceiling on anything read out of a compaction summary (design §8.2). A summary is a derivative
 * account written by a model; treating it as CONFIRMED would let a paraphrase outrank the events it
 * paraphrases, which is the invariant this constant exists to make impossible.
 */
export const SUMMARY_CERTAINTY_CEILING: Certainty = "PROBABLE";

/**
 * Precedence used when deduplication merges two claims that carry different types. The governing
 * types win: a sentence that appears once as a CONSTRAINT and once as an ordinary OBSERVATION is a
 * constraint that was also observed, and demoting it would drop it out of the mandatory set that
 * §10 reserves budget for. Merging in the other direction can only ever lose a restriction.
 */
const CLAIM_TYPE_PRECEDENCE: readonly ClaimType[] = ["CONSTRAINT", "DECISION", "PREFERENCE", "PROCEDURE", "FACT", "PLAN", "HYPOTHESIS", "OBSERVATION"];

/**
 * Precedence used when deduplication merges two claims carrying different lifecycle states. A
 * governed state that restricts retrieval wins over one that permits it, for the same reason:
 * merging must never launder a DISPUTED or SUPERSEDED reading into an ACTIVE one.
 */
const LIFECYCLE_PRECEDENCE: readonly LifecycleState[] = ["DELETED", "REVOKED", "QUARANTINED", "EXPIRED", "SUPERSEDED", "DISPUTED", "PROPOSED", "ACTIVE"];

/* ------------------------------------------------------------------------------------------------
 * Normalization and identity
 * ---------------------------------------------------------------------------------------------- */

/** List markers stripped before normalization, so `1. x`, `- x` and `- [x] x` share a dedup key. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const TASK_MARKER = /^\s*\[[ xX]\]\s+/;

/**
 * `NFKC → lowercase → collapse whitespace → strip list markers and punctuation` (design §7).
 *
 * Punctuation is replaced with a space rather than deleted. Deleting it would fold `a.b` into `ab`
 * and `run-time` into `runtime`, quietly merging identifiers that a technical corpus keeps apart;
 * replacing it keeps the token boundary that made them different in the first place.
 */
export function normalizeClaimText(text: string): string {
	let value = text.normalize("NFKC").toLowerCase();
	// Repeated because a Markdown task item carries two markers: `- ` and then `[x] `.
	for (let i = 0; i < 4; i += 1) {
		const stripped = value.replace(LIST_MARKER, "").replace(TASK_MARKER, "");
		if (stripped === value) break;
		value = stripped;
	}
	// Comparison operators become words first, so "attempts < 5" and "attempts > 5" stay two claims.
	// An arrow (`->`, `=>`, `<-`) is not a comparison and still folds away with the other punctuation.
	return value
		.replace(/>=/gu, " ge ")
		.replace(/<=/gu, " le ")
		.replace(/!=/gu, " ne ")
		.replace(/(?<![-=])>/gu, " gt ")
		.replace(/<(?!-)/gu, " lt ")
		.replace(/[\p{P}\p{S}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Claim identity.
 *
 * Design §7 writes this as `sha256(dedupKey)`, and design §8 writes the dedup rule as "identical
 * `dedupKey` **in compatible scope** ⇒ one claim". Those two sentences cannot both hold: the second
 * says the same sentence in two different projects is two claims, and two claims cannot share an
 * identifier — the fabrication guard in `VALIDATE_BRIEFING` indexes the run's claims by `claimId`,
 * and a collision there would let one project's claim vouch for another's.
 *
 * Resolved in favour of the isolation invariant (spec §4): identity is the dedup key **plus the
 * scope**. `dedupKey` stays on the claim verbatim, so the design's rule is still directly
 * inspectable, and scope is the only thing added.
 */
export function claimIdFor(dedupKey: string, scope: Scope): string {
	return sha256Hex(`${dedupKey}\u001f${scopeKey(scope)}`);
}

/** sha256(artifactId + claimId + relation): the same link never gets two ids (design §7). */
export function evidenceIdFor(artifactId: string, claimId: string, relation: EvidenceRelation): string {
	return sha256Hex(`${artifactId}\u001f${claimId}\u001f${relation}`);
}

function buildEvidence(artifactId: string, claimId: string, relation: EvidenceRelation, directness: EvidenceDirectness, locator: string, observedAt: number): Evidence {
	return {
		schemaVersion: SCHEMA_VERSION.evidence,
		evidenceId: evidenceIdFor(artifactId, claimId, relation),
		artifactId,
		claimId,
		relation,
		directness,
		locator,
		observedAt,
	};
}

/** Everything a path knows about one claim before identity and evidence are attached. */
interface ClaimDraft {
	text: string;
	claimType: ClaimType;
	certainty: Certainty;
	locator: string;
	directness: EvidenceDirectness;
	scope?: Scope;
	effectiveAt?: number;
	expiresAt?: number | null;
	supersedes?: string[];
	lifecycle?: LifecycleState | null;
}

function materialize(envelope: ArtifactEnvelope, draft: ClaimDraft): Claim | null {
	const text = draft.text.trim();
	if (text.length === 0) return null;
	const dedupKey = normalizeClaimText(text);
	// A block that normalizes to nothing (a bare `---`, a lone bullet marker) carried no assertion.
	// Emitting it would create a claim whose identity is the hash of the empty string, shared by
	// every other such block in the corpus.
	if (dedupKey.length === 0) return null;
	const scope = draft.scope ?? envelope.scope;
	const claimId = claimIdFor(dedupKey, scope);
	return {
		schemaVersion: SCHEMA_VERSION.claim,
		claimId,
		dedupKey,
		text,
		claimType: draft.claimType,
		certainty: draft.certainty,
		scope,
		effectiveAt: draft.effectiveAt ?? envelope.createdAt,
		expiresAt: draft.expiresAt ?? null,
		supersedes: draft.supersedes ?? [],
		lifecycle: draft.lifecycle ?? null,
		// Phase 1 emits SUPPORTS here; conflicts.ts (step 11) is what adds SUPERSEDES links.
		evidence: [buildEvidence(envelope.artifactId, claimId, "SUPPORTS", draft.directness, draft.locator, envelope.observedAt)],
	};
}

/* ------------------------------------------------------------------------------------------------
 * Path 2 — the compaction-summary heading grammar
 * ---------------------------------------------------------------------------------------------- */

export interface SummarySectionRule {
	/** The heading as it is written in the corpus, for documentation and for the trace. */
	heading: string;
	claimType: ClaimType;
	/**
	 * `design` — enumerated in PHASE0-DESIGN §8.2.
	 * `measured` — present in 14/14 live summaries but missing from the design's enumeration. The
	 * design's list was evidently taken from the head of a summary and stopped at the split-turn
	 * separator; `scripts/summary-grammar.ts` prints the frequency table that establishes this.
	 * Treating these three as unknown would put 3 of every 12 headings in the unknown bucket, i.e.
	 * a permanent 25% unknown rate on a corpus that is in fact perfectly regular — which would fire
	 * design §18 risk 3's 20% drift warning every single run and hide a real drift when one comes.
	 */
	provenance: "design" | "measured";
}

/**
 * The grammar, in the order the headings appear in a live summary.
 *
 * `Progress` is a container: the `###` subsections that follow it are split out as sections of
 * their own, so its own body is always empty. It is listed anyway, because a known heading with an
 * empty body must count as *known* — dropping it into the unknown bucket would be the same false
 * drift signal described above.
 */
export const SUMMARY_SECTION_GRAMMAR: readonly SummarySectionRule[] = [
	{ heading: "Goal", claimType: "PLAN", provenance: "design" },
	{ heading: "Constraints & Preferences", claimType: "CONSTRAINT", provenance: "design" },
	{ heading: "Progress", claimType: "PLAN", provenance: "design" },
	{ heading: "Done", claimType: "OBSERVATION", provenance: "design" },
	{ heading: "In Progress", claimType: "PLAN", provenance: "design" },
	{ heading: "Blocked", claimType: "PLAN", provenance: "design" },
	{ heading: "Key Decisions", claimType: "DECISION", provenance: "design" },
	{ heading: "Next Steps", claimType: "PLAN", provenance: "design" },
	{ heading: "Critical Context", claimType: "FACT", provenance: "design" },
	// The split-turn tail. `Original Request` restates the objective (PLAN), `Early Progress`
	// reports what already happened (OBSERVATION, exactly like `Done`), and `Context for Suffix`
	// carries the facts the next turn needs (FACT, exactly like `Critical Context`).
	{ heading: "Original Request", claimType: "PLAN", provenance: "measured" },
	{ heading: "Early Progress", claimType: "OBSERVATION", provenance: "measured" },
	{ heading: "Context for Suffix", claimType: "FACT", provenance: "measured" },
];

/** Lookup key for a heading: NFKC, unbolded, uncoloned, case- and whitespace-insensitive. */
export function headingKey(heading: string): string {
	return heading
		.normalize("NFKC")
		.replace(/\*\*/g, "")
		.replace(/\s+/gu, " ")
		.trim()
		// After trimming, not before: `**Key Decisions:**  ` only ends in a colon once the bold
		// markers and the trailing space are gone.
		.replace(/:$/, "")
		.trim()
		.toLowerCase();
}

export const SUMMARY_SECTION_RULES: ReadonlyMap<string, SummarySectionRule> = new Map(SUMMARY_SECTION_GRAMMAR.map((rule) => [headingKey(rule.heading), rule]));

/** Design §8.2 splits on `^##+ `; an `#` heading is therefore ordinary body text, not a section. */
const HEADING_LINE = /^(#{2,6})\s+(.*)$/;
const TOP_LEVEL_ITEM = /^(?:[-*+•]|\d{1,3}[.)])\s+/;

export interface SummaryBlock {
	kind: "item" | "prose";
	text: string;
	/** 0-based line offset of the block's first line within the whole artifact. */
	line: number;
}

export interface SummarySection {
	heading: string;
	level: number;
	line: number;
	blocks: SummaryBlock[];
	rule: SummarySectionRule | null;
}

/**
 * Splits a compaction summary into sections and each section into blocks.
 *
 * A block is either a top-level list item — its own line plus any *indented* continuation, which is
 * how nested bullets stay attached to the bullet they qualify — or a run of unindented prose. The
 * distinction matters because the live corpus contains all three shapes: sections that are pure
 * bullets, sections that are pure prose (`## Goal` is prose in 7 of 14 summaries), and sections
 * whose bullets are followed by a trailing `---` / `**Turn Context (split turn):**` separator or a
 * `<read-files>` path dump. Absorbing that trailing material into the last bullet would corrupt the
 * final claim of nearly every section; treating it as a claim of its own would file a directory
 * listing as a statement about the world.
 *
 * Anything above the first heading is returned under the empty heading, so a summary that has lost
 * its grammar still yields something rather than nothing.
 */
export function parseSummarySections(content: string): SummarySection[] {
	const lines = content.split(/\r?\n/);
	const sections: SummarySection[] = [];
	let current: SummarySection = { heading: "", level: 0, line: 0, blocks: [], rule: null };
	let block: SummaryBlock | null = null;
	let pending: string[] = [];

	const closeBlock = (): void => {
		if (block === null) return;
		const text = block.text.replace(/\s+$/u, "");
		if (text.trim().length > 0) current.blocks.push({ ...block, text });
		block = null;
		pending = [];
	};
	const closeSection = (): void => {
		closeBlock();
		if (current.heading.length > 0 || current.blocks.length > 0) sections.push(current);
	};

	lines.forEach((line, index) => {
		const heading = HEADING_LINE.exec(line);
		if (heading !== null) {
			closeSection();
			const title = (heading[2] ?? "").trim();
			current = { heading: title, level: (heading[1] ?? "##").length, line: index, blocks: [], rule: SUMMARY_SECTION_RULES.get(headingKey(title)) ?? null };
			return;
		}
		if (TOP_LEVEL_ITEM.test(line)) {
			closeBlock();
			block = { kind: "item", text: line, line: index };
			return;
		}
		const blank = line.trim().length === 0;
		if (block !== null && (blank || /^\s/u.test(line))) {
			// Blank lines are held back: they only belong to the block if indented content follows,
			// otherwise they are the gap before the next block and must not pad this one.
			if (blank) pending.push(line);
			else {
				block.text += `\n${[...pending, line].join("\n")}`;
				pending = [];
			}
			return;
		}
		if (block !== null && block.kind === "prose" && blank) {
			pending.push(line);
			return;
		}
		if (blank) {
			closeBlock();
			return;
		}
		if (block === null || block.kind === "item") {
			closeBlock();
			block = { kind: "prose", text: line, line: index };
			return;
		}
		block.text += `\n${[...pending, line].join("\n")}`;
		pending = [];
	});
	closeSection();
	return sections;
}

/** Strips the Markdown list syntax from a block's first line; the rest is the author's own text. */
function stripMarker(text: string): string {
	const lines = text.split("\n");
	const first = (lines[0] ?? "").replace(TOP_LEVEL_ITEM, "").replace(TASK_MARKER, "");
	return [first, ...lines.slice(1)].join("\n").trim();
}

/**
 * Which blocks of a known section become claims.
 *
 * Every top-level list item does. Prose does only when it is the section's whole content or when it
 * precedes the first list item — the shapes the corpus actually uses for a written-out `## Goal` or
 * `## Original Request`. Prose *after* the last item is the split-turn separator and the
 * `<read-files>` dump; it is counted (`droppedTrailingBlocks`) rather than either claimed or
 * silently discarded, so a grammar change that starts putting real content there is visible.
 */
function claimBlocks(section: SummarySection): { claimed: SummaryBlock[]; dropped: number } {
	const firstItem = section.blocks.findIndex((candidate) => candidate.kind === "item");
	if (firstItem < 0) return { claimed: section.blocks, dropped: 0 };
	const claimed = section.blocks.filter((candidate, index) => candidate.kind === "item" || index < firstItem);
	return { claimed, dropped: section.blocks.length - claimed.length };
}

/* ------------------------------------------------------------------------------------------------
 * Path 4 — excerpt windows over raw events
 * ---------------------------------------------------------------------------------------------- */

/** ±240 characters, the window design §18 prices at roughly 120 tokens against 1K for a whole event. */
export const EXCERPT_RADIUS = 240;

export interface Excerpt {
	text: string;
	start: number;
	end: number;
	/** `match` when a query term anchored the window, `head` when it was taken from the top. */
	anchor: "match" | "head";
}

/**
 * A deterministic window over an artifact.
 *
 * The anchor is the *first* occurrence of the *first* term that occurs at all — first by term
 * order, not by position — so the same terms over the same content always produce the same window
 * regardless of how the terms were collected. A recency retrieval, or a term set that matches
 * nothing, takes the head instead, which is honest about the fact that nothing in the artifact was
 * selected for.
 */
export function excerptFor(content: string, terms: readonly string[], mode: "match" | "head" = "match"): Excerpt {
	const width = EXCERPT_RADIUS * 2 + 1;
	if (mode === "head" || terms.length === 0) {
		const end = Math.min(content.length, width);
		return { text: withEllipses(content, 0, end), start: 0, end, anchor: "head" };
	}
	const haystack = content.toLowerCase();
	for (const term of terms) {
		const needle = term.toLowerCase();
		if (needle.length === 0) continue;
		const at = haystack.indexOf(needle);
		if (at < 0) continue;
		const start = Math.max(0, at - EXCERPT_RADIUS);
		const end = Math.min(content.length, at + needle.length + EXCERPT_RADIUS);
		return { text: withEllipses(content, start, end), start, end, anchor: "match" };
	}
	const end = Math.min(content.length, width);
	return { text: withEllipses(content, 0, end), start: 0, end, anchor: "head" };
}

/**
 * The ellipsis is a claim about the text: it says "this is a window, not the artifact". It cannot
 * affect identity — `normalizeClaimText` maps punctuation to whitespace and collapses it — so the
 * same passage reached from two different query terms still deduplicates.
 */
function withEllipses(content: string, start: number, end: number): string {
	return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

/* ------------------------------------------------------------------------------------------------
 * Extraction
 * ---------------------------------------------------------------------------------------------- */

export const EXTRACTION_PATHS = ["curated_memory", "compaction_summary", "raw_event"] as const;
export type ExtractionPath = (typeof EXTRACTION_PATHS)[number];

export interface ExtractionStats {
	envelopes: number;
	claims: number;
	byPath: Record<ExtractionPath, number>;
	/** Sections whose heading matched the grammar, including known-but-empty ones. */
	knownSections: number;
	/** Sections whose heading did not. Design §18 risk 3 asks for exactly this counter. */
	unknownSections: number;
	/** Per-heading breakdown of the above, so `/mnemosia status` can name the drift. */
	unknownHeadings: Record<string, number>;
	/** Trailing prose blocks inside a known section that produced no claim. */
	droppedTrailingBlocks: number;
	/** Envelopes whose `sourceType` matched no extraction path. Always 0 on the Phase 1 corpus. */
	unhandledEnvelopes: number;
}

export interface ClaimExtraction {
	claims: Claim[];
	stats: ExtractionStats;
}

export interface ExtractionOptions {
	/**
	 * The query terms the plan actually used. They anchor path 3's excerpt window; an empty set (or
	 * a recency retrieval, which the envelope reports itself) takes the head instead.
	 */
	terms?: readonly string[];
}

function emptyStats(): ExtractionStats {
	return {
		envelopes: 0,
		claims: 0,
		byPath: { curated_memory: 0, compaction_summary: 0, raw_event: 0 },
		knownSections: 0,
		unknownSections: 0,
		unknownHeadings: {},
		droppedTrailingBlocks: 0,
		unhandledEnvelopes: 0,
	};
}

function findOrigin<T extends { kind: string }>(envelope: ArtifactEnvelope, kind: T["kind"]): T | null {
	for (const entry of envelope.provenance) {
		if (entry !== null && typeof entry === "object" && (entry as { kind?: unknown }).kind === kind) return entry as T;
	}
	return null;
}

/**
 * AkashicForge's `kind` column → Mnemosia's `claimType` (design §8.1).
 *
 * An unrecognized kind becomes an OBSERVATION rather than defaulting to FACT: a memory kind nobody
 * has reviewed must not inherit the authority of one that was, which is the same rule an
 * adapter applies when it routes an unknown event kind to the least-trusted channel. The certainty
 * still reads CONFIRMED, because certainty here is a statement about *who wrote it* — a human
 * curating the vault — and that is true whatever the kind column says.
 */
export function claimTypeForMemoryKind(kind: string): ClaimType {
	switch (kind) {
		case "decisions":
			return "DECISION";
		case "preferences":
			return "PREFERENCE";
		case "procedures":
			return "PROCEDURE";
		case "project-state":
			return "FACT";
		case "open-loops":
			return "PLAN";
		case "people":
			return "FACT";
		default:
			return "OBSERVATION";
	}
}

const LIFECYCLE_LOOKUP: ReadonlySet<string> = new Set(LIFECYCLE_PRECEDENCE);

export function toLifecycle(state: string): LifecycleState | null {
	return LIFECYCLE_LOOKUP.has(state) ? (state as LifecycleState) : null;
}

/**
 * Certainty of a whole-artifact OBSERVATION, by the event kind that produced it (design §8.4).
 *
 * Tools observe and users assert, so both are PROBABLE; assistants speculate, so they are
 * SPECULATIVE. An unrecognized kind is UNKNOWN rather than being folded into the nearest neighbour.
 */
export function certaintyForEventKind(kind: string): Certainty {
	switch (kind) {
		case "user":
		case "tool":
			return "PROBABLE";
		case "assistant":
			return "SPECULATIVE";
		default:
			return "UNKNOWN";
	}
}

/** Extraction for a single envelope. Exported so tests and the trace can attribute per-artifact. */
export function extractFromEnvelope(envelope: ArtifactEnvelope, options: ExtractionOptions = {}): ClaimExtraction {
	const stats = emptyStats();
	stats.envelopes = 1;
	const claims: Claim[] = [];
	const push = (path: ExtractionPath, claim: Claim | null): void => {
		if (claim === null) return;
		claims.push(claim);
		stats.byPath[path] += 1;
	};

	switch (envelope.sourceType) {
		case "curated_memory": {
			const origin = findOrigin<AkashicMemoryOrigin>(envelope, "mnemosia/origin/akashic-memory");
			push(
				"curated_memory",
				materialize(envelope, {
					text: envelope.contentRef.inline,
					claimType: claimTypeForMemoryKind(origin?.memoryKind ?? ""),
					certainty: "CONFIRMED",
					locator: "whole",
					directness: "direct",
					// A curated memory's claim became effective when the row was last edited, not when
					// it was first written: freshness must reward the edit, or a maintained memory
					// would decay at the same rate as an abandoned one.
					effectiveAt: envelope.updatedAt,
					expiresAt: origin?.expiresAt ?? null,
					lifecycle: origin === null ? null : toLifecycle(origin.state),
					// Stored in artifact-id form. The column holds a bare memory id, which is an
					// AkashicForge identifier; converting it here means conflicts.ts (step 11) resolves
					// supersession against the same namespace every Evidence already points into.
					supersedes: origin?.supersedes ? [`akashic-memory:${origin.supersedes}`] : [],
				}),
			);
			break;
		}

		case "compaction_summary": {
			for (const section of parseSummarySections(envelope.contentRef.inline)) {
				if (section.rule === null) {
					stats.unknownSections += 1;
					const label = section.heading.length === 0 ? "(preamble)" : section.heading;
					stats.unknownHeadings[label] = (stats.unknownHeadings[label] ?? 0) + 1;
					// The whole section, honestly labelled. UNKNOWN certainty is the point: Mnemosia
					// does not know what this heading means, and says so instead of guessing a type.
					push(
						"compaction_summary",
						materialize(envelope, {
							text: section.blocks.map((entry) => entry.text).join("\n"),
							claimType: "OBSERVATION",
							certainty: "UNKNOWN",
							locator: `#${label}`,
							directness: "derived",
						}),
					);
					continue;
				}
				stats.knownSections += 1;
				const { claimed, dropped } = claimBlocks(section);
				stats.droppedTrailingBlocks += dropped;
				claimed.forEach((entry, index) => {
					push(
						"compaction_summary",
						materialize(envelope, {
							text: stripMarker(entry.text),
							claimType: section.rule?.claimType ?? "OBSERVATION",
							certainty: capCertainty("PROBABLE", SUMMARY_CERTAINTY_CEILING),
							locator: `#${section.heading}[${index}]`,
							// `derived` is what caps evidence strength at 0.4 in design §9. Every route
							// out of a summary takes it.
							directness: "derived",
						}),
					);
				});
			}
			break;
		}

		case "conversation_message":
		case "tool_output": {
			const origin = findOrigin<ConversationOrigin>(envelope, "mnemosia/origin/conversation");
			const eventKind = origin?.eventKind ?? (envelope.sourceType === "tool_output" ? "tool" : "");
			const terms = options.terms ?? [];
			const excerpt = excerptFor(envelope.contentRef.inline, terms, envelope.retrievalMethod === "recency_scan" ? "head" : "match");
			push(
				"raw_event",
				materialize(envelope, {
					text: excerpt.text,
					// One claim per artifact. See the file header on why this is not atomized.
					claimType: "OBSERVATION",
					certainty: certaintyForEventKind(eventKind),
					locator: `chars ${excerpt.start}-${excerpt.end}`,
					directness: "direct",
				}),
			);
			break;
		}

		default:
			stats.unhandledEnvelopes += 1;
			break;
	}

	stats.claims = claims.length;
	return { claims, stats };
}

function mergeStats(into: ExtractionStats, from: ExtractionStats): void {
	into.envelopes += from.envelopes;
	into.claims += from.claims;
	for (const path of EXTRACTION_PATHS) into.byPath[path] += from.byPath[path];
	into.knownSections += from.knownSections;
	into.unknownSections += from.unknownSections;
	for (const [heading, count] of Object.entries(from.unknownHeadings)) into.unknownHeadings[heading] = (into.unknownHeadings[heading] ?? 0) + count;
	into.droppedTrailingBlocks += from.droppedTrailingBlocks;
	into.unhandledEnvelopes += from.unhandledEnvelopes;
}

/** Extraction over a whole retrieval result. Order follows the envelopes, which the adapters sorted. */
export function extractClaims(envelopes: readonly ArtifactEnvelope[], options: ExtractionOptions = {}): ClaimExtraction {
	const stats = emptyStats();
	const claims: Claim[] = [];
	for (const envelope of envelopes) {
		const one = extractFromEnvelope(envelope, options);
		claims.push(...one.claims);
		mergeStats(stats, one.stats);
	}
	return { claims, stats };
}

/* ------------------------------------------------------------------------------------------------
 * Deduplication
 * ---------------------------------------------------------------------------------------------- */

export interface DedupResult {
	claims: Claim[];
	/** Input count, so a caller can report before/after without recounting. */
	before: number;
	after: number;
	/** How many input claims were folded into an existing one. */
	merged: number;
	/** How many surviving claims carry evidence from more than one artifact. */
	multiSourced: number;
}

function bestByPrecedence<T>(values: readonly T[], order: readonly T[]): T | undefined {
	let best: T | undefined;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const value of values) {
		const rank = order.indexOf(value);
		const effective = rank < 0 ? order.length : rank;
		if (effective < bestRank) {
			bestRank = effective;
			best = value;
		}
	}
	return best;
}

/**
 * "Identical `dedupKey` in compatible scope ⇒ one claim, evidence unioned, `certainty` = max,
 * earliest `effectiveAt`, all provenance kept" (design §8).
 *
 * The last clause is the one with teeth. Spec §23 requires deduplication that does not destroy
 * provenance, so a merged claim carries **every** contributing artifact's evidence — the union is
 * what makes `evidence_strength` (§9: `0.4·direct + 0.2·log2(1+supports)`) mean "how many
 * independent artifacts said this" instead of "which artifact happened to be read first".
 *
 * Scope compatibility is exact equality, and it is already folded into `claimId` (see `claimIdFor`),
 * so grouping by `claimId` *is* the scope check rather than a second one that could disagree with it.
 *
 * Output order is first appearance. The envelopes arrived in a total order the adapters imposed
 * (§16 determinism), so preserving it keeps the pipeline reproducible while staying readable.
 */
export function dedupeClaims(claims: readonly Claim[]): DedupResult {
	const groups = new Map<string, Claim[]>();
	const order: string[] = [];
	for (const claim of claims) {
		const existing = groups.get(claim.claimId);
		if (existing === undefined) {
			groups.set(claim.claimId, [claim]);
			order.push(claim.claimId);
		} else existing.push(claim);
	}

	const merged: Claim[] = [];
	for (const claimId of order) {
		const group = groups.get(claimId) ?? [];
		const base = group[0];
		if (base === undefined) continue;
		if (group.length === 1) {
			merged.push(base);
			continue;
		}

		const evidence = new Map<string, Evidence>();
		for (const member of group) for (const item of member.evidence) evidence.set(item.evidenceId, item);
		// A total order over the union, so two runs that read the same artifacts in different orders
		// still serialize byte-identically (§16).
		const evidenceList = [...evidence.values()].sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0));

		const supersedes = [...new Set(group.flatMap((member) => member.supersedes))].sort();
		const expiries = group.map((member) => member.expiresAt).filter((value): value is number => value !== null);
		const lifecycles = group.map((member) => member.lifecycle).filter((value): value is LifecycleState => value !== null);

		merged.push({
			...base,
			// The longest surviving text: two renderings of the same normalized sentence differ only
			// in the material normalization threw away, and the fuller one is the better quotation.
			text: group.reduce((longest, member) => (member.text.length > longest.length ? member.text : longest), base.text),
			claimType: bestByPrecedence(
				group.map((member) => member.claimType),
				CLAIM_TYPE_PRECEDENCE,
			) ?? base.claimType,
			certainty: group.reduce<Certainty>((best, member) => maxCertainty(best, member.certainty), "UNKNOWN"),
			effectiveAt: Math.min(...group.map((member) => member.effectiveAt)),
			// The earliest expiry wins: a claim that two sources bound differently stops being
			// retrievable at the first of those bounds, never the last.
			expiresAt: expiries.length === 0 ? null : Math.min(...expiries),
			lifecycle: bestByPrecedence(lifecycles, LIFECYCLE_PRECEDENCE) ?? null,
			supersedes,
			evidence: evidenceList,
		});
	}

	// "All provenance kept" is only a real property if it is measurable, so this counts the claims
	// that actually ended up standing on more than one artifact.
	const multiSourced = merged.filter((claim) => new Set(claim.evidence.map((item) => item.artifactId)).size > 1).length;

	return { claims: merged, before: claims.length, after: merged.length, merged: claims.length - merged.length, multiSourced };
}

// Ported from mnemosia/task.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Task analysis and scope authorization (spec §8 and §3, design §6, build-order step 7).
 *
 * Two functions, and the order between them is the point. Spec §3 says security authorization must
 * occur before relevance ranking — "a highly relevant memory that is unauthorized remains
 * unavailable" — so `authorizeScope` runs here, at state 3 of the machine, and produces the scope
 * set that `plan.ts` may query and `filters.ts` enforces. Nothing downstream can widen it, because
 * nothing downstream is given a way to.
 *
 * **Everything this module infers is labelled.** Spec §8 requires extracted information to be
 * classified CONFIRMED / PROBABLE / SPECULATIVE / UNKNOWN and forbids silently converting
 * speculation into retrieval fact. That is why every derived field is an `Extracted<T>` carrying a
 * certainty and the basis for it, rather than a bare value: a keyword rule that fired on one weak
 * match and a value the caller stated outright are different epistemic objects, and a briefing that
 * cannot tell them apart is exactly the failure §8's last line names.
 *
 * The rules are keyword tables and regular expressions. They are not clever, and pretending
 * otherwise by wrapping them in probabilistic language would misrepresent what they are; what they
 * are is deterministic, inspectable, and measurable against the §16 gold set.
 */

import { resolve } from "node:path";
import { SCHEMA_VERSION, scopeKey, type Certainty, type Scope, type ScopeAuthorizationSchema, type TaskAnalysisSchema } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Request
 * ---------------------------------------------------------------------------------------------- */

/** Design §16's four modes. Fast and Standard are `MVP_REQUIRED`; the other two are configured but unexercised in Phase 1. */
export const OPERATIONAL_MODES = ["fast", "standard", "deep", "high_assurance"] as const;
export type OperationalMode = (typeof OPERATIONAL_MODES)[number];

/** The §12 keyword rules produce exactly these. */
export const TASK_TYPES = ["plan", "implement", "debug", "review", "research", "recall", "status"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TEMPORAL_NEEDS = ["current_state", "recent", "historical", "any"] as const;
export type TemporalNeed = (typeof TEMPORAL_NEEDS)[number];

/**
 * What a caller hands Mnemosia. Spec §23: "accept a task, requesting agent, scope, mode, and
 * context budget" — those five, and nothing that would let a caller pre-empt a decision that
 * belongs to Mnemosia.
 *
 * `contextBudget` is supplied rather than measured because Pi exposes no live context occupancy to
 * a tool (design §17 ambiguity 3); it is treated as the equation's output, i.e. a hard ceiling.
 */
export interface BriefingRequest {
	runId: string;
	/** The requesting agent's own words. Never rewritten — only read. */
	task: string;
	requestingAgent: string;
	/** The session's working project, or `null` for a session with no repository. */
	project: string | null;
	contextBudget: number;
	mode?: OperationalMode;
	/**
	 * Projects the caller is explicitly asking to read beyond its own. This is the "explicitly
	 * requested" channel design §6's `INSUFFICIENT_AUTHORIZATION` turns on: a project path that
	 * merely *appears* in the task text is a mention, not a request.
	 */
	requestedProjects?: readonly string[];
	/** Overrides the keyword classifier when the caller already knows. Labelled CONFIRMED. */
	taskTypeHint?: TaskType;
	/** Injectable clock. The §16 determinism gate depends on this not being `Date.now` in tests. */
	now?: number;
}

/* ------------------------------------------------------------------------------------------------
 * Labelled extraction
 * ---------------------------------------------------------------------------------------------- */

/**
 * A value plus how much Mnemosia believes it and why.
 *
 * `basis` is prose for the trace rather than an enum, because the whole value of the field is that
 * a human reading `explainDecision` sees the actual rule that fired.
 */
export interface Extracted<T> {
	value: T;
	certainty: Certainty;
	basis: string;
}

function confirmed<T>(value: T, basis: string): Extracted<T> {
	return { value, certainty: "CONFIRMED", basis };
}

/* ------------------------------------------------------------------------------------------------
 * Task-type classification
 * ---------------------------------------------------------------------------------------------- */

/**
 * Keyword rules, in precedence order for ties.
 *
 * `debug` sits above `implement` because "fix the failing test" is a debugging task that happens to
 * involve editing code, and mis-filing it as implementation would cost it the known-failures
 * section that is the most useful thing memory can offer a debugger. `recall` and `status` sit last
 * because their keywords ("context", "summary", "progress") are common inside tasks that are really
 * about something else.
 */
export const TASK_TYPE_KEYWORDS: ReadonlyArray<{ type: TaskType; patterns: readonly RegExp[] }> = [
	{
		type: "debug",
		patterns: [/\bdebug\w*\b/iu, /\bbugs?\b/iu, /\berrors?\b/iu, /\bfail(?:s|ed|ing|ure)?\b/iu, /\bcrash\w*\b/iu, /\bbroken\b/iu, /\bregression\b/iu, /\bstack ?trace\b/iu, /\bexceptions?\b/iu, /\breproduce\b/iu, /\broot cause\b/iu, /\bfix(?:es|ed|ing)?\b/iu, /\bwhy (?:is|does|did|are)\b/iu],
	},
	{
		type: "review",
		patterns: [/\breview\w*\b/iu, /\baudit\w*\b/iu, /\bcritique\b/iu, /\bassess\w*\b/iu, /\bevaluat\w*\b/iu, /\bverif\w*\b/iu, /\bvalidat\w*\b/iu, /\binspect\w*\b/iu, /\bsecurity review\b/iu],
	},
	{
		type: "plan",
		patterns: [/\bplan\w*\b/iu, /\bdesign\w*\b/iu, /\barchitect\w*\b/iu, /\broadmap\b/iu, /\bstrateg\w*\b/iu, /\bapproach\b/iu, /\bpropos\w*\b/iu, /\boutline\b/iu, /\bdecompos\w*\b/iu, /\bshould we\b/iu],
	},
	{
		type: "implement",
		patterns: [/\bimplement\w*\b/iu, /\bbuild\w*\b/iu, /\bwrite\b/iu, /\brefactor\w*\b/iu, /\bmigrat\w*\b/iu, /\bwire (?:up|in)\b/iu, /\bship\b/iu, /\bintegrat\w*\b/iu, /\badd (?:a|an|the)\b/iu, /\bcreate (?:a|an|the)\b/iu],
	},
	{
		type: "research",
		patterns: [/\bresearch\w*\b/iu, /\binvestigat\w*\b/iu, /\bcompare\b/iu, /\bexplor\w*\b/iu, /\bfind out\b/iu, /\bsurvey\b/iu, /\bbenchmark\w*\b/iu, /\boptions\b/iu, /\bdocumentation\b/iu, /\bhow does\b/iu],
	},
	{
		type: "recall",
		patterns: [/\brecall\b/iu, /\bremember\b/iu, /\bremind\b/iu, /\bwhat did (?:we|i|you)\b/iu, /\bpreviously\b/iu, /\blast time\b/iu, /\bhistory\b/iu, /\bcatch me up\b/iu, /\bbrief me\b/iu, /\bprior (?:work|context|decisions?)\b/iu],
	},
	{
		type: "status",
		patterns: [/\bstatus\b/iu, /\bprogress\b/iu, /\bwhere (?:are|were) we\b/iu, /\bcurrent state\b/iu, /\bwhat(?:'s| is) left\b/iu, /\bdone so far\b/iu, /\bopen (?:loops|tasks|items)\b/iu, /\boutstanding\b/iu],
	},
];

/**
 * Highest keyword count wins; ties go to the earlier table entry.
 *
 * The certainty is the honest part. Two or more distinct rules firing is PROBABLE; a single rule is
 * SPECULATIVE, because one keyword in a long sentence is genuinely weak evidence; nothing firing is
 * UNKNOWN and falls back to `recall`, which is the least presumptuous reading of "an agent asked
 * the memory orchestrator for a briefing and did not say why".
 */
export function classifyTaskType(task: string): Extracted<TaskType> {
	let best: { type: TaskType; hits: number } = { type: "recall", hits: 0 };
	for (const rule of TASK_TYPE_KEYWORDS) {
		const hits = rule.patterns.filter((pattern) => pattern.test(task)).length;
		if (hits > best.hits) best = { type: rule.type, hits };
	}
	if (best.hits === 0) return { value: "recall", certainty: "UNKNOWN", basis: "no task-type keyword matched; defaulted to recall" };
	return {
		value: best.type,
		certainty: best.hits >= 2 ? "PROBABLE" : "SPECULATIVE",
		basis: `${best.hits} ${best.type} keyword rule${best.hits === 1 ? "" : "s"} matched`,
	};
}

/* ------------------------------------------------------------------------------------------------
 * Entity extraction
 * ---------------------------------------------------------------------------------------------- */

export const ENTITY_KINDS = ["path", "identifier", "quoted", "hash"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface TaskEntity {
	text: string;
	kind: EntityKind;
}

/**
 * Ordered because a Windows absolute path must be matched before the dotted-identifier rule gets to
 * chew on `store.ts`, and a backticked span must be matched before its contents are re-matched by
 * everything else. Each pattern's first capture group, when present, is the entity text.
 */
const ENTITY_PATTERNS: ReadonlyArray<{ kind: EntityKind; pattern: RegExp }> = [
	{ kind: "quoted", pattern: /`([^`\n]{2,120})`/gu },
	{ kind: "path", pattern: /\b([A-Za-z]:[\\/][^\s"'`,;)]+)/gu },
	// The lookbehind keeps the scan linear: a match may start only at the beginning of a run of path characters.
	{ kind: "path", pattern: /(?<![\w.@\/-])((?:\.{1,2}\/|\/)?(?:[\w.@-]+\/)+[\w.@-]+)/gu },
	{ kind: "hash", pattern: /\b([0-9a-f]{7,40})\b/gu },
	{ kind: "identifier", pattern: /\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]+)+)\b/gu },
	{ kind: "identifier", pattern: /\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/gu },
	{ kind: "identifier", pattern: /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/gu },
	{ kind: "identifier", pattern: /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gu },
];

/** Upper bound on entities carried forward. Beyond this the tail is noise, and it is reported. */
export const MAX_ENTITIES = 24;

/**
 * Path and identifier tokenization over the raw task text.
 *
 * Overlaps are resolved by claiming character spans: once a stretch of the task has been attributed
 * to an entity, a later pattern cannot re-attribute it. Without that, `src/adapters/store.ts`
 * would yield a path, a dotted identifier and a snake_case identifier for the same eleven
 * characters, and the entity count — which feeds a ranking signal — would measure regex overlap
 * instead of subject matter.
 */
export function extractEntities(task: string): Extracted<TaskEntity[]> {
	const claimed = new Uint8Array(task.length);
	const entities: TaskEntity[] = [];
	const seen = new Set<string>();

	for (const { kind, pattern } of ENTITY_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of task.matchAll(pattern)) {
			const text = match[1] ?? match[0];
			const start = match.index ?? 0;
			const end = start + match[0].length;
			if (claimed.subarray(start, end).some(Boolean)) continue;
			claimed.fill(1, start, end);
			const key = `${kind}:${text.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entities.push({ text, kind });
		}
	}

	const value = entities.slice(0, MAX_ENTITIES);
	if (value.length === 0) return { value, certainty: "UNKNOWN", basis: "no path, identifier, quoted span or hash found in the task text" };
	return {
		value,
		// A path or a backticked span is something the author typed deliberately; a bare camelCase
		// word could be ordinary English with a capital in it. The distinction is worth the label.
		certainty: value.some((entity) => entity.kind === "path" || entity.kind === "quoted" || entity.kind === "hash") ? "PROBABLE" : "SPECULATIVE",
		basis: `${value.length} entit${value.length === 1 ? "y" : "ies"} from ${new Set(value.map((entity) => entity.kind)).size} pattern class(es)${entities.length > value.length ? `; ${entities.length - value.length} beyond MAX_ENTITIES dropped` : ""}`,
	};
}

/* ------------------------------------------------------------------------------------------------
 * Terms
 * ---------------------------------------------------------------------------------------------- */

/**
 * The tokenizer the search index itself uses, supplied by injection.
 *
 * Design §9 requires relevance to be computed with "the store's own tokenizer", and the reason is
 * not tidiness: the FTS5 table is built with `unicode61 remove_diacritics 2`, so a term set produced
 * by any other splitter would score coverage against tokens the index does not contain. It arrives
 * by injection for the same reason the adapters' upstream handles do — see the note in
 * `filters.ts` on why nothing under `src/` reaches across drives.
 */
export type SearchTokenizer = (value: string) => string[];

/**
 * Removed before terms reach a query. AkashicForge's tokenizer keeps stopwords, and FTS5's default
 * operator is AND, so leaving `the` in a term list turns the query into "documents containing every
 * word of the sentence" — which on this corpus returns nothing at all. This list is deliberately
 * short and structural (articles, auxiliaries, prepositions, and the imperative verbs that appear
 * in nearly every task) rather than a general English stoplist, because a general stoplist would
 * also swallow domain words like `state` and `key`.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
	"a", "about", "all", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does", "for", "from", "get", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "just", "make", "me", "my", "need", "no", "not", "of", "on", "or", "our", "out", "over", "please", "should", "so", "some", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "up", "us", "use", "very", "want", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

/** Store-side cap (`tokenizeSearch` slices to 32); mirrored so the analysis never claims more. */
export const MAX_TERMS = 32;

/** Tokens shorter than this are almost always noise from a split identifier. */
const MIN_TERM_LENGTH = 3;

/**
 * The full content-term set for the task.
 *
 * This is *not* what goes into a query — `plan.ts` narrows it, because the store ANDs terms — but
 * it is what design §9's relevance signal measures coverage against, so it stays wide here.
 */
export function extractTerms(task: string, tokenize: SearchTokenizer): Extracted<string[]> {
	const raw = task.trim().length === 0 ? [] : tokenize(task);
	const value = raw.filter((token) => token.length >= MIN_TERM_LENGTH && !STOPWORDS.has(token.toLowerCase())).slice(0, MAX_TERMS);
	if (value.length === 0) return { value, certainty: "UNKNOWN", basis: raw.length === 0 ? "the task tokenized to nothing" : `all ${raw.length} token(s) were stopwords or shorter than ${MIN_TERM_LENGTH} characters` };
	return { value, certainty: "CONFIRMED", basis: `${value.length} content term(s) from ${raw.length} token(s) via the store's own tokenizer` };
}

/* ------------------------------------------------------------------------------------------------
 * Temporal requirements
 * ---------------------------------------------------------------------------------------------- */

export const DAY_MS = 86_400_000;

/**
 * Windows attached to each temporal need.
 *
 * They are short because the corpus is dense — 11,182 events over roughly a week of sessions — and
 * because a bound that admits everything is not a bound. `historical` and `any` deliberately have
 * no lower bound: "any" means the task gave no temporal signal, and inventing one would be exactly
 * the silent speculation spec §8 prohibits.
 */
export const TEMPORAL_WINDOW_DAYS: Readonly<Record<TemporalNeed, number | null>> = {
	current_state: 3,
	recent: 14,
	historical: null,
	any: null,
};

const TEMPORAL_PATTERNS: ReadonlyArray<{ need: TemporalNeed; pattern: RegExp }> = [
	{ need: "current_state", pattern: /\b(?:current(?:ly)?|latest|right now|as of now|today|present state|at the moment)\b/iu },
	{ need: "recent", pattern: /\b(?:recent(?:ly)?|yesterday|this (?:week|session)|last (?:session|run|week)|just (?:now|did|finished))\b/iu },
	{ need: "historical", pattern: /\b(?:origin(?:al|ally)|history|historical|ever|all time|first time|back (?:then|when)|why did we (?:originally|first))\b/iu },
];

export function classifyTemporalNeed(task: string): Extracted<TemporalNeed> {
	const matched = TEMPORAL_PATTERNS.filter((rule) => rule.pattern.test(task));
	const first = matched[0];
	if (first === undefined) return { value: "any", certainty: "UNKNOWN", basis: "no temporal marker in the task text" };
	// More than one marker means the task spans time rather than pointing at an instant; widening to
	// `historical` is the safe reading, because a narrow window cannot be reopened later in the run.
	if (matched.length > 1) return { value: "historical", certainty: "SPECULATIVE", basis: `${matched.length} conflicting temporal markers; widened to historical` };
	return { value: first.need, certainty: "PROBABLE", basis: `temporal marker matched ${first.need}` };
}

/* ------------------------------------------------------------------------------------------------
 * Early-exit detection
 * ---------------------------------------------------------------------------------------------- */

/**
 * Phrases that make "no memory required" a stated fact rather than an inference.
 */
const NO_MEMORY_MARKERS = /\b(?:no memory|without memory|no prior context|ignore (?:prior|previous) context|from scratch|self[- ]contained|standalone task)\b/iu;

/** Social turns and bare arithmetic: complete in themselves, and retrieval would only add noise. */
const TRIVIAL_TASK = /^\s*(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure)\b[\s!.?]*$/iu;
const PURE_ARITHMETIC = /^[\s\d+\-*/().^%=]+\??$/u;

/**
 * A task built entirely out of referents and fillers — "that one again", "do the thing" — names
 * nothing Mnemosia can retrieve on. The antecedent is in the caller's head, not in the request, and
 * guessing at it from the most recent event would be exactly the kind of plausible wrong answer a
 * memory orchestrator exists to avoid. The word list is closed and short on purpose: one content
 * word anywhere in the task defeats it.
 */
const BARE_REFERENT = /^(?:\s*(?:that|this|it|its|them|they|those|these|the|a|an|same|again|one|ones|thing|things|stuff|please|do|it's|now|too|also)\b[\s.,;?!]*)+$/iu;

/** Below this a "task" is a fragment, not a request. Chosen to admit `fix the CI` (10) and reject `?`. */
export const MIN_TASK_CHARS = 8;

/* ------------------------------------------------------------------------------------------------
 * Analysis
 * ---------------------------------------------------------------------------------------------- */

export const TASK_OUTCOMES = ["PROCEED", "NO_MEMORY_REQUIRED", "CLARIFICATION_REQUIRED"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export interface TaskAnalysis {
	schemaVersion: TaskAnalysisSchema;
	runId: string;
	/** The caller's words, trimmed. Spec §8's "current objective", not a paraphrase of it. */
	objective: string;
	requestingAgent: string;
	taskType: Extracted<TaskType>;
	entities: Extracted<TaskEntity[]>;
	terms: Extracted<string[]>;
	temporalNeed: Extracted<TemporalNeed>;
	/** Absolute epoch-ms bounds derived from `temporalNeed`. `null` means unbounded. */
	since: number | null;
	until: number | null;
	/** Spec §8: "whether historical information matters" / "whether user preferences matter". */
	historyMatters: Extracted<boolean>;
	preferencesMatter: Extracted<boolean>;
	/** Supplied by the caller, never inferred; a hard ceiling (design §10). */
	contextBudget: Extracted<number>;
	mode: Extracted<OperationalMode>;
	/** Spec §8 "required assurance level". High-assurance mode fails closed on unverified integrity. */
	assurance: Extracted<"standard" | "high">;
	/** The session's own project, normalized the way AkashicForge normalizes it. */
	project: Extracted<string | null>;
	requestedProjects: Extracted<string[]>;
	outcome: TaskOutcome;
	/** Why the outcome is what it is. Always at least one entry, including for PROCEED. */
	reasons: string[];
	analyzedAt: number;
}

export interface AnalyzeTaskDeps {
	tokenize: SearchTokenizer;
}

/**
 * AkashicForge normalizes a project path as `resolve(trim(p))`, lowercased on win32
 * (store.ts:367-370). That function is not exported, so it is mirrored here rather than injected —
 * and mirrored exactly, because a scope string that differs by one character from the stored one
 * silently matches no rows, which looks like an empty corpus rather than like a bug.
 *
 * `test/task.test.ts` pins the mirror against the project strings the live database actually holds.
 */
export function normalizeProjectPath(project: string): string {
	const normalized = resolve(project.trim());
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function analyzeTask(request: BriefingRequest, deps: AnalyzeTaskDeps): TaskAnalysis {
	const now = request.now ?? Date.now();
	const objective = request.task.trim();
	const mode: OperationalMode = request.mode ?? "standard";

	const taskType = request.taskTypeHint === undefined ? classifyTaskType(objective) : confirmed(request.taskTypeHint, "supplied by the requesting agent");
	const entities = extractEntities(objective);
	const terms = extractTerms(objective, deps.tokenize);
	const temporalNeed = classifyTemporalNeed(objective);
	const windowDays = TEMPORAL_WINDOW_DAYS[temporalNeed.value];

	const project = request.project === null ? confirmed<string | null>(null, "the caller reported no working project") : confirmed<string | null>(normalizeProjectPath(request.project), "supplied by the caller, normalized as AkashicForge stores it");
	const requestedProjects = confirmed(
		[...new Set((request.requestedProjects ?? []).map(normalizeProjectPath))].sort(),
		(request.requestedProjects ?? []).length === 0 ? "the caller requested no additional project scope" : "explicitly requested by the caller",
	);

	// Both of these are derived from the task type rather than from separate keyword tables. A
	// second table would be a second thing to keep consistent with the first, and there is no
	// evidence in the corpus that it would classify better.
	const historyMatters: Extracted<boolean> = {
		value: taskType.value !== "implement" || temporalNeed.value === "historical",
		certainty: taskType.certainty,
		basis: `derived from taskType=${taskType.value}, temporalNeed=${temporalNeed.value}`,
	};
	const preferencesMatter: Extracted<boolean> = {
		value: taskType.value !== "status",
		certainty: taskType.certainty,
		basis: `derived from taskType=${taskType.value}; only a pure status read ignores standing preferences`,
	};

	const reasons: string[] = [];
	let outcome: TaskOutcome = "PROCEED";

	if (objective.length === 0) {
		outcome = "CLARIFICATION_REQUIRED";
		reasons.push("the task is empty");
	} else if (NO_MEMORY_MARKERS.test(objective)) {
		outcome = "NO_MEMORY_REQUIRED";
		reasons.push("the task states that no prior context is to be used");
	} else if (TRIVIAL_TASK.test(objective) || PURE_ARITHMETIC.test(objective)) {
		outcome = "NO_MEMORY_REQUIRED";
		reasons.push("the task is self-contained (a social turn or a bare arithmetic expression); retrieval could only add noise");
	} else if (BARE_REFERENT.test(objective)) {
		outcome = "CLARIFICATION_REQUIRED";
		reasons.push("the task is a bare referent with no antecedent Mnemosia can resolve");
	} else if (objective.length < MIN_TASK_CHARS) {
		outcome = "CLARIFICATION_REQUIRED";
		reasons.push(`the task is ${objective.length} characters, below the ${MIN_TASK_CHARS}-character floor for a usable request`);
	} else if (terms.value.length === 0 && entities.value.length === 0) {
		outcome = "CLARIFICATION_REQUIRED";
		reasons.push("the task yielded no content terms and no entities, so there is nothing to retrieve on");
	} else {
		reasons.push(`taskType=${taskType.value} (${taskType.certainty}), ${terms.value.length} term(s), ${entities.value.length} entit(y|ies), temporal=${temporalNeed.value}`);
	}

	if (!Number.isInteger(request.contextBudget) || request.contextBudget <= 0) {
		outcome = "CLARIFICATION_REQUIRED";
		reasons.push(`contextBudget must be a positive integer; received ${String(request.contextBudget)}`);
	}

	return {
		schemaVersion: SCHEMA_VERSION.taskAnalysis satisfies TaskAnalysisSchema,
		runId: request.runId,
		objective,
		requestingAgent: request.requestingAgent,
		taskType,
		entities,
		terms,
		temporalNeed,
		since: windowDays === null ? null : now - windowDays * DAY_MS,
		until: null,
		historyMatters,
		preferencesMatter,
		contextBudget: confirmed(request.contextBudget, "supplied by the caller; Pi exposes no live context occupancy to a tool"),
		mode: request.mode === undefined ? { value: mode, certainty: "SPECULATIVE", basis: "no mode supplied; defaulted to standard" } : confirmed(mode, "supplied by the caller"),
		assurance: mode === "high_assurance" ? confirmed<"standard" | "high">("high", "high_assurance mode") : confirmed<"standard" | "high">("standard", "derived from mode"),
		project,
		requestedProjects,
		outcome,
		reasons,
		analyzedAt: now,
	};
}

/* ------------------------------------------------------------------------------------------------
 * Scope authorization
 * ---------------------------------------------------------------------------------------------- */

export const AUTHORIZATION_RULES = ["own_project", "global_scope", "explicitly_requested", "cross_project_not_requested", "unresolved_project_scope"] as const;
export type AuthorizationRuleId = (typeof AUTHORIZATION_RULES)[number];

export interface ScopeRefusal {
	scope: Scope;
	ruleId: AuthorizationRuleId;
	detail: string;
}

export interface ScopeGrant {
	scope: Scope;
	ruleId: AuthorizationRuleId;
	detail: string;
}

export interface ScopeAuthorization {
	schemaVersion: ScopeAuthorizationSchema;
	runId: string;
	outcome: "AUTHORIZED" | "INSUFFICIENT_AUTHORIZATION";
	granted: ScopeGrant[];
	refused: ScopeRefusal[];
	/** Fast membership test for filters.ts, computed once here so the two can never disagree. */
	authorizedKeys: string[];
	reasons: string[];
}

/** A path entity long enough and absolute enough to be a project root rather than a file inside one. */
function looksLikeProjectRoot(text: string): boolean {
	return /^[A-Za-z]:[\\/]/u.test(text) || text.startsWith("/");
}

/**
 * Resolves the scopes this run may read (spec §3, design §12's first hard filter).
 *
 * The rules, in full:
 *
 * - **Global is always granted.** It is the user's own vault on a single-user machine; there is no
 *   second tenant it could leak to (design §2 drops tenancy for exactly this reason).
 * - **The session's own project is granted.** That is the implicit authority of working in a repo.
 * - **Any other project is granted only if the caller explicitly requested it.** A project path
 *   that merely *appears* in the task text is a mention — "the fix we made in D:\Threadweaver" —
 *   and reading that project's memory on the strength of a mention is precisely the cross-project
 *   leak spec §4 forbids.
 * - **The run exits `INSUFFICIENT_AUTHORIZATION`** when something was refused and nothing
 *   project-scoped was granted: the task is about a project Mnemosia may not read, and answering
 *   from global memory alone would look like an answer while being about the wrong thing. Failing
 *   closed is the only honest option, and it is decided here, before anything is ranked.
 */
export function authorizeScope(analysis: TaskAnalysis): ScopeAuthorization {
	const granted: ScopeGrant[] = [{ scope: { level: "global", project: null }, ruleId: "global_scope", detail: "global memory is the requesting user's own vault on a single-user machine" }];
	const refused: ScopeRefusal[] = [];
	const reasons: string[] = [];

	const own = analysis.project.value;
	if (own !== null) granted.push({ scope: { level: "project", project: own }, ruleId: "own_project", detail: `the session's working project (${own})` });

	const requested = new Set(analysis.requestedProjects.value);
	for (const project of analysis.requestedProjects.value) {
		if (project === own) continue;
		granted.push({ scope: { level: "project", project }, ruleId: "explicitly_requested", detail: `explicitly requested cross-project read of ${project}` });
	}

	// Project paths the task text merely mentions.
	const mentioned = new Set<string>();
	for (const entity of analysis.entities.value) {
		if (entity.kind !== "path" || !looksLikeProjectRoot(entity.text)) continue;
		mentioned.add(normalizeProjectPath(entity.text));
	}
	for (const project of [...mentioned].sort()) {
		if (project === own || requested.has(project)) continue;
		// A mentioned path is usually a *file* inside the session's own project, which is not a
		// cross-project read at all and must not be reported as a refusal.
		if (own !== null && project.startsWith(`${own}\\`)) continue;
		if (own !== null && project.startsWith(`${own}/`)) continue;
		refused.push({ scope: { level: "project", project }, ruleId: "cross_project_not_requested", detail: `${project} appears in the task text but was not explicitly requested` });
	}

	if (own === null && requested.size === 0 && analysis.taskType.value !== "recall" && mentioned.size > 0) {
		reasons.push("no working project was supplied; only global scope is available");
	}

	const projectGrants = granted.filter((grant) => grant.scope.level === "project");
	const outcome: ScopeAuthorization["outcome"] = refused.length > 0 && projectGrants.length === 0 ? "INSUFFICIENT_AUTHORIZATION" : "AUTHORIZED";
	if (outcome === "INSUFFICIENT_AUTHORIZATION") {
		reasons.push(`the task is scoped to ${refused.map((entry) => entry.scope.project).join(", ")}, which was not explicitly requested, and no project scope is authorized for this run`);
	} else {
		reasons.push(`${granted.length} scope(s) granted, ${refused.length} refused`);
	}

	return {
		schemaVersion: SCHEMA_VERSION.scopeAuthorization satisfies ScopeAuthorizationSchema,
		runId: analysis.runId,
		outcome,
		granted,
		refused,
		// Built from the same `scopeKey` filters.ts tests membership with. Two definitions of scope
		// identity would be two chances to disagree about what is authorized.
		authorizedKeys: outcome === "AUTHORIZED" ? granted.map((grant) => scopeKey(grant.scope)) : [],
		reasons,
	};
}

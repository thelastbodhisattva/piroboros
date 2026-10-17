// Ported from mnemosia/types.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Mnemosia's domain model: the vocabulary every later module is written against.
 *
 * Three rules shape this file.
 *
 * 1. Every persisted or exchanged object carries `schemaVersion: "mnemosia/<entity>@1"`, so a
 *    consumer never has to guess which generation of a shape it is holding (design §7).
 * 2. The trust boundary is expressed in the type system, not in review comments. `SYSTEM_POLICY`
 *    and `AGENT_POLICY` are members of `Channel` but not of `AdapterChannel`, which is the only
 *    channel type an `ArtifactEnvelope` accepts — so an adapter emitting a policy channel is a
 *    compile error, not a runtime check that someone might forget to write (design §5).
 * 3. Fields the spec asks for that this corpus cannot honestly supply are dropped *in writing*,
 *    with the reason, rather than stubbed with a placeholder value. See DROPPED_ARTIFACT_FIELDS.
 *
 * Nothing here imports from the foundations. Mnemosia's domain model must not be a re-export of
 * AkashicForge's, or the adapters would stop being a boundary; the one exception the
 * design allows is `MemoryRecord`, which stays AkashicForge's type and is imported where it is
 * actually used (writes.ts, later) rather than mirrored here.
 */

/* ------------------------------------------------------------------------------------------------
 * Schema versions
 * ---------------------------------------------------------------------------------------------- */

/** One place to bump. A shape change that a consumer must notice changes the string here. */
export const SCHEMA_VERSION = {
	artifactEnvelope: "mnemosia/artifact-envelope@1",
	claim: "mnemosia/claim@1",
	evidence: "mnemosia/evidence@1",
	contextItem: "mnemosia/context-item@1",
	traceEvent: "mnemosia/trace-event@1",
	plannedQuery: "mnemosia/planned-query@1",
	taskAnalysis: "mnemosia/task-analysis@1",
	scopeAuthorization: "mnemosia/scope-authorization@1",
	retrievalPlan: "mnemosia/retrieval-plan@1",
	/* --- Phase 5 ------------------------------------------------------------------------------- */
	/** A recorded run's re-executable inputs (design §10's `replayOrchestration`). See `replay.ts`. */
	replayCapsule: "mnemosia/replay-capsule@1",
	/** The observable outcome of a run, comparable across policy versions. See `replay.ts`. */
	runFingerprint: "mnemosia/run-fingerprint@1",
	/** A run bound to a named policy-registry version rather than to the current one. See `rollback.ts`. */
	policyPin: "mnemosia/policy-pin@1",
	/** Spec §22's eight-field change record. See `rollback.ts`. */
	policyChangePacket: "mnemosia/policy-change-packet@1",
	/** The Phase 5 reranking activation switch, off by default. See `rerank.ts`. */
	rerankGate: "mnemosia/rerank-gate@1",
	/* --- Phase B: situation and intent ------------------------------------------------------- */
	/** Spec Stage 2's tiered situation analysis. See `situation.ts`. */
	situationContext: "mnemosia/situation-context@1",
	/** Spec Stage 3's bounded intent hypothesis set. See `intent.ts`. */
	intentHypothesisSet: "mnemosia/intent-hypothesis-set@1",
	/** Knowledge requirements derived from situation + intent. See `requirements.ts`. */
	knowledgeRequirements: "mnemosia/knowledge-requirements@1",
	/* --- Phase D: graph and specialist reuse -------------------------------------------------- */
	/** Per-claim producing/requesting seat lineage recorded on every run's trace. See `trace.ts`. */
	agentLineage: "mnemosia/agent-lineage@1",
} as const;

export type ArtifactEnvelopeSchema = typeof SCHEMA_VERSION.artifactEnvelope;
export type ClaimSchema = typeof SCHEMA_VERSION.claim;
export type EvidenceSchema = typeof SCHEMA_VERSION.evidence;
export type ContextItemSchema = typeof SCHEMA_VERSION.contextItem;
export type TraceEventSchema = typeof SCHEMA_VERSION.traceEvent;
export type PlannedQuerySchema = typeof SCHEMA_VERSION.plannedQuery;
export type TaskAnalysisSchema = typeof SCHEMA_VERSION.taskAnalysis;
export type ScopeAuthorizationSchema = typeof SCHEMA_VERSION.scopeAuthorization;
export type RetrievalPlanSchema = typeof SCHEMA_VERSION.retrievalPlan;

/* ------------------------------------------------------------------------------------------------
 * Channels — the trust boundary, enforced structurally
 * ---------------------------------------------------------------------------------------------- */

/**
 * Channels that originate inside the process and carry instruction authority. They are produced by
 * Mnemosia, the host, or the live user turn. Retrieved bytes may never be labelled with one of
 * these: that relabelling is precisely how a poisoned memory would acquire the authority to be
 * obeyed instead of merely read.
 *
 * `USER_DIRECTIVE` sits here rather than with the adapter channels because it means *the user is
 * saying this now*. A stored user message that Mnemosia retrieves is evidence about what a user
 * once said, which is `RETRIEVED_EVIDENCE`, and the distinction is the whole point of the split.
 */
export const PRIVILEGED_CHANNELS = ["SYSTEM_POLICY", "AGENT_POLICY", "USER_DIRECTIVE"] as const;
export type PrivilegedChannel = (typeof PRIVILEGED_CHANNELS)[number];

/**
 * The complete set of channels a source adapter is permitted to emit. `ArtifactEnvelope.channel`
 * is typed as this, not as `Channel`, which is what makes the §5 guarantee mechanical.
 */
export const ADAPTER_CHANNELS = ["RETRIEVED_EVIDENCE", "TOOL_OBSERVATION", "EXTERNAL_CONTENT"] as const;
export type AdapterChannel = (typeof ADAPTER_CHANNELS)[number];

/** The six-way enum required on every ContextItem (design §12). */
export const CHANNELS = [...PRIVILEGED_CHANNELS, ...ADAPTER_CHANNELS] as const;
export type Channel = PrivilegedChannel | AdapterChannel;

/**
 * A compile-time proof, not documentation.
 *
 * `Impossible<T>` only accepts `never`. If `AdapterChannel` ever gained a privileged member, the
 * `Extract` below would evaluate to that member instead of `never` and this file would stop
 * compiling — which is the design's requirement that an adapter emitting `SYSTEM_POLICY` or
 * `AGENT_POLICY` be a compile error rather than a code-review finding.
 */
export type Impossible<T extends never> = T;
export type AdaptersCannotEmitPrivilegedChannels = Impossible<Extract<AdapterChannel, PrivilegedChannel>>;

/* ------------------------------------------------------------------------------------------------
 * Scope
 * ---------------------------------------------------------------------------------------------- */

/** Storage-level scope. AkashicForge offers exactly these two; Mnemosia does not invent a third. */
export type ScopeLevel = "global" | "project";

/**
 * `branch` and `environment` are *claim qualifiers*, never storage boundaries (design §2). They are
 * optional because no column in either foundation carries them: they are extracted, in Phase 2,
 * behind a measurement gate, and are used for conflict classification only — never hard filtering.
 */
export interface Scope {
	level: ScopeLevel;
	/** Normalized absolute path, exactly as AkashicForge stores it. `null` for global scope. */
	project: string | null;
	branch?: string;
	environment?: string;
}

/**
 * A total, stable string identity for a scope.
 *
 * Three modules need to compare scopes for exact equality — claims.ts folds it into `claimId` so
 * that the same sentence in two projects cannot collapse into one claim, task.ts builds the
 * authorized set out of it, and filters.ts tests membership in that set. All three must agree
 * byte-for-byte or the isolation invariant (spec §4, "project … scopes must not leak into one
 * another") would hold in one module and not the next, so the definition lives here, once.
 *
 * The Phase 2 qualifiers are included even though nothing populates them yet: adding them later
 * would silently change every `claimId` ever recorded, which is a schema bump, not a patch.
 */
export function scopeKey(scope: Scope): string {
	return [scope.level, scope.project ?? "", scope.branch ?? "", scope.environment ?? ""].join("\u001f");
}

/* ------------------------------------------------------------------------------------------------
 * ArtifactEnvelope (design §7, spec §10)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Spec §10 fields Mnemosia deliberately does not carry. Recorded here, and not silently omitted,
 * because "the field is absent" and "the field was considered and rejected for this reason" are
 * different engineering claims and only the second one is honest.
 *
 * This constant is exported so a future reviewer diffing the spec against the code finds the
 * answer in the code rather than in a document that may have drifted.
 */
export const DROPPED_ARTIFACT_FIELDS = {
	/**
	 * spec §10 `tenant` / `user`. Dropped: single user, single machine, and neither foundation has a
	 * tenancy column. Synthesizing a constant tenant id would create the appearance of isolation
	 * machinery that does not exist, which is worse than its absence (design §2, §3 PROHIBITED).
	 */
	tenant: "no tenancy exists in either foundation; a constant value would fake isolation",
	user: "single-user machine; AkashicForge stores no actor on a memory row, only on a mutation",
	/**
	 * spec §10 `access_policy`. Dropped: there is no per-record ACL anywhere in the corpus. Access
	 * control here is the lifecycle state plus the scope filter, and both are already modelled.
	 */
	access_policy: "no per-record ACL exists; lifecycle state and scope are the real access controls",
	/**
	 * spec §10 `repository_scope`. Dropped as a separate field: AkashicForge's `project` already IS
	 * the repository, stored as a normalized absolute path. Two fields holding the same string would
	 * be two things to keep in sync and one more chance to disagree.
	 */
	repository_scope: "identical to scope.project, which is already a normalized absolute repo path",
} as const;

/** Which source, and which of its surfaces, produced an envelope. */
export const SOURCE_ID = {
	akashicMemories: "akashic-memories",
} as const;

/**
 * Deliberately a plain string rather than a union of the known values: §9 of the spec calls
 * for replaceable adapters, and a closed union would make adding another a change to the domain
 * model instead of a change to a plug-in. The constant above is the one source that ships.
 */
export type SourceId = string;

/** What kind of thing the artifact is, independent of which provider stored it. */
export const SOURCE_TYPES = ["curated_memory", "conversation_message", "tool_output", "compaction_summary"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * `verified` requires a check that actually ran and passed. `unverified` means no integrity claim
 * is available for this source — it is not a synonym for "probably fine". `failed` is hard-filtered
 * before ranking and can never be resurrected by relevance (design §12).
 */
export const INTEGRITY_STATUSES = ["verified", "unverified", "failed"] as const;
export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

/**
 * Provider-neutral by construction. "fts5" and "bm25" are implementation
 * details of a source; the domain only needs to know how the artifact was found, because that is
 * what ranking and the audit trail reason about.
 */
export const RETRIEVAL_METHODS = ["lexical_search", "recency_scan", "id_lookup", "structured_enumeration"] as const;
export type RetrievalMethod = (typeof RETRIEVAL_METHODS)[number];

/** Content crosses the trust boundary once, inline, and is hashed on the way through (design §5). */
export interface ContentRef {
	inline: string;
}

/**
 * The single shape every adapter returns. Everything downstream — claims, filters, ranking,
 * selection, briefing — reads this and never the provider's own row type.
 */
export interface ArtifactEnvelope {
	schemaVersion: ArtifactEnvelopeSchema;
	/** `akashic-memory:<uuid>` for curated memory; other adapters define their own prefix. */
	artifactId: string;
	sourceId: SourceId;
	sourceType: SourceType;
	/** Stable upstream locator, e.g. `akashic-forge/memories/<uuid>`. Human-readable on purpose. */
	sourceRef: string;
	contentRef: ContentRef;
	/** sha256 of `contentRef.inline`, computed by Mnemosia — never copied from the provider. */
	contentHash: string;
	createdAt: number;
	updatedAt: number;
	/** When *this run* observed the artifact. Distinct from updatedAt, which is the source's clock. */
	observedAt: number;
	scope: Scope;
	/**
	 * spec §10 `task_scope`: which unit of work the artifact belongs to. A conversation
	 * turn carries a `sessionId`; a curated memory belongs to no single task and is therefore
	 * `null`, which is a fact about curated memory, not a gap.
	 */
	taskScope: string | null;
	/** Constant in Phase 1: everything in both foundations is local, internal, single-user data. */
	classification: "internal";
	/** Adapter channels only. See AdaptersCannotEmitPrivilegedChannels above. */
	channel: AdapterChannel;
	/**
	 * Everything the source row carried that the envelope's own fields do not model, so a read never
	 * drops a provenance field (AkashicForge's api.ts states the same obligation). `unknown[]`
	 * because provenance is open-world; the `*Origin` interfaces below document what Phase 1 puts
	 * in the first slot.
	 */
	provenance: unknown[];
	integrityStatus: IntegrityStatus;
	retrievalMethod: RetrievalMethod;
	/**
	 * The source's **own** relevance score for the query that produced this artifact, raw and
	 * un-normalized, or `null` when the source published none.
	 *
	 * **The bm25 foundation change landed here.** Phase 1 read: *"null throughout Phase 1. Neither
	 * foundation exposes a relevance score today — AkashicForge computes bm25 inside FTS5 and
	 * discards it."* `store.ts` now returns that number as `MemoryRecord.rank`
	 * on its full-text path, and the Akashic memories adapter carries it here.
	 *
	 * Three properties a reader has to know, because they are what stop this being mistaken for a
	 * [0,1] signal:
	 *
	 * 1. **It is SQLite's raw `bm25()`, so it is negative and more negative is better.** No sign flip
	 *    happens at the adapter, because a value that has been transformed is no longer the value the
	 *    store computed and could not be checked against it.
	 * 2. **It is `null` on every non-full-text read** — a recency scan or an id read — because
	 *    bm25 is undefined without a MATCH. `null` here means *no score was published*, never *scored
	 *    zero*, and `rank.ts` branches on exactly that distinction to choose its deterministic
	 *    fallback.
	 * 3. **It is per-query and per-index, so it is not comparable across sources or runs.**
	 *    `rank.ts:normalizeRetrievalScores` is the only place it is turned into a signal, and it
	 *    normalizes within one source's result set for precisely this reason.
	 */
	retrievalScore: number | null;
	tokenEstimate: number;
}

/* ------------------------------------------------------------------------------------------------
 * Provenance payloads
 * ---------------------------------------------------------------------------------------------- */

/**
 * First provenance entry an AkashicForge memory envelope carries. It exists because the governance
 * columns (state, version, importance, tags, expiry, supersession) are inputs to hard filtering and
 * to three of the seven ranking signals, and the envelope has no other place to keep them without
 * growing provider-specific fields — which §10 forbids.
 */
export interface AkashicMemoryOrigin {
	kind: "mnemosia/origin/akashic-memory";
	memoryId: string;
	memoryKind: string;
	state: string;
	version: number;
	importance: number;
	tags: string[];
	expiresAt: number | null;
	supersedes: string | null;
	/** The hash the row stores, kept beside the one Mnemosia recomputed, so a failure is auditable. */
	storedContentHash: string | null;
}

/** Origin of a conversation turn or tool output: session, event kind and the source's truncation flag matter later. */
export interface ConversationOrigin {
	kind: "mnemosia/origin/conversation";
	eventId: number;
	eventKind: string;
	fingerprint: string;
	sessionId: string | null;
	/** True when the source itself clipped the event on the way in. */
	truncatedBySource: boolean;
	metadata: Record<string, unknown>;
}

/** Recorded on the envelope when an integrity check ran and failed, so "why" survives the filter. */
export interface IntegrityViolationEntry {
	kind: "mnemosia/integrity-violation";
	violations: string[];
	expectedContentHash: string | null;
	computedContentHash: string;
}

/* ------------------------------------------------------------------------------------------------
 * Claim / Evidence (design §7, spec §5.2–5.3)
 * ---------------------------------------------------------------------------------------------- */

export const CLAIM_TYPES = ["FACT", "OBSERVATION", "DECISION", "CONSTRAINT", "PLAN", "PREFERENCE", "PROCEDURE", "HYPOTHESIS"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const CERTAINTIES = ["CONFIRMED", "PROBABLE", "SPECULATIVE", "UNKNOWN"] as const;
export type Certainty = (typeof CERTAINTIES)[number];

export const EVIDENCE_RELATIONS = ["SUPPORTS", "CONTRADICTS", "SUPERSEDES", "QUALIFIES", "TEMPORAL_BOUND"] as const;
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];

/** `derived` means the claim reached us through a summary, which caps its evidence strength (§9). */
export type EvidenceDirectness = "direct" | "derived";

/** AkashicForge's lifecycle vocabulary, mirrored because a Claim may carry one and `null` otherwise. */
export const LIFECYCLE_STATES = ["PROPOSED", "ACTIVE", "DISPUTED", "SUPERSEDED", "EXPIRED", "REVOKED", "QUARANTINED", "DELETED"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export interface Evidence {
	schemaVersion: EvidenceSchema;
	/** sha256(artifactId + claimId + relation): the same link never gets two ids. */
	evidenceId: string;
	artifactId: string;
	claimId: string;
	relation: EvidenceRelation;
	directness: EvidenceDirectness;
	/** Where inside the artifact, e.g. `#Key Decisions[2]` or `chars 1200-1680`. */
	locator: string;
	observedAt: number;
}

export interface Claim {
	schemaVersion: ClaimSchema;
	/** sha256(dedupKey). Identity is content-derived, so dedup is a hash comparison, not a heuristic. */
	claimId: string;
	/** NFKC → lowercase → collapse whitespace → strip list markers and punctuation (design §7). */
	dedupKey: string;
	/** The original text, never the normalized form: the briefing quotes what was actually written. */
	text: string;
	claimType: ClaimType;
	certainty: Certainty;
	scope: Scope;
	effectiveAt: number;
	expiresAt: number | null;
	supersedes: string[];
	/** Present only for claims that came from a governed AkashicForge row. */
	lifecycle: LifecycleState | null;
	/** Always at least one. A claim with no evidence is a fabrication and cannot be constructed. */
	evidence: Evidence[];
}

/* ------------------------------------------------------------------------------------------------
 * ContextItem (design §7, spec §5.5)
 * ---------------------------------------------------------------------------------------------- */

/** The ten kinds spec §5.5 requires a ContextItem to identify itself as. */
export const CONTEXT_ITEM_KINDS = [
	"confirmed_fact",
	"user_claim",
	"tool_observation",
	"inference",
	"plan",
	"preference",
	"hypothesis",
	"constraint",
	"conflict",
	"recommendation",
] as const;
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

/** Briefing sections, in the order §10 assigns them soft budget shares. */
export const BRIEFING_SECTIONS = [
	"confirmed_facts",
	"previous_decisions",
	"current_state",
	"constraints",
	"known_failures_or_rejected",
	"preferences",
	"conflicts",
	"open_tasks",
	"uncertainties_or_gaps",
] as const;
export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

/**
 * The seven §9 signals. `utility` is the composed output rather than an input — it is listed here
 * because the trace must record it, not because anything weights it.
 */
export interface ScoreVector {
	authority: number;
	evidenceStrength: number;
	confidence: number;
	integrity: number;
	freshness: number;
	relevance: number;
	utility: number;
}

export interface ContextItem {
	schemaVersion: ContextItemSchema;
	itemId: string;
	kind: ContextItemKind;
	/** The full six-way enum here: a ContextItem may legitimately be an in-process directive. */
	channel: Channel;
	text: string;
	claimIds: string[];
	evidenceIds: string[];
	scope: Scope;
	effectiveAt: number;
	tokenCost: number;
	section: BriefingSection;
	score: ScoreVector;
	/** Mandatory items are placed before the MMR pool and are never dropped for redundancy (§10). */
	mandatory: boolean;
}

/* ------------------------------------------------------------------------------------------------
 * Retrieval planning — the adapter-facing request
 * ---------------------------------------------------------------------------------------------- */

/**
 * One source's slice of a RetrievalPlan. Built by plan.ts (build-order step 8) and consumed by
 * `SourceAdapter.query`. It is defined here, in the shared vocabulary, so the adapters can be built
 * and tested before the planner exists.
 *
 * `terms` is already tokenized: the planner owns tokenization (it uses AkashicForge's own
 * tokenizer, per design §9) so that every source sees the identical term set and relevance stays
 * comparable across them. An empty `terms` array is not an error — it means "read this scope by
 * recency", which is the plan for a task with no usable keywords.
 */
/**
 * How a source's `terms` combine.
 *
 * `all` is FTS5's own default — every term is a hard filter, which is what a large corpus needs and
 * why `plan.ts` narrows to three (`MAX_QUERY_TERMS`). `any` asks for documents sharing *at least
 * one* term, which is the only relevance test a ten-row corpus can actually answer: an AND of three
 * task words over ten dense curated rows returns nothing on 13 of 19 labelled tasks (measured), so
 * conjunction there is not a strict filter but an off switch.
 *
 * The mode is a property of the query rather than of the adapter because it is the *planner's*
 * judgement about corpus size, and the trace has to be able to show which judgement was made.
 */
export type QueryMatchMode = "all" | "any";

export interface PlannedQuery {
	schemaVersion: PlannedQuerySchema;
	runId: string;
	sourceId: SourceId;
	terms: string[];
	/** Combination rule for `terms`. Never inferred by an adapter — the planner states it. */
	matchMode: QueryMatchMode;
	scope: Scope;
	/** Restrict to one session/branch, or `null` for the whole scope. */
	taskScope: string | null;
	/** Inclusive epoch-ms bounds on the source's own creation clock. */
	since: number | null;
	until: number | null;
	/** Hard ceiling on envelopes returned. The adapter pages up to it, never past it. */
	maxArtifacts: number;
	/** Why the planner chose this source (spec §9: no source is queried to fill a quota). */
	justification: string;
}

/* ------------------------------------------------------------------------------------------------
 * Error taxonomy
 * ---------------------------------------------------------------------------------------------- */

/**
 * The five codes every provider failure is translated into (design §13). The class that carries
 * them lives in adapters/contract.ts, next to the translation function, because the codes are
 * domain vocabulary but the translation is adapter machinery.
 */
export const ADAPTER_ERROR_CODES = ["unavailable", "timeout", "auth", "schema", "internal"] as const;
export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

/* ------------------------------------------------------------------------------------------------
 * Retrieval state machine and audit vocabulary (design §6, §14)
 * ---------------------------------------------------------------------------------------------- */

export const RETRIEVAL_STATES = [
	"RECEIVE_REQUEST",
	"ANALYZE_TASK",
	"AUTHORIZE_SCOPE",
	"PLAN_RETRIEVAL",
	"EXECUTE_SOURCE_QUERIES",
	"NORMALIZE_ARTIFACTS",
	"EXTRACT_OR_RESOLVE_CLAIMS",
	"DEDUPLICATE",
	"APPLY_HARD_FILTERS",
	"SCORE_CANDIDATES",
	"DETECT_CONFLICTS",
	"RESOLVE_OR_ESCALATE",
	"SELECT_CONTEXT_SET",
	"REQUEST_COMPRESSION",
	"ASSEMBLE_BRIEFING",
	"VALIDATE_BRIEFING",
	"DELIVER",
	"COLLECT_FEEDBACK",
] as const;
export type RetrievalState = (typeof RETRIEVAL_STATES)[number];

/** Terminal outcomes that end a run before DELIVER (design §6). */
export const EARLY_EXITS = [
	"NO_MEMORY_REQUIRED",
	"CLARIFICATION_REQUIRED",
	"INSUFFICIENT_AUTHORIZATION",
	"RETRIEVAL_UNAVAILABLE",
	"PARTIAL_BRIEFING",
	"INSUFFICIENT_INFORMATION",
] as const;
export type EarlyExit = (typeof EARLY_EXITS)[number];

/**
 * Design §14's event vocabulary, plus one added in Phase 2 and one added in Phase 3.
 *
 * `provenance` carries the shape of the claim graph — edge counts by relation, grounding states,
 * the graph-distance histogram, the supersession chains. It is not a `transition` (the graph is
 * built inside `APPLY_HARD_FILTERS`, which already emits its own) and it is not a `score` (nothing
 * is weighted yet). Spec §12 requires that every input to a ranking decision be recoverable from the
 * trace, and Phase 2's `evidence_strength` reads three quantities — distance, independent groups,
 * contradictions — that exist only in this structure. Folding them into the per-candidate `score`
 * payload would repeat the whole graph once per claim; giving them an event kind records it once.
 *
 * `mutation` is Phase 3's, and it is the one event kind that describes something Mnemosia did to a
 * store rather than something she concluded about one. Every gate refusal, approval requirement,
 * pre-flight lifecycle check, submission, replay, version conflict, rebase, retry and ledger row
 * lands here. It is not an `outcome` — that kind terminates a *retrieval* run and there is exactly
 * one per run, whereas a single recommendation can produce a refusal, a conflict, a rebase and a
 * commit — and it is not a `transition`, which is design §6's retrieval state machine. Design §19
 * item 2 makes autonomous mutation a human approval item; an approval item whose exercise is not
 * separately identifiable in the audit log cannot be audited for compliance afterwards.
 */
export const TRACE_EVENT_KINDS = [
	"transition",
	"adapter_result",
	"claim_extracted",
	"filter_reject",
	"provenance",
	"score",
	"conflict",
	/**
	 * Phase 4. Every escalation routed at `RESOLVE_OR_ESCALATE`, with the rule that fired, the target
	 * seat and whether it was dispatched or delivered to the requester as its own work item.
	 *
	 * It is not a `conflict` — that kind carries what `detectConflicts` *concluded* about the claims,
	 * and the whole Phase 2 discipline preserved here is that concluding and routing are different
	 * acts by different modules. It is not a `transition` either: `RESOLVE_OR_ESCALATE` already emits
	 * one, and an access escalation has no conflict behind it at all, so folding the two would make a
	 * replay unable to tell a run that escalated nothing from a run whose escalations were all
	 * conflict-derived.
	 */
	"escalation",
	/**
	 * Phase 5. One event per invocation of the model-assisted reranker (spec §12), carrying the
	 * reranker version, the gate that admitted it, the attempt count, the status, and every id the
	 * model returned that the deterministic stage had not admitted.
	 *
	 * It is not a `score` — that kind carries the *deterministic* signals and weights §12 requires to
	 * be recoverable, and a reranking decision has neither. A replay that could not tell "this order
	 * came from the six weights" from "this order came from a model" would make the whole
	 * deterministic-fallback guarantee unauditable. It is emitted whether the reranker ran or not, so
	 * "the gate was closed" and "no reranker was configured" are distinguishable facts in the log
	 * rather than a shared silence.
	 */
	"rerank",
	/**
	 * Phase B. One event per situation/intent/requirements stage between ANALYZE_TASK and
	 * PLAN_RETRIEVAL, carrying the tier counts, the bounded hypothesis set with its clarification
	 * recommendation, and the derived knowledge requirements. They are not `transition`s: they do
	 * not move the retrieval state machine, they annotate it — a replay must be able to tell "the
	 * plan was built from task analysis alone (Phase A)" from "the plan was built with situation
	 * and intent vocabulary (Phase B)".
	 */
	"situation_analysis",
	"intent_hypotheses",
	"knowledge_requirements",
	"selection",
	"exclusion",
	"validation",
	"mutation",
	/**
	 * Phase D. One event per run, emitted after APPLY_HARD_FILTERS has fixed the accepted claim set,
	 * carrying per-claim cross-agent lineage: which seat produced each accepted claim (when one is
	 * attributable via a `specialist-finding:<seat>` tag) and which seat requested the run, plus the
	 * always-numeric `joinCoverage` share of attributed claims. It is not a `provenance` — that kind
	 * carries graph statistics over claims and artifacts, and a seat attribution is a fact about
	 * *agents*, not about evidence structure. A replay that could not tell "no seat was attributable"
	 * from "lineage was never recorded" would make the D3 contract unauditable.
	 */
	"agent_lineage",
	"outcome",
] as const;
export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number];

export type SituationContextSchema = typeof SCHEMA_VERSION.situationContext;
export type IntentHypothesisSetSchema = typeof SCHEMA_VERSION.intentHypothesisSet;

/**
 * One line of the append-only run log. `seq` is assigned by the writer and is dense from 0, so a
 * truncated file is detectable by a gap at the end rather than by guessing.
 *
 * `policyId`/`policyVersion` are `null` until PLAN_RETRIEVAL resolves a ranking policy; they are on
 * every event rather than only on scoring events because §12 requires that a replay be able to
 * attribute any decision to the policy in force when it was made.
 */
export interface TraceEvent {
	schemaVersion: TraceEventSchema;
	runId: string;
	seq: number;
	at: number;
	state: RetrievalState;
	event: TraceEventKind;
	policyId: string | null;
	policyVersion: string | null;
	payload: Record<string, unknown>;
}

/* ------------------------------------------------------------------------------------------------
 * Degradation records
 * ---------------------------------------------------------------------------------------------- */

/**
 * A named hole in the briefing. A source that failed, a source that was skipped, or a source that
 * legitimately returned nothing all produce one of these — an empty source is a recorded
 * gap, never an error (design §1).
 */
export interface RetrievalGap {
	sourceId: SourceId;
	/**
	 * `budget` is not an adapter condition: it means the material was retrieved and then could not be
	 * afforded. It is in the same list because spec §16 gives the briefing exactly one `retrieval_gaps`
	 * field, and a reader who is missing a constraint needs to be told so whether it was a source
	 * that failed or the ceiling that bound. `sourceId` is `mnemosia/selection` for these.
	 */
	reason: "adapter_error" | "circuit_open" | "empty_result" | "deadline" | "not_planned" | "budget";
	detail: string;
	/** Present when `reason` is `adapter_error`. */
	code: AdapterErrorCode | null;
}

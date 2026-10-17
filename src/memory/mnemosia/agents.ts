// Ported from mnemosia/agents.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * The Conclave registry — who may ask Mnemosia for a briefing, and what each of them needs from
 * memory (spec §25 Phase 4, design §21).
 *
 * Spec §2 names nine seats and Mnemosia is the ninth; the other eight are the requesting agents.
 * Spec §12 already requires that ranking policy be configurable **by requesting agent**, and Phase 1
 * built the lookup chain for it but populated only one agent-keyed entry (`vesperia-fast@2`, pinned
 * to one mode). Phase 4 makes the dimension real. It does so in two layers that are deliberately
 * kept apart, because they answer different questions:
 *
 * 1. **Ranking policy** — *what scores highest*. Configured through `policy.ts`, resolved through
 *    `resolvePolicy`, and shared wherever two agents genuinely want the same weights. Six of the
 *    eight share an existing policy; exactly two needed a new one. See `AGENT_POLICY` below for the
 *    per-agent answer and the reason.
 * 2. **Briefing profile** — *how the material that scored is composed, ordered and presented*.
 *    Section emphasis, conflict presentation, escalation targets, feedback role and the agent
 *    addendum. That is this file.
 *
 * **What this file deliberately is not.** Spec §25 reserves "agent-specific briefing *schemas*" for
 * Phase 5, behind strong offline evaluation. So there is exactly one `Briefing` schema and every
 * agent receives the same fields; what varies is which sections got budget, in what order they are
 * read, and one uniform `agent_briefing` block whose *content* is derived per agent from data the
 * run already holds. A per-agent field set would be a schema fork, and a schema fork in Phase 4 is
 * the thing §25 puts a gate in front of.
 *
 * **What was found about dispatch, and why it matters here.** Design §17 ambiguity 1 recorded that
 * the `conclave` skill's dispatch envelope was not discoverable from the agent `.md` files. It is
 * discoverable now — the skill is a `conclave` SKILL.md — and it turns out to
 * contain **no envelope at all**: it is 60 lines of prose doctrine (role boundaries, the canonical
 * pipeline, evidence handoff rules, a git-identity convention) with no schema, no tool declaration
 * and no message format. There is therefore nothing to conform to, and the default §17 recorded
 * stands: Mnemosia registers `mnemosia_brief` and any in-session agent calls it, naming itself in
 * `requesting_agent`. What Phase 4 adds is that the name is now *resolved* rather than accepted
 * verbatim — see `resolveAgent` — because the one thing the `.md` files do establish is that an
 * agent's dispatch name and its display name are not the same string.
 */

import { BRIEFING_SECTIONS, type BriefingSection } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------------------------------- */

/** Spec §2's eight requesting seats, in spec order. Mnemosia is the ninth and never requests. */
export const CONCLAVE_AGENTS = ["samaela", "vesperia", "nytheria", "elaria", "raskreia", "avaritia", "astrelia", "vaelia"] as const;
export type ConclaveAgent = (typeof CONCLAVE_AGENTS)[number];

/**
 * Dispatch name → canonical seat.
 *
 * **`planner` is Samaela.** the planner agent definition carries `name: planner` and
 * `display_name: Samaela`, and Pi dispatches by `name`. So the string that will actually arrive in
 * `requesting_agent` from a live session is `planner`, while spec §2, design §21, `eval/gold-tasks.json`
 * and every prose reference say `samaela`. Without this table a live Samaela request would resolve
 * to no profile and no agent policy, and would silently receive the default briefing — the Phase 4
 * integration failing closed and invisibly, on the one agent whose seat is named differently from
 * its file. This is not a hypothetical: it is the only name mismatch in the eight, and it is on the
 * agent the pipeline starts with.
 *
 * `mnemosia` is present and maps to nothing: she is the ninth seat and does not request briefings
 * from herself. `resolveAgent` reports that as `self_request` rather than as an unknown agent.
 */
export const AGENT_DISPATCH_NAMES: Readonly<Record<string, ConclaveAgent>> = Object.freeze({
	planner: "samaela",
	samaela: "samaela",
	vesperia: "vesperia",
	nytheria: "nytheria",
	elaria: "elaria",
	raskreia: "raskreia",
	avaritia: "avaritia",
	astrelia: "astrelia",
	vaelia: "vaelia",
});

/** The `display_name:` each `.md` file carries, verbatim. Rendered, never matched on. */
export const AGENT_DISPLAY_NAMES: Readonly<Record<ConclaveAgent, string>> = Object.freeze({
	samaela: "Samaela",
	vesperia: "Vesperia",
	nytheria: "Nytheria",
	elaria: "Elaria",
	raskreia: "Raskreia",
	avaritia: "Avaritia",
	astrelia: "Astrelia — Code Scout",
	vaelia: "Vaelia",
});

/** The `name:` each `.md` file carries — what Pi dispatches by, and what arrives in a request. */
export const AGENT_FILE_NAMES: Readonly<Record<ConclaveAgent, string>> = Object.freeze({
	samaela: "planner",
	vesperia: "vesperia",
	nytheria: "nytheria",
	elaria: "elaria",
	raskreia: "raskreia",
	avaritia: "avaritia",
	astrelia: "astrelia",
	vaelia: "vaelia",
});

export interface AgentResolution {
	/** The canonical seat, or `null` when the caller is not one of the eight. */
	agent: ConclaveAgent | null;
	/** Exactly the string the caller supplied, lowercased and trimmed. Never rewritten. */
	requested: string;
	how: "dispatch_name" | "self_request" | "unknown";
	/** Why the caller receives the profile it receives. Lands in the trace and the briefing. */
	detail: string;
}

/**
 * Resolves a `requesting_agent` string to a Conclave seat.
 *
 * Deliberately **not** fuzzy. A resolver that guessed would give an unrecognised caller a profile
 * somebody else's role designed, and the whole point of the per-agent layer is that the profile
 * encodes what that agent is *for*. An unknown caller gets the shared default and is told so.
 */
export function resolveAgent(requested: string): AgentResolution {
	const key = requested.trim().toLowerCase();
	const found = Object.hasOwn(AGENT_DISPATCH_NAMES, key) ? AGENT_DISPATCH_NAMES[key] : undefined;
	if (found !== undefined) {
		const via = AGENT_FILE_NAMES[found] === key ? "its dispatch name" : `the alias "${key}"`;
		return { agent: found, requested: key, how: "dispatch_name", detail: `resolved to the ${AGENT_DISPLAY_NAMES[found]} seat by ${via}` };
	}
	if (key === "mnemosia") {
		return { agent: null, requested: key, how: "self_request", detail: "Mnemosia is the ninth seat and does not brief herself; the shared default profile applies" };
	}
	return { agent: null, requested: key, how: "unknown", detail: `"${key}" is not one of the eight Conclave requesting seats (${CONCLAVE_AGENTS.join(", ")}); the shared default profile applies` };
}

/* ------------------------------------------------------------------------------------------------
 * The per-agent ranking policy answer
 * ---------------------------------------------------------------------------------------------- */

export interface AgentPolicyBinding {
	policyId: string;
	/** `true` when this agent is the only one on that policy. */
	exclusive: boolean;
	rationale: string;
}

/**
 * Which ranking policy each seat resolves to when no `(agent, taskType, mode)` or `(agent, *, mode)`
 * entry matches — `policy.ts`'s new third link.
 *
 * **Six of the eight share an existing policy, and that is the finding rather than a shortcut.**
 * Design §26 forbids placeholder abstractions built to hit a module count, and eight agent-keyed
 * weight vectors would have been exactly that: the honest question is not "does this agent deserve a
 * policy" but "does this agent's role imply a different ordering over the same candidate pool". For
 * six of them it does not, and saying so is worth more than six near-identical tables that a future
 * reader would have to diff to discover were the same.
 *
 * The two that needed one needed it for different reasons, and only one of them is a weight change.
 */
export const AGENT_POLICY: Readonly<Record<ConclaveAgent, AgentPolicyBinding>> = Object.freeze({
	samaela: Object.freeze({
		policyId: "samaela@3",
		exclusive: true,
		rationale: "a planner reconstructs what was settled and why. Authority rises to 0.24 because a recorded decision's standing is precisely what makes it binding on a new plan, and freshness falls to 0.10 because a decision does not stop being the decision by ageing — supersession retires it, not decay. No other seat wants that trade: it is the one role that reads old material on purpose.",
	}),
	vesperia: Object.freeze({
		policyId: "debug@2",
		exclusive: false,
		rationale: "shares debug@2, unchanged. Vesperia's stated need — what was tried, what failed, what was last observed — is the debugger's need term for term, and debug@2 was already measured for it (relevance 0.32, freshness 0.24, authority halved). Writing a vesperia@3 that differed from it in the third decimal would have been a stub. Her fast-mode vector stays vesperia-fast@2, which the more specific (agent, *, mode) link still reaches first.",
	}),
	nytheria: Object.freeze({
		policyId: "default@2",
		exclusive: false,
		rationale: "shares default@2. Nytheria wants low-confidence and unexplained material foregrounded, which is the inverse of a confidence weight — and a negative weight would break the Σ w·s composition every other policy depends on and make utility non-comparable across policies. Her requirement is a composition requirement, not a ranking one, and it is met in `sectionEmphasis` where it can actually be expressed.",
	}),
	elaria: Object.freeze({
		policyId: "review@2",
		exclusive: false,
		rationale: "shares review@2, unchanged, with Raskreia. review@2 doubles integrity to 0.20 and drops freshness to the 0.06 floor — provenance quality over recency — which is exactly what a validator judging whether something is right needs, and it was measured in Phase 1 for that purpose.",
	}),
	raskreia: Object.freeze({
		policyId: "review@2",
		exclusive: false,
		rationale: "shares review@2 with Elaria. The two roles differ sharply in what they should be *shown* — Elaria gets both sides of a conflict, Raskreia gets the security register — but not in how a candidate should be scored: both are judging standing and provenance rather than recency. Giving them separate identical tables would hide that agreement rather than record it.",
	}),
	avaritia: Object.freeze({
		policyId: "default@2",
		exclusive: false,
		rationale: "shares default@2. Avaritia's inputs are the token ledger and the orchestration trace, neither of which is a ranked claim; re-weighting the claim ranking for her would change something she does not read. Her entire per-agent surface is the cost block in the addendum.",
	}),
	astrelia: Object.freeze({
		policyId: "astrelia@3",
		exclusive: true,
		rationale: "the six weights are byte-identical to default@2; what differs is the **authority table**. Astrelia asks where the implementation is, and for that question a tool transcript that actually read the file is direct evidence while a curated decision memo is a claim about intent. The shared table ranks tool_output 0.5 and curated_memory 0.9; for this seat and only this seat the ordering inverts (tool_output 0.80, curated_memory 0.60). Recording it as a table difference rather than a weight difference is the point: nothing about how she trades relevance against authority changed, only what counts as authoritative.",
	}),
	vaelia: Object.freeze({
		policyId: "default@2",
		exclusive: false,
		rationale: "shares default@2. Vaelia is overwhelmingly a *producer* of external findings, and spec §3 forbids Mnemosia unrestricted browsing, so the corpus can never hold what Vaelia is for. Her per-agent surface is the research-request block — what this run could not answer — and a feedback channel that is the only way external evidence can legitimately enter memory at all.",
	}),
});

/* ------------------------------------------------------------------------------------------------
 * Briefing profiles
 * ---------------------------------------------------------------------------------------------- */

/**
 * How a conflict is presented to this seat.
 *
 * `resolved` delivers the deterministic outcome — the winner, with the loser visible under
 * `conflicts[]`. `both_with_qualification` forces spec §14's `INCLUDE_BOTH_WITH_QUALIFICATION`
 * onto every conflict this run resolved by picking a side, so the reader receives the disagreement
 * rather than Mnemosia's answer to it. Nothing is deleted either way; what changes is which of the
 * two claims may occupy a factual section.
 */
export type ConflictPresentation = "resolved" | "both_with_qualification";

/** Which of the addendum blocks this seat receives, in render order. */
export const ADDENDUM_BLOCKS = ["decision_register", "execution_ledger", "gap_register", "provenance_dossier", "security_register", "cost_ledger", "artifact_index", "research_requests", "escalations", "feedback_request"] as const;
export type AddendumBlock = (typeof ADDENDUM_BLOCKS)[number];

export interface AgentBriefingProfile {
	agent: ConclaveAgent;
	displayName: string;
	dispatchName: string;
	/** The role's own question, taken from the agent's `.md` file rather than paraphrased. */
	question: string;
	/**
	 * Design §10's soft shares, replaced wholesale for this seat. Every override sums to 1.00 and is
	 * checked at module load; a partial override would have made the effective share of an untouched
	 * section depend on how much the touched ones took, which is not something a reviewer can read
	 * off the table.
	 */
	sectionShares: Readonly<Record<BriefingSection, number>>;
	/** Rendered first, before design §16's standard epistemic order. */
	leadSections: readonly BriefingSection[];
	conflictPresentation: ConflictPresentation;
	blocks: readonly AddendumBlock[];
	/**
	 * Tokens reserved from the budget for this seat's addendum, charged with the frame at `select.ts`
	 * step 0 — i.e. taken out of the evidence pool before a single claim is placed, so design §4's
	 * hard-budget invariant holds over the delivered bytes rather than over the evidence subtotal.
	 *
	 * It is a **ceiling at the standard budget**, not a flat tax: `effectiveAddendumReserve` caps it at
	 * `ADDENDUM_BUDGET_SHARE` of whatever budget the caller actually granted.
	 */
	addendumReserve: number;
	/** Spec §22 fields this seat is expected to report. Not enforced — recorded, and validated offline. */
	feedbackExpected: readonly string[];
	/** `true` when this seat's principal relationship to feedback is producing it, not consuming it. */
	feedbackProducer: boolean;
	/**
	 * Governance: whether this seat's work requires verified evidence. Every Conclave member operates
	 * under governance (architecture: "Governance includes … verification requirements"), so all eight
	 * seats carry `"required"`; an unrecognised caller carries `"optional"` and keeps the single-pass
	 * behavior. This is the gate Phase C's default escalation reads (`orchestrator.ts:runBriefing`):
	 * with requirements outstanding and verification required, the run escalates rather than
	 * delivering under-covered evidence.
	 */
	verification: "required" | "optional";
	rationale: string;
}

/** Design §10's shares, unchanged — the shared default for a seat with no composition requirement. */
const BASE_SHARES: Readonly<Record<BriefingSection, number>> = Object.freeze({
	confirmed_facts: 0.3,
	previous_decisions: 0.15,
	current_state: 0.15,
	constraints: 0.1,
	known_failures_or_rejected: 0.1,
	preferences: 0.05,
	conflicts: 0.05,
	open_tasks: 0.05,
	uncertainties_or_gaps: 0.05,
});

function shares(values: Record<BriefingSection, number>): Readonly<Record<BriefingSection, number>> {
	return Object.freeze({ ...values });
}

/**
 * The eight profiles.
 *
 * Every share vector below was written from the role's own stated question — the one in its `.md`
 * file — before any briefing was generated under it, and none was adjusted afterwards. Three seats
 * keep design §10's shares exactly, because their requirement is not a composition requirement, and
 * that is stated on each rather than left to be inferred from the numbers being equal.
 */
export const AGENT_PROFILES: Readonly<Record<ConclaveAgent, AgentBriefingProfile>> = Object.freeze({
	samaela: Object.freeze({
		agent: "samaela" as const,
		displayName: AGENT_DISPLAY_NAMES.samaela,
		dispatchName: AGENT_FILE_NAMES.samaela,
		question: "What is the plan, and what has already been settled about it?",
		sectionShares: shares({ confirmed_facts: 0.18, previous_decisions: 0.25, current_state: 0.07, constraints: 0.14, known_failures_or_rejected: 0.18, preferences: 0.05, conflicts: 0.03, open_tasks: 0.08, uncertainties_or_gaps: 0.02 }),
		leadSections: ["previous_decisions", "constraints", "known_failures_or_rejected"] as const,
		conflictPresentation: "resolved" as const,
		blocks: ["decision_register", "escalations", "feedback_request"] as const,
		addendumReserve: 450,
		feedbackExpected: ["usedItemIds", "downstreamSuccess"] as const,
		feedbackProducer: false,
		verification: "required" as const,
		rationale: "Samaela's planning gate forbids her from re-deciding what is already decided, and her plan template requires a `Decisions` section listing rejected alternatives. So `previous_decisions` takes 0.25 and `known_failures_or_rejected` 0.18 — together 0.43 of the pool against design §10's 0.25 — and the cost is taken from `confirmed_facts` (0.30 → 0.18) and `current_state` (0.15 → 0.07), because a planner does not need this morning's tool output and a fact she can re-derive is cheaper to re-derive than to carry.",
	}),
	vesperia: Object.freeze({
		agent: "vesperia" as const,
		displayName: AGENT_DISPLAY_NAMES.vesperia,
		dispatchName: AGENT_FILE_NAMES.vesperia,
		question: "What was already tried here, and what failed?",
		sectionShares: shares({ confirmed_facts: 0.2, previous_decisions: 0.06, current_state: 0.25, constraints: 0.1, known_failures_or_rejected: 0.22, preferences: 0.02, conflicts: 0.02, open_tasks: 0.12, uncertainties_or_gaps: 0.01 }),
		leadSections: ["known_failures_or_rejected", "current_state", "open_tasks"] as const,
		conflictPresentation: "resolved" as const,
		blocks: ["execution_ledger", "escalations", "feedback_request"] as const,
		addendumReserve: 450,
		feedbackExpected: ["usedItemIds", "ignoredItemIds", "staleClaimIds", "missingEvidence", "downstreamSuccess"] as const,
		feedbackProducer: true,
		verification: "required" as const,
		rationale: "the executor's expensive mistake is repeating a failure somebody already had, so `known_failures_or_rejected` more than doubles (0.10 → 0.22) and `current_state` — where tool observations land — takes 0.25. `previous_decisions` falls to 0.06 because she receives the approved plan through Samaela's handoff and does not need memory to re-tell her what was decided. She is also the run's principal feedback *producer*: spec §22's memories-used / ignored / stale / missing-evidence signals can only come from whoever actually acted on the briefing, and the addendum carries the item ids to report against.",
	}),
	nytheria: Object.freeze({
		agent: "nytheria" as const,
		displayName: AGENT_DISPLAY_NAMES.nytheria,
		dispatchName: AGENT_FILE_NAMES.nytheria,
		question: "What is missing?",
		sectionShares: shares({ confirmed_facts: 0.18, previous_decisions: 0.07, current_state: 0.08, constraints: 0.1, known_failures_or_rejected: 0.03, preferences: 0.02, conflicts: 0.15, open_tasks: 0.12, uncertainties_or_gaps: 0.25 }),
		leadSections: ["uncertainties_or_gaps", "conflicts", "open_tasks"] as const,
		conflictPresentation: "both_with_qualification" as const,
		blocks: ["gap_register", "escalations", "feedback_request"] as const,
		addendumReserve: 450,
		feedbackExpected: ["additionalRetrievalRequested", "missingEvidence"] as const,
		feedbackProducer: false,
		verification: "required" as const,
		rationale: "this is the inversion the phase brief names: `uncertainties_or_gaps` is design §10's smallest share at 0.05 and is Nytheria's *primary payload*, so it takes 0.25 — a fivefold rise — and `conflicts` triples to 0.15. What is paid for it is `known_failures_or_rejected` (0.10 → 0.03), because a failure somebody already recorded is by definition not a blind spot. She also takes `both_with_qualification`: a conflict Mnemosia resolved is a place where two sources disagreed, and for the gap analyst the disagreement is the finding even when the resolution is correct.",
	}),
	elaria: Object.freeze({
		agent: "elaria" as const,
		displayName: AGENT_DISPLAY_NAMES.elaria,
		dispatchName: AGENT_FILE_NAMES.elaria,
		question: "Is this internally correct?",
		sectionShares: shares({ confirmed_facts: 0.22, previous_decisions: 0.12, current_state: 0.12, constraints: 0.08, known_failures_or_rejected: 0.05, preferences: 0.02, conflicts: 0.25, open_tasks: 0.02, uncertainties_or_gaps: 0.12 }),
		leadSections: ["conflicts", "uncertainties_or_gaps"] as const,
		conflictPresentation: "both_with_qualification" as const,
		blocks: ["provenance_dossier", "escalations", "feedback_request"] as const,
		addendumReserve: 480,
		feedbackExpected: ["validatorDisagreement", "staleClaimIds"] as const,
		feedbackProducer: true,
		verification: "required" as const,
		rationale: "Elaria's contract is `location -> problem -> required fix` against repository evidence, and her `.md` boundary says claims must be 'supported by repository evidence rather than invented paths or vague confidence'. A briefing that hands her Mnemosia's *conclusions* has pre-empted the review she was called to perform. So `conflicts` takes 0.25 — the largest conflict share of the eight — she is the only other seat on `both_with_qualification`, and the addendum carries the provenance dossier: graph distance, grounding state and evidence directness per cited claim, which is the material she needs to check whether a conclusion is earned.",
	}),
	raskreia: Object.freeze({
		agent: "raskreia" as const,
		displayName: AGENT_DISPLAY_NAMES.raskreia,
		dispatchName: AGENT_FILE_NAMES.raskreia,
		question: "Should we even build it this way?",
		sectionShares: shares({ confirmed_facts: 0.22, previous_decisions: 0.18, current_state: 0.07, constraints: 0.22, known_failures_or_rejected: 0.08, preferences: 0.02, conflicts: 0.15, open_tasks: 0.01, uncertainties_or_gaps: 0.05 }),
		leadSections: ["constraints", "previous_decisions", "conflicts"] as const,
		conflictPresentation: "resolved" as const,
		blocks: ["security_register", "escalations", "feedback_request"] as const,
		addendumReserve: 480,
		feedbackExpected: ["validatorDisagreement", "downstreamSuccess"] as const,
		feedbackProducer: false,
		verification: "required" as const,
		rationale: "the architecture challenger asks whether a boundary is the right boundary, and the two things that constrain that answer are the standing rules and the choices already made irreversibly — so `constraints` more than doubles to 0.22 and `previous_decisions` takes 0.18. She stays on `resolved` rather than joining Elaria: her question is whether the design is right, not whether Mnemosia's arbitration was, and handing her every settled disagreement would spend her budget re-litigating Elaria's work. Her distinct surface is the security register — quarantined artifacts, unverified integrity, refused scopes, and every escalation this run routed to her.",
	}),
	avaritia: Object.freeze({
		agent: "avaritia" as const,
		displayName: AGENT_DISPLAY_NAMES.avaritia,
		dispatchName: AGENT_FILE_NAMES.avaritia,
		question: "Can it be better?",
		sectionShares: BASE_SHARES,
		leadSections: [] as const,
		conflictPresentation: "resolved" as const,
		blocks: ["cost_ledger", "feedback_request"] as const,
		addendumReserve: 400,
		feedbackExpected: ["downstreamSuccess"] as const,
		feedbackProducer: false,
		verification: "required" as const,
		rationale: "**design §10's shares are kept exactly, and that is the answer rather than an omission.** Avaritia's inputs are `token_usage` and the orchestration trace — the cost of the briefing, not its contents — and there is no re-shuffling of claim sections that would serve a bottleneck analysis. Inventing one to make her table look as considered as the others would be the placeholder design §26 forbids. Her entire per-agent surface is the cost ledger, which is real data she is the only seat that reads.",
	}),
	astrelia: Object.freeze({
		agent: "astrelia" as const,
		displayName: AGENT_DISPLAY_NAMES.astrelia,
		dispatchName: AGENT_FILE_NAMES.astrelia,
		question: "Where is the implementation?",
		sectionShares: shares({ confirmed_facts: 0.35, previous_decisions: 0.1, current_state: 0.25, constraints: 0.08, known_failures_or_rejected: 0.08, preferences: 0.02, conflicts: 0.02, open_tasks: 0.06, uncertainties_or_gaps: 0.04 }),
		leadSections: ["current_state", "confirmed_facts"] as const,
		conflictPresentation: "resolved" as const,
		blocks: ["artifact_index", "feedback_request"] as const,
		addendumReserve: 400,
		feedbackExpected: ["usedItemIds", "staleClaimIds"] as const,
		feedbackProducer: false,
		verification: "required" as const,
		rationale: "the code scout wants the raw observation, not the curated prose about it: `current_state` — where design §8's whole-artifact tool and conversation excerpts land — rises to 0.25, and `confirmed_facts` to 0.35, together 0.60 of the pool. Her addendum is the artifact index: artifact id, source type, source ref and locator for every cited claim, which is the only block that hands a reader the coordinates to go and look rather than the sentence somebody wrote about it. This is the seat whose need is also expressed in the ranking table (`astrelia@3`), because 'prefer the transcript' is a statement about source standing and belongs where source standing is configured.",
	}),
	vaelia: Object.freeze({
		agent: "vaelia" as const,
		displayName: AGENT_DISPLAY_NAMES.vaelia,
		dispatchName: AGENT_FILE_NAMES.vaelia,
		question: "What do current docs and OSS patterns say?",
		sectionShares: BASE_SHARES,
		leadSections: [] as const,
		conflictPresentation: "resolved" as const,
		blocks: ["research_requests", "feedback_request"] as const,
		addendumReserve: 400,
		feedbackExpected: ["missingEvidence", "additionalRetrievalRequested"] as const,
		feedbackProducer: true,
		verification: "required" as const,
		rationale: "**design §10's shares are kept exactly, for a different reason than Avaritia's.** Spec §3 forbids Mnemosia unrestricted browsing, so the corpus structurally cannot contain what Vaelia exists to find; re-shaping the sections would be re-shaping the wrong material. What she gets instead is the research-request block — every `retrieval_gap` and every uncertainty this run recorded, restated as a question the external record might answer — and a feedback channel, because a Vaelia finding arriving as feedback is the only route by which external evidence can enter Mnemosia's memory without Mnemosia browsing for it.",
	}),
});

/* ------------------------------------------------------------------------------------------------
 * Load-time invariants
 * ---------------------------------------------------------------------------------------------- */

function assertSharesSumToOne(agent: string, values: Readonly<Record<BriefingSection, number>>): void {
	let total = 0;
	for (const section of BRIEFING_SECTIONS) {
		const value = values[section];
		if (typeof value !== "number" || !(value >= 0)) throw new Error(`agent ${agent}: section share for ${section} is ${String(value)}`);
		total += value;
	}
	if (Math.abs(total - 1) > 1e-9) throw new Error(`agent ${agent}: section shares sum to ${total}, expected 1`);
}

for (const agent of CONCLAVE_AGENTS) {
	const profile = AGENT_PROFILES[agent];
	if (profile.agent !== agent) throw new Error(`agent profile ${profile.agent} is filed under ${agent}`);
	assertSharesSumToOne(agent, profile.sectionShares);
	if (!Number.isInteger(profile.addendumReserve) || profile.addendumReserve < 0) throw new Error(`agent ${agent}: addendumReserve must be a non-negative integer`);
}

/* ------------------------------------------------------------------------------------------------
 * The shared default profile
 * ---------------------------------------------------------------------------------------------- */

/**
 * What an unrecognised caller — or Mnemosia asking herself — receives.
 *
 * It is design §10's shares, `resolved` conflicts, no lead sections and no addendum blocks beyond
 * the escalation list, i.e. **exactly the Phase 3 briefing**. That is deliberate: the Phase 4 layer
 * must be additive for a caller that does not participate in it, so that an unknown agent's briefing
 * is the one three phases of measurement were taken against rather than a fourth thing nobody has
 * measured.
 */
export const DEFAULT_PROFILE: AgentBriefingProfile = Object.freeze({
	agent: "vesperia" as const, // never read; the field is required by the type and the id below is what identifies it
	displayName: "(unrecognised caller)",
	dispatchName: "*",
	question: "(no Conclave role)",
	sectionShares: BASE_SHARES,
	leadSections: [] as const,
	conflictPresentation: "resolved" as const,
	blocks: ["escalations"] as const,
	addendumReserve: 0,
	feedbackExpected: [] as const,
	feedbackProducer: false,
	verification: "optional" as const,
	rationale: "no Conclave profile applies; design §10's shares and the Phase 3 briefing are delivered unchanged, so an unrecognised caller receives the composition the prior gates were measured against",
});

export function profileFor(agent: ConclaveAgent | null): AgentBriefingProfile {
	return agent === null ? DEFAULT_PROFILE : AGENT_PROFILES[agent];
}

/**
 * The largest share of a caller's budget the agent addendum may take.
 *
 * **Added after measuring, and the measurement is the argument.** The reserves above are sized for a
 * standard 6,000-token briefing, where 450 tokens is 7.5% and buys three genuinely useful blocks. A
 * *flat* reserve of that size against `fast` mode's 2,000 tokens is 22%, and `scripts/phase4-ab.ts`
 * measured what that costs: on the two fast-mode gold tasks (G14, G18) the seat lost evidence items
 * the same task delivered under the Phase 3 composition — G18 went from 3 items to 1. Paying a fifth
 * of a small briefing for a fixed block of metadata inverts the trade the block exists to make.
 *
 * 0.08 rather than a round 0.10 because the 10% figure is already spoken for: `tokens.ts`'s
 * `BUDGET_RESERVE_RATIO` withholds 10% as the margin behind the frame, and a second 10% named
 * differently would read as the same number twice. Below the cap nothing changes, so every
 * standard, deep and high-assurance briefing keeps the full per-seat reserve; only fast mode binds.
 */
export const ADDENDUM_BUDGET_SHARE = 0.08;

export function effectiveAddendumReserve(profile: AgentBriefingProfile, budget: number): number {
	return Math.min(profile.addendumReserve, Math.floor(ADDENDUM_BUDGET_SHARE * Math.max(0, budget)));
}

/** Every seat sharing `policyId`, in spec order. Reported in the briefing so sharing is visible. */
export function agentsSharingPolicy(policyId: string): ConclaveAgent[] {
	return CONCLAVE_AGENTS.filter((agent) => AGENT_POLICY[agent].policyId === policyId);
}

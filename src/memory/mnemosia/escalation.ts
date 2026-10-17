// Ported from mnemosia/escalation.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Escalation routing — spec §14's `ESCALATE_TO_ELARIA` and `ESCALATE_TO_RASKREIA`, and design §14's
 * "escalate uncertain access decisions" (Phase 4).
 *
 * Both outcomes were left unreachable through Phases 1–3 on a rule this module is written to keep:
 * *a module that cannot route must not emit a routing label*. `conflicts.ts` still cannot route. It
 * does not know who is asking, so it cannot tell an escalation from a request to a seat to that same
 * seat asking about itself, and a label whose recipient might be its own author is not a routing
 * decision. This module is handed the requesting agent and produces, for every label it writes, an
 * addressed `EscalationRequest` naming the target, the question, the evidence and the outcome
 * required. Label and dispatch are produced together or not at all.
 *
 * **What "routing" means here, given what exists.** Mnemosia has no message bus: the `conclave`
 * skill is prose doctrine with no dispatch envelope (`agents.ts` header), and spec §3 forbids
 * Mnemosia executing project tasks or acting for another agent. So routing is *addressing*, not
 * sending — the escalation is delivered to the requesting agent inside the briefing, naming which
 * seat must be consulted and what it must be asked, and the requesting agent dispatches it through
 * whatever the Conclave's ordinary sub-agent mechanism is. That is the same relationship
 * `writes.ts` already has to mutation: Mnemosia recommends, somebody else executes. An escalation
 * Mnemosia sent herself would be Mnemosia coordinating the Conclave, which spec §3's "must not
 * define the overall mission / replace Samaela's planning" rules out.
 *
 * **Two rules decide which target, and they divide by the kind of question rather than by severity.**
 *
 * - **Raskreia** gets the questions about whether a source may be *believed at all* — provenance
 *   that does not resolve, standing that disagrees with integrity, and access decisions the
 *   authorizer declined. Her `.md` question is "should we even build it this way", and its memory
 *   analogue is "should we even be reading this".
 * - **Elaria** gets the questions that are internally undecidable — two statements both still
 *   standing after every deterministic predicate has run. Her `.md` question is "is this internally
 *   correct", and an `UNRESOLVED` conflict is precisely a place where Mnemosia cannot answer it.
 *
 * Nothing here is a judgement call at runtime: each rule is a predicate over fields the conflict
 * record and the authorization already carry, and the trace records which predicate fired.
 */

import { createHash } from "node:crypto";

import { AGENT_DISPLAY_NAMES, resolveAgent, type ConclaveAgent } from "./agents.ts";
import type { ConflictRecord, ConflictResolution, EscalationOutcome } from "./conflicts.ts";
import type { ScopeAuthorization } from "./task.ts";
import type { TraceWriter } from "./trace.ts";

export const ESCALATION_SCHEMA_VERSION = "mnemosia/escalation@1";

/** Which seat an escalation is addressed to. Only two of the eight are escalation targets. */
export const ESCALATION_TARGETS = ["elaria", "raskreia"] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

/**
 * The predicates. Each is a property of data the run already holds — no predicate reads free text
 * and none of them is a threshold that could be moved to change how much escalates.
 */
export const ESCALATION_RULES = [
	/** A claim whose declared source events resolve to nothing, or which declares none. Provenance, not validity. */
	"unresolved_provenance",
	/** The authority table says believe A; the integrity check says A was never verified. */
	"authority_over_unverified",
	/** A contradiction with no deterministic winner: both sides standing, every predicate exhausted. */
	"undecided_contradiction",
	/** Any other conflict left `unresolved` after classification. */
	"unresolved_conflict",
	/**
	 * Design §14's "escalate uncertain access decisions".
	 *
	 * **Corrected while building: the case this rule fires on is not the one first written down.** The
	 * first draft escalated a scope the caller *explicitly requested and authorization refused* —
	 * which `task.ts:534-537` shows cannot happen, because an explicitly requested cross-project read
	 * is always granted. The rule would have been dead code wearing a §14 label.
	 *
	 * The genuinely uncertain decision is the other one: `cross_project_not_requested`. A project path
	 * appears in the task text, `authorizeScope` refuses it because a mention is not a request
	 * (spec §4's cross-project leak), and that refusal is a **conservative default rather than a
	 * determination** — the caller may well have meant it and simply not filled in
	 * `requested_projects`. Failing closed is right; failing closed silently is what leaves the reader
	 * unable to tell "there was nothing there" from "there was something and I would not look".
	 */
	"uncertain_access_decision",
] as const;
export type EscalationRule = (typeof ESCALATION_RULES)[number];

export interface EscalationRequest {
	schemaVersion: typeof ESCALATION_SCHEMA_VERSION;
	escalationId: string;
	target: EscalationTarget;
	targetDisplayName: string;
	rule: EscalationRule;
	/** The conflict that raised it, or `null` for an access escalation, which has no conflict record. */
	conflictId: string | null;
	claimIds: string[];
	/** What the target is being asked, phrased as a question that has an answer. */
	question: string;
	/** What the run already established, so the target is not made to rediscover it. */
	evidence: string;
	/** What Mnemosia needs back before the affected claims can leave `conflicts[]`. */
	requiredOutcome: string;
	/**
	 * `dispatch` when the requesting agent must consult another seat; `self` when the requester **is**
	 * the target. The second is a real routing decision rather than a formatting one: asking Elaria to
	 * ask Elaria is a loop, and suppressing the dispatch while keeping the question is what turns the
	 * escalation into the work item it actually is for her.
	 */
	delivery: "dispatch" | "self";
	/** The seat that asked for the briefing. Recorded so a stale escalation can be attributed. */
	raisedBy: string;
	raisedAt: number;
}

export interface EscalationResult {
	escalations: EscalationRequest[];
	/** conflictId → the routing outcome that replaced the deterministic one. */
	outcomeOverrides: Map<string, EscalationOutcome>;
	stats: {
		total: number;
		byTarget: Record<EscalationTarget, number>;
		byRule: Record<EscalationRule, number>;
		/** Escalations whose target is the requester, so no dispatch is asked for. */
		selfDelivered: number;
		/** Conflicts examined. `total` over this is the escalation rate for the run. */
		conflictsExamined: number;
	};
}

export interface RouteEscalationsInput {
	conflicts: ConflictResolution;
	authorization: ScopeAuthorization;
	/** The caller's `requesting_agent` string, unresolved. `resolveAgent` is applied here. */
	requestingAgent: string;
	/** Integrity of the best artifact behind a claim, for `authority_over_unverified`. */
	integrityOf?: (claimId: string) => "verified" | "unverified" | "failed" | undefined;
	now?: number;
	trace?: TraceWriter;
}

const TARGET_DISPLAY: Readonly<Record<EscalationTarget, string>> = Object.freeze({
	elaria: AGENT_DISPLAY_NAMES.elaria,
	raskreia: AGENT_DISPLAY_NAMES.raskreia,
});

const OUTCOME_FOR: Readonly<Record<EscalationTarget, EscalationOutcome>> = Object.freeze({
	elaria: "ESCALATE_TO_ELARIA",
	raskreia: "ESCALATE_TO_RASKREIA",
});

function escalationIdFor(rule: EscalationRule, subject: string, claimIds: readonly string[]): string {
	return createHash("sha256")
		.update(`${rule}${subject}${[...claimIds].sort().join("")}`, "utf8")
		.digest("hex")
		.slice(0, 32);
}

function short(claimId: string): string {
	return claimId.slice(0, 12);
}

/**
 * Decides the target for one conflict, or `null` when the conflict needs nobody.
 *
 * Order matters and is stated: the provenance and integrity rules are tested before the
 * undecidability rules, because a conflict that is *both* unresolved and provenance-broken is a
 * security question first. Escalating it to Elaria would ask a validator to reason about content
 * whose origin is in doubt, which is the wrong order of operations and the reason design §14 lists
 * integrity among the things a conflict resolution must consider.
 */
function classify(record: ConflictRecord, integrityOf: RouteEscalationsInput["integrityOf"]): { target: EscalationTarget; rule: EscalationRule } | null {
	if (record.conflictClass === "SUMMARY_SOURCE_MISMATCH") return { target: "raskreia", rule: "unresolved_provenance" };

	if (record.conflictClass === "AUTHORITY_DISAGREEMENT" && integrityOf !== undefined) {
		// The winner is the side the authority table preferred. If that side is the one nothing
		// verified, the two signals design §14 requires be considered together are pointing opposite
		// ways, and no ranking arithmetic resolves that — it is a question about whether the standing
		// table should be trusted here, which is an architecture question.
		const favoured = record.winnerClaimId;
		if (favoured !== null && integrityOf(favoured) === "unverified") return { target: "raskreia", rule: "authority_over_unverified" };
	}

	if (!record.unresolved) return null;
	if (record.conflictClass === "DIRECT_CONTRADICTION") return { target: "elaria", rule: "undecided_contradiction" };
	return { target: "elaria", rule: "unresolved_conflict" };
}

function questionFor(rule: EscalationRule, record: ConflictRecord | null): { question: string; requiredOutcome: string } {
	switch (rule) {
		case "unresolved_provenance":
			return {
				question: `A retrieved claim declares source events that resolve to nothing in this corpus. Is the artifact behind it trustworthy, or is this content whose origin cannot be established?`,
				requiredOutcome: "a verdict on the artifact: admissible, admissible-with-qualification, or quarantine. Until one arrives the claim stays in conflicts[] and cannot enter a factual section.",
			};
		case "authority_over_unverified":
			return {
				question: `The source-standing table favours a claim whose content integrity was never verified, over a claim that was. Should standing outrank verification for this source class?`,
				requiredOutcome: "either a confirmation that the standing ordering is correct here, or a policy change proposal against policy.ts (design §19 item 3). Mnemosia does not re-order her own authority table.",
			};
		case "undecided_contradiction":
			return {
				question: `Two claims contradict and no deterministic predicate decides between them${record === null ? "" : ` (similarity ${record.similarity === null ? "n/a" : record.similarity.toFixed(3)})`}. Which is internally correct, or are they compatible under a distinction Mnemosia cannot see?`,
				requiredOutcome: "a verdict naming the surviving claim, or a statement that both hold under different conditions. Both sides remain in conflicts[] until then; neither has been deleted.",
			};
		case "unresolved_conflict":
			return {
				question: `A detected conflict was left unresolved${record === null ? "" : ` (${record.conflictClass} via ${record.detector})`}. Is the plan or result that relies on these claims internally consistent?`,
				requiredOutcome: "a consistency verdict. Mnemosia has recorded the disagreement and will not choose a side without one.",
			};
		case "uncertain_access_decision":
			return {
				question: `The task names a project outside this run's authorized scope, and Mnemosia refused it because a mention is not a request. Should this agent be able to read that project for this task?`,
				requiredOutcome: "an access decision. Mnemosia does not widen her own authorization; if the answer is yes, the caller re-issues the request with the project named in requested_projects. Nothing from the refused scope was read, so this escalation costs nothing if the answer is no.",
			};
	}
}

export function routeEscalations(input: RouteEscalationsInput): EscalationResult {
	const now = input.now ?? Date.now();
	const requester = resolveAgent(input.requestingAgent);
	const escalations: EscalationRequest[] = [];
	const outcomeOverrides = new Map<string, EscalationOutcome>();
	const byTarget: Record<EscalationTarget, number> = { elaria: 0, raskreia: 0 };
	const byRule = Object.fromEntries(ESCALATION_RULES.map((rule) => [rule, 0])) as Record<EscalationRule, number>;
	let selfDelivered = 0;

	const emit = (target: EscalationTarget, rule: EscalationRule, conflictId: string | null, claimIds: readonly string[], evidence: string, record: ConflictRecord | null): void => {
		const { question, requiredOutcome } = questionFor(rule, record);
		// The one routing decision that is not a lookup. A conflict Elaria must adjudicate, raised in a
		// briefing Elaria asked for, is not a dispatch — it is her work item. Emitting it as a dispatch
		// would tell her to consult herself, which is the kind of instruction that gets a pipeline stuck.
		const isSelf = (requester.agent as ConclaveAgent | null) === target;
		if (isSelf) selfDelivered += 1;
		escalations.push({
			schemaVersion: ESCALATION_SCHEMA_VERSION,
			escalationId: escalationIdFor(rule, conflictId ?? "access", claimIds),
			target,
			targetDisplayName: TARGET_DISPLAY[target],
			rule,
			conflictId,
			claimIds: [...claimIds].sort(),
			question,
			evidence,
			requiredOutcome,
			delivery: isSelf ? "self" : "dispatch",
			raisedBy: requester.requested,
			raisedAt: now,
		});
		byTarget[target] += 1;
		byRule[rule] += 1;
		if (conflictId !== null) outcomeOverrides.set(conflictId, OUTCOME_FOR[target]);
	};

	/* --- conflict escalations ------------------------------------------------------------------- */
	for (const record of input.conflicts.conflicts) {
		const routed = classify(record, input.integrityOf);
		if (routed === null) continue;
		const evidence = `${record.conflictClass} detected by ${record.detector} over ${record.claimIds.length} claim(s) [${record.claimIds.map(short).join(", ")}]. Mnemosia's own reading: ${record.rationale}`;
		emit(routed.target, routed.rule, record.conflictId, record.claimIds, evidence, record);
	}

	/* --- access escalations (design §14) -------------------------------------------------------- */
	//
	// Only `cross_project_not_requested` escalates, and it is the only refusal rule `authorizeScope`
	// can produce, so this is not a filter that happens to admit everything — it is the statement that
	// any *future* refusal rule must opt in here deliberately rather than inherit an escalation it was
	// never designed for. A scope that was simply never mentioned is not refused and never reaches
	// this loop; escalating those would bury the real ones under every project on the machine.
	for (const refusal of input.authorization.refused) {
		if (refusal.ruleId !== "cross_project_not_requested") continue;
		emit(
			"raskreia",
			"uncertain_access_decision",
			null,
			[],
			`${refusal.scope.project ?? "(global)"} appears in the task text; authorizeScope refused it (${refusal.ruleId}): ${refusal.detail}. Run authorization outcome was ${input.authorization.outcome}. Nothing from that scope was read.`,
			null,
		);
	}

	const stats = { total: escalations.length, byTarget, byRule, selfDelivered, conflictsExamined: input.conflicts.conflicts.length };

	input.trace?.append({
		state: "RESOLVE_OR_ESCALATE",
		event: "escalation",
		payload: {
			...stats,
			requestingAgent: requester.requested,
			resolvedAgent: requester.agent,
			escalations: escalations.map((entry) => ({ escalationId: entry.escalationId, target: entry.target, rule: entry.rule, conflictId: entry.conflictId, delivery: entry.delivery, claims: entry.claimIds.length })),
		},
	});

	return { escalations, outcomeOverrides, stats };
}

/**
 * Applies the routing labels to the conflict records.
 *
 * Returns a **new** `ConflictResolution` rather than mutating: `detectConflicts`'s output is what
 * `rank.ts` scored against and what the trace already recorded, and rewriting it in place would make
 * the `conflict` trace events disagree with the delivered briefing about what the outcome was. The
 * override is a second, later fact about the same conflict, and the trace holds both.
 */
export function applyEscalationOutcomes(conflicts: ConflictResolution, overrides: ReadonlyMap<string, EscalationOutcome>): ConflictResolution {
	if (overrides.size === 0) return conflicts;
	const rewritten = conflicts.conflicts.map((record) => {
		const outcome = overrides.get(record.conflictId);
		return outcome === undefined ? record : { ...record, outcome };
	});
	const byId = new Map(rewritten.map((record) => [record.conflictId, record]));
	const byClaimId = new Map<string, ConflictRecord[]>();
	for (const record of rewritten) {
		for (const claimId of record.claimIds) {
			const list = byClaimId.get(claimId);
			if (list === undefined) byClaimId.set(claimId, [record]);
			else list.push(record);
		}
	}
	// `demoted` is keyed by claim and holds the record that demoted it. Rebuilt against the rewritten
	// records for the same reason `byClaimId` is: a reader following `demoted` to find out why a claim
	// is out of the factual sections must see the outcome the briefing renders, not the one it carried
	// before routing. `mandatory` is a set of claim ids and is unaffected — escalation changes the
	// label on a conflict, never which claims the conflict has.
	const demoted = new Map<string, ConflictRecord>();
	for (const [claimId, record] of conflicts.demoted) demoted.set(claimId, byId.get(record.conflictId) ?? record);
	const byOutcome = { ...conflicts.stats.byOutcome };
	for (const record of conflicts.conflicts) {
		const outcome = overrides.get(record.conflictId);
		if (outcome === undefined) continue;
		byOutcome[record.outcome] -= 1;
		byOutcome[outcome] += 1;
	}
	return { ...conflicts, conflicts: rewritten, byClaimId, demoted, stats: { ...conflicts.stats, byOutcome } };
}

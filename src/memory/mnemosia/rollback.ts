// Ported from mnemosia/rollback.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Safe rollback: policy-registry versions as addressable state, and spec §22's change record as a
 * real artifact (Phase 5).
 *
 * Design §19 item 3 already made a `policy.ts` bump a human approval item, and Phase 2 and Phase 4
 * each declared one — `mnemosia/policy-registry@1 → @2` and `@2 → @3`. What neither phase built is
 * the other half of an approval: the ability to *un*-approve. Three things are needed for that and
 * this module holds all three.
 *
 * 1. **Address a prior version.** `resolvePolicyAt(version, …)` answers "which policy would this
 *    request have resolved to under `@2`" — with the `@2` *chain*, not just the `@2` entries, because
 *    §19's own change list records that the resolution chain gained a link at `@3` and that link is
 *    the change with the widest blast radius.
 * 2. **Bind a run to it.** `PolicyPin` is passed to `runBriefing` through `OrchestratorDeps` and lands
 *    in the `ANALYZE_TASK` trace payload, so a pinned run says in its own audit log which registry it
 *    was decided under. Without that, a rollback would be indistinguishable in the trace from a
 *    resolver bug.
 * 3. **Prove the revert is exact.** A rollback that "mostly" restores prior behaviour is not a
 *    rollback. `replay.ts` is how that is proved: the same recorded envelopes, replayed under the
 *    pinned version, must reproduce the prior fingerprint *including the briefing digest*.
 *
 * **What a policy-registry pin does and does not roll back.** Design §21 keeps two layers apart —
 * the *ranking policy* (`policy.ts`, gated by §19 item 3) and the *briefing profile* (`agents.ts`:
 * lead order, addendum blocks, conflict presentation). A registry pin moves the first and leaves the
 * second alone, with one deliberate exception: `SelectionPolicy.sectionShares` lives on
 * `RankingPolicy`, and §19's `@2 → @3` packet lists "sectionShares became per-seat through
 * `withAgentSelection`" as one of the four registry changes. So `appliesAgentSelection` is false
 * below `@3` and the per-seat shares go back with the rest of the registry. Rolling the *profile*
 * back as well would be a second, unversioned change riding inside the one that was asked for —
 * which is exactly what §21.6 refused to let the Phase 4 agent-file build do.
 */

import { AGENT_POLICY, resolveAgent } from "./agents.ts";
import { DEFAULT_POLICY_ID, POLICIES, POLICY_REGISTRY_VERSION, PRIOR_POLICY_REGISTRY_VERSION, type PolicyResolution, type RankingPolicy } from "./policy.ts";
import type { OperationalMode, TaskType } from "./task.ts";
import { SCHEMA_VERSION } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * The registry lineage
 * ---------------------------------------------------------------------------------------------- */

export interface RegistryVersionRecord {
	version: string;
	phase: string;
	/** Whether a run can actually be resolved under this version today. */
	reconstructible: boolean;
	/** Links of the lookup chain in force at this version, in order. */
	chain: readonly string[];
	/** True once `withAgentSelection` exists, i.e. once section shares vary by seat. */
	agentSelection: boolean;
	/** Why this version is or is not reconstructible, and what it changed. */
	detail: string;
}

/**
 * The three registry versions, and the honest statement that only two of them can be run.
 *
 * **`@1` is not reconstructible and saying so is the point.** Phase 2's bump added three terms to
 * `EvidencePolicy` and a whole `conflict` sub-policy, and it renamed every policy id from `<name>@1`
 * to `<name>@2`. The `@1` objects were not kept — `POLICIES` holds the current registry only — so a
 * claim that Mnemosia can roll back to `@1` would be a claim about data that does not exist. It is
 * recorded here as a **limit of the rollback machinery**, which is a Phase 5 finding, rather than
 * quietly reconstructed from the design document's prose. Rolling back to `@1` would additionally
 * mean rolling back the Phase 2 evidence graph that `rank.ts` now computes against, i.e. reverting
 * code and not only data.
 */
export const POLICY_REGISTRY_HISTORY: readonly RegistryVersionRecord[] = Object.freeze([
	Object.freeze({
		version: "mnemosia/policy-registry@1",
		phase: "Phase 1",
		reconstructible: false,
		chain: Object.freeze(["(agent, taskType, mode)", "(agent, *, mode)", "(*, taskType, *)", "default@1"]),
		agentSelection: false,
		detail: "five policies, ids `<name>@1`, `EvidencePolicy` without ungroundedCeiling/corroboration/contradictionPenalty and with no `conflict` sub-policy. The objects were replaced rather than retained at the @2 bump, so this version cannot be resolved today; reverting to it would also mean reverting rank.ts's Phase 2 evidence formula, i.e. code and not only data.",
	}),
	Object.freeze({
		version: PRIOR_POLICY_REGISTRY_VERSION,
		phase: "Phase 2 / Phase 3",
		reconstructible: true,
		chain: Object.freeze(["(agent, taskType, mode)", "(agent, *, mode)", "(*, taskType, *)", DEFAULT_POLICY_ID]),
		agentSelection: false,
		detail: "the five @2 policies, which are still present byte-identical in POLICIES (design §19: 'every @2 policy id' was left unchanged by the @3 bump). Resolvable exactly: filter the registry to the @2 ids and run the four-link chain.",
	}),
	Object.freeze({
		version: POLICY_REGISTRY_VERSION,
		phase: "Phase 4 / Phase 5",
		reconstructible: true,
		chain: Object.freeze(["(agent, taskType, mode)", "(agent, *, mode)", "agent binding", "(*, taskType, *)", DEFAULT_POLICY_ID]),
		agentSelection: true,
		detail: "adds samaela@3 and astrelia@3, the agent-binding link, ASTRELIA_AUTHORITY_TABLE, and per-seat sectionShares through withAgentSelection.",
	}),
]);

export function registryVersionRecord(version: string): RegistryVersionRecord | undefined {
	return POLICY_REGISTRY_HISTORY.find((entry) => entry.version === version);
}

/** Versions a run can actually be resolved under today. */
export function reconstructibleRegistryVersions(): string[] {
	return POLICY_REGISTRY_HISTORY.filter((entry) => entry.reconstructible).map((entry) => entry.version);
}

/** Whether per-seat section shares apply at this registry version (a `@3` change, see the header). */
export function appliesAgentSelection(version: string): boolean {
	return registryVersionRecord(version)?.agentSelection ?? false;
}

/* ------------------------------------------------------------------------------------------------
 * Resolution at a version
 * ---------------------------------------------------------------------------------------------- */

/**
 * The suffix of a policy id that names its registry generation. `samaela@3` → `3`.
 *
 * `RankingPolicy.version` already holds it; this reads the id so that the partition of the registry
 * and the ids a reviewer sees in a trace cannot disagree.
 */
function generationOf(policy: RankingPolicy): string {
	const at = policy.policyId.lastIndexOf("@");
	return at === -1 ? policy.version : policy.policyId.slice(at + 1);
}

/** The registry as it stood at `version`: every policy whose generation is at or below it. */
export function policiesAt(version: string): RankingPolicy[] {
	const record = registryVersionRecord(version);
	if (record === undefined) throw new Error(`unknown policy-registry version ${version}; known: ${POLICY_REGISTRY_HISTORY.map((entry) => entry.version).join(", ")}`);
	if (!record.reconstructible) throw new Error(`${version} is not reconstructible: ${record.detail}`);
	const ceiling = Number(version.slice(version.lastIndexOf("@") + 1));
	return POLICIES.filter((policy) => Number(generationOf(policy)) <= ceiling);
}

export interface PinnedResolution extends PolicyResolution {
	registryVersion: string;
	/** True when the resolution differs from the one the *current* registry would have produced. */
	differsFromCurrent: boolean;
	currentPolicyId: string;
}

function matchKey(agent: string, taskType: string, mode: string): string {
	return `${agent.toLowerCase()}${taskType}${mode}`;
}

/**
 * `resolvePolicy` as it behaved at `version`.
 *
 * The chain is rebuilt here rather than parameterized inside `policy.ts` for a reason worth stating:
 * `policy.ts` is the file design §19 item 3 gates on approval, and adding a "which chain would you
 * like" switch to it would make the production resolver's behaviour a caller's choice. The pinned
 * resolver is a separate function in a separate module that the production path does not call, and
 * `runBriefing` reaches it only when a caller has explicitly supplied a `PolicyPin`.
 */
export function resolvePolicyAt(version: string, agent: string, taskType: TaskType, mode: OperationalMode): PinnedResolution {
	const record = registryVersionRecord(version);
	if (record === undefined) throw new Error(`unknown policy-registry version ${version}`);
	const available = policiesAt(version);
	const index = new Map(available.map((entry) => [matchKey(entry.match.agent, entry.match.taskType, entry.match.mode), entry]));
	const resolved = resolveAgent(agent);
	const attempted: string[] = [];

	const fallbackPolicy = available.find((entry) => entry.policyId === DEFAULT_POLICY_ID);
	if (fallbackPolicy === undefined) throw new Error(`the ${version} registry has no ${DEFAULT_POLICY_ID}`);

	const answer = (policy: RankingPolicy, matchedBy: PolicyResolution["matchedBy"]): PinnedResolution => {
		// The comparison is against the *current* resolver, so a pin that changes nothing says so.
		// Imported lazily-by-value rather than by calling resolvePolicy here would be circular; the
		// caller supplies the comparison instead when it needs one, and this cheap form uses the
		// registry's own head version.
		const current = currentResolution(agent, taskType, mode);
		return { policy, matchedBy, attempted, resolvedAgent: resolved.agent, registryVersion: version, differsFromCurrent: current !== policy.policyId, currentPolicyId: current };
	};

	for (const [key, matchedBy] of [
		[matchKey(agent, taskType, mode), "agent_task_mode"],
		[matchKey(agent, "*", mode), "agent_mode"],
	] as const) {
		attempted.push(key);
		const found = index.get(key);
		if (found !== undefined) return answer(found, matchedBy);
	}

	// Link 3 exists only from `@3`. Below it, a caller naming a Conclave seat falls through to the
	// task link — which is precisely the behaviour design §21.4 item 1 records as the defect Phase 4
	// corrected, and precisely what a rollback to `@2` is asking to restore.
	if (record.chain.includes("agent binding") && resolved.agent !== null) {
		const binding = AGENT_POLICY[resolved.agent];
		attempted.push(`agent:${resolved.agent}${binding.policyId}`);
		const bound = available.find((entry) => entry.policyId === binding.policyId);
		if (bound !== undefined) return answer(bound, "agent");
	}

	attempted.push(matchKey("*", taskType, "*"));
	const byTask = index.get(matchKey("*", taskType, "*"));
	if (byTask !== undefined) return answer(byTask, "task");

	attempted.push(matchKey("*", "*", "*"));
	return answer(fallbackPolicy, "default");
}

/** The head registry's answer, used only to report whether a pin changes anything. */
function currentResolution(agent: string, taskType: TaskType, mode: OperationalMode): string {
	const index = new Map(POLICIES.map((entry) => [matchKey(entry.match.agent, entry.match.taskType, entry.match.mode), entry]));
	const resolved = resolveAgent(agent);
	const direct = index.get(matchKey(agent, taskType, mode)) ?? index.get(matchKey(agent, "*", mode));
	if (direct !== undefined) return direct.policyId;
	if (resolved.agent !== null) return AGENT_POLICY[resolved.agent].policyId;
	return (index.get(matchKey("*", taskType, "*")) ?? POLICIES.find((entry) => entry.policyId === DEFAULT_POLICY_ID))?.policyId ?? DEFAULT_POLICY_ID;
}

/* ------------------------------------------------------------------------------------------------
 * The pin
 * ---------------------------------------------------------------------------------------------- */

export interface PolicyPin {
	readonly schemaVersion: typeof SCHEMA_VERSION.policyPin;
	/** A version from `POLICY_REGISTRY_HISTORY` that is `reconstructible`. */
	readonly registryVersion: string;
	/** Who pinned it. Recorded in the run's trace, like the mutation gate's `enabledBy`. */
	readonly pinnedBy: string;
	readonly reason: string;
	/** `false` below `@3`: per-seat section shares are a registry change, see the header. */
	readonly agentSelection: boolean;
}

/**
 * The only constructor. It refuses an unknown or unreconstructible version *at construction time*
 * rather than at resolution time, so a rollback plan that names `@1` fails while it is being written
 * down instead of halfway through the run it was supposed to make safe.
 */
// Ported library surface: no caller under src/ uses the pin or the policy change packet yet; the ported suite covers it.
export function pinPolicyRegistry(registryVersion: string, pinnedBy: string, reason: string): PolicyPin {
	const record = registryVersionRecord(registryVersion);
	if (record === undefined) throw new Error(`unknown policy-registry version ${registryVersion}; known: ${POLICY_REGISTRY_HISTORY.map((entry) => entry.version).join(", ")}`);
	if (!record.reconstructible) throw new Error(`cannot pin ${registryVersion}: ${record.detail}`);
	if (typeof pinnedBy !== "string" || pinnedBy.trim().length === 0) throw new Error("pinPolicyRegistry requires a named pinner; a rollback nobody is accountable for is not a rollback");
	if (typeof reason !== "string" || reason.trim().length === 0) throw new Error("pinPolicyRegistry requires a reason; design §19 item 3 makes a registry change a human decision and undoing one is the same decision");
	return Object.freeze({ schemaVersion: SCHEMA_VERSION.policyPin, registryVersion, pinnedBy: pinnedBy.trim(), reason: reason.trim(), agentSelection: record.agentSelection });
}

/* ------------------------------------------------------------------------------------------------
 * Spec §22's change packet
 * ---------------------------------------------------------------------------------------------- */

/**
 * Spec §22 lists eight things every policy change must include. This is that list as a type, so an
 * incomplete change packet is a value that fails validation rather than a paragraph somebody meant
 * to finish. `validatePolicyChangePacket` names every missing field; nothing here fills one in.
 */
export interface PolicyChangePacket {
	schemaVersion: typeof SCHEMA_VERSION.policyChangePacket;
	/** §22.1 */ previousVersion: string;
	/** §22.2 */ proposedVersion: string;
	/** §22.3 — what was measured, where, and against which pre-registered threshold. */
	evaluationEvidence: string[];
	/** §22.4 */ expectedBenefit: string;
	/** §22.5 — the prior gates, re-run, with their verdicts. */
	regressionResults: string[];
	/** §22.6 */ securityReview: string;
	/** §22.7 — must be executable, not aspirational: a pinnable version and the proof method. */
	rollbackPlan: string;
	/** §22.8. `PROPOSED` until a named human decides. Nothing in this codebase may set `APPROVED`. */
	approvalStatus: "PROPOSED" | "APPROVED" | "REJECTED";
	/** Who decided, once somebody has. `null` while `PROPOSED`. */
	decidedBy: string | null;
	/** Every policy id that changes, and how. */
	changes: string[];
	/** Every policy id that is byte-identical across the bump. Stating this is half the review. */
	unchanged: string[];
}

export interface PacketValidation {
	complete: boolean;
	missing: string[];
	detail: string;
}

const PACKET_REQUIRED: ReadonlyArray<keyof PolicyChangePacket> = ["previousVersion", "proposedVersion", "evaluationEvidence", "expectedBenefit", "regressionResults", "securityReview", "rollbackPlan", "approvalStatus"];

export function validatePolicyChangePacket(packet: PolicyChangePacket): PacketValidation {
	const missing: string[] = [];
	for (const field of PACKET_REQUIRED) {
		const value = packet[field];
		if (typeof value === "string" && value.trim().length === 0) missing.push(field);
		else if (Array.isArray(value) && value.length === 0) missing.push(field);
		else if (value === undefined || value === null) missing.push(field);
	}
	if (packet.approvalStatus !== "PROPOSED" && (packet.decidedBy === null || packet.decidedBy.trim().length === 0)) missing.push("decidedBy");
	return {
		complete: missing.length === 0,
		missing,
		detail: missing.length === 0 ? `all eight spec §22 fields are present; approval status is ${packet.approvalStatus}` : `spec §22 requires all eight; missing: ${missing.join(", ")}`,
	};
}

export function renderPolicyChangePacket(packet: PolicyChangePacket): string {
	const validation = validatePolicyChangePacket(packet);
	const lines: string[] = [];
	lines.push(`POLICY CHANGE PACKET (spec §22) — ${packet.previousVersion} → ${packet.proposedVersion}`);
	lines.push("─".repeat(110));
	lines.push(`1. previous version   : ${packet.previousVersion}`);
	lines.push(`2. proposed version   : ${packet.proposedVersion}`);
	lines.push(`3. evaluation evidence:`);
	for (const entry of packet.evaluationEvidence) lines.push(`     - ${entry}`);
	lines.push(`4. expected benefit   : ${packet.expectedBenefit}`);
	lines.push(`5. regression results :`);
	for (const entry of packet.regressionResults) lines.push(`     - ${entry}`);
	lines.push(`6. security review    : ${packet.securityReview}`);
	lines.push(`7. rollback plan      : ${packet.rollbackPlan}`);
	lines.push(`8. approval status    : ${packet.approvalStatus}${packet.decidedBy === null ? "" : ` (decided by ${packet.decidedBy})`}`);
	lines.push("");
	lines.push(`   changed  : ${packet.changes.length === 0 ? "(none)" : ""}`);
	for (const entry of packet.changes) lines.push(`     - ${entry}`);
	lines.push(`   unchanged: ${packet.unchanged.length === 0 ? "(none)" : ""}`);
	for (const entry of packet.unchanged) lines.push(`     - ${entry}`);
	lines.push("");
	lines.push(`   validation: ${validation.detail}`);
	return lines.join("\n");
}

/**
 * The two packets Phases 2 and 4 declared as outstanding approval items, written down as data.
 *
 * Design §19 item 3 recorded both in prose. Prose cannot be validated, diffed or refused, and a
 * §22 obligation that lives only in a document is one nobody can be shown to have met — which is
 * why the brief for this phase asks for "a real artifact the machinery produces, not prose". The
 * content is unchanged from §19; only its form is. **Both remain `PROPOSED`.** Nothing in this
 * codebase constructs `APPROVED`, and `test/rollback.test.ts` asserts it over the source tree.
 */
export const OUTSTANDING_POLICY_CHANGES: readonly PolicyChangePacket[] = Object.freeze([
	Object.freeze({
		schemaVersion: SCHEMA_VERSION.policyChangePacket,
		previousVersion: "mnemosia/policy-registry@1",
		proposedVersion: "mnemosia/policy-registry@2",
		evaluationEvidence: Object.freeze([
			"eval/harness.ts, full design §16 table re-run under @2 on the live corpus: 10/11, unchanged from @1, same single failure (irrelevant-memory rate 0.127 against ≤ 0.20 and ≤ ½ of the lexical baseline's 0.075).",
			"eval/conflicts-eval.ts over 67 labelled seeds (46 positive, 21 negative): precision 1.000, recall 0.957, SUMMARY_SOURCE_MISMATCH catch 1.000, against pre-registered 0.80 / 0.60 / 0.90.",
			"On a claim with one independent group, no contradiction and graph distance ≤ 2 the new evidence formula reduces exactly to Phase 1's, so the §16 table is comparable across the bump rather than silently re-baselined.",
		]) as string[],
		expectedBenefit: "evidence_strength computed from the real provenance graph rather than from a flat list: independence (distinct sourceId|taskScope groups) stops one session cited three times reading as three witnesses, contradiction is priced, and an ungrounded summary claim falls below the authority floor of an assistant turn.",
		regressionResults: Object.freeze([
			"Phase 1 gate: 10/11 before, 10/11 after, identical failing row.",
			"PHASE 6 RE-RUN, and the number above is kept as the record of what was measured at the time: the Phase 1 gate now reads 11/11 and the Phase 2 gate 3/4 (qualifier precision 0.784 over a fresh 227-hit sample). Neither movement is attributable to this bump — the failing row was retired by a threshold amendment argued in design §16, and the qualifier number came from correcting an extractor rule. The six ranking weights are still byte-identical and this packet's own delta is still inert.",
			"Six ranking weights byte-identical in all five policies; EVIDENCE_POLICY additive; CONFLICT_POLICY moves two already-fixed constants out of code into the reviewable table without changing either value.",
			"Determinism 30/30; provenance completeness 1.0000; stale inclusion 0; security isolation 0/6.",
		]) as string[],
		securityReview: "no change to the trust boundary, the channel enum, the hard-filter set or the quarantine path. The three new EvidencePolicy terms are multipliers on a signal that is computed only over claims that already survived filtering, and no signal can resurrect a rejected candidate (design §9). The conflict sub-policy exposes two thresholds to review that were previously literals in conflicts.ts, which widens auditability rather than authority.",
		rollbackPlan: "pinPolicyRegistry('mnemosia/policy-registry@1', …) is REFUSED: the @1 objects were replaced rather than retained, so this bump is NOT reversible by pinning. Reverting it requires reverting rank.ts's Phase 2 evidence formula as well — code, not only data. This is a limitation of the change as executed and is recorded rather than papered over.",
		approvalStatus: "PROPOSED" as const,
		decidedBy: null,
		changes: Object.freeze([
			"EvidencePolicy += ungroundedCeiling 0.25, corroborationBonus 0.1, corroborationCap 0.2, contradictionPenalty 0.15",
			"ConflictPolicy is new, holding design §11's already-fixed 0.6 and 0.2",
			"every policy id `<name>@1` → `<name>@2`",
		]) as string[],
		unchanged: Object.freeze(["the six ranking weights of all five policies", "AUTHORITY_TABLE", "HALF_LIFE_DAYS", "CERTAINTY_CONFIDENCE", "SECTION_SHARES", "SELECTION_POLICY"]) as string[],
	}),
	Object.freeze({
		schemaVersion: SCHEMA_VERSION.policyChangePacket,
		previousVersion: "mnemosia/policy-registry@2",
		proposedVersion: "mnemosia/policy-registry@3",
		evaluationEvidence: Object.freeze([
			"scripts/phase4-ab.ts over the 19 labelled gold retrieval tasks, control arm produced by the shipped code (an unrecognised caller resolves DEFAULT_PROFILE, which *is* the Phase 3 composition): 19/19 same outcome, 18/19 same item count, 50 → 49 factual items.",
			"scripts/phase4-live.ts, one live task through eight seats: 7 of 8 distinct evidence sets (Avaritia ≡ Vaelia, reported rather than obscured).",
			"Blast radius stated before it was measured: the new agent link changes the resolved policy on 13 of the 19 gold retrieval tasks.",
		]) as string[],
		expectedBenefit: "spec §12 lists 'requesting agent' first among the dimensions ranking must be configurable by, and the four-link chain had no key at which 'this is how Samaela reads memory, in every mode' could be written down. The fifth link makes the first-listed dimension reachable; the two new policies use it; six of the eight seats deliberately do not.",
		regressionResults: Object.freeze([
			"Phase 1 gate 10/11 (same single failure), Phase 2 gate 3/4 (same single failure), Phase 3 79/79 — all re-run under @3.",
			"PHASE 6 RE-RUN under @3: Phase 1 11/11, Phase 2 3/4, Phase 3 79/79, Phase 4 19/19 same outcome and 7-of-8 distinct evidence sets, Phase 5 19/19 EXACT replay. The Phase 1 row moved because design §16's irrelevant-memory clause was amended, not because this bump changed anything; scripts/phase5-experiment.ts still measures the @2 and @3 arms as indistinguishable on all eight graded rows.",
			"Critical recall 1.000, stale inclusion 0, provenance completeness 1.0000, security isolation 0/6, determinism 30/30.",
			"No weight, gold label, fixture, proxy or threshold moved.",
		]) as string[],
		securityReview: "the new link reads a caller-declared string (`requesting_agent`) and maps it through agents.ts:resolveAgent, which is exact rather than fuzzy — `vesperia-2` and `elara` resolve to nobody and receive the shared default with the reason stated in the briefing. A fuzzy resolver would hand a caller a profile designed around somebody else's job, which is a privilege question and not a UX one. ASTRELIA_AUTHORITY_TABLE lowers curated standing for one seat and raises tool_output; it cannot admit anything the hard filters rejected, because authority is a weight over the surviving set.",
		rollbackPlan: "pinPolicyRegistry('mnemosia/policy-registry@2', pinnedBy, reason) restores the four-link chain, hides samaela@3 and astrelia@3, and disables per-seat sectionShares. Proved exact by replay.ts: the same recorded envelopes replayed under the pin must reproduce the @2 briefing digest byte for byte. Measured in Phase 5.",
		approvalStatus: "PROPOSED" as const,
		decidedBy: null,
		changes: Object.freeze([
			"POLICIES += samaela@3, astrelia@3",
			"resolution chain += the `(agent)` binding link, above `(*, taskType, *)`",
			"ASTRELIA_AUTHORITY_TABLE is new (tool_output 0.50 → 0.80, curated_memory 0.90 → 0.60, for one seat)",
			"SelectionPolicy.sectionShares becomes per-seat through withAgentSelection",
		]) as string[],
		unchanged: Object.freeze(["the six weights of default@2, debug@2, review@2, recall@2, vesperia-fast@2", "AUTHORITY_TABLE", "EVIDENCE_POLICY", "CONFLICT_POLICY", "HALF_LIFE_DAYS", "CERTAINTY_CONFIDENCE", "every @2 policy id"]) as string[],
	}),
]);

/* ------------------------------------------------------------------------------------------------
 * Rollback plans
 * ---------------------------------------------------------------------------------------------- */

export interface RollbackPlan {
	from: string;
	to: string;
	pin: PolicyPin;
	/** What changes back, taken from the lineage rather than restated. */
	restores: string[];
	/** What a pin does NOT restore, so nobody mistakes the scope. */
	doesNotRestore: string[];
	/** How the revert is proved rather than asserted. */
	proof: string;
}

// Ported library surface: no caller under src/ uses planRollback yet; the ported suite covers it.
export function planRollback(from: string, to: string, pinnedBy: string, reason: string): RollbackPlan {
	const target = registryVersionRecord(to);
	const source = registryVersionRecord(from);
	if (source === undefined) throw new Error(`unknown policy-registry version ${from}`);
	if (target === undefined) throw new Error(`unknown policy-registry version ${to}`);
	const pin = pinPolicyRegistry(to, pinnedBy, reason);
	const removedChain = source.chain.filter((link) => !target.chain.includes(link));
	const ceiling = Number(to.slice(to.lastIndexOf("@") + 1));
	const hidden = POLICIES.filter((policy) => Number(generationOf(policy)) > ceiling).map((policy) => policy.policyId);
	return {
		from,
		to,
		pin,
		restores: [
			`the ${target.chain.length}-link resolution chain: ${target.chain.join(" → ")}`,
			removedChain.length === 0 ? "no chain link is removed" : `chain link(s) removed: ${removedChain.join(", ")}`,
			hidden.length === 0 ? "no policy is hidden" : `policies hidden from resolution: ${hidden.join(", ")}`,
			target.agentSelection ? "per-seat sectionShares remain in force" : "per-seat sectionShares are disabled; design §10's shares apply to every seat",
		],
		doesNotRestore: [
			"the agents.ts briefing profile layer — lead sections, addendum blocks, conflict presentation and the feedback template are versioned separately (design §21) and a policy-registry pin does not touch them",
			"escalation routing (src/escalation.ts), which is behaviour rather than policy data",
			"anything below the pinned version that is marked non-reconstructible in POLICY_REGISTRY_HISTORY",
		],
		proof: "replay.ts: capture a run's envelopes, replay them under the pin, and require the resulting RunFingerprint — including the briefing digest — to equal the fingerprint the prior version produced. A rollback that reproduces the outcome but not the briefing is not a rollback.",
	};
}

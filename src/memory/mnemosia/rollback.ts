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
// Ported library surface: no caller under src/ uses the pin yet; the ported suite covers it.
export function pinPolicyRegistry(registryVersion: string, pinnedBy: string, reason: string): PolicyPin {
	const record = registryVersionRecord(registryVersion);
	if (record === undefined) throw new Error(`unknown policy-registry version ${registryVersion}; known: ${POLICY_REGISTRY_HISTORY.map((entry) => entry.version).join(", ")}`);
	if (!record.reconstructible) throw new Error(`cannot pin ${registryVersion}: ${record.detail}`);
	if (typeof pinnedBy !== "string" || pinnedBy.trim().length === 0) throw new Error("pinPolicyRegistry requires a named pinner; a rollback nobody is accountable for is not a rollback");
	if (typeof reason !== "string" || reason.trim().length === 0) throw new Error("pinPolicyRegistry requires a reason; design §19 item 3 makes a registry change a human decision and undoing one is the same decision");
	return Object.freeze({ schemaVersion: SCHEMA_VERSION.policyPin, registryVersion, pinnedBy: pinnedBy.trim(), reason: reason.trim(), agentSelection: record.agentSelection });
}

// Ported from mnemosia/retention.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Retention: the trace-rotation policy of design §17 ambiguity 2 and §19 item 4.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE DECISION IS NOT RECORDED AS MADE, AND THAT IS THE POINT OF THIS HEADER.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Design §17 ambiguity 2 reads: *"Trace retention — unbounded at ~5–20KB/run. Default: keep
 * everything until Phase 2. Needs a human decision."* Two things follow.
 *
 * **First: the stated default has expired.** "Keep everything until Phase 2" was a default with a
 * termination condition, and the condition has been met — Phase 2 is built and measured. So the
 * ambiguity is no longer non-blocking in the way §17 claims for its entries; it currently has *no*
 * working default at all, only a lapsed one. That is a finding about the design document rather than
 * about the code, and it is recorded here rather than quietly patched.
 *
 * **Second: §19 item 4 makes the replacement a human approval item.** This module therefore does what
 * `mutate.ts` does with §19 item 2, for the same reason and with the same shape: it builds the whole
 * mechanism, states a default policy in reviewable form, computes exactly what that policy *would*
 * delete against the real directory — and does not delete it. `planTraceRotation` is pure and always
 * safe to call. `applyTraceRotation` requires a `RetentionGate` that only `enableRetention(named,
 * justification)` can produce, and in piroboros only `open.ts` calls that, with the user's approval.
 *
 * Recording the decision as made would be Mnemosia approving a §19 item on a human's behalf, which is
 * precisely the move this entire phase exists to refuse. Recording it as made *while also* refusing
 * to activate §19 item 2 would be worse: it would mean the approval discipline holds for the item
 * whose subject is somebody else's database and lapses for the item whose subject is Mnemosia's own
 * audit log — which is the one an interested party would most want to shorten.
 *
 * What is offered instead of a decision is the number the decision needs. `scripts/phase3-live.ts`
 * prints the measured trace-directory size, file count and age spread, so the choice costs the human
 * a minute rather than an investigation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROPOSED DEFAULT, stated so it can be approved or rejected as written
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Keep a trace while either of two things is true, and delete it only when neither is:
 *
 *   - it is younger than `maxAgeDays` (proposed: **90**), or
 *   - it is among the `keepRuns` most recent traces (proposed: **500**).
 *
 * The disjunction, rather than an age cut alone, is what makes the policy safe on a quiet machine:
 * an age-only rule would empty the directory entirely after a three-month gap, and `explainDecision`
 * — the whole reason traces are kept — would then have nothing to answer with. The count floor is
 * what guarantees that "why was this not in my briefing" is always answerable for recent work.
 *
 * 90 days is derived rather than picked: it is the half-life design §9 assigns to `FACT`, i.e. the
 * horizon past which this system already treats its own retrieved material as substantially stale.
 * A retention window shorter than the freshness horizon would discard the audit of decisions the
 * ranker still considers current. 500 runs at the measured ~5–20KB/run bounds the floor at 2.5–10MB,
 * which is a rounding error beside the 112MB corpus it audits.
 *
 * **Never deleted regardless of policy:** any trace named by a `PENDING` or `APPROVED` item in the
 * approval queue. A write proposal a human has not yet decided must not lose the audit of the run
 * that produced it — that is the one case where a trace is not merely derived history but the
 * evidence behind a pending decision.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const RETENTION_POLICY_SCHEMA_VERSION = "mnemosia/retention-policy@1";

export interface TraceRetentionPolicy {
	readonly schemaVersion: string;
	/** Traces younger than this are always kept. */
	readonly maxAgeDays: number;
	/** The N most recent traces are always kept, however old. */
	readonly keepRuns: number;
}

/** The proposal of the header. It is a *proposal*: nothing applies it. */
export const TRACE_RETENTION_DEFAULT: TraceRetentionPolicy = Object.freeze({
	schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
	maxAgeDays: 90,
	keepRuns: 500,
});

/**
 * §19 item 4's approval, expressed the same way §19 item 2's is in `mutate.ts`: a frozen value with
 * no mutator, obtainable only from an explicit constructor that demands a name and a reason.
 */
export interface RetentionGate {
	readonly schemaVersion: "mnemosia/retention-gate@1";
	readonly rotationEnabled: boolean;
	readonly enabledBy: string | null;
	readonly justification: string | null;
}

export const DEFAULT_RETENTION_GATE: RetentionGate = Object.freeze({
	schemaVersion: "mnemosia/retention-gate@1",
	rotationEnabled: false,
	enabledBy: null,
	justification: null,
});

export function enableRetention(enabledBy: string, justification: string): RetentionGate {
	if (typeof enabledBy !== "string" || enabledBy.trim().length === 0) throw new Error("enableRetention requires a named enabler; design §19 item 4 is a human decision");
	if (typeof justification !== "string" || justification.trim().length === 0) throw new Error("enableRetention requires a justification; deleting an audit trail is not a maintenance task");
	return Object.freeze({ schemaVersion: "mnemosia/retention-gate@1" as const, rotationEnabled: true, enabledBy: enabledBy.trim(), justification: justification.trim() });
}

export interface TraceFileInfo {
	runId: string;
	path: string;
	bytes: number;
	mtimeMs: number;
	ageDays: number;
}

export interface TraceRotationPlan {
	policy: TraceRetentionPolicy;
	root: string;
	now: number;
	files: number;
	bytes: number;
	keep: TraceFileInfo[];
	/** What the policy *would* delete. `applyTraceRotation` is the only thing that acts on it. */
	remove: TraceFileInfo[];
	/** Kept despite the policy because a pending or approved decision depends on them. */
	pinned: TraceFileInfo[];
	bytesReclaimable: number;
	oldestAgeDays: number;
	newestAgeDays: number;
}

export function readTraceDirectory(root: string, now: number = Date.now()): TraceFileInfo[] {
	if (!existsSync(root)) return [];
	const files: TraceFileInfo[] = [];
	for (const name of readdirSync(root)) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(root, name);
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		files.push({ runId: name.slice(0, -".jsonl".length), path, bytes: stat.size, mtimeMs: stat.mtimeMs, ageDays: (now - stat.mtimeMs) / 86_400_000 });
	}
	// Newest first, so "the N most recent" is a prefix and the ordering is total.
	files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
	return files;
}

export interface PlanTraceRotationOptions {
	root: string;
	now?: number;
	policy?: TraceRetentionPolicy;
	/** runIds a pending or approved decision depends on. Never removed, whatever the policy says. */
	pinnedRunIds?: Iterable<string>;
}

/**
 * Pure, side-effect free, and always safe to call. This is what a human reads before deciding.
 */
export function planTraceRotation(options: PlanTraceRotationOptions): TraceRotationPlan {
	const root = options.root;
	const now = options.now ?? Date.now();
	const policy = options.policy ?? TRACE_RETENTION_DEFAULT;
	const pinnedIds = new Set(options.pinnedRunIds ?? []);
	const files = readTraceDirectory(root, now);

	const keep: TraceFileInfo[] = [];
	const remove: TraceFileInfo[] = [];
	const pinned: TraceFileInfo[] = [];
	files.forEach((file, index) => {
		if (pinnedIds.has(file.runId)) {
			pinned.push(file);
			keep.push(file);
			return;
		}
		// The disjunction: recent by age OR recent by rank. Only failing both makes a file removable.
		if (file.ageDays < policy.maxAgeDays || index < policy.keepRuns) keep.push(file);
		else remove.push(file);
	});

	return {
		policy,
		root,
		now,
		files: files.length,
		bytes: files.reduce((sum, file) => sum + file.bytes, 0),
		keep,
		remove,
		pinned,
		bytesReclaimable: remove.reduce((sum, file) => sum + file.bytes, 0),
		oldestAgeDays: files.length === 0 ? 0 : (files[files.length - 1] as TraceFileInfo).ageDays,
		newestAgeDays: files.length === 0 ? 0 : (files[0] as TraceFileInfo).ageDays,
	};
}

export interface RotationResult {
	applied: boolean;
	removed: string[];
	failed: Array<{ path: string; error: string }>;
	bytesReclaimed: number;
	reason: string;
}

/**
 * The only function here that deletes anything, and it refuses unless §19 item 4 has been granted.
 *
 * The refusal is the default and there is no configuration that changes it — same construction as
 * `mutate.ts`'s gate, and for a stronger reason: an audit trail that a program may prune on its own
 * initiative is an audit trail whose absences cannot be distinguished from its silences.
 */
export function applyTraceRotation(plan: TraceRotationPlan, gate: RetentionGate = DEFAULT_RETENTION_GATE): RotationResult {
	if (!gate.rotationEnabled) {
		return {
			applied: false,
			removed: [],
			failed: [],
			bytesReclaimed: 0,
			reason: `trace rotation is NOT ACTIVE. Design §19 item 4 makes the retention policy a human approval item and no approval is recorded. The proposed default (keep < ${plan.policy.maxAgeDays}d OR among the ${plan.policy.keepRuns} most recent) would remove ${plan.remove.length} of ${plan.files} trace file(s), reclaiming ${plan.bytesReclaimable} bytes. Nothing was deleted.`,
		};
	}
	const removed: string[] = [];
	const failed: RotationResult["failed"] = [];
	let bytesReclaimed = 0;
	for (const file of plan.remove) {
		try {
			rmSync(file.path);
			removed.push(file.runId);
			bytesReclaimed += file.bytes;
		} catch (error) {
			failed.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { applied: true, removed, failed, bytesReclaimed, reason: `rotation applied under ${gate.enabledBy}'s authorization (${gate.justification}); ${removed.length} removed, ${failed.length} failed` };
}

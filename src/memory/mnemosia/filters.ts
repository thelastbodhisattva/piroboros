// Ported from mnemosia/filters.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Hard filters and the quarantine scan (spec §11, design §12, build-order step 9).
 *
 * A hard filter is not a low score. Spec §11's closing line — "a candidate rejected by a hard filter
 * must not be restored by a high semantic-relevance score" — is enforced structurally: this module
 * runs before `rank.ts` and returns two disjoint lists, so the ranker is never given a rejected
 * candidate to be tempted by. There is no threshold, no override, and no path back.
 *
 * **The scan runs over everything.** Design §12 is explicit that `validateMemorySafety` must run
 * over *every* normalized artifact and not only over curated memories, and the reason is historical
 * rather than theoretical: AkashicForge applies the scanner on the write path for memories, but other
 * sources never pass through that scanner, so their content has not been checked for an injected instruction. So `scanArtifacts`
 * walks the whole envelope set — including envelopes that produced no claims, whose count is still
 * reported — and a failure quarantines the artifact for the run.
 *
 * **Evidence is pruned before a claim is rejected.** Deduplication unions evidence across artifacts
 * (claims.ts), so a merged claim can stand on a clean artifact and a quarantined one at the same
 * time. Rejecting the whole claim would discard a supported statement because of an artifact it did
 * not need; keeping it whole would let the quarantined artifact stay in the provenance chain of
 * something that gets briefed. Pruning the bad evidence and rejecting only when nothing is left is
 * the only option that keeps both provenance and the quarantine honest.
 */

import { scopeKey, type ArtifactEnvelope, type Certainty, type Claim, type ClaimType, type Evidence, type LifecycleState } from "./types.ts";
import { CERTAINTY_RANK } from "./claims.ts";
import type { ScopeAuthorization } from "./task.ts";

/* ------------------------------------------------------------------------------------------------
 * The upstream safety scanner, described structurally
 * ---------------------------------------------------------------------------------------------- */

/**
 * AkashicForge's `validateMemorySafety` (store.ts:351), taken by injection.
 *
 * **Cross-drive imports: the decision.** Mnemosia's source is on `D:` and both foundations are on
 * `C:`. No relative specifier spans that, and Node will not accept a bare Windows absolute path as
 * an ESM specifier. Chunk A solved this for the adapters with dependency injection against
 * structurally-typed local interfaces, proved accurate by assigning the genuine upstream objects to
 * them in `scripts/*.ts` under `tsconfig.check.json`'s `paths` mapping. The same pattern is used
 * here, for the same reason and one stronger one: the alternative — copying `validateMemorySafety`
 * into Mnemosia — would fork a security scanner. Its five threat patterns would then be maintained
 * in two places, and the copy would drift silently, which for a prompt-injection filter means
 * Mnemosia would keep reporting that content was scanned long after it stopped being scanned
 * against the current rules. A stale security control that still claims to be a control is a worse
 * failure than not having one.
 *
 * The contract mirrors the upstream function's shape exactly: it **throws** on rejection and
 * returns the redacted content on success. That is deliberately not smoothed into a boolean, so
 * the thrown message — which names which class of threat fired — reaches the quarantine record.
 */
export type MemorySafetyScanner = (value: unknown) => string;

/* ------------------------------------------------------------------------------------------------
 * Rules
 * ---------------------------------------------------------------------------------------------- */

/**
 * Design §12's list, in evaluation order. First match wins, so a claim is attributed to the *first*
 * reason it was ineligible rather than to whichever check happened to run last.
 *
 * Order is not arbitrary. Schema validity comes first because a malformed claim cannot be
 * meaningfully tested by anything downstream of it. Authorization comes next because spec §3 puts
 * security before every other consideration, including whether the record is even alive. Only then
 * do the lifecycle and content checks run.
 */
export const HARD_FILTER_RULES = [
	"invalid_schema",
	"authorization_scope",
	"lifecycle_state",
	"expired",
	"explicit_supersession",
	"quarantine",
	"integrity_failed",
	"no_evidence",
] as const;
export type HardFilterRuleId = (typeof HARD_FILTER_RULES)[number];

/** Design §12: only these two states are retrievable, and DISPUTED only into `conflicts[]`. */
export const RETRIEVABLE_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(["ACTIVE", "DISPUTED"]);

export interface FilterRejection {
	claimId: string;
	ruleId: HardFilterRuleId;
	detail: string;
	/** Which artifacts were implicated. Empty only for a rule that tested the claim alone. */
	artifactIds: string[];
}

export interface QuarantineEntry {
	artifactId: string;
	sourceId: string;
	sourceType: string;
	/** The scanner's own message, so the operator sees which threat class fired. */
	detail: string;
}

export interface ArtifactScan {
	/** artifactId → why it is quarantined. Absent means the artifact passed. */
	quarantined: Map<string, QuarantineEntry>;
	scanned: number;
	/** Envelopes that could not be scanned at all (empty content, non-string). Counted, not hidden. */
	unscannable: number;
}

/**
 * Runs the safety scanner over every normalized artifact.
 *
 * A scan is attempted for every envelope, including ones that will produce no claims: design §12's
 * `excluded_candidate_summary.quarantined` count is a statement about the corpus that was read, not
 * about the claims that survived, and computing it from the claims would understate it.
 */
export function scanArtifacts(envelopes: readonly ArtifactEnvelope[], scan: MemorySafetyScanner): ArtifactScan {
	const quarantined = new Map<string, QuarantineEntry>();
	let scanned = 0;
	let unscannable = 0;
	for (const envelope of envelopes) {
		const content = envelope.contentRef.inline;
		if (typeof content !== "string" || content.trim().length === 0) {
			unscannable += 1;
			continue;
		}
		scanned += 1;
		try {
			scan(content);
		} catch (error) {
			quarantined.set(envelope.artifactId, {
				artifactId: envelope.artifactId,
				sourceId: envelope.sourceId,
				sourceType: envelope.sourceType,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { quarantined, scanned, unscannable };
}

/* ------------------------------------------------------------------------------------------------
 * Claim validation
 * ---------------------------------------------------------------------------------------------- */

const CLAIM_TYPE_SET: ReadonlySet<string> = new Set<ClaimType>(["FACT", "OBSERVATION", "DECISION", "CONSTRAINT", "PLAN", "PREFERENCE", "PROCEDURE", "HYPOTHESIS"]);
const CERTAINTY_SET: ReadonlySet<string> = new Set(Object.keys(CERTAINTY_RANK) as Certainty[]);

/**
 * Structural validation of a claim, independent of anything it points at.
 *
 * This is the "invalid schema" hard filter spec §11 asks for. It exists because claims will one day
 * arrive from a replaced adapter or a replayed trace rather than only from `claims.ts`, and the
 * pipeline downstream of here assumes — in the fabrication guard especially — that a claim's fields
 * mean what they say.
 */
export function validateClaimShape(claim: Claim): string | null {
	if (claim.schemaVersion !== "mnemosia/claim@1") return `unknown claim schemaVersion ${String(claim.schemaVersion)}`;
	if (typeof claim.claimId !== "string" || claim.claimId.length === 0) return "claimId is missing";
	if (typeof claim.text !== "string" || claim.text.trim().length === 0) return "text is empty";
	if (typeof claim.dedupKey !== "string" || claim.dedupKey.length === 0) return "dedupKey is empty";
	if (!CLAIM_TYPE_SET.has(claim.claimType)) return `unknown claimType ${String(claim.claimType)}`;
	if (!CERTAINTY_SET.has(claim.certainty)) return `unknown certainty ${String(claim.certainty)}`;
	if (claim.scope.level !== "global" && claim.scope.level !== "project") return `unknown scope level ${String(claim.scope.level)}`;
	if (claim.scope.level === "project" && (claim.scope.project === null || claim.scope.project.length === 0)) return "a project-level claim carries no project";
	if (!Number.isFinite(claim.effectiveAt)) return "effectiveAt is not a finite timestamp";
	// A claim with no evidence is a fabrication. `claims.ts` cannot build one; this catches anything
	// that did not come from `claims.ts`.
	if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) return "claim carries no evidence";
	for (const item of claim.evidence) {
		if (item.claimId !== claim.claimId) return `evidence ${item.evidenceId} points at a different claim`;
		if (typeof item.artifactId !== "string" || item.artifactId.length === 0) return `evidence ${item.evidenceId} names no artifact`;
	}
	return null;
}

/* ------------------------------------------------------------------------------------------------
 * Hard filtering
 * ---------------------------------------------------------------------------------------------- */

export interface HardFilterInput {
	claims: readonly Claim[];
	/** Every envelope the run normalized, not only the ones that produced claims. */
	envelopes: readonly ArtifactEnvelope[];
	authorization: ScopeAuthorization;
	scan: MemorySafetyScanner;
	/** Pre-computed scan, when the caller already ran one (the orchestrator will). */
	artifactScan?: ArtifactScan;
	now?: number;
	/**
	 * High-assurance mode: reject anything whose integrity is merely `unverified` (design §16).
	 * Off by default — on this corpus it would reject 99.9% of everything, since only curated
	 * memory publishes a hash to verify against.
	 */
	failClosedOnUnverified?: boolean;
}

export interface HardFilterStats {
	claimsIn: number;
	claimsOut: number;
	rejected: number;
	byRule: Record<HardFilterRuleId, number>;
	artifactsScanned: number;
	artifactsQuarantined: number;
	artifactsUnscannable: number;
	/** Evidence entries dropped from surviving claims because their artifact was rejected. */
	evidencePruned: number;
}

export interface HardFilterResult {
	accepted: Claim[];
	rejections: FilterRejection[];
	quarantined: QuarantineEntry[];
	stats: HardFilterStats;
}

function emptyByRule(): Record<HardFilterRuleId, number> {
	return { invalid_schema: 0, authorization_scope: 0, lifecycle_state: 0, expired: 0, explicit_supersession: 0, quarantine: 0, integrity_failed: 0, no_evidence: 0 };
}

/**
 * Applies design §12's hard filters, deterministically, before anything is ranked.
 *
 * Every rejection records a rule id and a detail string; nothing is dropped silently, which is what
 * makes `explainDecision(runId, claimId)` able to answer "why was this not in my briefing".
 */
/** Whole-claim checks, in rule order. `null` means the claim itself is eligible. */
function claimRejection(claim: Claim, authorization: ScopeAuthorization, authorized: ReadonlySet<string>, now: number): { ruleId: HardFilterRuleId; detail: string } | null {
	const shapeError = validateClaimShape(claim);
	if (shapeError !== null) return { ruleId: "invalid_schema", detail: shapeError };
	// Spec §3: a highly relevant memory that is unauthorized remains unavailable. This runs before
	// every content check, so an unauthorized claim is never even scanned for merit.
	if (authorization.outcome !== "AUTHORIZED" || !authorized.has(scopeKey(claim.scope))) {
		return { ruleId: "authorization_scope", detail: `scope ${claim.scope.level}:${claim.scope.project ?? "-"} is not in the authorized set` };
	}
	if (claim.lifecycle !== null && !RETRIEVABLE_STATES.has(claim.lifecycle)) {
		return { ruleId: "lifecycle_state", detail: `lifecycle ${claim.lifecycle} is not retrievable (only ACTIVE and DISPUTED are)` };
	}
	if (claim.expiresAt !== null && claim.expiresAt <= now) return { ruleId: "expired", detail: `expired at ${new Date(claim.expiresAt).toISOString()}` };
	return null;
}

/** Per-artifact content checks. `null` means this piece of evidence may stand. */
function artifactRejection(envelope: ArtifactEnvelope | undefined, artifactId: string, scan: ArtifactScan, failClosedOnUnverified: boolean): { ruleId: HardFilterRuleId; detail: string } | null {
	// An evidence pointer with no artifact behind it cannot be verified, quoted or explained.
	// Treating it as valid would be the fabrication the §16 provenance gate measures.
	if (envelope === undefined) return { ruleId: "invalid_schema", detail: `evidence names artifact ${artifactId}, which this run did not normalize` };
	const quarantine = scan.quarantined.get(artifactId);
	if (quarantine !== undefined) return { ruleId: "quarantine", detail: quarantine.detail };
	if (envelope.integrityStatus === "failed") return { ruleId: "integrity_failed", detail: "artifact integrity is failed" };
	if (failClosedOnUnverified && envelope.integrityStatus !== "verified") return { ruleId: "integrity_failed", detail: `high-assurance mode: integrity is ${envelope.integrityStatus}` };
	return null;
}

export function applyHardFilters(input: HardFilterInput): HardFilterResult {
	const now = input.now ?? Date.now();
	const artifactScan = input.artifactScan ?? scanArtifacts(input.envelopes, input.scan);
	const envelopeIndex = new Map(input.envelopes.map((envelope) => [envelope.artifactId, envelope]));
	const authorized = new Set(input.authorization.authorizedKeys);
	const failClosed = input.failClosedOnUnverified === true;

	const accepted: Claim[] = [];
	const rejections: FilterRejection[] = [];
	const byRule = emptyByRule();
	let evidencePruned = 0;

	const reject = (claim: Claim, ruleId: HardFilterRuleId, detail: string, artifactIds: string[] = []): void => {
		rejections.push({ claimId: claim.claimId, ruleId, detail, artifactIds });
		byRule[ruleId] += 1;
	};

	/**
	 * Explicit supersession (design §12) is a relation *between* claims, so the set of retired
	 * artifacts has to be settled before any single claim can be judged.
	 *
	 * Only a claim that would itself survive every other filter gets a vote. Without that, a
	 * poisoned artifact could carry `supersedes: [<the memory that contradicts it>]` and retire a
	 * clean, authorized, verified record on its own say-so — a one-line injection that deletes
	 * memory from the briefing. It must clear the whole-claim checks *and* stand on at least one
	 * artifact that is not quarantined, integrity-failed or out of its security domain.
	 */
	const supersededArtifacts = new Set<string>();
	for (const claim of input.claims) {
		if (claimRejection(claim, input.authorization, authorized, now) !== null) continue;
		if (!claim.evidence.some((item) => artifactRejection(envelopeIndex.get(item.artifactId), item.artifactId, artifactScan, failClosed) === null)) continue;
		for (const reference of claim.supersedes) supersededArtifacts.add(reference);
	}

	for (const claim of input.claims) {
		const claimError = claimRejection(claim, input.authorization, authorized, now);
		if (claimError !== null) {
			reject(claim, claimError.ruleId, claimError.detail);
			continue;
		}

		// A claim every one of whose artifacts has been explicitly retired by a surviving claim.
		// "Every" rather than "any": a claim standing on three artifacts of which one was superseded
		// is still supported by the other two.
		const artifactIds = claim.evidence.map((item) => item.artifactId);
		if (artifactIds.length > 0 && artifactIds.every((artifactId) => supersededArtifacts.has(artifactId))) {
			reject(claim, "explicit_supersession", "every supporting artifact is explicitly superseded by a retained claim", artifactIds);
			continue;
		}

		// Per-evidence content checks. Anything that fails removes that evidence, not the claim.
		const surviving: Evidence[] = [];
		const dropped: Array<{ ruleId: HardFilterRuleId; detail: string; artifactId: string }> = [];
		for (const item of claim.evidence) {
			const failure = artifactRejection(envelopeIndex.get(item.artifactId), item.artifactId, artifactScan, failClosed);
			if (failure === null) surviving.push(item);
			else dropped.push({ ...failure, artifactId: item.artifactId });
		}

		if (surviving.length === 0) {
			// Attributed to the first reason that fired, matching the whole-claim rule order.
			const first = dropped[0];
			reject(
				claim,
				first?.ruleId ?? "no_evidence",
				first?.detail ?? "no evidence survived the artifact checks",
				dropped.map((entry) => entry.artifactId),
			);
			continue;
		}

		evidencePruned += dropped.length;
		accepted.push(surviving.length === claim.evidence.length ? claim : { ...claim, evidence: surviving });
	}

	return {
		accepted,
		rejections,
		quarantined: [...artifactScan.quarantined.values()],
		stats: {
			claimsIn: input.claims.length,
			claimsOut: accepted.length,
			rejected: rejections.length,
			byRule,
			artifactsScanned: artifactScan.scanned,
			artifactsQuarantined: artifactScan.quarantined.size,
			artifactsUnscannable: artifactScan.unscannable,
			evidencePruned,
		},
	};
}

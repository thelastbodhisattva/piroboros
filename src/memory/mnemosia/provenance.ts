// Ported from mnemosia/provenance.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * The provenance graph (spec §25 Phase 2, spec §12 `graph_distance`, design §7 `Evidence.relation`).
 *
 * Phase 1 carried provenance as a **flat list**: each claim held an array of `Evidence`, every entry
 * of which was `SUPPORTS`, and the only question anything asked of it was "how many artifacts are in
 * this array". That is enough to answer *whether* a claim is sourced. It cannot answer the two
 * questions Phase 2 exists to answer — **how directly** a claim is supported, and **what else in the
 * run relates to it** — because both are questions about a structure, and a list is not one.
 *
 * This module builds the structure. Nodes are artifacts and claims; edges are the five relations
 * design §7 declared and Phase 1 left mostly unused:
 *
 * | relation        | Phase 1 | Phase 2 |
 * |-----------------|---------|---------|
 * | `SUPPORTS`      | emitted | unchanged — a claim standing on an artifact |
 * | `SUPERSEDES`    | declared, never emitted as an edge | claim → the claim it retires, transitively closed |
 * | `CONTRADICTS`   | never   | claim ↔ claim, from `relations.ts`'s deterministic predicates |
 * | `QUALIFIES`     | never   | claim ↔ claim, where a branch/environment qualifier diverges |
 * | `TEMPORAL_BOUND`| never   | claim → claim, where one's validity interval ends before the other's begins |
 *
 * **Why the graph is built before ranking rather than inside conflict detection.** The state machine
 * runs `SCORE_CANDIDATES` before `DETECT_CONFLICTS` (spec §7), and Phase 2's evidence-strength signal
 * needs corroboration counts and contradiction counts — both graph properties. Deriving them inside
 * `conflicts.ts` would mean either reordering the machine or scoring against a graph that does not
 * exist yet. So the graph is the shared substrate: it computes *structure*, deterministically, from
 * the accepted claim set alone, and `conflicts.ts` computes *classification and resolution* on top of
 * it. Neither duplicates the other's work, and the trace records the graph once.
 *
 * **`graph_distance` is distance to the nearest primary observation**, not to an arbitrary root:
 *
 * ```
 * 1  the claim stands on an artifact directly — a curated row, a user turn, a tool transcript
 * 2  the claim reached us only through a summary, and that summary's own sources are in this run
 * 3  the claim reached us only through a summary whose sources this run could not reach
 * ```
 *
 * Distance 3 is the honest label for "a polished account of something nobody here can check". It is
 * not by itself a conflict — absence of the underlying events is a *corpus* fact, exactly as design
 * §16's Phase 1E note distinguishes `INSUFFICIENT_INFORMATION` from `RETRIEVAL_UNAVAILABLE` — but it
 * is the ceiling that stops such a claim outranking the raw evidence it paraphrases.
 */

import { extractQualifiers, QUALIFIER_RANKING, type QualifierHit } from "./qualifiers.ts";
import { branchDifference, environmentDifference, keyValueDivergence, negationDivergence } from "./relations.ts";
import { candidatePairs, profileOf, type SimilarPair, type SimilarityProfile } from "./similarity.ts";
import { temporalValidity, temporallyDisjoint, type TemporalValidity } from "./temporal.ts";
import type { ArtifactEnvelope, Claim, EvidenceDirectness, EvidenceRelation, SourceType } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Grounding
 * ---------------------------------------------------------------------------------------------- */

/** Source types that are an observation rather than an account of one. */
export const PRIMARY_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<SourceType>(["curated_memory", "conversation_message", "tool_output"]);

/**
 * How well an artifact's own sources can be reached from inside this run.
 *
 * `session_absent` and `refs_unresolved` are deliberately different states even though both mean
 * "the underlying events are not here". The first is a property of *this retrieval* — the corpus
 * holds far more events than a run reads, so a summary whose session contributed
 * nothing to the candidate set is unremarkable. The second is a property of the *artifact*: an
 * artifact that declares source references names them as part of its own contract, so refs that name
 * nothing are a defect in the summary rather than a limit on the reader. Only the second is a
 * conflict (design §11's `SUMMARY_SOURCE_MISMATCH`); collapsing them would report every summary in
 * the corpus as poisoned.
 */
export const GROUNDING_STATES = ["primary", "grounded", "session_absent", "refs_unresolved", "refs_absent", "integrity_failed"] as const;
export type GroundingState = (typeof GROUNDING_STATES)[number];

export interface ArtifactGrounding {
	artifactId: string;
	sourceType: SourceType;
	state: GroundingState;
	/** Primary artifacts that ground this one, when any were found. */
	groundedBy: string[];
	/** Declared source references that named nothing this run normalized. */
	unresolvedRefs: string[];
	detail: string;
}

/* ------------------------------------------------------------------------------------------------
 * Nodes and edges
 * ---------------------------------------------------------------------------------------------- */

export interface ProvenanceEdge {
	/** Always a claimId: every edge in this graph is something a claim asserts or something asserted about it. */
	from: string;
	to: string;
	toKind: "artifact" | "claim" | "external";
	relation: EvidenceRelation;
	directness: EvidenceDirectness;
	locator: string;
	/** Why this edge exists, in prose, for the trace and for `explainDecision`. */
	basis: string;
}

export interface ClaimProvenance {
	claimId: string;
	/** 1 direct · 2 via a grounded summary · 3 via a summary whose sources this run could not reach. */
	graphDistance: number;
	distanceBasis: string;
	/** Distinct artifacts carrying a `SUPPORTS` edge. */
	supportingArtifacts: string[];
	/**
	 * Distinct *independent* evidence groups among the supporting artifacts.
	 *
	 * Two conversation events from one session are one session saying something twice; a curated row and
	 * a conversation event are two independent witnesses. The group key is `sourceId | taskScope`, falling
	 * back to the artifact id when a source has no task scope (curated memory has none, and each
	 * curated row was written by a human on its own occasion). Pricing corroboration per artifact
	 * instead lets one chatty session look like a consensus.
	 */
	independentGroups: number;
	groupKeys: string[];
	grounding: GroundingState;
	unresolvedRefs: string[];
	/** Claims that contradict this one, by `relations.ts`'s deterministic predicates. */
	contradictedBy: string[];
	/** Claims that qualify this one — same subject, different branch or environment. */
	qualifiedBy: string[];
	/** Claims this one directly retires. */
	supersedes: string[];
	/** Claims this one retires through a chain of any length, excluding itself. */
	supersedesTransitive: string[];
	/** Claims that retire this one directly. */
	supersededBy: string[];
	/** Longest supersession chain rooted at this claim. 0 when it retires nothing. */
	supersessionDepth: number;
	/** Claims whose validity interval this one bounds (it takes effect where the other ends). */
	temporalBoundOn: string[];
	temporal: TemporalValidity;
	qualifiers: QualifierHit[];
}

export interface ProvenanceStats {
	claims: number;
	artifacts: number;
	edges: number;
	byRelation: Record<EvidenceRelation, number>;
	byGrounding: Record<GroundingState, number>;
	byDistance: Record<string, number>;
	/** Claims standing on more than one independent evidence group. */
	corroborated: number;
	/** Claims with at least one `CONTRADICTS` edge. */
	contradicted: number;
	/** Supersession chains longer than one link — design's Phase 2 "transitive chains". */
	transitiveChains: number;
	deepestChain: number;
	neighbourPairs: number;
	branchQualified: number;
	environmentQualified: number;
	notYetEffective: number;
}

export interface ProvenanceGraph {
	edges: ProvenanceEdge[];
	byClaim: Map<string, ClaimProvenance>;
	grounding: Map<string, ArtifactGrounding>;
	claimsByArtifact: Map<string, string[]>;
	/** Near-duplicate claim pairs, computed once here and reused by `conflicts.ts`. */
	neighbours: Array<SimilarPair<Claim>>;
	stats: ProvenanceStats;
}

export interface BuildProvenanceInput {
	claims: readonly Claim[];
	envelopes: readonly ArtifactEnvelope[];
	now: number;
	/** Design §10's `shingleSize`; passed rather than imported so the policy stays the single source. */
	shingleSize?: number;
	/** Design §11's jaccard₃ neighbourhood threshold. */
	neighbourhoodThreshold?: number;
}

/**
 * Resolves one declared source reference against the artifacts this run normalized.
 *
 * Only an exact artifact id resolves. A reference that names nothing this run normalized is
 * reported as unresolved, so the answer "this run holds nothing by that name" is reached by having
 * looked rather than by assuming.
 */
function resolveRef(ref: string, artifactIds: ReadonlySet<string>): string | null {
	if (artifactIds.has(ref)) return ref;
	return null;
}

/**
 * Grounding for every artifact in the run.
 *
 * Computed over the whole envelope set rather than over the artifacts that produced claims, because
 * "does this summary's session appear in the candidate set" is a question about what was *read*, and
 * an envelope that produced no claims still proves its session was reachable.
 */
export function groundArtifacts(envelopes: readonly ArtifactEnvelope[]): Map<string, ArtifactGrounding> {
	// sourceId|sessionId -> the primary artifacts read from that session.
	const primaryBySession = new Map<string, string[]>();
	for (const envelope of envelopes) {
		if (!PRIMARY_SOURCE_TYPES.has(envelope.sourceType)) continue;
		if (envelope.taskScope === null) continue;
		const key = `${envelope.sourceId}${envelope.taskScope}`;
		const bucket = primaryBySession.get(key);
		if (bucket === undefined) primaryBySession.set(key, [envelope.artifactId]);
		else bucket.push(envelope.artifactId);
	}

	const result = new Map<string, ArtifactGrounding>();
	for (const envelope of envelopes) {
		if (envelope.integrityStatus === "failed") {
			result.set(envelope.artifactId, { artifactId: envelope.artifactId, sourceType: envelope.sourceType, state: "integrity_failed", groundedBy: [], unresolvedRefs: [], detail: "the artifact's integrity check failed, so nothing it carries can be grounded" });
			continue;
		}
		if (PRIMARY_SOURCE_TYPES.has(envelope.sourceType)) {
			result.set(envelope.artifactId, { artifactId: envelope.artifactId, sourceType: envelope.sourceType, state: "primary", groundedBy: [], unresolvedRefs: [], detail: "a primary observation: it is the evidence rather than an account of it" });
			continue;
		}

		// AkashicForge compaction summary: no per-claim source references exist in the schema, so the
		// session it was written into is the only handle on its evidence.
		const key = envelope.taskScope === null ? null : `${envelope.sourceId}${envelope.taskScope}`;
		const siblings = key === null ? undefined : primaryBySession.get(key);
		if (siblings === undefined || siblings.length === 0) {
			result.set(envelope.artifactId, {
				artifactId: envelope.artifactId,
				sourceType: envelope.sourceType,
				state: "session_absent",
				groundedBy: [],
				unresolvedRefs: [],
				detail: envelope.taskScope === null ? "the summary carries no session, so its underlying events cannot be located at all" : `this run normalized no primary event from session ${envelope.taskScope}`,
			});
			continue;
		}
		result.set(envelope.artifactId, {
			artifactId: envelope.artifactId,
			sourceType: envelope.sourceType,
			state: "grounded",
			groundedBy: [...siblings].sort(),
			unresolvedRefs: [],
			detail: `${siblings.length} primary event(s) from session ${envelope.taskScope} are in this run`,
		});
	}
	return result;
}

/* ------------------------------------------------------------------------------------------------
 * Construction
 * ---------------------------------------------------------------------------------------------- */

function emptyByRelation(): Record<EvidenceRelation, number> {
	return { SUPPORTS: 0, CONTRADICTS: 0, SUPERSEDES: 0, QUALIFIES: 0, TEMPORAL_BOUND: 0 };
}

function emptyByGrounding(): Record<GroundingState, number> {
	return { primary: 0, grounded: 0, session_absent: 0, refs_unresolved: 0, refs_absent: 0, integrity_failed: 0 };
}

/**
 * The transitive closure of `supersedes`, with cycle protection.
 *
 * A cycle — A retires B retires A — is not hypothetical once supersession links can come from
 * content rather than only from a governance column: a poisoned artifact could assert one. It is
 * broken by the visited set rather than by trusting the data, and the claims involved keep every
 * link they declared, so the cycle is visible in the graph instead of being silently pruned.
 */
function transitiveClosure(direct: ReadonlyMap<string, string[]>, start: string): { reachable: string[]; depth: number } {
	const reachable = new Set<string>();
	let depth = 0;
	let frontier = [...(direct.get(start) ?? [])];
	while (frontier.length > 0) {
		depth += 1;
		const next: string[] = [];
		for (const claimId of frontier) {
			if (claimId === start || reachable.has(claimId)) continue;
			reachable.add(claimId);
			next.push(...(direct.get(claimId) ?? []));
		}
		frontier = next;
		// A chain cannot be longer than the claim set; the visited set already guarantees termination,
		// and this bound only stops a pathological self-referential frontier from spinning.
		if (depth > direct.size + 1) break;
	}
	return { reachable: [...reachable].sort(), depth: reachable.size === 0 ? 0 : depth };
}

export function buildProvenanceGraph(input: BuildProvenanceInput): ProvenanceGraph {
	const { claims, envelopes, now } = input;
	const shingleSize = input.shingleSize ?? 3;
	const threshold = input.neighbourhoodThreshold ?? 0.6;

	const envelopeIndex = new Map(envelopes.map((envelope) => [envelope.artifactId, envelope]));
	const grounding = groundArtifacts(envelopes);

	const edges: ProvenanceEdge[] = [];
	const claimsByArtifact = new Map<string, string[]>();
	const qualifiersByClaim = new Map<string, QualifierHit[]>();
	const profilesByClaim = new Map<string, SimilarityProfile>();

	/* --- SUPPORTS edges, grounding and distance ------------------------------------------------- */
	interface Partial {
		supporting: string[];
		groupKeys: string[];
		grounding: GroundingState;
		unresolvedRefs: string[];
		graphDistance: number;
		distanceBasis: string;
	}
	const partial = new Map<string, Partial>();

	for (const claim of claims) {
		qualifiersByClaim.set(claim.claimId, extractQualifiers(claim.text));
		profilesByClaim.set(claim.claimId, profileOf(claim.dedupKey, shingleSize));

		const supporting: string[] = [];
		const groups = new Set<string>();
		let bestDistance = Number.POSITIVE_INFINITY;
		let bestBasis = "no supporting artifact resolved in this run";
		let bestGrounding: GroundingState = "session_absent";
		const unresolvedRefs: string[] = [];

		for (const evidence of claim.evidence) {
			const envelope = envelopeIndex.get(evidence.artifactId);
			const bucket = claimsByArtifact.get(evidence.artifactId);
			if (bucket === undefined) claimsByArtifact.set(evidence.artifactId, [claim.claimId]);
			else if (!bucket.includes(claim.claimId)) bucket.push(claim.claimId);

			edges.push({
				from: claim.claimId,
				to: evidence.artifactId,
				toKind: envelope === undefined ? "external" : "artifact",
				relation: evidence.relation,
				directness: evidence.directness,
				locator: evidence.locator,
				basis: envelope === undefined ? "the evidence names an artifact this run did not normalize" : `${evidence.relation.toLowerCase()} via ${envelope.sourceType}`,
			});

			if (evidence.relation !== "SUPPORTS") continue;
			if (envelope === undefined) continue;
			supporting.push(evidence.artifactId);
			groups.add(`${envelope.sourceId}${envelope.taskScope ?? evidence.artifactId}`);

			const state = grounding.get(evidence.artifactId)?.state ?? "session_absent";
			const refs = grounding.get(evidence.artifactId)?.unresolvedRefs ?? [];
			for (const ref of refs) if (!unresolvedRefs.includes(ref)) unresolvedRefs.push(ref);

			// The claim's own directness wins over the artifact's source type: `claims.ts` marks a
			// summary-derived claim `derived` even though the summary artifact is itself a real
			// document, and it is the *claim's* route to evidence that distance measures.
			const distance = evidence.directness === "direct" && state === "primary" ? 1 : state === "grounded" ? 2 : 3;
			if (distance < bestDistance) {
				bestDistance = distance;
				bestGrounding = state;
				bestBasis =
					distance === 1
						? `direct evidence on ${envelope.sourceType} ${evidence.artifactId}`
						: distance === 2
							? `derived through ${envelope.sourceType} ${evidence.artifactId}, whose own sources are in this run (${grounding.get(evidence.artifactId)?.detail ?? ""})`
							: `derived through ${envelope.sourceType} ${evidence.artifactId}, whose sources this run could not reach (${grounding.get(evidence.artifactId)?.detail ?? ""})`;
			}
		}

		partial.set(claim.claimId, {
			supporting: [...new Set(supporting)].sort(),
			groupKeys: [...groups].sort(),
			grounding: bestGrounding,
			unresolvedRefs: unresolvedRefs.sort(),
			graphDistance: Number.isFinite(bestDistance) ? bestDistance : 3,
			distanceBasis: bestBasis,
		});
	}

	/* --- SUPERSEDES edges, direct then transitive ----------------------------------------------- */
	//
	// A claim's `supersedes` names *artifacts* (claims.ts converts AkashicForge's bare memory id into
	// artifact-id form so both namespaces agree). Every claim standing on a retired artifact is
	// retired by that link, which is what turns an artifact-level governance fact into the claim-level
	// edges the graph needs.
	//
	// References resolve against the union of the normalized envelopes and the artifacts the run's
	// own evidence names. The second half matters: a caller that hands `buildProvenanceGraph` claims
	// without their envelopes — a replayed trace, or `conflicts.ts` used standalone in a test — must
	// still see supersession, because that link is carried on the claim and does not need the
	// artifact's bytes to be resolvable.
	const referenceable = new Set([...envelopeIndex.keys(), ...claimsByArtifact.keys()]);
	const directSupersedes = new Map<string, string[]>();
	for (const claim of [...claims].sort((a, b) => (a.claimId < b.claimId ? -1 : 1))) {
		const targets = new Set<string>();
		for (const reference of [...claim.supersedes].sort()) {
			const resolvedArtifact = resolveRef(reference, referenceable);
			const viaArtifact = resolvedArtifact === null ? [] : (claimsByArtifact.get(resolvedArtifact) ?? []);
			edges.push({
				from: claim.claimId,
				to: resolvedArtifact ?? reference,
				toKind: resolvedArtifact === null ? "external" : "artifact",
				relation: "SUPERSEDES",
				directness: "direct",
				locator: "claim.supersedes",
				basis: resolvedArtifact === null ? "declares supersession of something this run did not retrieve" : "declares supersession of an artifact in this run",
			});
			for (const target of viaArtifact) {
				if (target === claim.claimId) continue;
				targets.add(target);
			}
		}
		if (targets.size > 0) directSupersedes.set(claim.claimId, [...targets].sort());
	}
	for (const [from, targets] of [...directSupersedes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		for (const to of targets) {
			edges.push({ from, to, toKind: "claim", relation: "SUPERSEDES", directness: "direct", locator: "claim.supersedes", basis: "retires the claim that stands on the superseded artifact" });
		}
	}

	const supersededBy = new Map<string, string[]>();
	for (const [from, targets] of directSupersedes) {
		for (const to of targets) {
			const bucket = supersededBy.get(to);
			if (bucket === undefined) supersededBy.set(to, [from]);
			else bucket.push(from);
		}
	}

	/* --- pairwise edges: CONTRADICTS, QUALIFIES, TEMPORAL_BOUND --------------------------------- */
	const ordered = [...claims].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
	const neighbours = candidatePairs(
		ordered,
		(claim) => profilesByClaim.get(claim.claimId) ?? profileOf("", shingleSize),
		(claim) => claim.claimId,
		threshold,
	);

	const contradictedBy = new Map<string, string[]>();
	const qualifiedBy = new Map<string, string[]>();
	const temporalBoundOn = new Map<string, string[]>();
	const link = (index: Map<string, string[]>, key: string, value: string): void => {
		const bucket = index.get(key);
		if (bucket === undefined) index.set(key, [value]);
		else if (!bucket.includes(value)) bucket.push(value);
	};

	for (const pair of neighbours) {
		const a = pair.a;
		const b = pair.b;
		const qa = qualifiersByClaim.get(a.claimId) ?? [];
		const qb = qualifiersByClaim.get(b.claimId) ?? [];

		const branch = branchDifference(qa, qb);
		const environment = environmentDifference(qa, qb);
		if (branch.diverges || environment.diverges) {
			const detail = branch.diverges ? `branch ${branch.left.join("/")} vs ${branch.right.join("/")}` : `environment ${environment.left.join("/")} vs ${environment.right.join("/")}`;
			edges.push({ from: a.claimId, to: b.claimId, toKind: "claim", relation: "QUALIFIES", directness: "direct", locator: "qualifier", basis: detail });
			edges.push({ from: b.claimId, to: a.claimId, toKind: "claim", relation: "QUALIFIES", directness: "direct", locator: "qualifier", basis: detail });
			link(qualifiedBy, a.claimId, b.claimId);
			link(qualifiedBy, b.claimId, a.claimId);
			// A pair explained by a qualifier is not also a contradiction: two statements about two
			// branches disagree about nothing. Reporting both would double-count the same divergence
			// and would put a `DIRECT_CONTRADICTION` in front of the reader for a difference that has
			// a perfectly ordinary explanation.
			//
			// **This is the seam design §17 ambiguity 4 gated, and the gate is why it is conditional.**
			// Suppressing the contradiction does not only change what the reader is told; `contradictions`
			// is a term in `evidence_strength` (§9), so a suppressed pair keeps a `−0.15` it would
			// otherwise lose. That is a qualifier reaching a *score*, and doing it on the strength of an
			// extractor measured at 0.281 was the silent damage the ambiguity was written about. The
			// extractor now measures 0.837 over 620 hits on a sample drawn after its corrections
			// (`qualifiers.ts:QUALIFIER_RANKING`), so the suppression applies. With the flag off the
			// `QUALIFIES` edge is still emitted — classification is §2's job for these qualifiers and was
			// never gated — but it no longer decides anything a weight will multiply.
			if (QUALIFIER_RANKING.enabled) continue;
		}

		const negation = negationDivergence(a.text, b.text);
		const keyValues = keyValueDivergence(a.text, b.text);
		if (negation.diverges || keyValues.length > 0) {
			const detail = negation.diverges
				? `exactly one side carries a negation marker (${negation.negatedSide === "a" ? a.claimId.slice(0, 12) : b.claimId.slice(0, 12)})`
				: keyValues.map((entry) => `${entry.key}: ${entry.left} vs ${entry.right}`).join("; ");
			edges.push({ from: a.claimId, to: b.claimId, toKind: "claim", relation: "CONTRADICTS", directness: "direct", locator: "text", basis: detail });
			edges.push({ from: b.claimId, to: a.claimId, toKind: "claim", relation: "CONTRADICTS", directness: "direct", locator: "text", basis: detail });
			link(contradictedBy, a.claimId, b.claimId);
			link(contradictedBy, b.claimId, a.claimId);
		}

		if (temporallyDisjoint(a, b)) {
			const [earlier, later] = a.effectiveAt <= b.effectiveAt ? [a, b] : [b, a];
			edges.push({ from: later.claimId, to: earlier.claimId, toKind: "claim", relation: "TEMPORAL_BOUND", directness: "direct", locator: "validity interval", basis: `${earlier.claimId.slice(0, 12)}'s validity ends before ${later.claimId.slice(0, 12)}'s begins` });
			link(temporalBoundOn, later.claimId, earlier.claimId);
		}
	}

	/* --- assembly ------------------------------------------------------------------------------- */
	const byClaim = new Map<string, ClaimProvenance>();
	const stats: ProvenanceStats = {
		claims: claims.length,
		artifacts: envelopes.length,
		edges: edges.length,
		byRelation: emptyByRelation(),
		byGrounding: emptyByGrounding(),
		byDistance: {},
		corroborated: 0,
		contradicted: 0,
		transitiveChains: 0,
		deepestChain: 0,
		neighbourPairs: neighbours.length,
		branchQualified: 0,
		environmentQualified: 0,
		notYetEffective: 0,
	};

	for (const claim of claims) {
		const base = partial.get(claim.claimId);
		if (base === undefined) continue;
		const closure = transitiveClosure(directSupersedes, claim.claimId);
		const direct = directSupersedes.get(claim.claimId) ?? [];
		const qualifiers = qualifiersByClaim.get(claim.claimId) ?? [];
		const temporal = temporalValidity(claim, now);

		const entry: ClaimProvenance = {
			claimId: claim.claimId,
			graphDistance: base.graphDistance,
			distanceBasis: base.distanceBasis,
			supportingArtifacts: base.supporting,
			independentGroups: base.groupKeys.length,
			groupKeys: base.groupKeys,
			grounding: base.grounding,
			unresolvedRefs: base.unresolvedRefs,
			contradictedBy: (contradictedBy.get(claim.claimId) ?? []).sort(),
			qualifiedBy: (qualifiedBy.get(claim.claimId) ?? []).sort(),
			supersedes: direct,
			supersedesTransitive: closure.reachable,
			supersededBy: (supersededBy.get(claim.claimId) ?? []).sort(),
			supersessionDepth: closure.depth,
			temporalBoundOn: (temporalBoundOn.get(claim.claimId) ?? []).sort(),
			temporal,
			qualifiers,
		};
		byClaim.set(claim.claimId, entry);

		stats.byGrounding[entry.grounding] += 1;
		stats.byDistance[String(entry.graphDistance)] = (stats.byDistance[String(entry.graphDistance)] ?? 0) + 1;
		if (entry.independentGroups > 1) stats.corroborated += 1;
		if (entry.contradictedBy.length > 0) stats.contradicted += 1;
		if (entry.supersessionDepth > 1) stats.transitiveChains += 1;
		stats.deepestChain = Math.max(stats.deepestChain, entry.supersessionDepth);
		if (qualifiers.some((hit) => hit.kind === "branch")) stats.branchQualified += 1;
		if (qualifiers.some((hit) => hit.kind === "environment")) stats.environmentQualified += 1;
		if (temporal.status === "not_yet_effective") stats.notYetEffective += 1;
	}

	for (const edge of edges) stats.byRelation[edge.relation] += 1;
	// A total order, so two runs that read the same corpus serialize the graph byte-identically (§16).
	edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

	return { edges, byClaim, grounding, claimsByArtifact, neighbours, stats };
}

/**
 * The provenance of one claim, or a conservative default when the graph does not know it.
 *
 * The default is deliberately the *weakest* reading — distance 3, no corroboration, ungrounded —
 * rather than a neutral one. A caller holding a claim the graph never saw is in an unknown state,
 * and an unknown state must not be scored as a well-supported one.
 */
export function provenanceOf(graph: ProvenanceGraph, claimId: string, temporal: TemporalValidity): ClaimProvenance {
	const found = graph.byClaim.get(claimId);
	if (found !== undefined) return found;
	return {
		claimId,
		graphDistance: 3,
		distanceBasis: "this claim is not in the provenance graph; treated as maximally indirect",
		supportingArtifacts: [],
		independentGroups: 0,
		groupKeys: [],
		grounding: "session_absent",
		unresolvedRefs: [],
		contradictedBy: [],
		qualifiedBy: [],
		supersedes: [],
		supersedesTransitive: [],
		supersededBy: [],
		supersessionDepth: 0,
		temporalBoundOn: [],
		temporal,
		qualifiers: [],
	};
}

/** Every edge leaving a claim, for `explainDecision` and the briefing's provenance entry. */
export function edgesFrom(graph: ProvenanceGraph, claimId: string): ProvenanceEdge[] {
	return graph.edges.filter((edge) => edge.from === claimId);
}

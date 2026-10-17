// Ported from mnemosia/requirements.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Phase B stage 3 — knowledge-requirement generation (spec Stage 2/3: "treating [situation items]
 * as candidate knowledge requirements and selecting only those justified by the task").
 *
 * A requirement is a named hole in what Mnemosia knows, with a priority and a source preference —
 * not a query, and not a promise to retrieve. Phase B only *derives* them; consuming them into
 * retrieval rounds is Phase C's progressive-retrieval work. What Phase C will need that this module
 * already provides: stable ids (so coverage can be tracked per requirement), `satisfiedBy` left
 * open (the claim id that satisfied it gets written there later), and `queryHints` — deterministic
 * vocabulary the orchestrator feeds into the curated wide-term set so inferred context influences
 * retrieval planning without redefining the caller's task.
 *
 * Derivation is deterministic: situation items map through a category table weighted by tier and
 * confidence; intent hypotheses contribute discriminating-evidence requirements so the cheapest
 * high-value distinguishing evidence is named before any query runs.
 */

import type { SituationContext } from "./situation.ts";
import type { IntentHypothesisSet } from "./intent.ts";
import { SOURCE_ID } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------------------------- */

export const KNOWLEDGE_REQUIREMENT_PRIORITIES = ["high", "medium", "low"] as const;
export type KnowledgeRequirementPriority = (typeof KNOWLEDGE_REQUIREMENT_PRIORITIES)[number];

export interface KnowledgeRequirement {
	requirementId: string;
	category: string;
	priority: KnowledgeRequirementPriority;
	/** Source ids, most preferred first, drawn from `SOURCE_ID`. */
	sourcePreference: string[];
	/** The claim id that satisfied this requirement — filled by later phases, `null` for now. */
	satisfiedBy?: string | null;
	/** Deterministic vocabulary contributed to the curated wide-term set (may be empty). */
	queryHints?: string[];
}

/** Hard bound per derivation; beyond this the tail is unfetchable noise. */
export const MAX_KNOWLEDGE_REQUIREMENTS = 12;

/* ------------------------------------------------------------------------------------------------
 * Mapping tables
 * ---------------------------------------------------------------------------------------------- */

interface CategoryMapping {
	category: string;
	sourcePreference: string[];
	queryHints?: string[];
}

const CATEGORY_BY_SITUATION_ITEM: Readonly<Record<string, CategoryMapping>> = {
	"explicit-project": { category: "project-identity", sourcePreference: [SOURCE_ID.akashicMemories] },
	"explicit-requested-projects": { category: "project-identity", sourcePreference: [SOURCE_ID.akashicMemories] },
	"resume-open-work": { category: "open-work-state", sourcePreference: [SOURCE_ID.akashicMemories], queryHints: ["todo"] },
	"active-milestone-definition": { category: "milestone-definition", sourcePreference: [SOURCE_ID.akashicMemories], queryHints: ["phase"] },
	"previous-phase-outcome": { category: "previous-outcome", sourcePreference: [SOURCE_ID.akashicMemories], queryHints: ["outcome"] },
	"known-failures": { category: "known-failures", sourcePreference: [SOURCE_ID.akashicMemories], queryHints: ["failure"] },
	"coding-conventions": { category: "conventions", sourcePreference: [SOURCE_ID.akashicMemories], queryHints: ["convention"] },
	"vague-referent": { category: "subject-identification", sourcePreference: [] },
};

/**
 * Priority from tier + confidence: believed-and-load-bearing is high, plausible is medium,
 * unknown-or-needing-clarification is low (recorded, not pursued).
 */
function priorityFor(tier: SituationContext["items"][number]["tier"], confidence: number): KnowledgeRequirementPriority {
	if (tier === "unknown" || tier === "needs_clarification") return "low";
	if (confidence >= 0.7) return "high";
	if (confidence >= 0.4) return "medium";
	return "low";
}

/* ------------------------------------------------------------------------------------------------
 * Derivation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Derives knowledge requirements from situation context items and intent hypotheses. Pure and
 * deterministic; bounded by MAX_KNOWLEDGE_REQUIREMENTS; duplicate categories collapse onto the
 * first (highest-belief) occurrence.
 */
export function deriveKnowledgeRequirements(task: string, situation: SituationContext, intentHypotheses: IntentHypothesisSet, requestingAgent: string): KnowledgeRequirement[] {
	void task; // reserved: task-conditioned requirement wording arrives with model-assisted generation
	const requirements: KnowledgeRequirement[] = [];
	const seenCategories = new Set<string>();

	for (const item of situation.items) {
		if (requirements.length >= MAX_KNOWLEDGE_REQUIREMENTS) break;
		if (item.tier === "needs_clarification") continue; // clarification is the intent layer's decision, not a retrieval target
		const mapping = CATEGORY_BY_SITUATION_ITEM[item.id];
		if (mapping === undefined) continue;
		if (mapping.sourcePreference.length === 0) continue;
		if (seenCategories.has(mapping.category)) continue;
		seenCategories.add(mapping.category);
		let priority = priorityFor(item.tier, item.confidence);
		// Vaelia researches current documentation for a living; documentation-shaped requirements
		// are her high-priority business even at medium belief.
		if (requestingAgent === "vaelia" && mapping.category === "conventions") priority = "high";
		requirements.push({
			requirementId: `req-${mapping.category}`,
			category: mapping.category,
			priority,
			sourcePreference: [...mapping.sourcePreference],
			satisfiedBy: null,
			queryHints: [...(mapping.queryHints ?? [])],
		});
	}

	for (const hypothesis of intentHypotheses.hypotheses) {
		if (requirements.length >= MAX_KNOWLEDGE_REQUIREMENTS) break;
		const category = `discriminating-evidence:${hypothesis.hypothesisId}`;
		if (seenCategories.has(category)) continue;
		seenCategories.add(category);
		requirements.push({
			requirementId: `req-discriminating-${hypothesis.hypothesisId}`,
			category,
			priority: hypothesis.status === "alternative" ? "medium" : "high",
			sourcePreference: [SOURCE_ID.akashicMemories],
			satisfiedBy: null,
			queryHints: [],
		});
	}

	return validateKnowledgeRequirements(requirements);
}

/* ------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

const KNOWN_SOURCES: ReadonlySet<string> = new Set<string>(Object.values(SOURCE_ID));

/**
 * Schema-validates and bounds a requirement list: drops malformed entries, unknown sources and
 * duplicates, caps at MAX_KNOWLEDGE_REQUIREMENTS. Invalid input degrades the list; it never throws.
 */
export function validateKnowledgeRequirements(value: readonly KnowledgeRequirement[]): KnowledgeRequirement[] {
	const seen = new Set<string>();
	const requirements: KnowledgeRequirement[] = [];
	for (const requirement of value) {
		if (requirements.length >= MAX_KNOWLEDGE_REQUIREMENTS) break;
		if (typeof requirement.requirementId !== "string" || requirement.requirementId.length === 0 || seen.has(requirement.requirementId)) continue;
		if (typeof requirement.category !== "string" || requirement.category.length === 0) continue;
		if (!KNOWLEDGE_REQUIREMENT_PRIORITIES.includes(requirement.priority)) continue;
		const sources = Array.isArray(requirement.sourcePreference) ? requirement.sourcePreference.filter((source): source is string => typeof source === "string" && KNOWN_SOURCES.has(source)) : [];
		if (sources.length === 0) continue; // a requirement no registered source could ever satisfy is noise
		seen.add(requirement.requirementId);
		requirements.push({
			...requirement,
			requirementId: requirement.requirementId.slice(0, 120),
			sourcePreference: sources.slice(0, 3),
			satisfiedBy: typeof requirement.satisfiedBy === "string" ? requirement.satisfiedBy : null,
			queryHints: Array.isArray(requirement.queryHints) ? requirement.queryHints.filter((hint): hint is string => typeof hint === "string").slice(0, 3) : [],
		});
	}
	return requirements;
}

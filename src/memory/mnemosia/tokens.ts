// Ported from mnemosia/tokens.ts @ f0a8ad4 (MIT; see NOTICE)
/**
 * Token estimation and budget arithmetic.
 *
 * Design assumption 4 fixes the estimator at `ceil(chars / 4)`. That is deliberately not a
 * tokenizer: Mnemosia budgets context for a caller whose model she does not know, so a
 * model-specific count would be precise about the wrong model. What the budget actually needs is a
 * function that is (a) monotonic in content length, (b) identical on every machine and every run,
 * and (c) never optimistic enough to overflow a real context window by a factor that matters.
 * `ceil(chars / 4)` is all three, and the §16 determinism gate depends on the second one.
 */

/** Characters per token. Changing this changes every recorded tokenEstimate; treat as a schema bump. */
export const CHARS_PER_TOKEN = 4;

/** Fraction of a budget held back for the briefing's own scaffolding (design §10). */
export const BUDGET_RESERVE_RATIO = 0.1;

/**
 * `ceil(chars / 4)`, using UTF-16 code-unit length — the same `String.prototype.length` every other
 * length check in both foundations uses, so a memory that fits AkashicForge's MAX_MEMORY_CHARS and
 * a claim that fits a budget are measured on one ruler.
 *
 * The empty string costs 0 tokens rather than 1: a section that rendered nothing must not consume
 * budget, or an empty briefing would price itself above zero.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Sum of the parts, computed per part. Summing lengths first would round only once and under-count. */
export function estimateTokensOfAll(texts: readonly string[]): number {
	let total = 0;
	for (const text of texts) total += estimateTokens(text);
	return total;
}

/**
 * A budget in flight. Immutable: every arithmetic operation returns a new value, so a selection
 * loop cannot lose track of what it spent by mutating a shared object, and a rejected candidate
 * leaves no trace on the budget it was tested against.
 */
export interface Budget {
	/** The caller's hard ceiling. Never exceeded (design §16: 100% compliance). */
	total: number;
	/** `ceil(0.10 · total)`, withheld from the selectable pool. */
	reserve: number;
	used: number;
}

export function createBudget(total: number, reserveRatio: number = BUDGET_RESERVE_RATIO): Budget {
	if (!Number.isInteger(total) || total < 0) throw new Error("budget total must be a non-negative integer");
	if (!(reserveRatio >= 0 && reserveRatio < 1)) throw new Error("reserveRatio must be in [0, 1)");
	return { total, reserve: Math.ceil(reserveRatio * total), used: 0 };
}

/** What may still be spent by the MMR pool: the ceiling minus the reserve minus what is gone. */
export function selectableRemaining(budget: Budget): number {
	return Math.max(0, budget.total - budget.reserve - budget.used);
}

/** What may still be spent by a mandatory item, which is allowed to eat into the reserve. */
export function hardRemaining(budget: Budget): number {
	return Math.max(0, budget.total - budget.used);
}

/** Does `tokens` fit the selectable pool? Mandatory placement asks `fitsHard` instead. */
export function fits(budget: Budget, tokens: number): boolean {
	return tokens <= selectableRemaining(budget);
}

export function fitsHard(budget: Budget, tokens: number): boolean {
	return tokens <= hardRemaining(budget);
}

/** Spending past `total` is a programming error, not a value to clamp: the caller must test first. */
export function spend(budget: Budget, tokens: number): Budget {
	if (!Number.isInteger(tokens) || tokens < 0) throw new Error("tokens must be a non-negative integer");
	const used = budget.used + tokens;
	if (used > budget.total) throw new Error(`budget overflow: ${used} tokens used of ${budget.total}`);
	return { total: budget.total, reserve: budget.reserve, used };
}

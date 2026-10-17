import type { DerivedThinkingStep } from "./types.ts";

// Ported from pi-thinking-steps 1.0.17 (MIT, see NOTICE): render.ts pickCollapsedStep, stepHasEventType and
// selectSummarySteps. Pure and deterministic; no rendering here.

export function pickCollapsedStep(steps: DerivedThinkingStep[], activeStepId?: string): DerivedThinkingStep | undefined {
	if (steps.length === 0) return undefined;
	if (activeStepId) {
		const active = steps.find((step) => step.id === activeStepId);
		if (active) return active;
	}

	let latestFailureIndex = -1;
	let latestSuccessAfterFailureIndex = -1;

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!;
		if (step.hasExplicitFailure) {
			latestFailureIndex = index;
			latestSuccessAfterFailureIndex = -1;
		}
		if (latestFailureIndex !== -1 && step.hasExplicitSuccess && index > latestFailureIndex) {
			latestSuccessAfterFailureIndex = index;
		}
	}

	if (latestSuccessAfterFailureIndex !== -1) return steps[latestSuccessAfterFailureIndex];
	if (latestFailureIndex !== -1) return steps[latestFailureIndex];

	return [...steps]
		.sort((left, right) => (right.collapsedPriority ?? 0) - (left.collapsedPriority ?? 0) || right.blockIndex - left.blockIndex || right.stepIndex - left.stepIndex)[0];
}

function stepHasEventType(step: DerivedThinkingStep, type: string): boolean {
	return step.summaryEvents?.some((event) => event.type === type) ?? false;
}

export function selectSummarySteps(steps: DerivedThinkingStep[], activeStepId?: string): DerivedThinkingStep[] {
	if (steps.length <= 5) return steps;

	const indexed = steps.map((step, index) => ({ step, index }));
	const selected = new Set<number>();
	const activeIndex = activeStepId ? steps.findIndex((step) => step.id === activeStepId) : -1;
	let latestFailureIndex = -1;
	let latestSuccessAfterFailureIndex = -1;

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!;
		if (step.hasExplicitFailure) {
			latestFailureIndex = index;
			latestSuccessAfterFailureIndex = -1;
		}
		if (latestFailureIndex !== -1 && step.hasExplicitSuccess && index > latestFailureIndex) {
			latestSuccessAfterFailureIndex = index;
		}
	}

	if (activeIndex !== -1) selected.add(activeIndex);
	if (latestFailureIndex !== -1) selected.add(latestFailureIndex);
	if (latestSuccessAfterFailureIndex !== -1) selected.add(latestSuccessAfterFailureIndex);

	const scoreEntry = ({ step, index }: { step: DerivedThinkingStep; index: number }): number => {
		let score = step.collapsedPriority ?? 0;
		const isStaleSuccessBeforeLatestFailure = step.hasExplicitSuccess && latestFailureIndex !== -1 && index < latestFailureIndex;
		if (index === latestFailureIndex && latestSuccessAfterFailureIndex === -1) score += 120;
		if (index === latestSuccessAfterFailureIndex) score += 110;
		if (stepHasEventType(step, "decision") || stepHasEventType(step, "plan_change")) score += 80;
		if (step.hasExplicitFailure) score += 50;
		if (step.hasExplicitSuccess && !isStaleSuccessBeforeLatestFailure) score += 45;
		if (isStaleSuccessBeforeLatestFailure) score -= 200;
		if (stepHasEventType(step, "focus") && !stepHasEventType(step, "decision") && !stepHasEventType(step, "plan_change") && !step.hasExplicitFailure && !step.hasExplicitSuccess) score -= 15;
		return score + (index / 100);
	};

	const targetCount = Math.min(5, steps.length);
	for (const entry of [...indexed].sort((left, right) => scoreEntry(right) - scoreEntry(left))) {
		if (selected.size >= targetCount) break;
		selected.add(entry.index);
	}

	return [...selected]
		.sort((left, right) => left - right)
		.map((index) => steps[index]!)
		.slice(0, targetCount);
}

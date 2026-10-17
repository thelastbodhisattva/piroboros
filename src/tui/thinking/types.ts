// Types used by the ported thinking-step parser (pi-thinking-steps 1.0.17, MIT; see NOTICE). Only the
// parser's own types are kept; the upstream export, review and theme types are not used here.

export type ThinkingStepsMode = "collapsed" | "summary" | "expanded";

export type ThinkingSemanticRole = "inspect" | "plan" | "compare" | "verify" | "write" | "search" | "error" | "default";

export type ThinkingSummaryEventType = "failure" | "success" | "decision" | "plan_change" | "uncertainty" | "action" | "focus" | "generic";

export interface ThinkingSummaryEvent {
	type: ThinkingSummaryEventType;
	text: string;
	order: number;
	priority: number;
}

export interface ThinkingSourceBlock {
	contentIndex: number;
	text: string;
	redacted?: boolean;
}

export interface DerivedThinkingStep {
	id: string;
	contentIndex: number;
	blockIndex: number;
	stepIndex: number;
	summary: string;
	body: string;
	role: ThinkingSemanticRole;
	icon: string;
	baselineSummary?: string;
	challengerSummary?: string;
	summaryEvents?: ThinkingSummaryEvent[];
	collapsedPriority?: number;
	hasExplicitFailure?: boolean;
	hasExplicitSuccess?: boolean;
}

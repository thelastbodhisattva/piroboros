// Ported from mnemosia/extension.ts @ f0a8ad4 (MIT; see NOTICE)
// This is openFoundations. It opens what a briefing needs: one source adapter over the curated memories, the scanner, the tokenizer and the redactor.
// The store is the one the akashic tool uses; this file never opens a second connection to it. Paths are explicit.
import { join } from "node:path";
import { createMemoryApi } from "../akashic/api.ts";
import { redactSensitive, tokenizeSearch, validateMemorySafety, type AkashicStore } from "../akashic/store.ts";
import type { Redactor } from "./brief.ts";
import type { MemorySafetyScanner } from "./filters.ts";
import { createAkashicMemoriesAdapter } from "./adapters/akashic-memories.ts";
import type { SourceAdapter } from "./adapters/contract.ts";
import { applyTraceRotation, enableRetention, planTraceRotation } from "./retention.ts";
import type { SearchTokenizer } from "./task.ts";

export interface MnemosiaPaths {
	traceRoot: string;
	feedbackPath: string;
}

/** `${home}/mnemosia/traces` and `${home}/mnemosia/feedback.jsonl`. Opening the foundations prunes old traces (see openFoundations). */
export const mnemosiaPaths = (home: string): MnemosiaPaths => ({ traceRoot: join(home, "mnemosia", "traces"), feedbackPath: join(home, "mnemosia", "feedback.jsonl") });

export interface Foundations extends MnemosiaPaths {
	adapters: SourceAdapter[];
	scan: MemorySafetyScanner;
	tokenize: SearchTokenizer;
	redact: Redactor;
}

/**
 * Trace rotation was a human-approval item in the port (retention.ts, design 19 item 4). The user
 * approved it for piroboros with the retention.ts defaults: a trace is kept while it is under 90 days
 * old or among the 500 newest. The feedback log is capped separately, in submitFeedback.
 */
const TRACE_ROTATION_GATE = enableRetention("piroboros host", "user-approved review fix: traces were never rotated; keep 90 days or the 500 newest");

export function openFoundations(store: AkashicStore, paths: MnemosiaPaths, warn: (message: string) => void = () => {}): Foundations {
	// Housekeeping must not stop startup: a traces path that is a file, an unreadable folder or a failed delete is reported and skipped.
	try {
		const { failed } = applyTraceRotation(planTraceRotation({ root: paths.traceRoot }), TRACE_ROTATION_GATE);
		if (failed.length > 0) warn(`trace rotation could not remove ${failed.length} file(s): ${failed[0]!.error}`);
	} catch (error) {
		warn(`trace rotation skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		...paths,
		adapters: [createAkashicMemoriesAdapter({ api: createMemoryApi(store) })],
		scan: validateMemorySafety,
		tokenize: tokenizeSearch,
		redact: redactSensitive,
	};
}

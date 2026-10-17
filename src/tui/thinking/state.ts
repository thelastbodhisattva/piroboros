import { deriveThinkingSteps } from "./parse.ts";
import type { DerivedThinkingStep, ThinkingSourceBlock, ThinkingStepsMode } from "./types.ts";

// The thinking panel's state: the step memo (N14) and the display mode (D23). Source text comes from committed
// state only: the thinking blocks of the live partial while a response streams, of the `pi.assistant` entry after.

export const MEMO_MAX = 256;
export const LIVE_INTERVAL_MS = 100;
export const LIVE_TAIL_CODE_POINTS = 32_000;
export const MODES: readonly ThinkingStepsMode[] = ["collapsed", "summary", "expanded"];
export const DEFAULT_MODE: ThinkingStepsMode = "summary";

/** The thinking blocks of an assistant message that have something to show: text, or a redacted marker. */
export function thinkingBlocksOf(message: unknown): ThinkingSourceBlock[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	const out: ThinkingSourceBlock[] = [];
	content.forEach((block: { type?: string; thinking?: unknown; redacted?: unknown } | null, contentIndex) => {
		if (block?.type !== "thinking") return;
		const text = typeof block.thinking === "string" ? block.thinking : "";
		const redacted = block.redacted === true;
		if (redacted || text.trim() !== "") out.push({ contentIndex, text, ...(redacted ? { redacted } : {}) });
	});
	return out;
}

/** The last `max` code points of `text`; the text itself when it is not longer. */
export function tailOf(text: string, max = LIVE_TAIL_CODE_POINTS): string {
	if (text.length <= max) return text;
	const points = Array.from(text);
	return points.length <= max ? text : points.slice(-max).join("");
}

interface LiveMark {
	at: number;
	steps: DerivedThinkingStep[];
}

/**
 * Step derivation with a memo. Key: (conversation, entry id or "live:"+attempt, block ordinal, text length), in an
 * LRU of MEMO_MAX entries. A live block is re-derived at most every LIVE_INTERVAL_MS and from its trailing
 * LIVE_TAIL_CODE_POINTS only; a final entry is parsed once, in full.
 */
export class StepMemo {
	/** Parser runs so far; tests read it. */
	derives = 0;
	private readonly lru = new Map<string, DerivedThinkingStep[] | LiveMark>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	get size(): number {
		return this.lru.size;
	}

	private touch<T extends DerivedThinkingStep[] | LiveMark>(key: string): T | undefined {
		const hit = this.lru.get(key);
		if (hit === undefined) return undefined;
		this.lru.delete(key);
		this.lru.set(key, hit);
		return hit as T;
	}

	private put(key: string, value: DerivedThinkingStep[] | LiveMark): void {
		this.lru.delete(key);
		this.lru.set(key, value);
		while (this.lru.size > MEMO_MAX) this.lru.delete(this.lru.keys().next().value as string);
	}

	/** Steps of every non-redacted block of one message, in order. `id` is the entry id, or "live:"+attempt while streaming. */
	steps(conversation: string | number, id: string, blocks: readonly ThinkingSourceBlock[], live: boolean): DerivedThinkingStep[] {
		const out: DerivedThinkingStep[] = [];
		let ordinal = 0;
		for (const block of blocks) {
			if (block.redacted === true && block.text.trim() === "") continue;
			const blockIndex = ordinal++;
			const key = `${conversation}|${id}|${blockIndex}|${block.text.length}`;
			let steps = this.touch<DerivedThinkingStep[]>(key);
			if (steps === undefined) {
				const markKey = `live|${conversation}|${id}|${blockIndex}`;
				const mark = live ? this.touch<LiveMark>(markKey) : undefined;
				if (mark !== undefined && this.now() - mark.at < LIVE_INTERVAL_MS) steps = mark.steps;
				else {
					this.derives += 1;
					const text = live ? tailOf(block.text) : block.text;
					steps = deriveThinkingSteps([{ contentIndex: block.contentIndex, text }]).map((step) => ({ ...step, blockIndex }));
					this.put(key, steps);
					if (live) this.put(markKey, { at: this.now(), steps });
				}
			}
			out.push(...steps);
		}
		return out;
	}
}

/**
 * The display mode. Held in memory for the session; the global value is settings tui.thinkingSteps (default summary).
 * Restore order: session, then global, then summary.
 */
export class ThinkingState {
	readonly memo: StepMemo;
	private session: ThinkingStepsMode | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly readGlobal: () => ThinkingStepsMode | undefined;
	private readonly writeGlobal: (value: ThinkingStepsMode | "clear") => void;

	constructor(options: { global: () => ThinkingStepsMode | undefined; write: (value: ThinkingStepsMode | "clear") => void; now?: () => number }) {
		this.readGlobal = options.global;
		this.writeGlobal = options.write;
		this.memo = new StepMemo(options.now);
	}

	mode(): ThinkingStepsMode {
		return this.session ?? this.readGlobal() ?? DEFAULT_MODE;
	}

	set(mode: ThinkingStepsMode): void {
		this.session = mode;
		this.notify();
	}

	/** Drops the session override, so the global setting shows again. */
	clearSession(): void {
		this.session = undefined;
		this.notify();
	}

	cycle(): ThinkingStepsMode {
		const next = MODES[(MODES.indexOf(this.mode()) + 1) % MODES.length]!;
		this.set(next);
		return next;
	}

	/** Writes the global setting first; the session mode follows only when the write succeeded. `clear` restores the default. */
	setGlobal(value: ThinkingStepsMode | "clear"): void {
		this.writeGlobal(value);
		this.session = value === "clear" ? DEFAULT_MODE : value;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

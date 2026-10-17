import { type HarnessType, type Conversation } from "../durable.ts";
import type { Compactor } from "./compactor.ts";
import { indexPass } from "./log.ts";

// compactLoop (D6): it indexes new root entries and builds the inline nodes (at most 512 bytes); the compactor, when
// there is one, then joins the nodes that BuildNode tasks finished, advances the compaction view and starts the next
// tasks. Passes are serial. The turn loop calls `indexNow()` before it advances the view, so the view never lags
// behind the log.

export interface CompactLoopDeps {
	harness: HarnessType;
	root: Conversation;
	compactor?: Pick<Compactor, "pass">;
	onAlarm?(text: string): void;
	onReport?(error: unknown): void;
}

export class CompactLoop {
	private readonly deps: CompactLoopDeps;
	private chain: Promise<void> = Promise.resolve();
	private unsubscribe: (() => void) | undefined;
	private stopped = true;
	private queued = false;

	constructor(deps: CompactLoopDeps) {
		this.deps = deps;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		// The listener only schedules; it never calls Session APIs.
		this.unsubscribe = this.deps.harness.subscribeCommits(() => this.wake());
		this.wake();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.unsubscribe?.();
		await this.chain;
	}

	/** Schedule a catch-up pass; several wakes while one is queued collapse into one. */
	wake(): void {
		if (this.stopped || this.queued) return;
		this.queued = true;
		this.chain = this.chain.then(async () => {
			this.queued = false;
			if (this.stopped) return;
			try {
				await this.catchUp();
			} catch (error) {
				this.deps.onReport?.(error);
			}
		});
	}

	/** Resolves once every entry committed before the call is indexed. Errors reach the caller. */
	indexNow(): Promise<void> {
		const run = this.chain.then(() => this.catchUp());
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async catchUp(): Promise<void> {
		for (;;) {
			while (await indexPass(this.deps));
			// A compactor failure never blocks indexing, so a turn can always start.
			try {
				if (!(await this.deps.compactor?.pass())) return;
			} catch (error) {
				this.deps.onReport?.(error);
				return;
			}
		}
	}
}

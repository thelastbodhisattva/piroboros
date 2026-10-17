import { ctx, defineDoc, type HarnessType, type Tx } from "../durable.ts";
import { NodeDoc, nodeKey } from "./log.ts";
import { advanceTo, cloneView, emptyView, VIEW_MAX, VIEW_TARGET, type CompactorLabel, type Line, type Nodes, type ViewState } from "./view.ts";

// View and turn-state documents, and the glue between the pure view rules and the store. Nodes are read by
// snapshot outside a commit and never probed with tx.doc, which would create an absent node.

type ViewValue = { lines: Line[]; bytes: number; T: number; shrinking: boolean; batchSeq: number };

const viewDoc = (kind: string) => defineDoc<ViewValue>({
	scope: "session",
	kind,
	version: 1,
	initial: () => ({ lines: [], bytes: 0, T: 0, shrinking: false, batchSeq: 0 }),
	migrate: (_value, fromVersion) => { throw new Error(`unsupported ${kind} v${fromVersion}`); },
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** What the main model reads. Its only writer is the turn commit. */
export const ViewDoc = viewDoc("piroboros.view");
/** What the compactor reads as context (D5): the same lines, kept to 32,000 bytes. Its only writer is the compact loop. */
export const CviewDoc = viewDoc("piroboros.cview");

export type TurnState = {
	itemIds: string[];
	cwd: string;
	/** When the turn started (epoch ms); the hook renders it as the date. */
	at: number;
	/** Messages the view covers. */
	T: number;
	/** First message id of the rendered window; 0 renders the whole view. */
	windowStart: number;
	compactor: CompactorLabel;
	/**
	 * True while the turn started from Conclave reports alone, with no user item (F3). The guard blocks root write, edit
	 * and bash until the user sends something. A document written before this field existed reads as false.
	 */
	reportOnly?: boolean;
	/** Hash of the memory snapshot of the last note, or "" when the last snapshot was empty. */
	noteHash?: string;
	/** Notes written so far; part of the note request id, so a hash that comes back is noted again. */
	notes?: number;
};

export const TurnStateDoc = defineDoc<TurnState>({
	scope: "session",
	kind: "piroboros.turnState",
	version: 1,
	initial: () => ({ itemIds: [], cwd: "", at: 0, T: 0, windowStart: 0, compactor: "not configured", reportOnly: false }),
	migrate: (_value, fromVersion) => { throw new Error(`unsupported piroboros.turnState v${fromVersion}`); },
});

export const toViewState = (doc: Readonly<ViewState> | undefined): ViewState => (doc === undefined ? emptyView() : cloneView(doc as ViewState));

/**
 * Compute the view after advancing to `T` messages. The pure rules call `get` synchronously, so nodes are loaded
 * in rounds: a run that asks for a node it does not have records the key, the keys are read by snapshot, and the
 * run repeats until it asks for nothing new. Only the last run, which saw every node it needed, is returned.
 */
export async function planAdvance(harness: Pick<HarnessType, "snapshot">, current: Readonly<ViewState> | undefined, T: number, max = VIEW_MAX, target = VIEW_TARGET, extra?: (view: ViewState, nodes: Nodes) => void, unbuilt?: (level: number, index: number) => boolean): Promise<ViewState> {
	const cache = new Map<string, string | null>();
	const missing = new Set<string>();
	const nodes: Nodes = {
		get(level, index) {
			// A node the caller knows is unbuilt is not asked of the store: an absent document is never in the session cache,
			// so every pass would pay a lookup for each of them.
			if (unbuilt?.(level, index) === true) return undefined;
			const key = nodeKey(level, index);
			const hit = cache.get(key);
			if (hit === undefined) missing.add(key);
			return hit ?? undefined;
		},
	};
	for (;;) {
		missing.clear();
		const next = toViewState(current);
		advanceTo(next, T, nodes, max, target);
		extra?.(next, nodes);
		if (missing.size === 0) return next;
		for (const key of missing) cache.set(key, (await harness.snapshot(NodeDoc, key, ctx))?.text ?? null);
	}
}

/** Write `next` into the view document as a minimal delta: the lines from the first difference on. */
export async function applyView(tx: Tx, before: Readonly<ViewState> | undefined, next: ViewState, which: typeof ViewDoc = ViewDoc): Promise<void> {
	const doc = await tx.doc(which);
	const start = toViewState(before);
	if (doc.T !== start.T || doc.bytes !== start.bytes || doc.lines.length !== start.lines.length) throw new Error("invariant: the view changed during an advance; the turn commit is its only writer");
	let p = 0;
	const same = (a: Line, b: Line): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
	while (p < doc.lines.length && p < next.lines.length && same(doc.lines[p] as Line, next.lines[p]!)) p += 1;
	if (p < doc.lines.length || p < next.lines.length) doc.lines.splice(p, doc.lines.length - p, ...next.lines.slice(p));
	doc.bytes = next.bytes;
	doc.T = next.T;
	doc.shrinking = next.shrinking;
	doc.batchSeq = next.batchSeq;
}

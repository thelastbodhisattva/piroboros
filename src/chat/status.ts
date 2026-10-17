import { ctx, recentEntries, type Conversation, type HarnessType } from "../durable.ts";
import type { Compactor } from "./compactor.ts";
import { CursorDoc } from "./log.ts";
import { TurnStateDoc, ViewDoc } from "./tree.ts";
import { viewBanner, type CompactorLabel } from "./view.ts";

/** Text of `/status`: messages saved, summary view size, lines waiting for a summary, the model's window, and the cache use of recent responses. */
export async function statusText(harness: HarnessType, root: Conversation, label: CompactorLabel, compactor?: Pick<Compactor, "report">): Promise<string> {
	const report = await compactor?.report();
	const cursor = await harness.snapshot(CursorDoc, ctx);
	const view = await harness.snapshot(ViewDoc, ctx);
	const turn = await harness.snapshot(TurnStateDoc, ctx);
	const unbuilt = view?.lines.filter((line) => line[2] === null).length ?? 0;
	const out = [
		`messages saved: ${cursor?.T ?? 0}; the summary view covers ${view?.T ?? 0}`,
		`summary view: ${view?.lines.length ?? 0} lines, ${view?.bytes ?? 0} bytes, built in ${view?.batchSeq ?? 0} batches${view?.shrinking ? ", still shrinking" : ""}`,
		`lines waiting for a summary: ${unbuilt}`,
		`compactor: ${label}${label === "disabled" && report?.reason !== undefined ? ` (${report.reason})` : ""}${label !== "configured" ? `; the model sees messages from ${turn?.windowStart ?? 0} on` : ""}`,
	];
	if (report !== undefined && label === "configured") {
		out.push(
			`compactor model: ${report.model ?? "none"}, up to ${report.maxConcurrent} requests at once`,
			`compactor work: ${report.waiting} waiting, ${report.inFlight} running, ${report.built} done, ${report.retries} retries, ${report.busyRetries} retries while the provider was busy`,
			`compactor paused after errors: ${report.breaker === "open" ? "yes" : "no"}${report.breakerReason === undefined ? "" : ` (${report.breakerReason})`}`,
		);
	}
	if (report?.lastError != null) out.push(`last compactor error: ${report.lastError}`);
	const banner = viewBanner(label, view?.bytes ?? 0);
	if (banner !== undefined) out.push(banner);
	const usage: string[] = [];
	for (const entry of await recentEntries(root, 400)) {
		const message = entry.model?.[0] as { role?: string; provider?: string; model?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } } | undefined;
		if (message?.role !== "assistant" || message.usage === undefined) continue;
		usage.push(`  ${message.provider}/${message.model}: input ${message.usage.input ?? 0}, cache read ${message.usage.cacheRead ?? 0}, cache write ${message.usage.cacheWrite ?? 0}`);
		if (usage.length === 5) break;
	}
	out.push(usage.length === 0 ? "no responses yet" : `last responses, newest first:\n${usage.join("\n")}`);
	return out.join("\n");
}

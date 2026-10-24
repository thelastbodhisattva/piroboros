import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createSqliteTelemetry, type SqliteTelemetry } from "@earendil-works/chord/telemetry-sqlite";

// Local request and task timings (telemetry.sqlite). chord's recorder buffers spans and ten-second metric intervals
// and writes them once a second; nothing leaves the machine. Message text never reaches it, and error text is dropped
// at the store (see below).

export interface Telemetry {
	recorder: SqliteTelemetry;
	/** Model requests of the last 24 hours, one line per model. */
	summary(now?: number): Promise<string>;
	close(): Promise<void>;
}

/**
 * ponytail: error text (status.error.message of a span: a provider's reply, a thrown fault) can echo prompt text or
 * paths, so a connection-local TEMP trigger removes it from every inserted span; the error name stays. secure_delete
 * keeps the removed text out of the WAL. If upstream moves error text to another column this misses it: rerun the
 * canary probe on every pi-durable, chord or pi-ai upgrade.
 */
const DROP_ERROR_TEXT = `PRAGMA secure_delete = ON;
CREATE TEMP TRIGGER drop_error_text AFTER INSERT ON main.telemetry_spans
WHEN json_extract(NEW.status, '$.error.message') IS NOT NULL
BEGIN UPDATE telemetry_spans SET status = json_remove(NEW.status, '$.error.message') WHERE id = NEW.id; END;`;

export async function openTelemetry(path: string): Promise<Telemetry> {
	const db = await openNodeSqliteDatabase(path);
	let recorder: SqliteTelemetry | undefined;
	try {
		recorder = await createSqliteTelemetry(db);
		await db.exec(DROP_ERROR_TEXT);
	} catch (error) {
		await recorder?.close().catch(() => undefined);
		await db.close().catch(() => undefined);
		throw error;
	}
	const rec = recorder;
	return {
		recorder: rec,
		async summary(now = Date.now()) {
			let head = "";
			try { await rec.flush(); } catch (error) { head = `telemetry recording stopped: ${error instanceof Error ? error.message : String(error)} (the numbers below are up to then)\n`; }
			const startMin = now - 86_400_000;
			const [duration, tokens, cost] = await Promise.all(["pi.ai.request.duration", "pi.ai.tokens", "pi.ai.cost"].map((name) => rec.findMetrics({ name, startMin })));
			const rows = new Map<string, { n: number; failed: number; ms: number; input: number; output: number; cost: number }>();
			const row = (m: { attributes: Record<string, unknown> }) => {
				const key = `${m.attributes.provider}/${m.attributes.model}`;
				if (!rows.has(key)) rows.set(key, { n: 0, failed: 0, ms: 0, input: 0, output: 0, cost: 0 });
				return rows.get(key)!;
			};
			for (const m of duration!) { const r = row(m); r.n += m.count; r.ms += m.sum; if (m.attributes.stop === "error") r.failed += m.count; }
			for (const m of tokens!) { const r = row(m); if (m.attributes.kind === "input") r.input += m.sum; else if (m.attributes.kind === "output") r.output += m.sum; }
			for (const m of cost!) row(m).cost += m.sum;
			const lines = [...rows].filter(([, r]) => r.n > 0).map(([model, r]) => `${model}: ${r.n} requests, ${r.failed} failed, ${(r.ms / r.n / 1000).toFixed(1)} s average, ${r.input} in / ${r.output} out tokens, $${r.cost.toFixed(4)}`);
			return `${head}${lines.length === 0 ? "no model requests recorded in the last 24 hours" : `model requests, last 24 hours (the last 10 seconds may not show yet)\n${lines.join("\n")}`}`;
		},
		async close() {
			const errors: unknown[] = [];
			try { await rec.close(); } catch (error) { errors.push(error); }
			try { await db.close(); } catch (error) { errors.push(error); }
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "telemetry close failed in more than one step");
		},
	};
}

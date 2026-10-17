import { createElement, type ReactElement } from "react";
import { Box } from "ink";
import { VIEW_MAX } from "../chat/view.ts";
import type { MemoryStatus } from "../memory/host.ts";
import { safe } from "./sanitize.ts";
import { THEME } from "./theme.ts";
import { clip, spanLine, type FrameLine } from "./viewport.ts";

// The session panel: what the right column shows while no Conclave run is on screen. It is a fixed block of
// PANEL_ROWS single-line rows, so the layout does not move while text streams. It reads only data that App
// already refreshes; nothing here reads a file or starts a timer.

export const PANEL_ROWS = 8;
export const PANEL_HINT = "/conclave <task>";

export interface PanelData {
	main: string | undefined;
	thinking: string;
	viewBytes: number;
	compactor: string;
	memory: Pick<MemoryStatus, "pendingSync" | "quarantined" | "proposed"> | undefined;
	web: { enabled: boolean; provider: string | undefined; keyMissing: boolean };
	/** The outcome of the last Conclave run, when one has ended. */
	outcome: string | undefined;
}

export function memoryText(memory: PanelData["memory"]): string {
	if (memory === undefined) return "not read yet";
	const parts = [...(memory.pendingSync ? ["vault sync pending"] : []), ...(memory.quarantined > 0 ? [`${memory.quarantined} quarantined`] : []), ...(memory.proposed > 0 ? [`${memory.proposed} proposed`] : [])];
	return parts.length === 0 ? "ok" : parts.join(", ");
}

export function webText(web: PanelData["web"]): string {
	if (!web.enabled) return "off";
	if (web.provider === undefined) return "fetch only";
	return `search ${web.provider}${web.keyMissing ? ", key missing" : ""}`;
}

/** Exactly PANEL_ROWS lines, each at most `width` columns, a blank line where a row has nothing to say. */
export function panelLines(data: PanelData, width: number): string[] {
	const rows = [
		"Session",
		`main ${data.main ?? "not set"}`,
		`thinking ${data.thinking}`,
		`view ${Math.round(data.viewBytes / 1000)} KB / ${VIEW_MAX / 1000} KB`,
		`compactor ${data.compactor}`,
		`memory ${memoryText(data.memory)}`,
		`web ${webText(data.web)}`,
		data.outcome === undefined || data.outcome === "" ? PANEL_HINT : `last run: ${data.outcome}`,
	];
	return rows.map((row) => clip(row, Math.max(1, width)) || " ");
}

/** The framed panel (P18): the title, then uppercase muted labels padded to 10 with their values, then the hint or the last run. Still PANEL_ROWS rows. */
export function panelFrame(data: PanelData, width: number): FrameLine[] {
	const w = Math.max(1, width);
	const warn = THEME.warn;
	const row = (label: string, value: string, color?: string): FrameLine => spanLine([{ text: label.padEnd(10), color: THEME.muted }, { text: value, ...(color === undefined ? {} : { color }) }], w);
	const memory = memoryText(data.memory);
	return [
		spanLine([{ text: "◆ Session", bold: true }], w),
		row("MAIN", data.main ?? "not set"),
		row("THINKING", data.thinking),
		row("VIEW", `${Math.round(data.viewBytes / 1000)} KB / ${VIEW_MAX / 1000} KB`),
		row("COMPACTOR", data.compactor),
		row("MEMORY", memory, data.memory === undefined || memory === "ok" ? undefined : warn),
		row("WEB", webText(data.web), data.web.keyMissing ? warn : undefined),
		spanLine([{ text: data.outcome === undefined || data.outcome === "" ? PANEL_HINT : `last run: ${data.outcome}`, color: THEME.muted }], w),
	];
}

/** The panel in at most `maxRows` rows: the first rows stay, the rest are cut. */
export function SessionPanel({ data, width, maxRows = PANEL_ROWS }: { data: PanelData; width: number; maxRows?: number }): ReactElement {
	const lines = panelLines(data, width).slice(0, Math.max(0, maxRows));
	return createElement(Box, { flexDirection: "column" }, ...lines.map((line, i) => safe(line, { key: `r${i}`, wrap: "truncate-end", ...(i === 0 ? { bold: true } : {}), ...(i === PANEL_ROWS - 1 && line === PANEL_HINT ? { color: THEME.muted } : {}) })));
}

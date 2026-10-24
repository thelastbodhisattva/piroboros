import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Context, ToolExecutionApi, ToolRegistration } from "./durable.ts";

// The shell is bash on every platform. On Windows that is Git Bash. The WSL launchers (System32, Sysnative and the WindowsApps alias) are never used.

export const BASH_HINT = "Install Git for Windows (https://git-scm.com/download/win), which includes Git Bash. On Linux and macOS install bash from your package manager.";

export const isWslLauncher = (path: string): boolean => /[\\/](?:system32|sysnative|microsoft[\\/]windowsapps)[\\/]bash\.exe$/iu.test(path);

/** The bash executable to run commands with, or undefined when none is installed. */
export function findBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform !== "win32") return existsSync("/bin/bash") ? "/bin/bash" : (env.PATH ?? "").split(delimiter).map((dir) => join(dir, "bash")).find((p) => existsSync(p));
	const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")];
	for (const root of roots) {
		if (!root) continue;
		for (const rel of [join("Git", "bin", "bash.exe"), join("Git", "usr", "bin", "bash.exe")]) {
			const candidate = join(root, rel);
			if (existsSync(candidate)) return candidate;
		}
	}
	return (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "bash.exe")).find((p) => !isWslLauncher(p) && existsSync(p));
}

const SGR = /\u001b\[[0-9;:]*m/gu;
const PARTIAL_ESCAPE = /\u001b(?:\[[0-9;:]*)?$/u;

/**
 * Removes color codes (ESC [ ... m) from streamed text. A code split across two chunks is held back until it
 * completes, per stream. Every other escape passes through and is shown as visible text by the terminal layer.
 */
export function sgrStripper(): { push(text: string, stream: string): string; flush(stream: string): string } {
	const carry = new Map<string, string>();
	return {
		push(text, stream) {
			let joined = (carry.get(stream) ?? "") + text;
			carry.delete(stream);
			joined = joined.replace(SGR, "");
			const partial = PARTIAL_ESCAPE.exec(joined);
			if (partial !== null) {
				carry.set(stream, partial[0]);
				joined = joined.slice(0, partial.index);
			}
			return joined;
		},
		flush(stream) {
			const rest = carry.get(stream) ?? "";
			carry.delete(stream);
			return rest;
		},
	};
}

/* --- output clipping (H2) ------------------------------------------------------------------------------------ */

export const CLIP_HEAD = 12_000;
export const CLIP_TAIL = 18_000;

/** Keeps the first CLIP_HEAD and the last CLIP_TAIL characters of a stream, and counts the rest. */
export class HeadTail {
	private head = "";
	private tail = "";
	private total = 0;

	push(text: string): void {
		this.total += text.length;
		if (this.head.length < CLIP_HEAD) {
			const take = Math.min(text.length, CLIP_HEAD - this.head.length);
			this.head += text.slice(0, take);
			text = text.slice(take);
		}
		this.tail += text;
		if (this.tail.length > CLIP_TAIL * 2) this.tail = this.tail.slice(-CLIP_TAIL);
	}

	/** The text to show and how many characters it leaves out. */
	result(): { text: string; omitted: number } {
		let tail = this.tail.length > CLIP_TAIL ? this.tail.slice(-CLIP_TAIL) : this.tail;
		const low = tail.charCodeAt(0);
		if (this.total - this.head.length - tail.length > 0 && low >= 0xdc00 && low <= 0xdfff) tail = tail.slice(1);
		if (this.total - this.head.length - tail.length <= 0) return { text: this.head + tail, omitted: 0 };
		const end = this.head.charCodeAt(this.head.length - 1);
		const head = end >= 0xd800 && end <= 0xdbff ? this.head.slice(0, -1) : this.head; // never cut a surrogate pair
		const omitted = this.total - head.length - tail.length;
		return { text: `${head}\n[${omitted} characters omitted from the middle of the output]\n${tail}`, omitted };
	}
}

const CLIP_NOTE = `Output beyond ${CLIP_HEAD + CLIP_TAIL} characters is cut to its first ${CLIP_HEAD} and last ${CLIP_TAIL} characters with a marker in between. Nothing is saved to a file.`;

/**
 * Wrap a shell tool so oversized output keeps its head and its tail. The tool's own tail retention would keep only
 * the end, and its spill file is switched off in ShellEnv. A failed command keeps its output and its error.
 */
export function clipShellOutput<T extends ToolRegistration>(tool: T): T {
	const decoder = new TextDecoder("utf-8");
	return {
		...tool,
		description: tool.description.replace(/ Output is truncated.*?temp file\./u, ` ${CLIP_NOTE}`),
		outputLimits: { maxBytes: 4 * (CLIP_HEAD + CLIP_TAIL), maxLines: CLIP_HEAD + CLIP_TAIL, retain: "tail" as const },
		async execute(args: never, api: ToolExecutionApi, context: Context) {
			const clip = new HeadTail();
			// outputWindow is cleared so the environment never skips text the clip has not seen.
			const inner = { ...api, outputWindow: undefined, output: (chunk: string | Uint8Array, skipped?: never) => { clip.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })); api.output(chunk, skipped); } };
			try {
				const result = await tool.execute(args, inner as ToolExecutionApi, context);
				const shown = clip.result();
				return shown.omitted > 0 ? { ...result, output: [{ type: "text" as const, text: shown.text }] } : result;
			} catch (error) {
				const shown = clip.result();
				if (shown.omitted <= 0 || context.abortSignal?.aborted) throw error;
				return { output: [{ type: "text" as const, text: shown.text }], isError: true, diagnostics: [{ severity: "error" as const, message: error instanceof Error ? error.message : String(error) }] };
			}
		},
	} as T;
}

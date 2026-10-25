import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, posix, resolve } from "node:path";
import { err, ExecutionError, type Result, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { ShellEnv } from "../durable.ts";
import { checkRead, denyRoots, type GuardConfig } from "../guard.ts";

// Confinement for Vesperia's shell (P27e1): native bubblewrap on Linux. `confineFor` picks the backend when a Workspace opens and
// the choice is stored in the row's `confine` column; ConfinedShellEnv wraps each command of that Workspace. A command is passed as
// one argument of `bash -c` (1.4.0 cannot select its stdin transport for bash, so the stdin wrapper waits for P27e2, where wsl.exe needs it).

/** The row's `confine` column. */
export interface Confine { name: "none" | "bubblewrap"; bwrap?: string; net?: boolean; why?: string }

/** Everything the argv and the self-test read from the machine; probes replace it. Paths are POSIX. */
export interface ConfineDeps {
	platform: NodeJS.Platform;
	/** The user's home, which becomes an empty tmpfs inside. */
	home: string;
	piroHome: string;
	wsRoot: string;
	deny: string[];
	/** The guard's read verdict: false inside a deny root outside a guard.allow folder. */
	allowed(path: string): boolean;
	/** realpath, or undefined when the path does not exist. */
	real(path: string): string | undefined;
	read(path: string): string | undefined;
	which(name: string): string | undefined;
	run(program: string, args: string[]): Promise<{ code: number | null; out: string }>;
}

export const UNCONFINED = "WARNING: shell commands are not confined on this system. Vesperia's commands run in the Workspace folder but can still read and write any path your account can, including your live project.";
/** Linux refuses one argument over 131,072 bytes counting its NUL (MAX_ARG_STRLEN). */
export const COMMAND_MAX = 131_071;

const within = (root: string, path: string): boolean => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

export function nativeDeps(cfg: GuardConfig, wsRoot: string): ConfineDeps {
	return {
		platform: process.platform, home: cfg.profile ?? homedir(), piroHome: cfg.home, wsRoot, deny: denyRoots(cfg),
		allowed: (path) => checkRead(path, undefined, cfg).allowed,
		real: (path) => { try { return realpathSync(path); } catch { return undefined; } },
		read: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
		which: (name) => (process.env.PATH ?? "").split(delimiter).map((dir) => posix.join(dir, name)).find((p) => existsSync(p)),
		run: (program, args) => new Promise((done) => execFile(program, args, { timeout: 10_000, env: { PATH: process.env.PATH ?? "" } }, (e, out, errs) => done({ code: e === null ? 0 : typeof e.code === "number" ? e.code : null, out: `${out}${errs}` }))),
	};
}

/**
 * The bwrap arguments for `inner` run in the Workspace `c.ws` from `c.cwd`. Options apply in order: masks first, binds after. A mask
 * path is resolved first; one that does not exist, or lies inside an earlier mask, is dropped. `refused` names needed paths left
 * masked because they lie in a deny root outside every guard.allow folder, or are, or contain, a protected folder.
 */
export function bwrapArgs(d: ConfineDeps, c: { ws: string; cwd: string; net: boolean; path: string }, inner: string[]): { args: string[]; refused: string[] } {
	const masks: string[] = [];
	for (const mask of [d.home, "/run", "/var/run", d.piroHome, ...d.deny]) {
		const r = d.real(mask);
		if (r !== undefined && !masks.some((m) => within(m, r))) masks.push(r);
	}
	const binds: [string, string][] = [];
	const refused: string[] = [];
	const protectedRoots = [d.piroHome, d.wsRoot, ...d.deny].map((root) => d.real(root) ?? root);
	const need = (path: string): void => {
		const r = d.real(path);
		if (r === undefined || binds.some(([, dest]) => dest === r)) return;
		if (!d.allowed(r) || protectedRoots.some((root) => within(r, root))) { if (masks.some((m) => within(m, r))) refused.push(path); return; }
		binds.push([r, r]);
	};
	for (const line of (d.read(posix.join(c.ws, ".git/objects/info/alternates")) ?? "").split(/\r?\n/u)) if (line.startsWith("/")) need(line);
	const resolv = c.net ? d.real("/etc/resolv.conf") : undefined;
	if (resolv !== undefined && masks.some((m) => within(m, resolv))) need(posix.dirname(resolv));
	// PATH entries under the home: the entry, and its parent only for `<parent>/bin` where the parent is neither the home nor a direct child of it.
	const home = d.real(d.home) ?? d.home;
	for (const entry of c.path.split(":")) {
		const r = entry.startsWith("/") ? d.real(entry) : undefined;
		if (r === undefined || r === home || !within(home, r)) continue;
		const parent = posix.dirname(r);
		if (posix.basename(r) === "bin" && parent !== home && posix.dirname(parent) !== home) need(parent);
		need(r);
	}
	const args = ["--die-with-parent", "--new-session", "--unshare-all", ...(c.net ? ["--share-net"] : []), "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
		...masks.flatMap((m) => ["--tmpfs", m]), ...binds.flatMap(([s, t]) => ["--ro-bind", s, t]), "--bind", c.ws, c.ws, "--chdir", c.cwd, ...inner];
	return { args, refused };
}

// Runs inside the sandbox: write and remove a file in the Workspace, no auth.json beside the home, and (network on) a readable resolv.conf.
const SELF_TEST = 'm="$1/.piroboros-selftest"; : > "$m" || { echo "the Workspace is not writable"; exit 1; }; rm -f "$m"; [ ! -e "$2/auth.json" ] || { echo "auth.json is visible"; exit 1; }; [ "$3" = 0 ] || [ -r /etc/resolv.conf ] || { echo "resolv.conf is not readable"; exit 1; }';

/** Pick the backend for a Workspace folder. A failure is never a run failure: it gives none plus a warning. */
export async function confineFor(s: { confine: "auto" | "none"; network: boolean }, d: ConfineDeps, ws: string): Promise<{ confine: Confine; label: string; notice: string[] }> {
	const none = (why: string, test = false): { confine: Confine; label: string; notice: string[] } =>
		({ confine: { name: "none", why }, label: "none", notice: [test ? `WARNING: confinement failed its self-test (${why}). Shell commands are not confined: Vesperia's commands run in the Workspace folder but can still read and write any path your account can, including your live project.` : `${UNCONFINED} Not used: ${why}.`] });
	if (s.confine === "none") return none("workspace.confine is none");
	if (d.platform !== "linux") return none(`bubblewrap needs Linux; this is ${d.platform}`);
	const bwrap = d.which("bwrap");
	if (bwrap === undefined) return none("bubblewrap is not installed (package bubblewrap)");
	const test = bwrapArgs(d, { ws, cwd: ws, net: s.network, path: process.env.PATH ?? "" }, ["sh", "-c", SELF_TEST, "sh", ws, d.piroHome, s.network ? "1" : "0"]);
	const ran = await d.run(bwrap, test.args);
	if (ran.code !== 0) return none(ran.out.trim().split("\n")[0] || "bwrap did not start", true);
	return { confine: { name: "bubblewrap", bwrap, net: s.network }, label: "bubblewrap", notice: [...(s.network ? ["Network: on. Confined commands can reach your network, and can send any file they can see."] : []), ...(test.refused.length > 0 ? [`Left hidden in the sandbox because they are protected: ${test.refused.join(", ")}`] : [])] };
}

/** Wraps each command of a Workspace whose row says bubblewrap; every other command runs as before. A command a chosen backend cannot start is an error, never a rerun. */
export class ConfinedShellEnv extends ShellEnv {
	private readonly lookup: (cwd: string) => { ws: string; confine: Confine; deps: ConfineDeps } | undefined;

	constructor(options: ConstructorParameters<typeof ShellEnv>[0], lookup: (cwd: string) => { ws: string; confine: Confine; deps: ConfineDeps } | undefined) { super(options); this.lookup = lookup; }

	override async exec(command: Parameters<ShellEnv["exec"]>[0], options: Parameters<ShellEnv["exec"]>[1], context: Parameters<ShellEnv["exec"]>[2]): Promise<Result<ShellExecResult, ExecutionError>> {
		if (typeof command !== "string") return super.exec(command, options, context);
		const cwd = resolve(this.cwd, options?.cwd ?? ".");
		const w = this.lookup(cwd);
		if (w === undefined || w.confine.name !== "bubblewrap") return super.exec(command, options, context);
		const bytes = Buffer.byteLength(command);
		if (command.includes("\0") || bytes > COMMAND_MAX) return err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", command.includes("\0") ? "this command holds a NUL byte, which a confined shell cannot take; write it to a script file in the Workspace and run that" : `this command is too long for a confined shell (${bytes} bytes, limit 128 KiB); write it to a script file in the Workspace and run that`));
		const { args } = bwrapArgs(w.deps, { ws: w.ws, cwd, net: w.confine.net !== false, path: options?.env?.PATH ?? "" }, ["bash", "-c", command]);
		const result = await super.exec([w.confine.bwrap!, ...args], options, context);
		return !result.ok && result.error.code === "spawn_error" ? err<ShellExecResult, ExecutionError>(new ExecutionError("spawn_error", `confinement backend unavailable: ${result.error.message}`, result.error)) : result;
	}
}

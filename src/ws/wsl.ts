import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { err, ExecutionError, ok, type Result, type ShellExecResult } from "@earendil-works/pi-durable/env";
import type { ShellEnv } from "../durable.ts";
import { sgrStripper } from "../shell.ts";
import { bwrapArgs, type Confine, type ConfineDeps, seccompExec, within } from "./confine.ts";
import type { DockerConf } from "./docker.ts";

// The WSL runner and bubblewrap in WSL (P27e2). Every call is wsl.exe with an argv array, never a shell string; the pattern is LayerFS 1.1.0's
// (see NOTICE). Where a script is needed inside the distro it is a constant below and every input is a positional argument.

export interface WslRun { code: number | null; out: Buffer; err: string; timedOut: boolean }
export interface WslDeps {
	systemRoot: string;
	/** One wsl.exe call; `args` is everything after the program. A command passes `stdin` and `onData` (then `out` stays empty). Probes replace it. */
	run(args: string[], o?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal; onData?: (chunk: Buffer, stream: "stdout" | "stderr") => void }): Promise<WslRun>;
}
/** A Workspace's WSL backend, kept in the row's `confine`: the distro and user pinned at open, and the bwrap argv up to `--chdir <workspace>`. */
export interface WslConf { distro: string; user: string; ws: string; ext4: string; argv: string[]; places: string[] }
/** The distro, user and ext4 folder of a Workspace's sandbox folders (a WslConf has them, and so does a DockerConf on Windows). */
export type Remote = { distro: string; user: string; ext4: string };
export interface WslPlan { places: string[]; project: string; files: number; prev?: WslConf; prevDocker?: DockerConf }
export class SelfTestError extends Error {}

export function wslDeps(): WslDeps {
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	// Only SystemRoot, WSL_UTF8 and an empty WSLENV: nothing from the Windows environment reaches the distro.
	const env = { SystemRoot: systemRoot, WSL_UTF8: "1", WSLENV: "" };
	return { systemRoot, run: (args, o = {}) => new Promise((done) => {
		const child = spawn(win32.join(systemRoot, "System32", "wsl.exe"), args, { env, stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
		const out: Buffer[] = [];
		let errs = "";
		let timedOut = false;
		let end: NodeJS.Timeout | undefined;
		let over = false;
		const fin = (code: number | null): void => { if (over) return; over = true; clearTimeout(timer); clearTimeout(end); o.signal?.removeEventListener("abort", kill); done({ code, out: Buffer.concat(out), err: errs, timedOut }); };
		const kill = (): void => { child.kill(); };
		const timer = o.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
		o.signal?.addEventListener("abort", kill, { once: true });
		if (o.signal?.aborted) kill();
		child.stdout?.on("data", (b: Buffer) => { if (o.onData !== undefined) o.onData(b, "stdout"); else out.push(b); });
		child.stderr?.on("data", (b: Buffer) => { if (o.onData !== undefined) o.onData(b, "stderr"); else if (errs.length < 4096) errs += b.toString("utf8"); });
		child.stdin?.on("error", () => undefined);
		if (o.stdin !== undefined) child.stdin?.end(o.stdin);
		child.on("error", (e) => { errs += e.message; fin(null); });
		child.on("close", fin);
		// A descendant holding the pipes open must not keep the call waiting.
		child.on("exit", (code) => { end = setTimeout(() => fin(code), 2000); });
	}) };
}

export type Who = { distro?: string; user?: string };
export const via = (w: Who, argv: string[]): string[] => [...(w.distro === undefined ? [] : ["--distribution", w.distro]), ...(w.user === undefined ? [] : ["--user", w.user]), "--exec", ...argv];
export const posixOf = (p: string): string => p.replaceAll("\\", "/");
/** One call of a constant script; a refusal names the call, the distro or user, or what wsl.exe said. */
export async function call(d: WslDeps, w: Who, what: string, script: string, args: string[] = [], timeoutMs = 20_000): Promise<string> {
	const r = await d.run(via(w, ["sh", "-c", script, "sh", ...args]), { timeoutMs });
	if (r.timedOut) throw new Error(`${what}: wsl.exe did not answer within ${timeoutMs / 1000} s`);
	if (r.code === null && /ENOENT/u.test(r.err)) throw new Error("wsl.exe is not available on this machine");
	if (r.code === -1 || r.code === 0xFFFFFFFF) throw new Error(`distro ${w.distro ?? "(default)"} or user ${w.user ?? "(default)"} not found`);
	if (r.code !== 0) throw new Error(`${what}: exit ${r.code}${r.err === "" ? "" : ` (${r.err.trim().slice(0, 200)})`}`);
	return r.out.toString("utf8");
}

const RESOLVE = 'printf "%s\\n" "$WSL_DISTRO_NAME" "$(id -u)" "$(id -g)" "$(id -un)" "$(getent passwd "$(id -un)" | cut -d: -f6)" "$(uname -r)" "$(test -x /usr/bin/bwrap && echo 1)" "$(wslinfo --networking-mode 2>/dev/null)"; cat /proc/self/mounts';
const LOGIN = 'printf "\\001S"; printf "%s\\0" "$PATH" "${LANG:-C.UTF-8}" "$(readlink -f /etc/resolv.conf)"; printf "\\001E"';
export const WSLPATH = 'for p; do wslpath -a -u "$p" || echo; done';
const REALPATH = 'for p; do realpath -e -- "$p" 2>/dev/null || echo; done';
const PIDRUN = 'echo $$ > "$1"; shift; exec "$@"';
const KILL = 'kill -KILL "$(cat -- "$1")" 2>/dev/null; rm -f -- "$1"';
// Runs inside the sandbox: write and remove a file in the Workspace, no auth.json, a readable resolv.conf, no Windows program, no System32, nothing listed in the live project folder, then the
// node version and what each masked mount lists.
const SELF_TEST = 'm="$1/.piroboros-selftest"; : > "$m" || { echo "the Workspace is not writable"; exit 1; }; rm -f "$m"; [ ! -e "$2/auth.json" ] || { echo "auth.json is visible"; exit 1; }; [ "$3" = 0 ] || [ -r /etc/resolv.conf ] || { echo "resolv.conf is not readable"; exit 1; }; command -v perl >/dev/null && { perl -e \'socket(S,40,1,0) and exit 1; exit($!+0==97?0:2)\' || { echo "an AF_VSOCK socket can be created"; exit 1; }; }; if "$4" >/dev/null 2>&1; then echo "a Windows program ran"; exit 1; fi; [ ! -e "$5" ] || { echo "the Windows System32 folder is visible"; exit 1; }; [ -z "$6" ] || [ -z "$(ls -A -- "$6" 2>/dev/null)" ] || { echo "the live project is visible"; exit 1; }; echo "node $(node --version 2>/dev/null || echo none)"; shift 6; for m; do echo "mount $m"; ls -A "$m" 2>/dev/null; done; true';
export const WRAPPER = 'IFS= read -rd "" c; exec bash -c "$c"';

export interface WslInfo { distro: string; user: string; uid: string; gid: string; home: string; net: string; mounts: string[] }

/** The distro and user (the pinned ones, or the default), refused when bubblewrap (unless `bwrap` is false, for Docker) cannot work there. Also reads the Windows-backed mounts. */
export async function resolveWsl(d: WslDeps, who: Who, bwrapNeeded = true): Promise<WslInfo> {
	const lines = (await call(d, who, "resolving the distro", RESOLVE)).split("\n");
	const [distro = "", uid = "", gid = "", user = "", home = "", kernel = "", bwrap = "", net = ""] = lines;
	if (/^docker-desktop/iu.test(distro)) throw new Error(`distro ${distro} is Docker Desktop's own and cannot run commands`);
	if (distro === "" || user === "" || home === "") throw new Error("the distro did not report its name, user and home");
	if (uid === "0") throw new Error(`the default user of ${distro} is root; set a normal default user in the distro`);
	if (!/WSL2/iu.test(kernel)) throw new Error(`${distro} runs kernel ${kernel}, which is not WSL2 (bubblewrap needs it)`);
	if (bwrapNeeded && bwrap !== "1") throw new Error(`bubblewrap is not installed in ${distro} (package bubblewrap)`);
	const unescape = (s: string): string => s.replace(/\\([0-7]{3})/gu, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
	const mounts = lines.slice(8).map((l) => l.split(" ")).filter((f) => ["9p", "drvfs", "virtiofs"].includes(f[2] ?? "")).map((f) => unescape(f[1] ?? ""));
	return { distro, user, uid, gid, home, net, mounts: ["/mnt", ...new Set(mounts)].filter((m) => m !== "") };
}

/** PATH, LANG and the resolv.conf target from the login shell; empty and relative entries and entries under a Windows-backed mount are dropped. */
async function loginValues(d: WslDeps, who: Who, mounts: string[]): Promise<{ path: string[]; lang: string; resolv: string; fallback: boolean }> {
	const parse = (r: WslRun): string[] | undefined => {
		if (r.timedOut || r.code !== 0) return undefined;
		const s = r.out.toString("utf8");
		const i = s.indexOf("\x01S");
		const j = s.lastIndexOf("\x01E");
		const f = i < 0 || j < i ? [] : s.slice(i + 2, j).split("\0");
		return f.length >= 3 ? f : undefined;
	};
	let f = parse(await d.run(via(who, ["bash", "-lc", LOGIN]), { timeoutMs: 10_000 }));
	const fallback = f === undefined;
	f ??= parse(await d.run(via(who, ["env", "LANG=C.UTF-8", "sh", "-c", LOGIN]), { timeoutMs: 10_000 }));
	if (f === undefined) throw new Error("reading PATH from the distro failed");
	return { path: (f[0] ?? "").split(":").filter((e) => e.startsWith("/") && !mounts.some((m) => within(m, e))), lang: f[1] || "C.UTF-8", resolv: f[2] ?? "", fallback };
}

/** Run `fn` until the paths it asks `real` about are all resolved in the distro (realpath -e, one call per round). */
async function settled<T>(d: WslDeps, who: Who, fn: (real: (p: string) => string | undefined) => T): Promise<T> {
	const known = new Map<string, string | undefined>();
	for (let round = 0; round < 4; round++) {
		const ask = new Set<string>();
		const out = fn((p) => { if (known.has(p)) return known.get(p); ask.add(p); return undefined; });
		if (ask.size === 0) return out;
		const lines = (await call(d, who, "resolving sandbox paths", REALPATH, [...ask])).split("\n");
		[...ask].forEach((p, i) => known.set(p, lines[i] || undefined));
	}
	throw new Error("resolving sandbox paths did not settle");
}

/**
 * Choose bubblewrap in WSL for the Workspace folder `ws` (a Windows path under `<wsRoot>/<home hash>/<id>`): resolve and pin the distro and user,
 * translate the Windows paths, create the ext4 folders, build the argv and run the self-test. A refusal throws; a failed check throws SelfTestError.
 */
export async function wslPick(s: { network: boolean; distro?: string }, d: ConfineDeps, ws: string, p: WslPlan): Promise<{ confine: Confine; label: string; notice: string[] }> {
	const w = d.wsl!;
	if (/^docker-desktop/iu.test(s.distro ?? "")) throw new Error("workspace.wsl.distro names Docker Desktop's own distro, which cannot run commands");
	let info: WslInfo;
	try { info = await resolveWsl(w, p.prev === undefined ? { distro: s.distro } : { distro: p.prev.distro, user: p.prev.user }); } catch (error) {
		if (p.prev === undefined) throw error;
		info = await resolveWsl(w, { distro: s.distro }).catch(() => { throw error; });
	}
	const who = { distro: info.distro, user: info.user };
	const notice: string[] = [];
	if (p.prev !== undefined && (p.prev.distro !== info.distro || p.prev.user !== info.user)) notice.push(`The earlier sandbox folders of this Workspace stay in ${p.prev.distro} as ${p.prev.user} at ${p.prev.ext4}; remove them there.`);
	if (win32.isAbsolute(ws) && !/^[A-Za-z]:[\\/]/u.test(ws)) throw new Error(`${ws} is not on a local Windows drive`);
	const hash = win32.basename(win32.dirname(ws));
	const selftest = win32.join(d.wsRoot, hash, "selftest");
	if (!existsSync(win32.join(selftest, "w.exe"))) { mkdirSync(selftest, { recursive: true }); copyFileSync(win32.join(w.systemRoot, "System32", "whoami.exe"), win32.join(selftest, "w.exe")); }
	const system32 = win32.join(w.systemRoot, "System32");
	const wins = [...new Set([ws, d.wsRoot, d.piroHome, ...d.deny, selftest, system32, ...(p.project === "" ? [] : [p.project])])];
	const out = (await call(w, who, "translating paths", WSLPATH, wins.map((x) => win32.resolve(x)))).split("\n");
	const to = new Map(wins.map((x, i) => [x, out[i] ?? ""]));
	const lin = (x: string): string => to.get(x) ?? "";
	if (!info.mounts.some((m) => within(m, lin(ws)))) throw new Error(`${ws} is not on a local Windows drive`);
	const login = await loginValues(w, who, info.mounts);
	const wsLin = lin(ws);
	const ext4 = `${info.home}/.local/state/piroboros-ws/${hash}/${win32.basename(ws)}`;
	const nm = p.places.map((place, i) => [`${ext4}/nm/${i}`, `${wsLin}/${place}`]);
	await call(w, who, "creating the sandbox folders", 'mkdir -p -m 0700 -- "$@"', [`${ext4}/run`, ...nm.map(([src]) => src!)]);
	const env = [["PATH", login.path.join(":")], ["HOME", info.home], ["USER", info.user], ["LOGNAME", info.user], ["LANG", login.lang], ["TMPDIR", "/tmp"], ["NO_COLOR", "1"], ["TERM", "dumb"]];
	const c = { ws: wsLin, cwd: wsLin, net: s.network, path: login.path.join(":"), project: p.project === "" ? undefined : lin(p.project), wsl: { mounts: info.mounts, nm, env, extra: [] as string[] } };
	const test = ["sh", "-c", SELF_TEST, "sh", wsLin, lin(d.piroHome), s.network ? "1" : "0", `${lin(selftest)}/w.exe`, lin(system32), c.project ?? "", ...info.mounts];
	const built = await settled(w, who, (real) => {
		const dl: ConfineDeps = { ...d, platform: "linux", home: info.home, piroHome: lin(d.piroHome), wsRoot: lin(d.wsRoot), deny: d.deny.map(lin).filter((x) => x !== ""), allowed: () => true, real, read: () => undefined };
		return { real: bwrapArgs(dl, c, []), test: bwrapArgs(dl, { ...c, wsl: { ...c.wsl, extra: [lin(selftest)] } }, test) };
	});
	const ran = await w.run(via(who, seccompExec("/usr/bin/bwrap", built.test.args)), { timeoutMs: 20_000 });
	const lines = ran.out.toString("utf8").split("\n");
	if (ran.timedOut || ran.code !== 0) throw new SelfTestError(ran.timedOut ? "the self-test did not finish within 20 s" : lines[0] || ran.err.trim().split("\n")[0] || "bwrap did not start");
	// Each masked mount may list only the first folder of a bound path inside it.
	const bound = [wsLin, lin(selftest), ...nm.map(([, dst]) => dst!), login.resolv];
	let mount = "";
	for (const line of lines.slice(1)) {
		if (line.startsWith("mount ")) { mount = line.slice(6); continue; }
		if (mount !== "" && line !== "" && !bound.some((b) => within(mount, b) && b.slice(mount.length + 1).split("/")[0] === line)) throw new SelfTestError(`${mount} lists ${line}, which is not a bind parent`);
	}
	const have = /^node (.+)$/mu.exec(ran.out.toString("utf8"))?.[1] ?? "none";
	const need = /^>=\s*(\d+\.\d+\.\d+)\s*$/u.exec(((): string => { try { return (JSON.parse(readFileSync(win32.join(p.project, "package.json"), "utf8")) as { engines?: { node?: string } }).engines?.node ?? ""; } catch { return ""; } })())?.[1];
	// ponytail: only `>=X.Y.Z` is compared; add a semver range check when a project uses another form.
	const lt = (a: string, b: string): boolean => { const x = a.replace(/^v/u, "").split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); return false; };
	if (need !== undefined && (have === "none" || lt(have, need))) notice.push(`Node in ${info.distro} is ${have}; this project needs >=${need}. Install a newer Node in the distro for npm commands.`);
	if (s.network) notice.push(`Network: on. Confined commands can reach the WSL VM's network, which includes the Windows host (${info.net === "nat" || info.net === "mirrored" ? `networking mode: ${info.net}` : "through the NAT gateway, or on Windows localhost with mirrored networking"}), and can send any file they can see.`);
	if (p.files > 1000) notice.push(`git in the sandbox reads this project through drvfs: the first git status takes about ${Math.round(p.files * 0.0057)} s, later ones about ${(0.5 + p.files * 0.0003).toFixed(1)} s.`);
	if (built.real.refused.length > 0) notice.push(`Left hidden in the sandbox because they are protected: ${built.real.refused.join(", ")}`);
	if (login.fallback) notice.push(`The login shell of ${info.distro} did not answer, so PATH comes from wsl.exe itself; put toolchain PATH lines in ~/.profile.`);
	return { confine: { name: "bubblewrap", bwrap: "/usr/bin/bwrap", net: s.network, wsl: { ...who, ws: wsLin, ext4, argv: built.real.args, places: p.places } }, label: `bubblewrap in WSL (${info.distro})`, notice };
}

/** The sandbox folders of a Workspace, removed with the Workspace (exactly the computed path, never one read from Workspace content). */
export const wslRemove = (d: WslDeps, c: Remote): Promise<string> => call(d, c, "removing the sandbox folders", 'rm -rf --one-file-system -- "$1"', [c.ext4]);

/** Remove the ids under the own home-hash folder of a distro that no open, held or conflicted Workspace names. */
export async function wslSweep(d: WslDeps, c: Remote, keep: Set<string>): Promise<void> {
	const base = posix.dirname(c.ext4);
	for (const name of (await call(d, c, "listing the sandbox folders", 'ls -1A -- "$1" 2>/dev/null || true', [base])).split("\n")) if (/^\d+$/u.test(name) && !keep.has(name)) await call(d, c, "removing a sandbox folder", 'rm -rf --one-file-system -- "$1"', [`${base}/${name}`]);
}

let seq = 0;
/** Run one command of a Workspace in the sandbox: wsl.exe with a constant argv, the command on stdin. Timeout and abort also end bwrap through its PID file. */
export async function execWsl(w: { ws: string; confine: Confine; deps: ConfineDeps }, cwd: string, command: string, options: Parameters<ShellEnv["exec"]>[1], context: Parameters<ShellEnv["exec"]>[2]): Promise<Result<ShellExecResult, ExecutionError>> {
	const c = w.confine.wsl!;
	const d = w.deps.wsl!;
	const rel = posixOf(win32.relative(w.ws, cwd));
	// The guard sets GIT_CEILING_DIRECTORIES for a plain Workspace; its value here is the Linux form of the Workspace's parent.
	const ceiling = options?.env?.GIT_CEILING_DIRECTORIES === undefined ? [] : ["--setenv", "GIT_CEILING_DIRECTORIES", posix.dirname(c.ws)];
	const pid = `${c.ext4}/run/${process.pid}-${++seq}.pid`;
	const args = via(c, ["sh", "-c", PIDRUN, "sh", pid, ...seccompExec(w.confine.bwrap!, [...c.argv.slice(0, -2), ...ceiling, "--chdir", rel === "" ? c.ws : `${c.ws}/${rel}`, "bash", "-c", WRAPPER])]);
	return wslCommand(d, args, command, options, context, async () => { await call(d, c, "ending the sandbox", KILL, [pid], 10_000).catch(() => ""); }, () => { void call(d, c, "removing the PID file", 'rm -f -- "$1"', [pid]).catch(() => ""); }, `distro ${c.distro} or user ${c.user} not found`);
}

/** One wsl.exe call whose stdin is the command (the constant wrapper reads it): output streams to the tool, `kill` runs on timeout or abort, `done` after a normal exit. */
export async function wslCommand(d: WslDeps, args: string[], command: string, options: Parameters<ShellEnv["exec"]>[1], context: Parameters<ShellEnv["exec"]>[2], kill: () => Promise<void>, done: () => void, missing: string): Promise<Result<ShellExecResult, ExecutionError>> {
	const strip = sgrStripper();
	const dec = { stdout: new TextDecoder(), stderr: new TextDecoder() };
	const emit = (text: string, stream: "stdout" | "stderr"): void => { const clean = strip.push(text, stream); if (clean !== "") options?.onOutput?.(clean, context, { stream } as never); };
	const r = await d.run(args, { stdin: command, timeoutMs: options?.timeout === undefined ? undefined : options.timeout * 1000, signal: context.abortSignal, onData: (b, stream) => emit(dec[stream].decode(b, { stream: true }), stream) });
	for (const stream of ["stdout", "stderr"] as const) { emit(dec[stream].decode(), stream); const rest = strip.flush(stream); if (rest !== "") options?.onOutput?.(rest, context, { stream } as never); }
	if (r.timedOut || context.abortSignal?.aborted) { await kill(); return err(new ExecutionError(r.timedOut ? "timeout" : "aborted", r.timedOut ? `timeout:${options?.timeout}` : "aborted")); }
	done();
	if (r.code === null || r.code === -1 || r.code === 0xFFFFFFFF) return err(new ExecutionError("spawn_error", `confinement backend unavailable: ${r.code === null ? (r.err.trim() || "wsl.exe did not start") : missing}`));
	return ok({ exitCode: r.code });
}

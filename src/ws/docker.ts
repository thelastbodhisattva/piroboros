import { mkdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import { err, ExecutionError, type Result, type ShellExecResult } from "@earendil-works/pi-durable/env";
import type { ShellEnv } from "../durable.ts";
import { type Confine, type ConfineDeps, within } from "./confine.ts";
import { call, posixOf, type Remote, resolveWsl, via, WRAPPER, WSLPATH, wslBad, wslCommand, type WslPlan } from "./wsl.ts";

// The Docker backend (P27e3): one container per Workspace, created at open and reopen, removed at merge, discard, hold and recovery. The handle is the 64-hex container ID.
// Natively the docker CLI runs as a child; on Windows it runs through the WSL runner against the distro's own Engine, never Docker Desktop. The engine's built-in seccomp
// profile is kept (it refuses AF_VSOCK sockets and io_uring); an engine without seccomp is refused and the self-test checks both blocks.

/** A Workspace's Docker backend, kept in the row's `confine`. `remote` is the distro, user and ext4 folder on Windows. */
export interface DockerConf { cli: string; config: string; container: string; image: string; net: boolean; alt: string[]; places: string[]; remote?: Remote }

const SOCK = "unix:///var/run/docker.sock";
// Runs in the container: the Workspace is writable, and (with perl) an AF_VSOCK socket cannot be created and io_uring_setup fails with EPERM.
const SELF_TEST = 'm=/work/.piroboros-selftest; : > "$m" || { echo "the Workspace is not writable"; exit 1; }; rm -f "$m"; command -v perl >/dev/null || { echo skipped; exit 0; }; perl -e \'socket(S,40,1,0) and exit 1\' || { echo "an AF_VSOCK socket can be created"; exit 1; }; perl -e \'syscall(425,0,0)==-1 && $!==1 and exit 0; exit 1\' || { echo "io_uring_setup is not blocked"; exit 1; }';

/** One docker call: `args` follow the fixed `--config <folder>` (and on Windows the fixed socket); only code constants and computed paths and IDs appear in them. */
export async function docker(d: ConfineDeps, c: DockerConf, args: string[], ms = 10_000): Promise<{ code: number | null; out: string }> {
	if (c.remote === undefined) return d.run(c.cli, ["--config", c.config, ...args], ms);
	const r = await d.wsl!.run(via(c.remote, ["/usr/bin/docker", "--config", c.config, "-H", SOCK, ...args]), { timeoutMs: ms });
	return { code: r.timedOut ? null : r.code, out: `${r.out.toString("utf8")}${r.err}` };
}

const last = (out: string): string => out.trim().split("\n").at(-1) ?? "";

/** Choose Docker for the Workspace folder `ws`: the checks, the container and its self-test. A refusal throws with the reason. */
export async function dockerPick(s: { network: boolean; distro?: string; image: string }, d: ConfineDeps, ws: string, p: WslPlan): Promise<{ confine: Confine; label: string; notice: string[]; alt: string[] }> {
	const win = d.platform === "win32";
	const P = win ? win32 : posix;
	const hash = P.basename(P.dirname(ws));
	const id = P.basename(ws);
	const notice: string[] = [];
	let host = ws;
	let alt = p.alt;
	let user: string[] = typeof process.getuid === "function" && !win ? ["--user", `${process.getuid()}:${process.getgid!()}`] : [];
	let nm: string[][] = [];
	let c: DockerConf = { cli: "", config: `${d.wsRoot}/${hash}/docker-config`, container: "", image: s.image, net: s.network, alt: p.alt, places: p.places };
	let where = "a shell";
	if (win) {
		const w = d.wsl;
		if (w === undefined) throw new Error("WSL is not available");
		const prev = p.prevDocker?.remote;
		const info = await resolveWsl(w, prev === undefined ? { distro: s.distro } : { distro: prev.distro, user: prev.user }, false).catch((error: unknown) => { if (prev === undefined) throw error; return resolveWsl(w, { distro: s.distro }, false); });
		const who = { distro: info.distro, user: info.user };
		where = `the ${info.distro} distro`;
		for (const x of [ws, ...p.alt]) if (!/^[A-Za-z]:[\\/]/u.test(x)) throw new Error(`${x} is not on a local Windows drive`);
		alt = p.alt.filter((a) => !wslBad(d, a));
		if (alt.length < p.alt.length) notice.push(`Left hidden in the sandbox because they are protected: ${p.alt.filter((a) => !alt.includes(a)).join(", ")}`);
		const lin = (await call(w, who, "translating paths", WSLPATH, [ws, ...alt].map((x) => win32.resolve(x)))).split("\n");
		for (const x of lin.slice(0, alt.length + 1)) if (!info.mounts.some((m) => within(m, x))) throw new Error(`${x} is not on a local Windows drive`);
		host = lin[0]!;
		alt = lin.slice(1, alt.length + 1);
		const base = `${info.home}/.local/state/piroboros-ws/${hash}`;
		const ext4 = `${base}/${id}`;
		nm = p.places.map((place, i) => [`${ext4}/nm/${i}`, `/work/${place}`]);
		c = { ...c, cli: "/usr/bin/docker", config: `${base}/docker-config`, remote: { ...who, ext4 } };
		user = ["--user", `${info.uid}:${info.gid}`];
		await call(w, who, "creating the Docker folders", 'mkdir -p -m 0700 -- "$@"', [c.config, ...nm.map(([src]) => src!)]);
		const [sock = "", bin = "", has = ""] = (await call(w, who, "checking the Docker socket", 'printf "%s\\n" "$(readlink -f /var/run/docker.sock)" "$(readlink -f /usr/bin/docker)" "$([ -S /var/run/docker.sock ] && echo 1)"')).split("\n");
		if (has !== "1") throw new Error(`the Docker socket /var/run/docker.sock does not exist in ${info.distro}`);
		if (bin === "" || info.mounts.some((m) => within(m, bin))) throw new Error(`/usr/bin/docker is missing in ${info.distro} or is not the distro's own`);
		if (info.mounts.some((m) => within(m, sock))) throw new Error(`the Docker socket in ${info.distro} belongs to Docker Desktop (${sock})`);
	} else {
		const cli = d.which("docker");
		if (cli === undefined) throw new Error("docker is not installed or not on PATH");
		mkdirSync(c.config, { recursive: true, mode: 0o700 });
		c = { ...c, cli };
	}
	let r = await docker(d, c, ["info", "--format", "{{.OperatingSystem}}|{{.SecurityOptions}}"]);
	if (r.code !== 0) r = await docker(d, c, ["info", "--format", "{{.OperatingSystem}}|{{.SecurityOptions}}"]);
	if (r.code !== 0) throw new Error(`docker did not answer (${last(r.out) || "no reply"})`);
	const [os = "", sec = ""] = last(r.out).split("|");
	if (/^Docker Desktop/u.test(os)) throw new Error("the engine is Docker Desktop's, which is not supported");
	if (!/seccomp/u.test(sec)) throw new Error("the engine has no seccomp, so its default profile cannot block AF_VSOCK and io_uring");
	if ((await docker(d, c, ["image", "inspect", "--format", "{{.Id}}", s.image])).code !== 0) throw new Error(`image ${s.image} is not present; run docker pull ${s.image} in ${where}`);
	if (p.prevDocker !== undefined) await docker(d, c, ["rm", "-f", p.prevDocker.container]);
	const mount = (src: string, dst: string, ro = false): string[] => {
		if (!/^[^,:"\n]+$/u.test(src)) throw new Error(`${src} holds a character a Docker mount cannot take`);
		return ["--mount", `type=bind,source=${src},target=${dst}${ro ? ",readonly" : ""}`];
	};
	const inside = alt.map((_, i) => (i === 0 ? "/piroboros-objects" : `/piroboros-objects-${i}`));
	const name = `piroboros-ws-${hash}-${id}-${Date.now().toString(36)}`;
	r = await docker(d, c, ["run", "-d", "--pull", "never", "--init", "--name", name, "--label", `piroboros.home=${hash}`, "--label", `piroboros.ws=${id}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "1024",
		"--network", s.network ? "bridge" : "none", "-e", "HOME=/tmp", ...mount(host, "/work"), ...nm.flatMap(([src, dst]) => mount(src!, dst!)), ...alt.flatMap((a, i) => mount(a, inside[i]!, true)), "-w", "/work", ...user, s.image, "sleep", "infinity"], 30_000);
	const container = /^[0-9a-f]{64}$/mu.exec(r.out)?.[0];
	if (r.code !== 0 || container === undefined) throw new Error(`docker run failed (${last(r.out) || "no container ID"})`);
	c = { ...c, container };
	try {
		const t = await docker(d, c, ["exec", container, "sh", "-c", SELF_TEST]);
		if (t.code !== 0) throw new Error(`the container self-test failed (${last(t.out) || `exit ${t.code}`})`);
		if (/^skipped$/mu.test(t.out)) notice.push("The container self-test skipped the seccomp checks: the image has no perl.");
	} catch (error) { await docker(d, c, ["rm", "-f", container]); throw error; }
	if (s.network) notice.push(win ? "Network: on. Confined commands can reach the WSL VM's network, which includes the Windows host, and can send any file they can see." : "Network: on. Confined commands can reach your network, and can send any file they can see.");
	return { confine: { name: "docker", net: s.network, docker: c }, label: c.remote === undefined ? "docker" : `docker in WSL (${c.remote.distro})`, notice, alt: inside };
}

/** Remove a Workspace's container, best effort. */
export const dockerRemove = (d: ConfineDeps, c: DockerConf): Promise<unknown> => docker(d, c, ["rm", "-f", c.container]);

/** Remove every container of this home hash whose Workspace id is not open in this store; another home's containers carry another hash and are never listed. */
export async function dockerSweep(d: ConfineDeps, c: DockerConf, hash: string, open: Set<string>): Promise<void> {
	const r = await docker(d, c, ["ps", "-a", "--no-trunc", "--filter", `label=piroboros.home=${hash}`, "--format", "{{.ID}}|{{.Labels}}"]);
	for (const line of r.out.split("\n")) {
		const [cid = "", labels = ""] = line.trim().split("|");
		if (/^[0-9a-f]{64}$/u.test(cid) && !open.has(/piroboros\.ws=(\d+)/u.exec(labels)?.[1] ?? "")) await docker(d, c, ["rm", "-f", cid]);
	}
}

/** One command in the container: natively `docker exec` as a child (names only in argv, values in the CLI's own environment), on Windows through the runner with the command on stdin. */
export async function execDocker(w: { ws: string; confine: Confine; deps: ConfineDeps }, cwd: string, command: string, options: Parameters<ShellEnv["exec"]>[1], context: Parameters<ShellEnv["exec"]>[2], run: (argv: string[], o: Parameters<ShellEnv["exec"]>[1]) => Promise<Result<ShellExecResult, ExecutionError>>): Promise<Result<ShellExecResult, ExecutionError>> {
	const c = w.confine.docker!;
	const rel = c.remote === undefined ? posix.relative(w.ws, cwd) : posixOf(win32.relative(w.ws, cwd));
	const wd = rel === "" ? "/work" : `/work/${rel}`;
	// A plain Workspace's ceiling is the container root, whatever the host guard computed.
	const ceiling = options?.env?.GIT_CEILING_DIRECTORIES !== undefined;
	const stop = async (): Promise<void> => { await docker(w.deps, c, ["restart", "-t", "0", c.container]); };
	let result: Result<ShellExecResult, ExecutionError>;
	if (c.remote === undefined) {
		const env = { ...options?.env, ...(ceiling ? { GIT_CEILING_DIRECTORIES: "/" } : {}) };
		const names = Object.keys(env).filter((n) => !["PATH", "HOME", "TMPDIR"].includes(n));
		result = await run([c.cli, "--config", c.config, "exec", "-w", wd, ...names.flatMap((n) => ["-e", n]), c.container, "bash", "-c", command], { ...options, env });
		if (!result.ok && (result.error.code === "timeout" || result.error.code === "aborted")) await stop();
	} else {
		const args = via(c.remote, ["/usr/bin/env", "NO_COLOR=1", "TERM=dumb", "LANG=C.UTF-8", ...(ceiling ? ["GIT_CEILING_DIRECTORIES=/"] : []), "/usr/bin/docker", "--config", c.config, "-H", SOCK, "exec", "-i", "-w", wd,
			"-e", "NO_COLOR", "-e", "TERM", "-e", "LANG", ...(ceiling ? ["-e", "GIT_CEILING_DIRECTORIES"] : []), c.container, "bash", "-c", WRAPPER]);
		result = await wslCommand(w.deps.wsl!, args, command, options, context, stop, () => undefined, `distro ${c.remote.distro} or user ${c.remote.user} not found`);
	}
	// ponytail: one extra inspect (about 0.6 s) per failing command; narrow it by exit code if that cost shows up.
	if (!result.ok || result.value.exitCode === 0) return result;
	const r = await docker(w.deps, c, ["inspect", "--format", "{{.State.Running}}", c.container]);
	return last(r.out) === "true" && r.code === 0 ? result : err(new ExecutionError("spawn_error", `confinement backend unavailable: ${r.code === 0 ? "the container is not running" : last(r.out) || "docker did not answer"}`));
}

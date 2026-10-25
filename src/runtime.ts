import { readFileSync } from "node:fs";
import { FileCredentialStore } from "./auth.ts";
import { createBase } from "./base.ts";
import {
	checkIntegrity, compactorStatus, describeIntegrity, ensureHome, getDeviceId, homePaths, isModelRef, profileDir, mergeSettings, readSettings, recordIntegrity, recordUnrecorded, reloadChanges, splitModelRef, unsetSettings, withDefaults,
	type HomePaths, type IntegrityReport, type Settings, type SettingsChange,
} from "./config.ts";
import type { SetupEnv } from "./setup.ts";
import { configure, createRegistry, ctx, defineExtension, onSessionFailed, openHarness, parkedTasks, ROOT, SessionFailed, type Conversation, type Extension, type HarnessType, type ReportInfo, type Storage, type ToolExecutionApi } from "./durable.ts";
import { openTelemetry, type Telemetry } from "./telemetry.ts";
import { MemoryHost, type MemoryStatus } from "./memory/host.ts";
import { createAkashicTool } from "./memory/akashic/tools.ts";
import { createMnemosiaTools } from "./memory/mnemosia/tools.ts";
import type { VaultChildRunner } from "./memory/akashic/vault.ts";
import { checkAllowEntries, checkRead, conversationsWithoutGuardFirst, createGuard, type Guard, type GuardConfig, type PipelineState } from "./guard.ts";
import { createSearch, type Search, type SearchDeps } from "./search.ts";
import { ConfinedShellEnv } from "./ws/confine.ts";
import { findBash } from "./shell.ts";
import { Workspaces, type WsOptions } from "./ws/workspace.ts";
import { isInside, canonicalize } from "./paths.ts";
import { join } from "node:path";
import { createSkills, type Skills } from "./skills.ts";
import { contextCheck, createAppModels, resolveModel, type CustomProviders, type Models, type Provider } from "./models.ts";
import { CompactLoop } from "./chat/compactloop.ts";
import { Compactor } from "./chat/compactor.ts";
import { Learner, LearnLoop, type LearnDeps } from "./learn.ts";
import { budget, chat, createStuck, planning, viewtools } from "./chat/extension.ts";
import { checkMappingVersion } from "./chat/log.ts";
import { TurnLoop, enqueueMessage, type TurnStatus } from "./chat/turn.ts";
import { TurnStateDoc } from "./chat/tree.ts";
import { ensureRun } from "./undo.ts";
import { Conclave, ConclaveDoc, MemberWatch, feedWatch, type ConclaveDeps } from "./conclave/pipeline.ts";
import { createWeb, createWebSearch, searchKey, type SearchProvider, type WebDeps } from "./web.ts";
import { ThinkingState } from "./tui/thinking/state.ts";
import type { ThinkingStepsMode } from "./tui/thinking/types.ts";

// Composition root: the credential store, models, guard, harness, root conversation and turn loop.

/** The root stops when its run shows no output and no running tool for this long (the provider SDK stops its own timer once headers arrive). */
export const ROOT_IDLE_TIMEOUT_MS = 600_000;
export const idleStopText = (ms: number): string => `stopped (idle): no output for ${Math.round(ms / 1000)} s.`;

export interface RuntimeOptions {
	home: string;
	/** In-memory storage when false (tests). Default true: ${home}/chat.sqlite. */
	persistent?: boolean;
	/** Test seam: a ready durable storage, used instead of the file or memory one. */
	storage?: Storage;
	models?: Models;
	extraProviders?: readonly Provider[];
	/** models.json handle; /reload re-reads it together with settings.json. */
	customProviders?: CustomProviders;
	cwd?: string;
	profile?: string;
	/** Use this model for this run only; nothing is written. */
	main?: string;
	/** Start the turn loop (default true). Restart tests open without it. */
	autostart?: boolean;
	pipeline?: () => Promise<PipelineState | undefined>;
	onReport?: (message: string) => void;
	onStatus?: (status: TurnStatus) => void;
	onRestore?: (text: string, ids: string[]) => void;
	env?: NodeJS.ProcessEnv;
	/** Test seams for find and grep: the fff loader and the rg program. */
	search?: Pick<SearchDeps, "loadFff" | "rg" | "holderBuilt">;
	/** Test seams for Workspaces: where they live, the fs dependency, the clock, waits and a spy on git calls. */
	workspace?: Pick<WsOptions, "wsRoot" | "fs" | "now" | "platform" | "sleep" | "gitSpy" | "confineDeps">;
	/** Test seams for the Conclave: the definitions to load and a hook that runs at the start of each phase. */
	conclave?: Pick<ConclaveDeps, "definitions" | "beforePhase">;
	/** Test seams for the learning loop: a hook at the start of each phase and the request timeout. */
	learn?: Pick<LearnDeps, "beforePhase" | "requestTimeoutMs">;
	/** Test seam: waits after a compactor provider error, in milliseconds (default 1,000, 2,000). */
	compactorBackoffMs?: readonly number[];
	/** Test seam: the compactor request timeout in milliseconds (default 300,000). */
	compactorTimeoutMs?: number;
	/** Test seam: the root idle watchdog in milliseconds (default ROOT_IDLE_TIMEOUT_MS). */
	rootIdleTimeoutMs?: number;
	/** Test seam: replaces the git and gh child processes of the vault mirror. */
	vaultRunner?: VaultChildRunner;
	/** Test seams for web_fetch: the DNS lookup and the loopback stub. Nothing in settings.json reaches them. */
	web?: Pick<WebDeps, "resolve" | "testing" | "now">;
}

export interface Runtime {
	paths: HomePaths;
	models: Models;
	harness: HarnessType;
	root: Conversation;
	loop: TurnLoop;
	/** BuildNode tasks, the gate and the compactor's status. */
	compactor: Compactor;
	/** /learn: the learning loop's passes, proposals and ledger. */
	learner: Learner;
	guard: Guard;
	/** Vesperia's Workspaces and their store. */
	workspaces: Workspaces;
	/** /conclave: start, approve, cancel, status. */
	conclave: Conclave;
	/** find and grep; the fff index is destroyed by close(). */
	search: Search;
	/** The skills index, the project trust question and /reload's rescan. */
	skills: Skills;
	/** The akashic store, the vault mirror and the briefing sources. Closed by close(). */
	memory: MemoryHost;
	/** What the status line shows about memory: pending vault sync, quarantined and proposed counts. */
	memoryStatus(): MemoryStatus;
	/** /akashic ...: the reply text. */
	akashic(args: string): Promise<string>;
	settings(): Settings;
	/** The thinking panel: session mode, the global setting behind it and the step memo (D23). */
	thinking: ThinkingState;
	/** Config integrity as found at startup (F5). */
	integrity: IntegrityReport;
	acceptIntegrity(): void;
	/**
	 * Re-read and validate settings.json and models.json; keep the previous configuration on error. Files that
	 * changed since piroboros last wrote them are shown to `confirm` before anything is applied or recorded. Without
	 * a `confirm` function a changed file is declined.
	 */
	reload(confirm?: (changes: string) => Promise<boolean>): Promise<{ ok: true; warnings?: string[] } | { ok: false; error: string; declined?: true }>;
	/**
	 * The settings write path for the chat: the checked write (config.ts), then the live settings, then a loop wake.
	 * `note` says when a change only applies at the next start.
	 */
	updateSettings(change: SettingsChange): { ok: true; note?: string } | { ok: false; error: string };
	/** settings.json as piroboros last read or wrote it: the same as settings() without a --model override. */
	stored(): Settings;
	/** What the sign-in and model pickers need, for /login and /settings. */
	setupEnv(): SetupEnv;
	/** The checks /model makes before it writes. */
	checkMain(ref: string): { ok: true } | { ok: false; error: string };
	/** /model: validate, write the merged setting; it applies at the next turn commit. */
	setMain(ref: string): { ok: true } | { ok: false; error: string };
	send(text: string): Promise<string>;
	/** /telemetry: model requests of the last 24 hours. */
	telemetry(): Promise<string>;
	/** Resolves once, with the storage error, if the durable session fails. Never rejects, and never resolves after a normal close(). */
	fatal: Promise<unknown>;
	close(): Promise<void>;
}

function reportMessage(error: unknown, info?: ReportInfo): string {
	const text = error instanceof Error ? error.message : String(error);
	const source = info === undefined ? undefined : "task" in info && info.task !== undefined ? info.task.kind : "extension" in info ? info.extension : undefined;
	return source === undefined ? text : `${source}: ${text}`;
}

const pausedText = (n: number): string => `${n === 1 ? "1 task" : `${n} tasks`} stopped without finishing on several starts in a row and ${n === 1 ? "is" : "are"} paused: Esc stops a paused reply, /conclave cancel a paused pipeline`;

export async function openRuntime(options: RuntimeOptions): Promise<Runtime> {
	const paths = homePaths(options.home);
	// A storage error fails the whole session (pi-durable 1.2.0). Reports once the session is closing are noise.
	let failed = false;
	let fail: (error: unknown) => void = () => {};
	const fatal = new Promise<unknown>((resolve) => { fail = resolve; });
	const report = (message: string): void => { if (!failed) options.onReport?.(message); };
	ensureHome(options.home, options.env);
	recordUnrecorded(options.home);
	const integrity = checkIntegrity(options.home);
	const store = new FileCredentialStore(paths.auth, paths.authLock, report);
	const models = options.models ?? createAppModels(store, options.extraProviders);
	let settings = readSettings(options.home);
	const cwd = options.cwd ?? process.cwd();
	const effective = (): Settings => (options.main === undefined ? settings : { ...settings, main: options.main });
	const thinking = new ThinkingState({
		global: () => withDefaults(settings).thinkingSteps as ThinkingStepsMode,
		write: (value) => { applySettings(value === "clear" ? { unset: "tui.thinkingSteps" } : { set: { tui: { thinkingSteps: value } } }); },
	});
	const PLANNING_NOTE = "planning applies at the next start, because the tool list stays fixed while piroboros runs";
	// Throws on a refused or invalid write. `planningOn` and `loop` are set by the time a chat command calls this.
	const applySettings = (change: SettingsChange): string | undefined => {
		const profile = options.profile ?? profileDir();
		settings = "unset" in change ? unsetSettings(options.home, change.unset, profile) : mergeSettings(options.home, change.set, profile);
		// A new global thinking-steps value replaces the session choice, so it shows at once.
		if ("unset" in change ? change.unset === "tui.thinkingSteps" : change.set.tui?.thinkingSteps !== undefined) thinking.clearSession();
		loop.wake();
		learnLoop.wake();
		return withDefaults(settings).planning !== planningOn ? PLANNING_NOTE : undefined;
	};
	const checkMain: Runtime["checkMain"] = (ref) => {
		if (!isModelRef(ref)) return { ok: false, error: 'the model must be written as "provider/model"' };
		const model = resolveModel(models, ref);
		if (model === undefined) return { ok: false, error: `unknown model ${ref}` };
		const check = contextCheck(model, "main");
		return check.ok ? { ok: true } : { ok: false, error: check.reason ?? "model rejected" };
	};
	const update: Runtime["updateSettings"] = (change) => {
		try {
			const note = applySettings(change);
			return { ok: true, ...(note === undefined ? {} : { note }) };
		} catch (error) {
			return { ok: false, error: reportMessage(error) };
		}
	};

	const allowWarned = new Set<string>();
	const guardConfig = (): GuardConfig => {
		const d = withDefaults(settings);
		return { home: options.home, profile: options.profile ?? profileDir(), deny: d.guardDeny, allow: d.guardAllow, warn: (message) => { if (!allowWarned.has(message)) { allowWarned.add(message); options.onStatus?.({ kind: "notice", message }); } }, shellTimeoutMs: d.shellTimeoutMs, shellEnvAllow: d.shellEnvAllow };
	};
	const notice = (message: string): void => options.onStatus?.({ kind: "notice", message });
	const workspaces = new Workspaces({
		home: options.home, guard: guardConfig, notice, ...options.workspace,
		settings: () => { const w = withDefaults(settings).workspace; return { enabled: w.enabled, nested: w.nested, confine: w.confine, network: w.network, wslDistro: w.wsl?.distro, dockerImage: w.docker?.image }; },
	});
	// F7: liveness comes from the pipeline task through the harness (isTaskLive). F3: the turn's origin is read from the turn state.
	const guard = createGuard({
		config: guardConfig,
		workspace: { has: (c) => workspaces.has(c), after: (c, t, p, cwd) => workspaces.after(c, t, p, cwd), ceiling: (cwd) => workspaces.ceilingFor(cwd) },
		pipeline: options.pipeline ?? (() => conclave.pipelineState()),
		reportOnly: async () => (await harness.snapshot(TurnStateDoc, ctx))?.reportOnly === true,
		warn: (message) => options.onStatus?.({ kind: "notice", message }),
	});
	checkAllowEntries(guardConfig());
	const search = createSearch({ home: options.home, guard: guardConfig, inWorkspace: (cwd) => { try { return isInside(join(workspaces.wsRoot, workspaces.hash), canonicalize(cwd)); } catch { return false; } }, ...(options.search ?? {}) });
	const base: Extension = createBase([...guard.tools(), ...search.tools]);
	// Skills are scanned once here and again on /reload. A skill file is opened only if the guard would let the read tool open it.
	// Under node --test without an explicit profile the real profile is never scanned (tests must not read the user's own skills).
	const skillsProfile = options.profile ?? (process.env.NODE_TEST_CONTEXT !== undefined || process.env.PIROBOROS_TEST === "1" ? undefined : profileDir());
	const skills = createSkills({ home: options.home, profile: skillsProfile, cwd, allow: (path) => checkRead(path, cwd, guardConfig()).allowed });
	// Memory: the store and vault under ${home}/akashic, briefing traces under ${home}/mnemosia. The tools tell the
	// callers apart through the Conclave doc (a member's role) and the turn state (a report-only turn, F3).
	const memory = new MemoryHost({ home: options.home, warn: (message) => options.onStatus?.({ kind: "notice", message }), runner: options.vaultRunner });
	const caller = async (api: ToolExecutionApi) => {
		const conversation = api.conversationId as number;
		const members = (await api.snapshot(ConclaveDoc, ctx))?.runs ?? {};
		const role = Object.entries(members).find(([, id]) => id === conversation)?.[0] ?? "root";
		// Vesperia's records wait for /akashic accept, like writes made in a report-only turn.
		const reportOnly = role === "vesperia" || (conversation === (ROOT as number) && (await api.snapshot(TurnStateDoc, ctx))?.reportOnly === true);
		// A cwd (or explicit project) inside a Workspace folder is the live project it copies.
		const there = (await api.agent(ctx)).cwd ?? cwd;
		return { role, cwd: workspaces.projectOf(there) ?? there, reportOnly, project: (path: string) => workspaces.projectOf(path) ?? path };
	};
	const mnemosia = createMnemosiaTools(memory.foundations, caller);
	// Tools only, no hooks and no sections, so where it sits changes the order of the tool list and nothing else.
	const memoryExtension: Extension = defineExtension({ name: "memory", tools: [createAkashicTool(memory, caller), mnemosia.brief, mnemosia.feedback] });
	// H3: the hook names the reason and asks for the stop; the abort runs unawaited, because it waits for the
	// round that is still finishing. The turn loop takes the reason when the aborted run settles.
	let stopReason: string | undefined;
	// A Conclave member that gets stuck is aborted the same way; the pipeline finds the stop in the member's entries and posts FAILED (stuck).
	const stopRun = (id: number, message: string): void => {
		if (id === (ROOT as number)) stopReason = message;
		void harness.conversation(id as never, ctx).then((conversation) => conversation?.abort(ctx)).catch((error: unknown) => { if (id === (ROOT as number)) stopReason = undefined; report(reportMessage(error)); });
	};
	const stuck = createStuck(stopRun);
	const readInstructions = (): string | undefined => {
		try {
			const text = readFileSync(paths.instructions, "utf8").replace(/^\u{FEFF}/u, "").trim();
			return text === "" ? undefined : text;
		} catch {
			return undefined;
		}
	};
	const compactor = new Compactor({ settings: effective, models, authPath: paths.auth, env: options.env ?? process.env, instructions: readInstructions, ...(options.compactorBackoffMs === undefined ? {} : { backoffMs: options.compactorBackoffMs }), ...(options.compactorTimeoutMs === undefined ? {} : { requestTimeoutMs: options.compactorTimeoutMs }) });
	// The learner reads the chat and the skills, and writes memories as QUARANTINED; its task lives in the registry only.
	const learner = new Learner({ home: options.home, cwd, settings: effective, models, compactor, memory, skills, notice: (message) => options.onStatus?.({ kind: "notice", message }), ...options.learn });
	const registry = createRegistry();
	// web_fetch lives in its own extension, which the root never selects. The tool also checks the caller's seat and web.enabled itself.
	const webKey = (provider: SearchProvider): string | undefined => searchKey(provider, paths.auth, options.env ?? process.env);
	// The URLs a Vaelia run may open at the start: the task and the reports posted before her seat (the chat view is not used).
	const webSeed = async (api: ToolExecutionApi): Promise<string[]> => {
		const doc = await api.snapshot(ConclaveDoc, ctx);
		return doc === undefined ? [] : [doc.task, ...doc.review.reports.map((report) => report.text)];
	};
	const webDeps: WebDeps = { caller, seed: webSeed, settings: () => withDefaults(settings).web, scrub: () => compactor.scrubFor(true), searchKey: webKey, ...options.web };
	const webExtension: Extension = defineExtension({
		name: "web",
		tools: [createWeb(webDeps), createWebSearch(webDeps)],
	});
	const conclave = new Conclave({
		settings: effective,
		models,
		registry,
		cwd,
		...options.conclave,
		scrub: () => compactor.scrubFor(false),
		webKey,
		onNotice: (message) => options.onStatus?.({ kind: "notice", message }),
		onVesperia: (run) => { ensureRun(options.home, run); },
		workspaces,
	});
	// The compactor and conclave extensions carry only their tasks, which any conversation's tasks resolve by name.
	for (const extension of [guard.extension, base, viewtools, planning, memoryExtension, webExtension, stuck, chat, skills.extension, budget, compactor.extension, learner.extension, conclave.extension]) registry.install(extension);
	// D12: the root selects the chat extensions explicitly, and the budget extension is last everywhere. The plan
	// tool is part of the selection unless settings.planning is false; that is read at start, so the tool list
	// stays the same for the life of the process. The memory extension follows the other tool extensions: it has
	// no hooks and no sections, so its place only orders the tool list, and stuck, chat and budget keep theirs.
	// The skills section is the last static section: after chat, before budget. It renders nothing without skills.
	const planningOn = withDefaults(settings).planning;
	const rootExtensions = [guard.extension, base, viewtools, ...(planningOn ? [planning] : []), memoryExtension, stuck, chat, skills.extension, budget];

	// Merge records a crash left are rolled back or finished before the scheduler can replay any run (the home lock is held).
	for (const line of await workspaces.recover().catch((error: unknown) => [`workspace recovery: ${reportMessage(error)}`])) notice(line);
	// A failure to open the store turns telemetry off, visibly; the run goes on without it.
	let telemetry: Telemetry | undefined;
	if (withDefaults(settings).telemetry) {
		try { telemetry = await openTelemetry(paths.telemetry); } catch (error) { report(`telemetry off: ${reportMessage(error)}`); }
	}
	const harness = await openHarness({
		path: options.persistent === false ? undefined : paths.chat,
		storage: options.storage,
		telemetry: telemetry?.recorder,
		models,
		identity: { attribution: null },
		registry,
		settings: {
			extensions: [guard.extension, base, viewtools, budget], steeringMode: "all", followUpMode: "all", compaction: { enabled: false, backgroundTokens: 0 },
			// A getter: pi-durable reads it at every request, so /reload applies a changed cacheRetention at the next turn.
			get stream() { return { cacheRetention: withDefaults(effective()).cacheRetention }; },
		},
		env: (cwd) => new ConfinedShellEnv({ cwd: cwd ?? process.cwd(), shellPath: findBash() }, (c) => workspaces.shellFor(c)),
		onReport: (error, info) => { if (info.type !== "task_parked") report(reportMessage(error, info)); },
	}).catch(async (error: unknown) => {
		await telemetry?.close().catch(() => undefined);
		memory.close();
		throw error;
	});
	// The session starts closing the moment storage throws, before the failing call's error reaches its caller.
	harness.subscribeClose(() => { failed = true; });
	onSessionFailed(harness, fail);
	guard.bindHarness(harness);
	compactor.bind(harness);
	conclave.bind(harness);

	const agent = (() => {
		const main = effective().main !== undefined && isModelRef(effective().main as string) ? splitModelRef(effective().main as string) : undefined;
		return { extensions: rootExtensions, cwd, ...(main ? { model: { provider: main.provider, modelId: main.modelId } } : {}) };
	})();
	let root: Conversation;
	try {
		await checkMappingVersion(harness, [guard.extension, base, viewtools, planning, memoryExtension, stuck, chat, skills.extension, budget].map((e) => e.name)); // a stored index from another mapping is never remapped
		root = await harness.root(ctx, { agent });
		// Every stored selection must list guard first. The root is repaired; anything else is refused. Any other
		// difference between the stored root selection and the code's is migrated by the first turn commit (turn.ts).
		const offenders = await conversationsWithoutGuardFirst(harness);
		for (const id of offenders) {
			if (id !== (ROOT as number)) throw new Error(`conversation ${id} does not select the guard first; refusing to open`);
		}
		if (offenders.length > 0) await root.configure({ extensions: rootExtensions }, ctx);
	} catch (error) {
		await harness.close(ctx);
		await telemetry?.close().catch(() => undefined);
		memory.close();
		throw error;
	}
	learner.bind(harness, root);
	harness.resume();
	// Root idle watchdog: a MemberWatch fed by the root's commits. Its timer runs only while a run is in progress.
	const idleMs = options.rootIdleTimeoutMs ?? ROOT_IDLE_TIMEOUT_MS;
	const rootWatch = new MemberWatch({ maxTurns: Infinity, idleTimeoutMs: idleMs }, () => stopRun(ROOT as number, idleStopText(idleMs)));
	let idleTimer: NodeJS.Timeout | undefined;
	const unwatch = feedWatch(harness, ROOT as number, rootWatch, (running) => {
		if (!running) { clearInterval(idleTimer); idleTimer = undefined; stuck.endRun(); } else if (idleTimer === undefined) {
			rootWatch.reason = undefined; // one watch serves every run
			rootWatch.activity(); // the tool state was just set from this same change
			idleTimer = setInterval(() => rootWatch.tick(), Math.max(10, Math.min(250, idleMs / 4)));
			idleTimer.unref();
		}
	});
	// pi-durable resumes a live pipeline by itself. Say so, and forget one that ended while piroboros was closed.
	await conclave.recover().catch((error: unknown) => report(reportMessage(error)));
	const parked = await parkedTasks(harness);
	// Workspace state rules: an `open` Workspace of an ended or parked task is held, and a parked task of a finished Workspace is ended.
	const wsStart = await workspaces.startup(parked.filter((t) => t.kind === "piroboros.conclave").map((t) => String(t.id))).catch((error: unknown) => { report(reportMessage(error)); return { abort: [] as string[] }; });
	for (const id of wsStart.abort) await harness.abortTask((/^\d+$/u.test(id) ? Number(id) : id) as never, ctx).catch(() => undefined);
	if (parked.length > 0) options.onStatus?.({ kind: "notice", message: pausedText(parked.length) });

	const compact = new CompactLoop({ harness, root, compactor, onAlarm: (text) => report(`alarm: ${text}`), onReport: (error) => report(reportMessage(error)) });
	const learnLoop = new LearnLoop({ harness, learner, onReport: (error) => report(reportMessage(error)) });
	const loop = new TurnLoop({
		harness,
		root,
		models,
		settings: () => ({ main: effective().main, thinking: withDefaults(settings).thinking, cwd }),
		onStatus: options.onStatus,
		onRestore: options.onRestore,
		onReport: (error) => report(reportMessage(error)),
		takeStop: () => { const reason = stopReason; stopReason = undefined; return reason; },
		index: compact,
		compactor: () => compactor.state().label,
		gate: (T, signal) => compactor.gate(T, signal),
		instructions: readInstructions,
		holdReports: () => conclave.live(),
		// One chat runs for the life of the process, so the briefing breaker is reset at each turn instead of at a session start.
		memory: (turnCwd) => { mnemosia.newSession(); return memory.snapshot(turnCwd); },
		selection: rootExtensions,
	});
	if (options.autostart !== false) {
		compact.start();
		learnLoop.start();
		loop.start();
	}

	return {
		paths,
		models,
		harness,
		root,
		loop,
		compactor,
		learner,
		guard,
		workspaces,
		conclave,
		search,
		skills,
		memory,
		memoryStatus: () => memory.status(),
		akashic: (args) => memory.command(args, cwd),
		settings: effective,
		thinking,
		integrity,
		acceptIntegrity: () => recordIntegrity(options.home),
		async reload(confirm) {
			try {
				// Both files are validated before either is applied. A file that no longer matches the hash piroboros
				// recorded is shown to the user first; the new hash is recorded only after they confirm (F5).
				const next = readSettings(options.home);
				const checked = options.customProviders?.check();
				if (checked?.ok === false) return { ok: false, error: checked.error };
				const changes = reloadChanges(options.home);
				if (changes.tampered) {
					const summary = describeIntegrity(changes);
					if (!confirm || !(await confirm(summary))) return { ok: false, declined: true, error: `config files changed outside piroboros, so nothing was reloaded:\n${summary}` };
				}
				const custom = options.customProviders?.reload();
				if (custom?.ok === false) return { ok: false, error: custom.error };
				if (withDefaults(next).thinkingSteps !== withDefaults(settings).thinkingSteps) thinking.clearSession();
				settings = next;
				if (changes.tampered) recordIntegrity(options.home);
				loop.wake();
				learnLoop.wake();
				const warnings = [...(custom?.ok && custom.warnings ? custom.warnings : []), ...(withDefaults(next).planning !== planningOn ? [PLANNING_NOTE] : [])];
				return { ok: true, ...(warnings.length > 0 ? { warnings } : {}) };
			} catch (error) {
				return { ok: false, error: reportMessage(error) };
			}
		},
		updateSettings: update,
		stored: () => settings,
		setupEnv: () => ({ home: options.home, models, store, deviceId: deviceIdFor(options.home), existing: settings, env: options.env ?? process.env, ...(options.customProviders === undefined ? {} : { custom: options.customProviders }) }),
		checkMain,
		setMain(ref) {
			const checked = checkMain(ref);
			if (!checked.ok) return checked;
			const result = update({ set: { main: ref } });
			return result.ok ? { ok: true } : result;
		},
		send: async (text) => {
			try {
				return await enqueueMessage(harness, text);
			} catch (error) {
				// The call that hits a storage error rejects with the raw error while the session closes. Callers expect SessionFailed.
				if (failed && !(error instanceof SessionFailed)) {
					const end = await harness.closed;
					if (end.reason === "failed") throw new SessionFailed(end.error);
				}
				throw error;
			}
		},
		telemetry: async () => (telemetry === undefined ? "telemetry is off; /settings telemetry turns it on at the next start" : telemetry.summary()),
		fatal,
		async close() {
			// Every step runs even when an earlier one throws; the errors are reported together.
			const errors: unknown[] = [];
			const step = async (run: () => unknown): Promise<void> => {
				try { await run(); } catch (error) { errors.push(error); }
			};
			await step(() => { unwatch(); clearInterval(idleTimer); idleTimer = undefined; });
			await step(() => loop.stop());
			await step(() => compact.stop());
			await step(() => learnLoop.stop());
			await step(() => search.close());
			await step(() => harness.close(ctx));
			await step(() => workspaces.close());
			await step(() => telemetry?.close());
			// Flush the briefing traces, then close the store. The tools can no longer run.
			await step(() => mnemosia.close());
			await step(() => memory.close());
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "close failed in more than one step");
		},
	};
}

export function deviceIdFor(home: string): () => string {
	return () => getDeviceId(home);
}

export { compactorStatus, configure };

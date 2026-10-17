// Ported from akashic-forge/index.ts @ f0a8ad4 (MIT; see NOTICE)
// The memory wiring for one piroboros home: the akashic store, the vault mirror, the briefing sources and the
// /akashic commands, which are adapted from the source's command. Everything lives under ${home}/akashic and ${home}/mnemosia.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createMemoryApi, type MemoryApi } from "./akashic/api.ts";
import { renderMemorySnapshot } from "./akashic/snapshot.ts";
import { AkashicStore, type MemoryRecord, type MemoryState } from "./akashic/store.ts";
import { VaultError, VaultManager, type VaultChildRunner, type VaultFailure } from "./akashic/vault.ts";
import { mnemosiaPaths, openFoundations, type Foundations } from "./mnemosia/open.ts";

export interface MemoryPaths {
	db: string;
	limits: string;
	vaultConfig: string;
	vaultClone: string;
}

export const memoryPaths = (home: string): MemoryPaths => ({ db: join(home, "akashic", "memory.sqlite"), limits: join(home, "akashic", "limits.json"), vaultConfig: join(home, "akashic", "vault.json"), vaultClone: join(home, "akashic", "vault") });

export interface MemoryNote {
	hash: string;
	ids: string[];
	content: string;
}

export interface MemoryStatus {
	memories: number;
	vaultConfigured: boolean;
	pendingSync: boolean;
	/** Written in a report-only turn; out of the snapshot until /akashic accept. */
	quarantined: number;
	/** Imported from the vault; out of the snapshot until /akashic vault accept. */
	proposed: number;
}

export interface MemoryHostOptions {
	home: string;
	/** Receives what the vault code would have sent to the console. */
	warn?: (message: string) => void;
	/** Test seam: replaces the git and gh child processes. */
	runner?: VaultChildRunner;
}

const failureText = (failure: VaultFailure): string => `${failure.code}: ${failure.reason}`;
const describe = (error: unknown): string => (error instanceof VaultError && error.code !== undefined ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));

export class MemoryHost {
	readonly paths: MemoryPaths;
	readonly store: AkashicStore;
	readonly api: MemoryApi;
	readonly vault: VaultManager;
	readonly foundations: Foundations;
	private readonly warn: (message: string) => void;

	constructor(options: MemoryHostOptions) {
		this.paths = memoryPaths(options.home);
		this.warn = options.warn ?? (() => {});
		this.store = new AkashicStore(this.paths.db, this.paths.limits);
		this.api = createMemoryApi(this.store);
		this.vault = new VaultManager(this.store, undefined, this.paths.vaultConfig, options.runner, this.warn);
		this.foundations = openFoundations(this.store, mnemosiaPaths(options.home), this.warn);
	}

	/** The top memories for `cwd` as one framed, escaped block, or undefined when there is nothing to show. */
	snapshot(cwd: string): MemoryNote | undefined {
		const rendered = renderMemorySnapshot(this.store.listMemories({ scope: "all", project: cwd, limit: 5, order: "importance" }));
		return rendered === undefined ? undefined : { hash: createHash("sha256").update(rendered.content).digest("hex").slice(0, 16), ids: rendered.ids, content: rendered.content };
	}

	status(): MemoryStatus {
		return { memories: this.store.countMemories(), vaultConfigured: this.vault.configured, pendingSync: this.vault.pendingSync, quarantined: this.store.countState("QUARANTINED"), proposed: this.store.countState("PROPOSED") };
	}

	/** Change the state of a record the user accepted. Goes through the governed mutation, so the ledger has a row. */
	private async accept(state: MemoryState, target: string): Promise<string> {
		const records: MemoryRecord[] = target === "all" ? this.store.listByState(state, 1_000) : [this.store.getMemory(target)].filter((record): record is MemoryRecord => record !== undefined);
		if (records.length === 0) return target === "all" ? `no ${state.toLowerCase()} memories` : `no memory with id ${target}`;
		const wrong = records.filter((record) => record.state !== state);
		if (wrong.length > 0) return `${wrong[0]!.id} is ${wrong[0]!.state}, not ${state}; nothing was changed`;
		let failure: VaultFailure | undefined;
		for (const record of records) {
			const outcome = await this.vault.write(() => this.api.mutateMemory({ memoryId: record.id, idempotencyKey: `accept:${record.id}:${record.version}`, expectedVersion: record.version, actor: "user", reason: `accepted from ${state}`, transition: "ACTIVE" }));
			failure ??= outcome.vault;
		}
		return `${records.length} memor${records.length === 1 ? "y" : "ies"} accepted and now in the snapshot${failure === undefined ? "" : `\nvault mirror failed (saved locally): ${failureText(failure)}`}`;
	}

	/** /akashic ... Returns the reply text. */
	async command(args: string, cwd: string): Promise<string> {
		const [first = "status", second, third, ...rest] = args.trim().split(/\s+/u).filter((part) => part !== "");
		try {
			if (first === "status") return this.statusText(cwd);
			if (first === "accept") return second === undefined ? "usage: /akashic accept <id|all>" : await this.accept("QUARANTINED", second);
			if (first !== "vault") return "usage: /akashic [status] | accept <id|all> | vault status|init <repo-url> [--auto-push]|sync|commit [message]|push|import|accept <id|all>";
			switch (second ?? "status") {
				case "status": {
					const vault = await this.vault.status();
					if (!vault.configured) return "vault: not configured; run /akashic vault init <repo-url>";
					return [`vault: ${vault.clonePath} (${vault.clean ? "clean" : "needs attention"}), origin ${vault.repoUrl}`, vault.branch === undefined ? "" : `branch: ${vault.branch}`, `pending sync: ${this.vault.pendingSync ? "yes, run /akashic vault sync" : "no"}`, ...(vault.changes ?? []).slice(0, 10).map((line) => `  ${line}`)].filter((line) => line !== "").join("\n");
				}
				case "init": {
					if (third === undefined) return "usage: /akashic vault init <repo-url> [--auto-push]";
					const config = await this.vault.init(third, { clonePath: this.paths.vaultClone, autoPush: rest.includes("--auto-push") });
					return `vault ready at ${config.clonePath}; every memory is written there as a Markdown file (commit ${config.autoCommit ? "on" : "off"}, push ${config.autoPush ? "on" : "off"}). SQLite stays the source of truth.`;
				}
				case "sync": {
					const done = await this.vault.sync(false);
					return `vault synced: ${done.written} file${done.written === 1 ? "" : "s"} written, ${done.removed} removed${done.pushed ? ", pushed" : ""}`;
				}
				case "push": {
					const done = await this.vault.sync(true);
					return `vault synced and pushed: ${done.written} file${done.written === 1 ? "" : "s"} written, ${done.removed} removed`;
				}
				case "commit": {
					// The only way a vault-gated record reaches the clone; the mirror never writes those.
					const message = [third, ...rest].filter((part) => part !== undefined).join(" ");
					const done = await this.vault.commit(message === "" ? undefined : message);
					return done ? "vault committed; gated records in the clone are published with it" : "nothing to commit";
				}
				case "import": {
					const report = await this.vault.import(cwd);
					return [
						`import: ${report.inserted.length} added as PROPOSED, ${report.exists.length} already stored (left unchanged), ${report.duplicates.length} duplicate content, ${report.outOfScope.length} for other projects, ${report.invalid.length} rejected`,
						...report.invalid.slice(0, 5).map((item) => `  rejected ${item.path}: ${item.message}`),
						report.pullFailed === undefined ? "" : `pull failed, the files already in the clone were read: ${failureText(report.pullFailed)}`,
						report.inserted.length === 0 ? "" : "Imported memories stay out of the snapshot until you run /akashic vault accept <id|all>.",
					].filter((line) => line !== "").join("\n");
				}
				case "accept":
					return third === undefined ? "usage: /akashic vault accept <id|all>" : await this.accept("PROPOSED", third);
				default:
					return `unknown vault command ${second}; use status, init, sync, commit, push, import or accept`;
			}
		} catch (error) {
			return describe(error);
		}
	}

	private statusText(cwd: string): string {
		const stats = this.store.stats(cwd);
		const status = this.status();
		const kinds = Object.entries(stats.memoriesByKind).map(([kind, count]) => `${kind} ${count}`).join(", ") || "none";
		const usage = [stats.memoryUsage.global, ...(stats.memoryUsage.project === undefined ? [] : [stats.memoryUsage.project])].map((u) => `${u.scope}: ${u.usedChars}/${u.limitChars} chars, ${u.entries} entries`).join("; ");
		return [
			`${stats.memories} memories (${kinds})`,
			usage,
			`vault: ${status.vaultConfigured ? `configured${status.pendingSync ? ", pending sync (run /akashic vault sync)" : ""}` : "not configured"}`,
			status.quarantined > 0 ? `${status.quarantined} quarantined: written while only member reports were in the turn; /akashic accept <id|all> releases them` : "",
			status.proposed > 0 ? `${status.proposed} proposed: imported from the vault; /akashic vault accept <id|all> releases them` : "",
		].filter((line) => line !== "").join("\n");
	}

	close(): void {
		this.store.close();
	}
}

import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { readJsonFile, writeJsonFile } from "./config.ts";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./models.ts";

// Credential store at ${PIROBOROS_HOME}/auth.json (D14). `modify` is the only write path. It is serialized
// inside the process and across processes (an exclusive SQLite lock around the read-modify-write), and
// writes are atomic. Secrets are never logged or thrown in messages.

const LOCK_WAIT_MS = 10_000;

type Store = Record<string, Credential>;

function isBusy(error: unknown): boolean {
	const e = error as { errcode?: number; message?: string };
	return e.errcode === 5 || e.errcode === 6 || /database is locked|SQLITE_BUSY/iu.test(e.message ?? "");
}

export class FileCredentialStore implements CredentialStore {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly authPath: string;
	private readonly lockPath: string;
	private readonly report: (message: string) => void;

	constructor(authPath: string, lockPath: string, report: (message: string) => void = () => {}) {
		this.authPath = authPath;
		this.lockPath = lockPath;
		this.report = report;
	}

	private load(): Store {
		const raw = readJsonFile(this.authPath);
		return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Store) : {};
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.load()[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.exclusive(options, async () => {
			const store = this.load();
			const current = store[providerId];
			let next = await fn(current);
			if (next === undefined) return current;
			if (next.type === "oauth" && current?.type === "oauth" && (typeof next.refresh !== "string" || next.refresh === "") && typeof current.refresh === "string" && current.refresh !== "") {
				next = { ...next, refresh: current.refresh };
				this.report(`the new credential for ${providerId} carried no refresh token; the previous one was kept`);
			}
			store[providerId] = next;
			writeJsonFile(this.authPath, store);
			return next;
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.exclusive(options, async () => {
			const store = this.load();
			if (!(providerId in store)) return;
			delete store[providerId];
			writeJsonFile(this.authPath, store);
		});
	}

	/** In-process queue, then the cross-process lock, then `work`. */
	private exclusive<T>(options: AuthOperationOptions | undefined, work: () => Promise<T>): Promise<T> {
		const run = this.tail.then(async () => {
			const release = await this.lockProcesses(options?.signal);
			try {
				return await work();
			} finally {
				release();
			}
		});
		this.tail = run.then(() => undefined, () => undefined);
		return run;
	}

	private async lockProcesses(signal?: AbortSignal): Promise<() => void> {
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			signal?.throwIfAborted();
			let db: DatabaseSync | undefined;
			try {
				db = new DatabaseSync(this.lockPath);
				db.exec("PRAGMA busy_timeout = 0");
				db.exec("BEGIN EXCLUSIVE");
				const held = db;
				return () => {
					try { held.exec("ROLLBACK"); } catch { /* closed */ }
					try { held.close(); } catch { /* closed */ }
				};
			} catch (error) {
				try { db?.close(); } catch { /* discard */ }
				if (!isBusy(error)) throw error;
				if (Date.now() >= deadline) throw new Error("timed out waiting for another piroboros process to finish writing auth.json");
				await sleep(15);
			}
		}
	}
}

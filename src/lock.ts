import { DatabaseSync } from "node:sqlite";

// Process-wide exclusive lock (D13). One piroboros process per home: the lock database is opened with
// locking_mode=EXCLUSIVE and a BEGIN EXCLUSIVE transaction that stays open for the life of the process.
// The operating system releases it when the process ends, however it ends.

export const EXIT_LOCK_BUSY = 3;

export class LockBusyError extends Error {
	readonly exitCode = EXIT_LOCK_BUSY;
	constructor(path: string) {
		super(`another piroboros process is using this home (lock held on ${path}); close it and try again`);
		this.name = "LockBusyError";
	}
}

export interface HeldLock {
	release(): void;
}

// SQLITE_BUSY is 5 and SQLITE_LOCKED is 6; node:sqlite reports them in `errcode`.
function isBusy(error: unknown): boolean {
	const e = error as { errcode?: number; message?: string };
	return e.errcode === 5 || e.errcode === 6 || /database is locked|SQLITE_BUSY/iu.test(e.message ?? "");
}

/**
 * Take the exclusive lock or throw LockBusyError (exit code 3). Any other failure is rethrown unchanged,
 * so an unwritable home is not reported as "busy".
 */
export function acquireLock(path: string): HeldLock {
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(path);
		db.exec("PRAGMA busy_timeout = 0");
		db.exec("PRAGMA locking_mode = EXCLUSIVE");
		db.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		try { db?.close(); } catch { /* the failed handle is discarded */ }
		if (isBusy(error)) throw new LockBusyError(path);
		throw error;
	}
	const held = db;
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			try { held.exec("ROLLBACK"); } catch { /* already closed */ }
			try { held.close(); } catch { /* already closed */ }
		},
	};
}

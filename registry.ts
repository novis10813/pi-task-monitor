// registry.ts — durable task registry (source of truth on disk).
//
// All mutations are tmp+rename atomic. The registry is per-project:
// <cwd>/.pi/tasks/registry.json.

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

export type TaskState = "running" | "exited" | "timed_out" | "cancelled" | "log_overflow";

export interface TaskEntry {
	id: string;
	name: string;
	command: string;
	cwd: string;
	pid: number;
	log: string;
	exitFile: string;
	createdAt: number;
	timeoutSeconds: number | null;
	/** Whether a terminal state should wake the agent (callback). */
	callback: boolean;
	state: TaskState;
	exitCode: number | null; // null while running, or "unknown" after external kill
	endedAt: number | null;
	logBytes: number;
	/** Watermark: last state the agent has been told about. Callbacks fire only on transitions past this. */
	reported: { state: TaskState; logBytes: number };
	/** When set, output is ALSO appended (`tee -a`) to this caller-owned file; never pruned. */
	outputFile?: string;
}

export interface Registry {
	version: 1;
	tasks: TaskEntry[];
}

export function tasksDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "tasks");
}

export function registryPath(cwd: string): string {
	return join(tasksDir(cwd), "registry.json");
}

const EMPTY: Registry = { version: 1, tasks: [] };

export function loadRegistry(cwd: string): Registry {
	const p = registryPath(cwd);
	if (!existsSync(p)) return structuredClone(EMPTY);
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as Registry;
		if (raw.version !== 1 || !Array.isArray(raw.tasks)) return structuredClone(EMPTY);
		return raw;
	} catch {
		// Corrupt registry: don't crash the session. Tasks still on disk (pids)
		// can be re-adopted manually; the registry itself is unrecoverable.
		return structuredClone(EMPTY);
	}
}

export function saveRegistry(cwd: string, reg: Registry): void {
	mkdirSync(tasksDir(cwd), { recursive: true });
	const p = registryPath(cwd);
	const tmp = `${p}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(reg, null, 2));
	renameSync(tmp, p);
}

export function newTaskId(): string {
	return "t" + Math.random().toString(16).slice(2, 7).padEnd(5, "0");
}

export function deriveName(command: string): string {
	const tokens = command.trim().split(/\s+/).slice(0, 3).join(" ");
	return tokens.length > 32 ? tokens.slice(0, 32) + "…" : tokens;
}

/** True if the pid currently refers to a live process. */
export function isAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false; // pid 0 would mean "my own process group"
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Update a running entry in place based on disk probes:
 * - dead + exit sidecar present  -> exited with known code
 * - dead + no sidecar            -> exited with unknown code (external kill / OOM)
 * - alive                        -> refresh logBytes only
 */
export function probeTask(t: TaskEntry): void {
	if (t.state !== "running") return;
	if (!isAlive(t.pid)) {
		const sidecar = readExitSidecar(t);
		t.state = "exited";
		t.exitCode = sidecar.code;
		t.endedAt = sidecar.at ?? Date.now();
	}
	t.logBytes = logSize(t.log);
}

export function logSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/**
 * Read the exit sidecar (`<code> <epoch-seconds>`, legacy: `<code>` only).
 * code null if not yet written / not an int; at null for legacy format.
 */
export function readExitSidecar(t: TaskEntry): { code: number | null; at: number | null } {
	try {
		const parts = readFileSync(t.exitFile, "utf8").trim().split(/\s+/);
		const code = Number(parts[0]);
		return {
			code: Number.isInteger(code) ? code : null,
			at: parts[1] !== undefined && Number.isFinite(Number(parts[1])) ? Number(parts[1]) * 1000 : null,
		};
	} catch {
		return { code: null, at: null };
	}
}

/**
 * Display-only read: load + probe in memory, NO save. All durable state
 * transitions go through settleRegistry (poller) under the registry lock —
 * a probe-then-save here would race concurrent writers (lost update).
 */
export function snapshotRegistry(cwd: string): Registry {
	const reg = loadRegistry(cwd);
	for (const t of reg.tasks) probeTask(t);
	return reg;
}

/** Read only the last maxBytes of a file (O(tail), not O(size)). */
export function tailFile(path: string, maxBytes: number): string {
	try {
		const size = statSync(path).size;
		const len = Math.min(size, maxBytes);
		if (len === 0) return "";
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

// --- Single-writer lock ------------------------------------------------------
// All registry mutations MUST go through withRegistryLock: it serializes
// in-process async paths (poller vs tool handlers) and cross-process writers
// (two pi sessions in the same project) via an O_EXCL lock file, then does
// fresh-read -> mutate -> atomic-save inside the critical section. Without
// this, a poller save can clobber a concurrent spawn entry (lost update).

const LOCK_FILE = ".registry.lock";
const STALE_LOCK_MS = 2_000; // critical section is <50ms; 2s old == crashed holder
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;

const inProcessLocks = new Map<string, Promise<void>>();

function inProcessMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = inProcessLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	inProcessLocks.set(key, new Promise<void>((r) => (release = r)));
	return prev.catch(() => {}).then(() => fn()).finally(release);
}

async function acquireFileLock(dir: string): Promise<boolean> {
	try {
		mkdirSync(dir, { recursive: true }); // mutators legitimately create the dir
	} catch {
		return false;
	}
	const lockPath = join(dir, LOCK_FILE);
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
			// Break a stale lock (crashed holder).
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch {
				continue; // vanished -> retry
			}
			if (Date.now() > deadline) return false;
			await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
		}
	}
}

function releaseFileLock(dir: string): void {
	try {
		unlinkSync(join(dir, LOCK_FILE));
	} catch {
		/* already gone */
	}
}

/**
 * Run `fn` with exclusive write access to the project registry. `fn`
 * receives a freshly-read registry; mutate it in place — it is atomically
 * saved after `fn` returns. Throws on lock timeout.
 */
export function withRegistryLock<T>(cwd: string, fn: (registry: Registry) => T | Promise<T>): Promise<T> {
	return inProcessMutex(`reg:${cwd}`, async () => {
		const dir = tasksDir(cwd);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		if (!(await acquireFileLock(dir))) {
			throw new Error(`task-monitor: registry lock timeout for ${cwd}`);
		}
		try {
			const registry = loadRegistry(cwd);
			const result = await fn(registry);
			saveRegistry(cwd, registry);
			return result;
		} finally {
			releaseFileLock(dir);
		}
	});
}

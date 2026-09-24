// Logical owner is the spawning session. A live spawning pi process has
// priority over another window attached to the same session. No workspace
// fallback: a different session must never claim this task's callback.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registryPath, tasksDir, type TaskEntry, type TaskOwner } from "./registry.js";

const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
const PRUNE_PRESENCE_MS = 24 * 60 * 60 * 1000;
// Preserve process identity across /reload (which constructs a fresh extension instance).
const processIdKey = Symbol.for("pi.task-monitor.process-id");
const processIds = globalThis as unknown as Record<symbol, string | undefined>;
const defaultProcessId = (processIds[processIdKey] ??= randomUUID());

interface Presence extends TaskOwner {
	instanceId: string;
	pid: number;
	updatedAt: number;
}

function presencePath(cwd: string, processId: string): string {
	return join(tasksDir(cwd), "owners", `${processId}.json`);
}

/** One instance per extension process; processId prevents PID-reuse confusion. */
export class SessionOwnership {
	constructor(readonly processId = defaultProcessId) {}
	private readonly instanceId = randomUUID();
	private cwd: string | undefined;
	private sessionId: string | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	start(cwd: string, sessionId: string, onHeartbeat?: () => void): void {
		this.stop();
		this.cwd = cwd;
		this.sessionId = sessionId;
		this.announce();
		this.prunePresence();
		this.timer = setInterval(() => {
			this.announce();
			// Discover tasks created by another window after this session went idle.
			// A failed probe must not stop the owner heartbeat.
			try { onHeartbeat?.(); } catch { /* try again next heartbeat */ }
		}, HEARTBEAT_MS);
		this.timer.unref();
	}

	/** Announce immediately after the first task creates the registry. */
	announce(): void {
		if (!this.cwd || !this.sessionId || !existsSync(registryPath(this.cwd))) return;
		const path = presencePath(this.cwd, this.processId);
		const tmp = `${path}.tmp-${process.pid}`;
		try {
			mkdirSync(join(tasksDir(this.cwd), "owners"), { recursive: true });
			writeFileSync(tmp, JSON.stringify({ sessionId: this.sessionId, processId: this.processId, instanceId: this.instanceId, pid: process.pid, updatedAt: Date.now() }));
			renameSync(tmp, path);
		} catch {
			// Failure to announce loses process priority, not session ownership.
			rmSync(tmp, { force: true });
		}
	}

	private prunePresence(): void {
		if (!this.cwd) return;
		const dir = join(tasksDir(this.cwd), "owners");
		try {
			for (const name of readdirSync(dir)) {
				if (!name.endsWith(".json")) continue;
				const file = join(dir, name);
				try {
					if (Date.now() - statSync(file).mtimeMs > PRUNE_PRESENCE_MS) rmSync(file, { force: true });
				} catch { /* another process removed it */ }
			}
		} catch { /* registry not yet created */ }
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.cwd) {
			const path = presencePath(this.cwd, this.processId);
			try {
				const presence = JSON.parse(readFileSync(path, "utf8")) as Presence;
				if (presence.instanceId === this.instanceId) rmSync(path, { force: true });
			} catch { /* missing or already replaced */ }
		}
		this.cwd = undefined;
		this.sessionId = undefined;
	}

	current(cwd: string, sessionId: string): boolean {
		return this.cwd === cwd && this.sessionId === sessionId;
	}

	owner(sessionId: string): TaskOwner {
		return { sessionId, processId: this.processId };
	}

	/** Used by the poller to remain armed while waiting for the original window. */
	belongsToSession(task: TaskEntry, sessionId: string): boolean {
		return task.owner?.sessionId === sessionId;
	}

	canDeliver(cwd: string, task: TaskEntry, sessionId: string): boolean {
		if (!this.current(cwd, sessionId) || !this.belongsToSession(task, sessionId)) return false;
		if (task.owner!.processId === this.processId) return true;
		return !this.originalIsActive(cwd, task.owner!);
	}

	private originalIsActive(cwd: string, owner: TaskOwner): boolean {
		let presence: Presence;
		try {
			presence = JSON.parse(readFileSync(presencePath(cwd, owner.processId), "utf8")) as Presence;
		} catch {
			return false;
		}
		if (presence.processId !== owner.processId || presence.sessionId !== owner.sessionId ||
			!Number.isFinite(presence.updatedAt) || Date.now() - presence.updatedAt > STALE_MS ||
			presence.updatedAt > Date.now() + HEARTBEAT_MS || !Number.isSafeInteger(presence.pid) || presence.pid <= 0) return false;
		try {
			process.kill(presence.pid, 0);
			return true;
		} catch (e) {
			return (e as NodeJS.ErrnoException).code === "EPERM";
		}
	}
}

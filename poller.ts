// poller.ts — the 3s heartbeat: settles state transitions, samples resource
// usage, and delivers exit callbacks. One poller per cwd (module-level map);
// self-stops when nothing is running (zero cost when idle).
//
// settleRegistry is the SINGLE place durable state transitions happen
// (timeout / exit / log-overflow / cancel-reaper), under the registry lock.
// session_start calls it too, so every reader sees settled state.

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	type Registry,
	type TaskEntry,
	isAlive,
	loadRegistry,
	logSize,
	readExitSidecar,
	registryPath,
	tailFile,
	tasksDir,
	withRegistryLock,
} from "./registry.js";
import { killGroup } from "./spawner.js";
import { sampleUsage, usageFileFor, usageSummaryLine } from "./usage.js";
import { deliverEvents, hasClaim, type DeliveryCtx } from "./delivery.js";
import { forgetTask } from "./usage.js";
import { fmtDur, footerText } from "./format.js";

const POLL_INTERVAL_MS = 3_000;
const LOG_HARD_CAP_BYTES = 20 * 1024 * 1024;

const pollers = new Map<string, { timer: NodeJS.Timeout; alive: boolean }>();

/**
 * Apply all pending state transitions to the registry under the lock and
 * save. No callbacks, no sampling, no footer — pure settle.
 */
export async function settleRegistry(cwd: string, now = Date.now()): Promise<Registry> {
	// Fast path: no registry file -> nothing to settle, and (importantly) no
	// .pi/tasks/ directory is created in projects that never spawn tasks.
	if (!existsSync(registryPath(cwd))) return { version: 1, tasks: [] };
	return withRegistryLock(cwd, (reg) => {
		for (const t of reg.tasks) {
			if (t.state === "cancelled") {
				// Reaper: a crash between the "cancelled" mark and the group
				// kill would orphan the process. Re-kill any survivor.
				if (t.pid > 0 && isAlive(t.pid)) killGroup(t.pid);
				continue;
			}
			if (t.state !== "running") continue;
			// 1. timeout
			if (t.timeoutSeconds !== null && t.createdAt + t.timeoutSeconds * 1000 <= now) {
				killGroup(t.pid); // fire-and-forget (SIGTERM -> 5s -> SIGKILL)
				t.state = "timed_out";
				t.endedAt = now;
				t.logBytes = logSize(t.log);
				continue;
			}
			// 2. dead?
			if (!isAlive(t.pid)) {
				const sidecar = readExitSidecar(t);
				t.state = "exited";
				t.exitCode = sidecar.code;
				t.endedAt = sidecar.at ?? now; // real exit time if the wrapper wrote it
				t.logBytes = logSize(t.log);
				continue;
			}
			// 3. log overflow hard cap
			const size = logSize(t.log);
			t.logBytes = size;
			if (size > LOG_HARD_CAP_BYTES) {
				killGroup(t.pid);
				t.state = "log_overflow";
				t.endedAt = now;
			}
		}
		return reg;
	});
}

/** One tick: settle -> sample usage -> deliver due callbacks -> prune -> footer. */
export async function runTick(cwd: string, dc: DeliveryCtx): Promise<void> {
	const registry = await settleRegistry(cwd);
	const running = registry.tasks.filter((t) => t.state === "running");
	if (running.length > 0) {
		await sampleUsage(running); // never throws; gpu/vram null without nvidia
	}
	const due = registry.tasks.filter(
		(t) => t.callback === true && t.reported.state !== t.state,
	);
	if (due.length > 0) {
		await deliverEvents(cwd, due, dc, buildExitMessage);
	}
	await pruneDelivered(cwd);
	dc.setFooter(footerText(registry.tasks));
}

/**
 * Live exit callback message: the new terminal state(s) first (with log tail
 * + resource peak for diagnosis), then a snapshot of all tasks.
 */
export function buildExitMessage(claimed: TaskEntry[]): string {
	const lines: string[] = ["[task-event] Background process update:"];
	for (const t of claimed) {
		const verb = t.state === "exited" ? (t.exitCode === 0 ? "SUCCEEDED" : "FAILED") : t.state.toUpperCase();
		const codePart = t.state === "exited" ? ` with code ${t.exitCode ?? "unknown"}` : "";
		lines.push(`• "${t.name}" (${t.id}) ${verb}${codePart} after ${fmtDur((t.endedAt ?? Date.now()) - t.createdAt)}`);
		lines.push(`  log: ${t.log} (${logSize(t.log)} bytes)`);
		const tail = tailLines(t, 5);
		if (tail) lines.push("  last output:");
		for (const l of tail ?? []) lines.push(`    ${l}`);
		if (t.state === "exited" && (t.exitCode ?? 0) !== 0) {
			const peak = usageSummaryLine(t);
			if (peak) lines.push(`  peak usage: ${peak}`);
		}
	}
	return lines.join("\n");
}

function tailLines(t: TaskEntry, n: number): string[] | null {
	const raw = tailFile(t.log, 4096);
	const ls = raw.split("\n").filter((x) => x.length > 0).slice(-n);
	return ls.length > 0 ? ls : null;
}

function startPoller(cwd: string, dc: DeliveryCtx): void {
	const entry = { timer: undefined as unknown as NodeJS.Timeout, alive: false };
	pollers.set(cwd, entry);
	entry.alive = true;
	const tick = async () => {
		if (!entry.alive) return;
		try {
			await runTick(cwd, dc);
		} catch (e) {
			// A failing tick must not kill the poller.
			dc.notify(`task-monitor: poller error: ${(e as Error).message}`, "error");
		}
		if (!loadRegistry(cwd).tasks.some((t) => t.state === "running")) {
			entry.alive = false; // idle: self-stop (spawn/restart re-arms)
			pollers.delete(cwd);
			return;
		}
		entry.timer = setTimeout(tick, POLL_INTERVAL_MS);
	};
	// Immediate first tick: CPU baseline sample + quick settle for instant exits.
	void tick();
}

function stopPoller(cwd: string): void {
	const entry = pollers.get(cwd);
	if (!entry) return;
	entry.alive = false;
	clearTimeout(entry.timer);
	pollers.delete(cwd);
}

/**
 * One poller per cwd, restarted with the fresh delivery ctx. No-op when
 * nothing is running and nothing is due (keeps the poller off the clock and
 * avoids creating .pi/tasks/ in projects that never spawn background work).
 */
export function ensurePoller(cwd: string, dc: DeliveryCtx): void {
	stopPoller(cwd);
	const reg = loadRegistry(cwd);
	const hasRunning = reg.tasks.some((t) => t.state === "running");
	const hasDue = reg.tasks.some((t) => t.callback === true && t.reported.state !== t.state);
	if (!hasRunning && !hasDue) return;
	startPoller(cwd, dc);
}

export function stopPollerFor(cwd: string): void {
	stopPoller(cwd);
}

const PRUNE_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 days

function removeTaskFiles(cwd: string, t: TaskEntry): void {
	const dir = tasksDir(cwd);
	// t.log is always the managed log; a caller-owned outputFile (if any) is
	// never touched here.
	const files = [t.log, t.exitFile, usageFileFor(t), `${usageFileFor(t)}.prev`, join(dir, `${t.id}.claim`)];
	for (const f of files) {
		try {
			unlinkSync(f);
		} catch {
			/* already gone */
		}
	}
}

/**
 * Remove terminal tasks whose transition has been fully delivered to the
 * agent (`reported` == current state). A task with a live claim is skipped:
 * the send may still be retrying and needs the log/usage files to build the
 * message. Tasks with callback=false are never delivered — they fall through
 * to pruneOld. Called each tick after delivery and at session_start.
 */
export async function pruneDelivered(cwd: string): Promise<number> {
	if (!existsSync(registryPath(cwd))) return 0;
	return withRegistryLock(cwd, (reg) => {
		const keep: TaskEntry[] = [];
		let removed = 0;
		for (const t of reg.tasks) {
			const delivered = t.state !== "running" && t.reported.state === t.state;
			if (!delivered || hasClaim(cwd, t.id)) {
				keep.push(t);
				continue;
			}
			removeTaskFiles(cwd, t);
			forgetTask(t.id);
			removed++;
		}
		reg.tasks = keep;
		return removed;
	});
}

/**
 * Remove terminal tasks older than 7 days (registry entry + log/exit/usage/
 * claim files). Running tasks are never pruned. Returns the count removed.
 * Called at session_start (fire-and-forget).
 */
export async function pruneOld(cwd: string): Promise<number> {
	if (!existsSync(registryPath(cwd))) return 0;
	return withRegistryLock(cwd, (reg) => {
		const now = Date.now();
		const keep = reg.tasks.filter(
			(t) => t.state === "running" || (t.endedAt ?? t.createdAt) >= now - PRUNE_MAX_AGE_MS,
		);
		const removed = reg.tasks.length - keep.length;
		for (const t of reg.tasks) {
			if (keep.includes(t)) continue;
			removeTaskFiles(cwd, t);
		}
		reg.tasks = keep;
		return removed;
	});
}

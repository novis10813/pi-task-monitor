// spawner.ts — detached spawn + process-group kill + registry registration.
//
// Design notes (verified in Phase 0 spike, /tmp/tm-spike):
// - The user command MUST run in a subshell: `( <command> )`. A naive
//   `{ <command>; }` wrapper dies on user commands containing `exit N`,
//   and the exit-code sidecar is never written.
// - detached: true makes bash the process-group leader (pgid == pid), so
//   kill(-pid) terminates the whole tree (bash -> npm -> node, ...).
// - After a group kill there is NO exit sidecar (the wrapper itself is
//   killed) — "cancelled" semantics must come from the registry, not disk.
//
// Registration order (pid-0 guard makes every crash window self-healing):
//   1. reserve id + entry (pid: 0) under the registry lock
//   2. spawn the wrapper (files keyed by id)
//   3. fill in the real pid under the lock
// A crash between steps leaves at most a pid-0 entry, which settles to
// "exited, unknown" (isAlive/killGroup reject pid <= 0 — kill(0) would
// otherwise target the CALLER's process group).

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type TaskEntry,
	deriveName,
	newTaskId,
	tasksDir,
	withRegistryLock,
} from "./registry.js";

export type CancelResult =
	| { ok: true; name: string; outcome: string }
	| { ok: false; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Spawn the wrapper; returns the wrapper pid (== process group id).
 * The exit sidecar carries the REAL exit time (`<code> <epoch-seconds>`),
 * so endedAt is accurate even when the exit is first observed after a
 * restart (detection time would otherwise overstate the duration).
 */
function spawnWrapper(entry: TaskEntry): number {
	const wrapper =
		`cd ${shellQuote(entry.cwd)} && ` +
		`( ${entry.command} ) > ${shellQuote(entry.log)} 2>&1; ` +
		`printf "%s %s\\n" $? "$(date +%s)" > ${shellQuote(entry.exitFile)}`;
	const child = spawn("bash", ["-lc", wrapper], { detached: true, stdio: "ignore" });
	child.unref();
	if (child.pid === undefined) throw new Error("spawn failed: no pid returned");
	return child.pid;
}

/**
 * Register a background task. Reserves the id and registry entry under the
 * lock, spawns the detached wrapper, then records the pid under the lock.
 * Throws (and cleans up) if spawn or the lock fails.
 */
export async function spawnTask(
	cwd: string,
	command: string,
	opts: { name?: string; timeoutSeconds?: number | null; callback: boolean },
): Promise<TaskEntry> {
	const dir = tasksDir(cwd);
	mkdirSync(dir, { recursive: true });

	let entry!: TaskEntry;
	await withRegistryLock(cwd, (reg) => {
		let id = newTaskId();
		while (reg.tasks.some((t) => t.id === id)) id = newTaskId();
		entry = {
			id,
			name: opts.name ?? deriveName(command),
			command,
			cwd,
			pid: 0,
			log: join(dir, `${id}.log`),
			exitFile: join(dir, `${id}.exit`),
			createdAt: Date.now(),
			timeoutSeconds: opts.timeoutSeconds ?? null,
			callback: opts.callback,
			state: "running",
			exitCode: null,
			endedAt: null,
			logBytes: 0,
			reported: { state: "running", logBytes: 0 },
		};
		reg.tasks.push(entry);
	});

	let pid: number;
	try {
		pid = spawnWrapper(entry);
	} catch (e) {
		await withRegistryLock(cwd, (reg) => {
			reg.tasks = reg.tasks.filter((t) => t.id !== entry.id);
		});
		throw e;
	}
	await withRegistryLock(cwd, (reg) => {
		const t = reg.tasks.find((x) => x.id === entry.id);
		if (t) t.pid = pid;
	});
	entry.pid = pid;
	return entry;
}

/** SIGTERM the whole group, escalate to SIGKILL after grace. */
export async function killGroup(pid: number, graceMs = 5000): Promise<"term" | "kill" | "gone"> {
	if (!pid || pid <= 0) return "gone";
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return "gone";
	}
	const start = Date.now();
	while (Date.now() - start < graceMs) {
		await sleep(200);
		try {
			process.kill(-pid, 0);
		} catch {
			return "term"; // group fully gone
		}
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		return "term";
	}
	await sleep(150);
	return "kill";
}

/**
 * Cancel a running task: mark `cancelled` under the lock FIRST (watermark =
 * persistent callback suppression — a kill is never news), then SIGTERM the
 * process group. A crash in between is healed by the settle reaper, which
 * re-kills any survivor of a cancelled task.
 * Shared by kill_background and the /tasks panel.
 */
export async function cancelTask(cwd: string, id: string): Promise<CancelResult> {
	const marked = await withRegistryLock(cwd, (reg) => {
		const t = reg.tasks.find((x) => x.id === id);
		if (!t) return null;
		if (t.state !== "running") return { notRunning: t.state };
		t.state = "cancelled";
		t.endedAt = Date.now();
		t.reported = { state: "cancelled", logBytes: t.logBytes };
		return { name: t.name, pid: t.pid };
	});
	if (marked === null) return { ok: false, error: `unknown task id: ${id}` };
	if ("notRunning" in marked) return { ok: false, error: `task ${id} is not running (state: ${marked.notRunning})` };
	const outcome = await killGroup(marked.pid);
	return { ok: true, name: marked.name, outcome };
}

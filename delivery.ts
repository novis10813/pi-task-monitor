// delivery.ts — exit callbacks & recovery reports, "exactly once" best effort.
//
// Ordering & guarantees (single-user, documented trade-offs):
//   1. claim a task (O_EXCL file) so two concurrent pi processes can't both report
//   2. write the `reported` watermark to the registry (durably, BEFORE sending)
//   3. send the message; release the claim on success
//   4. on send failure the claim is KEPT and the task goes to an in-memory
//      pending queue (retried next tick, bounded). The watermark is already set,
//      so it will not be re-claimed as a fresh transition.
//
// Consequences:
//   - No duplicate notifications (watermark precedes send).
//   - A crash in the narrow save->send window loses ONE notification
//     (at-most-once) — and, since delivered-looking tasks are pruned, the
//     task's record with it. Nothing else is unrecoverable.
//   - Cancelled tasks never notify (explicit stop is not news); the suppression
//     is durable via the watermark, so restarts stay silent too.

import { closeSync, existsSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tailFile, tasksDir, type TaskEntry, withRegistryLock } from "./registry.js";
import { fmtDur } from "./format.js";
import { usageSummaryLine } from "./usage.js";

export interface DeliveryCtx {
	/** Re-check immediately before claim and watermark: session switches may happen mid-tick. */
	canDeliver: (task: TaskEntry) => boolean;
	belongsToSession: (task: TaskEntry) => boolean;
	isCurrent: () => boolean;
	sendMessage: (content: string, details: unknown) => Promise<void> | void;
	notify: (msg: string, kind: "info" | "warning" | "error") => void;
	/** Ask the UI to re-render the footer block (footer-bus detail). */
	notifyFooter: () => void;
}

const MAX_SEND_RETRIES = 3;
/** Claims older than this are assumed to belong to a dead pi process. */
const CLAIM_STALE_MS = 30_000;

// Pending (claimed, watermarked, not yet sent) batches, keyed by cwd.
interface Pending {
	tasks: TaskEntry[];
	count: number;
}
const pending = new Map<string, Pending>();

function claimPath(cwd: string, id: string): string {
	return join(tasksDir(cwd), `${id}.claim`);
}

export function hasPending(cwd: string): boolean {
	return pending.has(cwd);
}

/** A session replacement must never retry the old session's message in the new one. */
export function discardPending(cwd: string): void {
	const batch = pending.get(cwd);
	pending.delete(cwd);
	if (batch) for (const t of batch.tasks) releaseClaim(cwd, t.id);
}

export function tryClaim(cwd: string, id: string): boolean {
	try {
		const fd = openSync(claimPath(cwd, id), "wx");
		writeFileSync(fd, String(process.pid));
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

export function releaseClaim(cwd: string, id: string): void {
	try {
		rmSync(claimPath(cwd, id), { force: true });
	} catch {
		/* already gone */
	}
}

/** True if a claim file exists (delivery in flight, retrying, or stuck). */
export function hasClaim(cwd: string, id: string): boolean {
	return existsSync(claimPath(cwd, id));
}

/**
 * Reap stale claims (older than CLAIM_STALE_MS), including claims left by a
 * process that crashed between claim and watermark. Do not remove a fresh
 * watermarked claim: its sender may still be constructing/sending a message.
 * Runs each tick and at session_start.
 */
export function clearStaleClaims(cwd: string, tasks: TaskEntry[]): void {
	const now = Date.now();
	for (const t of tasks) {
		if (t.state === "running") continue;
		const p = claimPath(cwd, t.id);
		try {
			const st = statSync(p);
			if (now - st.mtimeMs > CLAIM_STALE_MS) releaseClaim(cwd, t.id);
		} catch {
			/* no claim */
		}
	}
}

// ---------------------------------------------------------------------------
// message construction
// ---------------------------------------------------------------------------

function tailBlock(t: TaskEntry, lines: number, indent: string): string {
	const raw = tailFile(t.log, 16 * 1024);
	const body = raw
		.split("\n")
		.slice(-lines)
		.map((l) => indent + l)
		.join("\n");
	return body ? `\n${indent}Last output:\n${body}` : "";
}

function eventLine(t: TaskEntry): string {
	const end = t.endedAt ?? Date.now();
	const verb = t.state === "exited" ? (t.exitCode === 0 ? "SUCCEEDED" : "FAILED") : t.state.toUpperCase();
	const code = t.state === "exited" ? ` with code ${t.exitCode ?? "unknown"}` : "";
	return `• "${t.name}" (${t.id}) ${verb}${code} after ${fmtDur(end - t.createdAt)}`;
}

function resourceLine(t: TaskEntry): string {
	if (t.state === "exited" && t.exitCode !== 0) {
		const res = usageSummaryLine(t);
		if (res) return `  Resources (last 30m): ${res}`;
	}
	return "";
}

/** Recovery report for transitions that happened while pi was closed. */
export function buildRecoveryMessage(terminal: TaskEntry[], running: TaskEntry[]): string {
	const parts = terminal.map((t) => {
		let s = eventLine(t) + tailBlock(t, 5, "  ");
		const r = resourceLine(t);
		if (r) s += `\n${r}`;
		return s;
	});
	const lines = ["[task-event recovery] While pi was closed:"];
	if (parts.length > 0) lines.push(...parts);
	for (const t of running) {
		lines.push(`• "${t.name}" (${t.id}) still running (started ${fmtDur(Date.now() - t.createdAt)} ago, log: ${t.log})`);
	}
	lines.push("Poller re-attached; you will be notified on future exits.");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// claim + watermark + send (with in-memory retry)
// ---------------------------------------------------------------------------

/**
 * Report every due transition. Per task: claim (O_EXCL) -> watermark under
 * the registry lock (fresh state, so a concurrent transition is not
 * clobbered) -> send. Returns ids actually sent this tick.
 *
 * The watermark precedes the send: no duplicates ever; a crash in the
 * save->send window loses at most one notification (at-most-once), and the
 * final state stays visible via /tasks.
 */
export async function deliverEvents(
	cwd: string,
	due: TaskEntry[],
	dc: DeliveryCtx,
	build: (claimed: TaskEntry[]) => string,
): Promise<string[]> {
	const sent: string[] = [];

	// 1. retry a previously-failed batch still held by this process
	const prev = pending.get(cwd);
	if (prev) {
		pending.delete(cwd);
		if (dc.isCurrent() && prev.tasks.every(dc.canDeliver)) {
			await sendBatch(cwd, prev.tasks, prev.count, dc, build, sent);
		} else {
			for (const t of prev.tasks) releaseClaim(cwd, t.id);
		}
	}

	// 2. fresh transitions
	const claimed: TaskEntry[] = [];
	for (const t of due) {
		if (dc.isCurrent() && dc.canDeliver(t) && tryClaim(cwd, t.id)) claimed.push(t);
	}
	if (claimed.length > 0) {
		await sendBatch(cwd, claimed, 1, dc, build, sent);
	}
	return sent;
}

async function sendBatch(
	cwd: string,
	tasks: TaskEntry[],
	count: number,
	dc: DeliveryCtx,
	build: (claimed: TaskEntry[]) => string,
	sent: string[],
): Promise<void> {
	// Watermark under the lock, using the FRESH on-disk state (a transition
	// may have landed between the caller's read and now).
	const watermarked: TaskEntry[] = [];
	for (const t of tasks) {
		const fresh = await withRegistryLock(cwd, (reg) => {
			const f = reg.tasks.find((x) => x.id === t.id);
			if (!f || !dc.isCurrent() || !dc.canDeliver(f) || !f.callback || f.state !== t.state ||
				f.state === "running" || f.state === "cancelled" ||
				(count === 1 && f.reported.state === f.state)) return null;
			f.reported = { state: f.state, logBytes: f.logBytes };
			return structuredClone(f);
		});
		if (fresh) watermarked.push(fresh);
		else releaseClaim(cwd, t.id);
	}
	if (watermarked.length === 0) return;
	if (!dc.isCurrent()) {
		for (const t of watermarked) releaseClaim(cwd, t.id);
		return; // already watermarked: at-most-once loss if the session switched here
	}
	try {
		await dc.sendMessage(build(watermarked), detailsFor(watermarked));
		for (const t of watermarked) releaseClaim(cwd, t.id);
		sent.push(...watermarked.map((t) => t.id));
	} catch (e) {
		if (!dc.isCurrent()) {
			for (const t of watermarked) releaseClaim(cwd, t.id);
			return;
		}
		// Keep claims: retried next tick; give up after MAX_SEND_RETRIES
		// (watermark stays -> never re-claimed as a fresh transition).
		if (count > MAX_SEND_RETRIES) {
			for (const t of watermarked) releaseClaim(cwd, t.id);
			dc.notify(
				`task-monitor: giving up completion notice for ${watermarked.map((t) => t.id).join(", ")}: ${(e as Error).message}`,
				"error",
			);
		} else {
			pending.set(cwd, { tasks: watermarked, count: count + 1 });
			dc.notify(`task-monitor: retrying completion notice (${count + 1}/${MAX_SEND_RETRIES}): ${(e as Error).message}`, "warning");
		}
	}
}

function detailsFor(tasks: TaskEntry[]): unknown {
	return {
		source: "task-monitor",
		events: tasks.map((t) => ({ id: t.id, name: t.name, state: t.state, exitCode: t.exitCode, log: t.log })),
	};
}

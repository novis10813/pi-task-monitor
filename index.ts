// task-monitor — durable background process tracking for pi.
//
//   - spawn_background tool (detached spawn, disk registry, survives pi exit)
//   - monitor tool: status | tail | usage
//   - /tasks TUI panel (list, detail/tail, kill)
//   - 3s poller: state settle, CPU/RAM/GPU/VRAM sampling, exit callbacks
//   - session_start recovery report for events that happened while closed
//
// Registry writes are serialized through withRegistryLock (single-writer);
// settleRegistry (poller.ts) is the only place state transitions happen.

import { StringEnum } from "@earendil-works/pi-ai";
import {
	formatSize,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import {
	loadRegistry,
	snapshotRegistry,
	tailFile,
	tasksDir,
	type TaskEntry,
	withRegistryLock,
} from "./registry.js";
import { cancelTask, spawnTask } from "./spawner.js";
import { durationOf, footerText, stateColor, stateLabel } from "./format.js";
import { buildRecoveryMessage, clearStaleClaims, deliverEvents, type DeliveryCtx } from "./delivery.js";
import { ensurePoller, pruneOld, settleRegistry, stopPollerFor } from "./poller.js";
import { usageReport, type UsageReport, type UsageStat } from "./usage.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Build a DeliveryCtx. `recovery` selects the safe session_start delivery mode:
 * - live callbacks (poller): followUp + triggerTurn — wake the agent now. Safe
 *   because the user prompt was already submitted, so no prompt() collision.
 * - recovery (session_start): nextTurn — queue for the next turn without
 *   triggering. Using triggerTurn here races the CLI `-p` prompt in print mode
 *   (prompt() throws "Agent is already processing") and is noisy in TUI.
 */
function makeDeliveryCtx(pi: ExtensionAPI, ctx: ExtensionContext, recovery = false): DeliveryCtx {
	return {
		// Awaiting the send matters: failures (e.g. session ending mid-send)
		// must be observed by the delivery retry logic, not become unhandled.
		sendMessage: (content, details) =>
			pi.sendMessage(
				{ customType: recovery ? "task-event-recovery" : "task-event", content, display: true, details },
				recovery ? { deliverAs: "nextTurn" } : { deliverAs: "followUp", triggerTurn: true },
			),
		notify: (m, k) => {
			if (ctx.hasUI) ctx.ui.notify(m, k);
		},
		setFooter: (text) => ctx.ui.setStatus("task-monitor", text),
	};
}

function refreshCtx(ctx: ExtensionContext): TaskEntry[] {
	const registry = snapshotRegistry(ctx.cwd);
	ctx.ui.setStatus("task-monitor", footerText(registry.tasks));
	return registry.tasks;
}

function findTask(cwd: string, id: string): TaskEntry {
	const t = snapshotRegistry(cwd).tasks.find((x) => x.id === id);
	if (!t) throw new Error(`unknown task id: ${id} (use monitor with action="status" to list tasks)`);
	return t;
}

function listText(tasks: TaskEntry[], cwd: string): string {
	if (tasks.length === 0) return `No background tasks for project ${cwd}.`;
	const lines = tasks.map(
		(t) => `• ${t.id}  ${stateLabel(t).padEnd(16)} ${durationOf(t).padStart(8)}  "${t.name}"  ${t.command}${t.state === "running" ? `  (pid ${t.pid})` : ""}`,
	);
	lines.push(`Log dir: ${tasksDir(cwd)}`);
	return lines.join("\n");
}

function oneText(t: TaskEntry): string {
	const tail = tailFile(t.log, 4096).split("\n").slice(-5).join("\n");
	const head = [
		`${t.id}  ${stateLabel(t)}  ${durationOf(t)}`,
		`name:    ${t.name}`,
		`command: ${t.command}`,
		`cwd:     ${t.cwd}`,
		t.state === "running" ? `pid:     ${t.pid}` : `exit:    ${t.exitCode ?? "unknown"}`,
		`log:     ${t.log} (${formatSize(t.logBytes)})`,
		`timeout: ${t.timeoutSeconds ?? "none"}`,
	];
	return tail ? `${head.join("\n")}\n--- last 5 lines ---\n${tail}` : head.join("\n");
}

function tailText(t: TaskEntry, n: number): string {
	const raw = tailFile(t.log, 50 * 1024);
	const all = raw.split("\n");
	const lines = all.slice(-n).join("\n");
	const note = raw.length >= 50 * 1024 ? " (showing last 50KB of log)" : "";
	return `--- last ${n} lines of ${t.log} (${formatSize(t.logBytes)})${note} ---\n${lines}`;
}

function usageText(t: TaskEntry, rep: UsageReport): string {
	const line = (label: string, s: UsageStat | null, unit: string): string => {
		if (!s) return `  ${label.padEnd(5)} n/a`;
		const trend = s.trend === "flat" ? "" : `  (${s.trend})`;
		return `  ${label.padEnd(5)} min ${s.min}${unit}  max ${s.max}${unit}  avg ${s.avg}${unit}  peak @${new Date(s.peakAt).toISOString().slice(11, 16)}${trend}`;
	};
	const raw = rep.samples.slice(-5).map((s) => `  ${JSON.stringify(s)}`).join("\n");
	return [
		`usage ${t.id} "${t.name}" (window ${rep.windowMin}m, ${rep.count} samples, ${rep.procs ?? "?"} procs):`,
		line("cpu", rep.cpu, "%"),
		line("rss", rep.rss_mb, "MB"),
		line("gpu", rep.gpu, "%"),
		line("vram", rep.vram_mb, "MB"),
		`raw (last ${Math.min(5, rep.samples.length)}):`,
		raw,
		`full history: ${rep.file}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// /tasks panel
// ---------------------------------------------------------------------------

class TasksPanel {
	private view: "list" | "detail" = "list";
	private sel = 0;
	private detailId?: string;
	private tailLines = 10;
	private pendingKill?: string;
	private note = "";
	private tasks: TaskEntry[] = [];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private cwd: string,
		private theme: Theme,
		private onClose: () => void,
		private notify: (m: string, k: "info" | "warning" | "error") => void,
		private onRefresh: () => void,
	) {
		this.load();
	}

	private load(): void {
		this.tasks = snapshotRegistry(this.cwd).tasks;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.view === "detail") {
				this.view = "list";
				this.pendingKill = undefined;
				this.note = "";
				this.invalidate();
				return;
			}
			this.onClose();
			return;
		}
		if (this.view === "detail") {
			if (matchesKey(data, "l")) {
				this.tailLines = this.tailLines === 10 ? 25 : 10;
				this.invalidate();
			} else if (matchesKey(data, "return") || matchesKey(data, "left")) {
				this.view = "list";
				this.invalidate();
			} else if (matchesKey(data, "k") && this.detailId) {
				const id = this.detailId;
				this.view = "list";
				void this.kill(id);
			}
			return;
		}
		// list view
		if (this.tasks.length === 0) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up")) {
			this.sel = (this.sel - 1 + this.tasks.length) % this.tasks.length;
			this.note = "";
			this.invalidate();
		} else if (matchesKey(data, "down")) {
			this.sel = (this.sel + 1) % this.tasks.length;
			this.note = "";
			this.invalidate();
		} else if (matchesKey(data, "return") && this.tasks[this.sel]) {
			this.load();
			this.detailId = this.tasks[this.sel].id;
			this.view = "detail";
			this.note = "";
			this.invalidate();
		} else if (matchesKey(data, "k") && this.tasks[this.sel]) {
			const id = this.tasks[this.sel].id;
			if (this.pendingKill === id) {
				this.pendingKill = undefined;
				void this.kill(id);
			} else {
				this.pendingKill = id;
				this.note = `kill ${id}? press k again to confirm`;
			}
			this.invalidate();
		} else if (matchesKey(data, "l")) {
			this.tailLines = this.tailLines === 10 ? 25 : 10;
			this.invalidate();
		} else if (matchesKey(data, "c") && this.tasks[this.sel]) {
			this.note = `log: ${this.tasks[this.sel].log}`;
			this.invalidate();
		}
	}

	private async kill(id: string): Promise<void> {
		const r = await cancelTask(this.cwd, id);
		this.onRefresh();
		if (r.ok) this.notify(`task ${id} "${r.name}" stopped (${r.outcome})`, "info");
		else this.notify(r.error, "warning");
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];
		lines.push("");
		lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(3)) + th.fg("accent", " Tasks ") + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))), width));
		lines.push(truncateToWidth(`  ${th.fg("dim", this.cwd)}`, width));
		lines.push("");

		if (this.view === "detail" && this.detailId) {
			const t = this.tasks.find((x) => x.id === this.detailId);
			if (t) {
				lines.push(truncateToWidth(
					`  ${th.fg("accent", t.id)} ${th.fg(stateColor(t), stateLabel(t))} ${th.fg("muted", durationOf(t))} ${th.fg("text", `"${t.name}"`)}`,
					width,
				));
				lines.push(truncateToWidth(`  ${th.fg("dim", "command:")} ${th.fg("muted", t.command)}`, width));
				lines.push(truncateToWidth(`  ${th.fg("dim", "log:")} ${th.fg("muted", `${t.log} (${formatSize(t.logBytes)})`)}`, width));
				lines.push("");
				const tail = tailFile(t.log, 50 * 1024).split("\n").slice(-this.tailLines);
				lines.push(truncateToWidth(`  ${th.fg("dim", `--- last ${this.tailLines} lines ---`)}`, width));
				for (const line of tail) lines.push(truncateToWidth(`  ${line}`, width));
				lines.push("");
				lines.push(truncateToWidth(`  ${th.fg("dim", "l")}: ${this.tailLines}/25 lines   ${th.fg("dim", "k")}: kill   ${th.fg("dim", "enter/esc")}: back`, width));
			} else {
				lines.push(truncateToWidth(`  ${th.fg("dim", "task not found")}`, width));
			}
		} else if (this.tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No background tasks. Ask the agent to use spawn_background.")}`, width));
		} else {
			this.tasks.forEach((t, i) => {
				const marker = i === this.sel ? th.fg("accent", "▸") : " ";
				lines.push(truncateToWidth(
					`  ${marker} ${th.fg("accent", t.id)} ${th.fg(stateColor(t), stateLabel(t).padEnd(16))} ${th.fg("muted", durationOf(t).padStart(8))} ${th.fg("text", `"${t.name}"`)} ${th.fg("dim", t.command.length > Math.max(10, width - 60) ? t.command.slice(0, Math.max(10, width - 60)) + "…" : t.command)}`,
					width,
				));
			});
			lines.push("");
			if (this.note) {
				lines.push(truncateToWidth(`  ${th.fg(this.pendingKill ? "warning" : "dim", this.note)}`, width));
			}
			lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓")}: move   ${th.fg("dim", "enter")}: detail   ${th.fg("dim", "k")}: kill   ${th.fg("dim", "c")}: log path   ${th.fg("dim", "esc")}: close`, width));
		}
		lines.push("");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const recoveryDc = makeDeliveryCtx(pi, ctx, true); // recovery mode (nextTurn)
		try {
			const registry = await settleRegistry(ctx.cwd);
			clearStaleClaims(ctx.cwd, registry.tasks);

			// Recovery: report terminal transitions that happened while pi was closed.
			const running = registry.tasks.filter((t) => t.state === "running");
			const due = registry.tasks.filter(
				(t) => t.state !== "running" && t.callback && t.state !== "cancelled" && t.reported.state !== t.state,
			);
			if (due.length > 0) {
				const sent = await deliverEvents(ctx.cwd, due, recoveryDc, (claimed) => buildRecoveryMessage(claimed, running));
				if (sent.length > 0 && ctx.hasUI) {
					ctx.ui.notify(`task-monitor: ${sent.length} task event(s) while you were away — reported to the agent`, "info");
				}
			}
			recoveryDc.setFooter(footerText(registry.tasks));
		} catch (e) {
			if (ctx.hasUI) ctx.ui.notify(`task-monitor: recovery failed: ${(e as Error).message}`, "error");
		}
		// The poller must use LIVE delivery (followUp + triggerTurn) for exit callbacks.
		ensurePoller(ctx.cwd, makeDeliveryCtx(pi, ctx, false));
		void pruneOld(ctx.cwd) // best-effort 7-day prune of terminal tasks
			.catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopPollerFor(ctx.cwd); // tasks are intentionally durable — never killed here
	});

	pi.registerTool({
		name: "spawn_background",
		label: "Spawn Background",
		description:
			"Start a long-running shell command as a tracked background process. Non-blocking: returns immediately with a task id. The process keeps running even if pi is closed; output and exit code are stored in <cwd>/.pi/tasks/. Use for commands expected to run longer than a few minutes (dev servers, long builds, watchers, migrations). Use bash for short commands.",
		promptSnippet: "Spawn a long-running shell command as a tracked background process (non-blocking)",
		promptGuidelines: [
			"Use spawn_background (not bash) for commands expected to run longer than a few minutes or that must outlive this session (dev servers, long builds, watchers, migrations).",
			"spawn_background is for long-running shell processes; use task-planning tools (e.g. TaskCreate) for multi-step work plans — do not conflate the two.",
			"Check background processes with monitor (action=\"status\" or \"tail\"); never poll them with bash sleep loops.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run (executed via bash -lc in a subshell; stdout+stderr go to a log file)" }),
			name: Type.Optional(Type.String({ description: "Short human-readable label (default: derived from the command)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: current session cwd)" })),
			timeout_seconds: Type.Optional(Type.Number({ description: "Kill the task after this many seconds (optional; no default)" })),
			callback: Type.Optional(Type.Boolean({ description: "Wake the agent when the task exits (default: true)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd ? resolve(ctx.cwd, params.cwd.replace(/^@/, "")) : ctx.cwd;
			if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
			let entry: TaskEntry;
			try {
				// spawnTask: reserves the registry entry under the lock, spawns the
				// detached wrapper (dir must pre-exist — the wrapper redirects into
				// it ~300ms in), then records the pid under the lock.
				entry = await spawnTask(cwd, params.command, {
					name: params.name,
					timeoutSeconds: params.timeout_seconds ?? null,
					callback: params.callback ?? true,
				});
			} catch (e) {
				throw new Error(`spawn failed: ${(e as Error).message}`);
			}
			// Settle once: an instantly-dead command (e.g. `exit 3`) may already be
			// terminal. If so, the tool result below IS the notification — watermark
			// it so the poller doesn't send a duplicate callback.
			const settled = await settleRegistry(cwd);
			entry = settled.tasks.find((x) => x.id === entry.id)!;
			if (entry.state !== "running") {
				await withRegistryLock(cwd, (reg) => {
					const x = reg.tasks.find((y) => y.id === entry.id);
					if (x) x.reported = { state: x.state, logBytes: x.logBytes };
				});
				entry = loadRegistry(cwd).tasks.find((x) => x.id === entry.id)!;
			}
			refreshCtx(ctx);
			ensurePoller(cwd, makeDeliveryCtx(pi, ctx, false));

			const id = entry.id;
			const text =
				entry.state === "running"
					? [
							`Task ${id} "${entry.name}" started (pid ${entry.pid}).`,
							`Log: ${entry.log}`,
							`You will be notified when it exits (code + output tail). Check anytime with monitor(task_id="${id}", action="status"|"tail").`,
						].join("\n")
					: [
							`Task ${id} "${entry.name}" exited instantly with code ${entry.exitCode ?? "unknown"}`,
							`Log: ${entry.log}`,
							`Use monitor(task_id="${id}", action="tail") to read the output.`,
						].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { id, state: entry.state, exitCode: entry.exitCode, pid: entry.pid },
			};
		},
		renderCall(args, theme) {
			const cmd = typeof args.command === "string" ? args.command : "";
			const text =
				theme.fg("toolTitle", theme.bold("spawn_background ")) +
				theme.fg("accent", args.name ? `"${args.name}" ` : "") +
				theme.fg("dim", cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd);
			return new Text(text, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "starting..."), 0, 0);
			const c = result.content[0];
			return new Text(c?.type === "text" ? c.text : "", 0, 0);
		},
	});

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Inspect background processes started with spawn_background. Actions: status (all tasks, or one task with recent output), tail (last N lines of a task's log), usage (CPU/RAM/GPU/VRAM stats), wait (block until the task exits or the timeout elapses), kill (stop the task).",
		promptSnippet: "Check status, tail the log, inspect resource usage, wait for, or kill a background process",
		promptGuidelines: [
			"For resource problems (suspected OOM, memory leak, CPU spike), call monitor with action=\"usage\" before deciding to kill or restart.",
			"To block on a background task finishing, use monitor with action=\"wait\" (not a bash sleep loop).",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "tail", "usage", "wait", "kill"] as const),
			task_id: Type.Optional(Type.String({ description: "Task id from spawn_background. Omit with action=status to list all tasks; required for all other actions." })),
			lines: Type.Optional(Type.Number({ description: "For tail: number of lines (default 30, max 200)" })),
			window_minutes: Type.Optional(Type.Number({ description: "For usage: statistics window in minutes (default 30)" })),
			samples: Type.Optional(Type.Number({ description: "For usage: raw samples to return (default 20, max 100)" })),
			timeout_seconds: Type.Optional(Type.Number({ description: "For wait: max seconds to block (default 30, max 300)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "status") {
				// Settle (locked) so the agent always sees current truth.
				const registry = await settleRegistry(ctx.cwd);
				const tasks = registry.tasks;
				ctx.ui.setStatus("task-monitor", footerText(tasks));
				if (!params.task_id) {
					return {
						content: [{ type: "text", text: listText(tasks, ctx.cwd) }],
						details: { count: tasks.length },
					};
				}
				const t = findTask(ctx.cwd, params.task_id);
				return { content: [{ type: "text", text: oneText(t) }], details: { id: t.id, state: t.state } };
			}
			const t = findTask(ctx.cwd, params.task_id!);
			if (params.action === "tail") {
				const n = Math.min(200, Math.max(1, Math.round(params.lines ?? 30)));
				return { content: [{ type: "text", text: tailText(t, n) }], details: { id: t.id, logBytes: t.logBytes } };
			}
			if (params.action === "kill") {
				const r = await cancelTask(ctx.cwd, t.id);
				if (!r.ok) throw new Error(r.error);
				return {
					content: [{ type: "text", text: `Task ${t.id} "${r.name}" stopped (${r.outcome}). No completion notice will be sent for it.` }],
					details: { id: t.id, outcome: r.outcome },
				};
			}
			if (params.action === "wait") {
				const maxSec = Math.min(300, Math.max(1, Math.round(params.timeout_seconds ?? 30)));
				const deadline = Date.now() + maxSec * 1000;
				let aborted = false;
				const onAbort = () => (aborted = true);
				_signal?.addEventListener?.("abort", onAbort, { once: true });
				try {
					for (;;) {
						const cur = findTask(ctx.cwd, t.id);
						if (cur.state !== "running") {
							const tail = tailFile(cur.log, 8192).split("\n").filter((x) => x.length > 0).slice(-20).join("\n");
							return {
								content: [{
									type: "text",
									text: `Task ${cur.id} "${cur.name}" ${stateLabel(cur)} after ${durationOf(cur)}.${tail ? `\n--- last 20 lines ---\n${tail}` : ""}`,
								}],
								details: { id: cur.id, state: cur.state, exitCode: cur.exitCode },
							};
						}
						if (aborted) {
							return {
								content: [{ type: "text", text: `Wait interrupted. Task ${t.id} is still running; call monitor(action="wait") again to resume waiting.` }],
								details: { id: t.id, interrupted: true },
							};
						}
						const remaining = deadline - Date.now();
						if (remaining <= 0) break;
						await new Promise((r) => setTimeout(r, Math.min(500, remaining)));
					}
					const cur = findTask(ctx.cwd, t.id);
					if (cur.state !== "running") {
						const tail = tailFile(cur.log, 8192).split("\n").filter((x) => x.length > 0).slice(-20).join("\n");
						return {
							content: [{ type: "text", text: `Task ${cur.id} "${cur.name}" ${stateLabel(cur)} after ${durationOf(cur)}.${tail ? `\n--- last 20 lines ---\n${tail}` : ""}` }],
							details: { id: cur.id, state: cur.state, exitCode: cur.exitCode },
						};
					}
					return {
						content: [{ type: "text", text: `Task ${t.id} "${cur.name}" still ${cur.state} after ${maxSec}s. It will keep running; call monitor(action="wait") again to continue waiting, or action="kill" to stop it.` }],
						details: { id: t.id, state: cur.state, timedOut: true },
					};
				} finally {
					_signal?.removeEventListener?.("abort", onAbort);
				}
			}
			// usage
			const rep = usageReport(
				t,
				Math.max(1, Math.round(params.window_minutes ?? 30)),
				Math.min(100, Math.max(1, Math.round(params.samples ?? 20))),
			);
			if (!rep) {
				return {
					content: [{ type: "text", text: `No usage samples for ${t.id} yet (task too new, or sampling unavailable on this platform). Log: ${t.log}` }],
					details: { id: t.id },
				};
			}
			return { content: [{ type: "text", text: usageText(t, rep) }], details: { id: t.id, count: rep.count } };
		},
		renderCall(args, theme) {
			const text =
				theme.fg("toolTitle", theme.bold("monitor ")) +
				theme.fg("muted", args.action) +
				(args.task_id ? theme.fg("accent", ` ${args.task_id}`) : "") +
				(args.lines ? theme.fg("dim", ` ${args.lines} lines`) : "");
			return new Text(text, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "inspecting..."), 0, 0);
			const c = result.content[0];
			return new Text(c?.type === "text" ? c.text : "", 0, 0);
		},
	});

	pi.registerCommand("tasks", {
		description: "List and manage background tasks (spawn_background)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tasks requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) =>
				new TasksPanel(
					ctx.cwd,
					theme,
					done,
					(m, k) => ctx.ui.notify(m, k),
					() => refreshCtx(ctx),
				),
			);
			refreshCtx(ctx);
		},
	});
}

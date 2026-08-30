// task-monitor — durable background process tracking for pi.
//
//   - spawn_background tool (detached spawn, disk registry, survives pi exit)
//   - kill_background tool (SIGTERM → SIGKILL)
//   - /tasks TUI panel (list, detail/tail, kill)
//   - 3s poller: state settle, CPU/RAM/GPU/VRAM sampling, exit callbacks
//   - session_start recovery report for events that happened while closed
//
// Registry writes are serialized through withRegistryLock (single-writer);
// settleRegistry (poller.ts) is the only place state transitions happen.

import {
	formatSize,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import { ensurePoller, pruneDelivered, pruneOld, settleRegistry, stopPollerFor } from "./poller.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Build a DeliveryCtx. `recovery` selects the safe session_start delivery mode:
 * - live callbacks (poller): steer + triggerTurn — wake the agent now.
 *   Busy agent: steer is injected after the current tool-call batch, before the
 *   next LLM call (mid-turn notice); followUp would hold the event until the
 *   whole turn finishes. Idle agent: triggerTurn starts a turn immediately
 *   (deliverAs is moot when not streaming). No prompt() race: while streaming
 *   steer only enqueues, and the user prompt was already submitted.
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
				recovery ? { deliverAs: "nextTurn" } : { deliverAs: "steer", triggerTurn: true },
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
			// Delivered terminal tasks are disposable now; also sweeps leftovers
			// from sessions where the poller stopped before pruning.
			await pruneDelivered(ctx.cwd);
			recoveryDc.setFooter(footerText(snapshotRegistry(ctx.cwd).tasks));
		} catch (e) {
			if (ctx.hasUI) ctx.ui.notify(`task-monitor: recovery failed: ${(e as Error).message}`, "error");
		}
		// The poller must use LIVE delivery (steer + triggerTurn) for exit callbacks.
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
			"You will be notified via callback when the task exits; use /tasks (TUI) to inspect manually.",
			"Never poll background processes with bash sleep loops.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run (executed via bash -lc in a subshell; stdout+stderr go to a log file)" }),
			name: Type.Optional(Type.String({ description: "Short human-readable label (default: derived from the command)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: current session cwd)" })),
			timeout_seconds: Type.Optional(Type.Number({ description: "Kill the task after this many seconds (optional; no default)" })),
			callback: Type.Optional(Type.Boolean({ description: "Wake the agent when the task exits (default: true)" })),
			log_file: Type.Optional(Type.String({ description: "Mirror output file (absolute, or relative to the task cwd): output is appended there via tee, in real time, and the file is never auto-deleted — it accumulates across runs. The managed .pi/tasks/ log remains the primary record. Default: managed log only." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd ? resolve(ctx.cwd, params.cwd.replace(/^@/, "")) : ctx.cwd;
			if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
			let logFile: string | undefined;
			if (params.log_file) {
				logFile = resolve(cwd, params.log_file.replace(/^@/, ""));
				mkdirSync(dirname(logFile), { recursive: true });
			}
			let entry: TaskEntry;
			try {
				// spawnTask: reserves the registry entry under the lock, spawns the
				// detached wrapper (dir must pre-exist — the wrapper redirects into
				// it ~300ms in), then records the pid under the lock.
				entry = await spawnTask(cwd, params.command, {
					name: params.name,
					timeoutSeconds: params.timeout_seconds ?? null,
					callback: params.callback ?? true,
					logFile,
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
				void pruneDelivered(cwd).catch(() => {}); // tool result was the notification
			}
			refreshCtx(ctx);
			ensurePoller(cwd, makeDeliveryCtx(pi, ctx, false));

			const id = entry.id;
			const notify =
				params.callback === false
					? "No exit notification will be sent (callback: false) — read the log to check on it."
					: "You will be notified when it exits (code + output tail).";
			const persistNote = logFile
				? ` Output is also appended (tee) to ${logFile}; that file accumulates across runs and is never auto-deleted.`
				: "";
			const text =
				entry.state === "running"
					? [
							`Task ${id} "${entry.name}" started (pid ${entry.pid}).`,
							`Log: ${entry.log}.${persistNote}`,
							notify,
						].join("\n")
					: [
							`Task ${id} "${entry.name}" exited instantly with code ${entry.exitCode ?? "unknown"}`,
							`Log: ${entry.log}`,
							`Use /tasks (TUI) to inspect the log manually.`,
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
		name: "kill_background",
		label: "Kill Background",
		description:
			"Stop a background process started with spawn_background. SIGTERM the whole process group, escalate to SIGKILL after a grace period. No completion notice is sent for a killed task.",
		promptSnippet: "Stop a background process",
		promptGuidelines: [
			"Use kill_background only when you know the task must stop (e.g. wrong command, resource problem); otherwise let it finish and rely on the exit callback.",
		],
		parameters: Type.Object({
			task_id: Type.String({ description: "Task id from spawn_background" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const r = await cancelTask(ctx.cwd, params.task_id);
			if (!r.ok) throw new Error(r.error);
			refreshCtx(ctx);
			return {
				content: [{ type: "text", text: `Task ${params.task_id} "${r.name}" stopped (${r.outcome}). No completion notice will be sent for it.` }],
				details: { id: params.task_id, outcome: r.outcome },
			};
		},
		renderCall(args, theme) {
			const text =
				theme.fg("toolTitle", theme.bold("kill_background ")) +
				theme.fg("accent", typeof args.task_id === "string" ? args.task_id : "");
			return new Text(text, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "stopping..."), 0, 0);
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

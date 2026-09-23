// format.ts — shared display helpers (durations, state labels/colors, footer).

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { FooterDetailTheme } from "../shared/footer-bus.js";
import type { TaskEntry } from "./registry.js";

export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function durationOf(t: TaskEntry, now = Date.now()): string {
	const end = t.state === "running" ? now : (t.endedAt ?? t.createdAt);
	return fmtDur(end - t.createdAt);
}

export function stateLabel(t: TaskEntry): string {
	if (t.state === "running") return "running";
	if (t.state === "exited") return t.exitCode === null ? "exited(unknown)" : `exited(${t.exitCode})`;
	return t.state;
}

export function stateColor(t: TaskEntry): ThemeColor {
	switch (t.state) {
		case "running":
			return "accent";
		case "exited":
			return t.exitCode === 0 ? "success" : "error";
		case "cancelled":
			return "muted";
		case "timed_out":
		case "log_overflow":
			return "warning";
	}
}

// ---------------------------------------------------------------------------
// footer block (footer-bus detail; structure mirrors subagent/footer.ts)
// ---------------------------------------------------------------------------

/** Terminal tasks stay in the footer this long after ending (the "flash"). */
export const FINISH_FLASH_MS = 3_000;
const NARROW_WIDTH = 48;
const MAX_RUNNING_ITEMS = 4;
const MAX_FINISHED_ITEMS = 4;

/**
 * Render the task-monitor footer block. Pure; `now` is injectable for tests.
 * Running tasks always show; terminal tasks only within FINISH_FLASH_MS of
 * `endedAt` (stateless — the registry carries the real exit time). Cancelled
 * tasks never show: an explicit stop is not news (same rule as delivery).
 */
export function renderTaskBlock(
	tasks: TaskEntry[],
	width: number,
	theme: FooterDetailTheme,
	now = Date.now(),
): string[] | undefined {
	const running = tasks.filter((t) => t.state === "running");
	const finished = tasks
		.filter(
			(t) =>
				t.state !== "running" &&
				t.state !== "cancelled" &&
				now - (t.endedAt ?? t.createdAt) <= FINISH_FLASH_MS,
		)
		.sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
	if (running.length === 0 && finished.length === 0) return undefined;

	const count = running.length > 0 ? `${running.length} running` : `${finished.length} finished`;

	if (width < NARROW_WIDTH) {
		let line = theme.fg("dim", "⎿ ") + theme.fg("text", `Tasks: ${count}`);
		if (running.length > 0) {
			for (const t of running) line += theme.fg("dim", ` · ${t.id} ${durationOf(t, now)}`);
		} else {
			for (const t of finished) line += theme.fg("dim", ` · ${t.id} ${stateLabel(t)}`);
		}
		return [line];
	}

	const lines: string[] = [theme.fg("dim", "⎿ ") + theme.fg("text", `Tasks: ${count}`)];
	const runningShown = running.slice(0, MAX_RUNNING_ITEMS);
	for (const t of runningShown) {
		lines.push(
			`  ${theme.fg("accent", "▸")} ${theme.fg("accent", t.id)} ${theme.fg("text", `"${t.name}"`)} ${theme.fg("dim", durationOf(t, now))}`,
		);
	}
	const finishedShown = finished.slice(0, MAX_FINISHED_ITEMS);
	for (const t of finishedShown) {
		const color = stateColor(t);
		const icon = t.state === "exited" ? (t.exitCode === 0 ? "✓" : "✗") : "⚠";
		lines.push(
			`  ${theme.fg(color, icon)} ${theme.fg(color, t.id)} ${theme.fg("text", `"${t.name}"`)} ${theme.fg(color, stateLabel(t))} ${theme.fg("dim", fmtDur((t.endedAt ?? t.createdAt) - t.createdAt))}`,
		);
	}
	const extra = Math.max(0, running.length + finished.length - (runningShown.length + finishedShown.length));
	if (extra > 0) lines.push(theme.fg("dim", `… +${extra} more`));
	return lines;
}

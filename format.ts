// format.ts — shared display helpers (durations, state labels/colors, footer block).

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
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
// footer block (footer:block payload; protocol and format live in footer-composer.ts)
// ---------------------------------------------------------------------------

export const FOOTER_BLOCK_CHANNEL = "footer:block";
export const FOOTER_SYNC_CHANNEL = "footer:sync";

function footerState(t: TaskEntry): "running" | "success" | "error" | "warning" {
	switch (t.state) {
		case "running":
			return "running";
		case "exited":
			return t.exitCode === 0 ? "success" : "error";
		default:
			return "warning"; // timed_out / log_overflow
	}
}

/**
 * Map the registry to a footer:block snapshot. Pure. Cancelled tasks never
 * show: an explicit stop is not news (same rule as delivery). The composer
 * shows terminal tasks only within its flash window after `endedAt`.
 */
export function toFooterBlock(tasks: TaskEntry[]) {
	return {
		v: 1 as const,
		id: "task-monitor",
		label: "Tasks",
		items: tasks
			.filter((t) => t.state !== "cancelled")
			.map((t) => ({
				key: t.id,
				state: footerState(t),
				title: t.id,
				text: t.state === "running" ? `"${t.name}"` : `"${t.name}" ${stateLabel(t)}`,
				startedAt: t.createdAt,
				...(t.state !== "running" ? { endedAt: t.endedAt ?? t.createdAt } : {}),
			})),
	};
}

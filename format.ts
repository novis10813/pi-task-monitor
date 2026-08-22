// format.ts — shared display helpers (durations, state labels/colors, footer).

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TaskEntry } from "./registry.js";

export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function durationOf(t: TaskEntry): string {
	const end = t.state === "running" ? Date.now() : (t.endedAt ?? t.createdAt);
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

export function footerText(tasks: TaskEntry[]): string | undefined {
	const running = tasks.filter((t) => t.state === "running").length;
	if (running === 0) return undefined;
	return `${running} running`;
}

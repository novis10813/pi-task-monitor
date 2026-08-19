// usage.ts — per-process-group resource sampling (CPU / RAM / GPU / VRAM).
//
// Linux-first (reads /proc). macOS falls back to `ps` (lifetime-average CPU,
// documented limitation). GPU via nvidia-smi when present (auto-detected,
// cached); otherwise gpu/vram are null with zero overhead.
//
// Samples are appended to <id>.usage.jsonl (single-generation 2MiB rotation).
// The writer is the poller only (single writer per task per pi process;
// multiple pi processes appending concurrently is acceptable for
// append-only observation data — small O_APPEND writes are atomic).

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import type { TaskEntry } from "./registry.js";

const HZ = 100; // Linux USER_HZ (clock ticks per second)
const PAGE = 4096;
const USAGE_CAP_BYTES = 2 * 1024 * 1024;

export interface UsageSample {
	t: number;
	cpu: number | null; // % of one core, summed over the group
	rss_mb: number | null;
	gpu: number | null; // % summed over group pids (nvidia-smi pmon)
	vram_mb: number | null;
	n: number; // process count in the group
}

interface TickMark {
	at: number;
	ticks: number;
}
// Previous CPU tick marks per task id (for delta computation).
const prevTicks = new Map<string, TickMark>();
let nvidia: boolean | null = null; // null = undetected

export function usageFileFor(t: TaskEntry): string {
	return t.log.replace(/\.log$/, ".usage.jsonl");
}

function isLinux(): boolean {
	return process.platform === "linux";
}

// ---------------------------------------------------------------------------
// process group enumeration + per-pid metrics
// ---------------------------------------------------------------------------

/** All pids in the subtree rooted at `root` (inclusive). */
function groupPids(root: number): number[] {
	if (!isLinux()) return [root];
	const children = new Map<number, number[]>();
	try {
		for (const e of readdirSync("/proc")) {
			if (!/^\d+$/.test(e)) continue;
			const s = procStatFields(Number(e));
			if (s) (children.get(s.ppid) ?? children.set(s.ppid, []).get(s.ppid)!).push(Number(e));
		}
	} catch {
		return [root];
	}
	const out = [root];
	const seen = new Set([root]);
	const q = [root];
	while (q.length) {
		const c = q.shift()!;
		for (const ch of children.get(c) ?? []) {
			if (!seen.has(ch)) {
				seen.add(ch);
				out.push(ch);
				q.push(ch);
			}
		}
	}
	return out;
}

function procStatFields(pid: number): { ppid: number; utime: number; stime: number } | null {
	try {
		const st = readFileSync(`/proc/${pid}/stat`, "utf8");
		const i = st.lastIndexOf(")"); // comm may contain spaces/parens
		const f = st.slice(i + 2).split(" ");
		// after ')': [0]=state [1]=ppid ... [11]=utime [12]=stime
		return { ppid: Number(f[1]), utime: Number(f[11]), stime: Number(f[12]) };
	} catch {
		return null;
	}
}

function procRssMb(pid: number): number | null {
	try {
		const f = readFileSync(`/proc/${pid}/statm`, "utf8").split(/\s+/);
		return (Number(f[1]) * PAGE) / 1048576;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// nvidia-smi (best effort, cached detection)
// ---------------------------------------------------------------------------

function nvidiaSmi(args: string[]): Promise<string | null> {
	if (nvidia === false) return Promise.resolve(null);
	return new Promise((res) => {
		execFile("nvidia-smi", args, { timeout: 2500 }, (err, stdout) => {
			if (err) {
				nvidia = false;
				res(null);
			} else {
				nvidia = true;
				res(stdout);
			}
		});
	});
}

/** Parse `nvidia-smi pmon -c 1 -s u` into pid -> sm% (summed per pid). */
async function gpuPct(): Promise<Map<number, number> | null> {
	const out = await nvidiaSmi(["pmon", "-c", "1", "-s", "u"]);
	if (out === null) return null;
	const m = new Map<number, number>();
	for (const line of out.split("\n")) {
		// columns: # gpu pid type sm mem enc dec pup pdp
		const f = line.trim().split(/\s+/);
		if (f.length < 6 || !/^\d+$/.test(f[2])) continue;
		const pid = Number(f[2]);
		const sm = Number(f[4]);
		if (Number.isFinite(sm)) m.set(pid, (m.get(pid) ?? 0) + sm);
	}
	return m;
}

/** Parse `nvidia-smi --query-compute-apps=pid,used_memory` into pid -> MiB. */
async function vramMb(): Promise<Map<number, number> | null> {
	const out = await nvidiaSmi(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]);
	if (out === null) return null;
	const m = new Map<number, number>();
	for (const line of out.split("\n")) {
		const f = line.split(",").map((s) => s.trim());
		if (f.length < 2) continue;
		const pid = Number(f[0]);
		const mem = Number(f[1]);
		if (Number.isFinite(pid) && Number.isFinite(mem)) m.set(pid, (m.get(pid) ?? 0) + mem);
	}
	return m;
}

// ---------------------------------------------------------------------------
// sampling
// ---------------------------------------------------------------------------

/**
 * Sample one usage row for every given task. One nvidia-smi round per tick
 * (shared across tasks). First call per task establishes the CPU baseline.
 */
export async function sampleUsage(tasks: TaskEntry[]): Promise<void> {
	if (tasks.length === 0) return;
	const now = Date.now();
	const gpu = isLinux() || nvidia !== null ? await gpuPct() : null;
	const vram = gpu !== null ? await vramMb() : null;

	for (const t of tasks) {
		const pids = groupPids(t.pid);
		if (pids.length === 0) continue;

		let ticks = 0;
		let rss = 0;
		let rssOk = true;
		let anyStat = false;
		for (const pid of pids) {
			const s = isLinux() ? procStatFields(pid) : null;
			if (s) {
				ticks += s.utime + s.stime;
				anyStat = true;
			}
			const r = isLinux() ? procRssMb(pid) : null;
			if (r === null) rssOk = false;
			else rss += r;
		}
		if (!anyStat) continue;

		// CPU delta over the previous tick
		let cpu: number | null = null;
		const prev = prevTicks.get(t.id);
		if (prev && now > prev.at) {
			const dt = (now - prev.at) / 1000;
			cpu = Math.max(0, ((ticks - prev.ticks) / HZ) / dt) * 100;
		}
		prevTicks.set(t.id, { at: now, ticks });

		// GPU / VRAM summed over the group
		let g: number | null = null;
		let v: number | null = null;
		if (gpu) g = pids.reduce((acc, pid) => acc + (gpu.get(pid) ?? 0), 0) || null;
		if (vram) v = pids.reduce((acc, pid) => acc + (vram.get(pid) ?? 0), 0) || null;

		appendSample(t, {
			t: now,
			cpu: cpu === null ? null : Math.round(cpu * 10) / 10,
			rss_mb: rssOk ? Math.round(rss * 10) / 10 : null,
			gpu: g === null ? null : Math.round(g),
			vram_mb: v === null ? null : Math.round(v),
			n: pids.length,
		});
	}
}

/** Drop CPU baseline for terminal tasks (bounded map). */
export function forgetTask(id: string): void {
	prevTicks.delete(id);
}

function appendSample(t: TaskEntry, s: UsageSample): void {
	const p = usageFileFor(t);
	try {
		if (existsSync(p) && statSync(p).size > USAGE_CAP_BYTES) renameSync(p, `${p}.prev`);
		appendFileSync(p, JSON.stringify(s) + "\n");
	} catch {
		/* observation data loss is non-fatal */
	}
}

// ---------------------------------------------------------------------------
// reading (monitor action=usage)
// ---------------------------------------------------------------------------

export interface UsageStat {
	min: number;
	max: number;
	avg: number;
	peakAt: number; // timestamp of max
	trend: "rising" | "falling" | "flat";
}

export interface UsageReport {
	count: number;
	procs: number | null;
	windowMin: number;
	file: string;
	samples: UsageSample[]; // last N raw samples
	cpu: UsageStat | null;
	rss_mb: UsageStat | null;
	gpu: UsageStat | null;
	vram_mb: UsageStat | null;
}

export function usageReport(t: TaskEntry, windowMin = 30, maxSamples = 20): UsageReport | null {
	const file = usageFileFor(t);
	if (!existsSync(file)) return null;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const cutoff = Date.now() - windowMin * 60000;
	const samples: UsageSample[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const s = JSON.parse(line) as UsageSample;
			if (typeof s.t === "number" && s.t >= cutoff) samples.push(s);
		} catch {
			/* skip corrupt line */
		}
	}
	if (samples.length === 0) return null;

	const stat = (key: keyof Omit<UsageSample, "t" | "n">): UsageStat | null => {
		const vals: Array<{ t: number; v: number }> = [];
		for (const s of samples) {
			const v = s[key];
			if (typeof v === "number") vals.push({ t: s.t, v });
		}
		if (vals.length === 0) return null;
		const vs = vals.map((x) => x.v);
		const max = Math.max(...vs);
		const peakAt = vals.find((x) => x.v === max)!.t;
		const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
		const half = Math.floor(vals.length / 2);
		const a1 = vals.slice(0, half).reduce((a, b) => a + b.v, 0) / Math.max(1, half);
		const a2 = vals.slice(half).reduce((a, b) => a + b.v, 0) / Math.max(1, vals.length - half);
		const trend = a2 > a1 * 1.25 ? "rising" : a2 < a1 * 0.75 ? "falling" : "flat";
		return { min: Math.min(...vs), max, avg: Math.round(avg * 10) / 10, peakAt, trend };
	};

	return {
		count: samples.length,
		procs: samples[samples.length - 1].n,
		windowMin,
		file,
		samples: samples.slice(-maxSamples),
		cpu: stat("cpu"),
		rss_mb: stat("rss_mb"),
		gpu: stat("gpu"),
		vram_mb: stat("vram_mb"),
	};
}

/** One-line resource summary for exit callbacks (non-zero exits). */
export function usageSummaryLine(t: TaskEntry, windowMin = 30): string | null {
	const r = usageReport(t, windowMin, 1);
	if (!r) return null;
	const parts: string[] = [];
	if (r.cpu) parts.push(`cpu peak ${r.cpu.max}%`);
	if (r.rss_mb) parts.push(`rss peak ${r.rss_mb.max}MB (${r.rss_mb.trend})`);
	if (r.gpu) parts.push(`gpu peak ${r.gpu.max}%`);
	if (r.vram_mb) parts.push(`vram peak ${r.vram_mb.max}MB`);
	if (parts.length === 0) parts.push("gpu/vram n/a");
	return parts.join(" · ");
}

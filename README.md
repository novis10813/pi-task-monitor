# task-monitor

A pi extension for **durable background process tracking**. Two focused tools,
zero npm dependencies (Node builtins only), POSIX only (Linux first; macOS
degrades CPU sampling to lifetime averages).

## What it does

- **`spawn_background`** — start a long-running shell command as a *detached*
  process. It keeps running when pi is closed, killed, or the machine reboots
  (well: when pi is closed — the process is reparented to init). Output goes to
  a per-task log (optionally mirrored to a caller-provided `log_file`, see
  below); the real exit code **and exit time** go to a sidecar file.
- **`kill_background`** — stop a task: SIGTERM the whole process group,
  escalate to SIGKILL after 5s. No completion notice is sent for a killed task.
- **`/tasks`** — TUI panel (for the human): list, detail + live tail (`l`),
  kill (`k`, confirm), log path (`c`).
- **Exit callback** — when a tracked task exits (code 0 or not), the agent is
  woken with a `[task-event]` message: state, exit code, duration, log tail,
  and — for non-zero exits — a resource-usage peak line (helps diagnose OOM /
  runaway CPU).
- **Session-aware callbacks** — a task belongs to the pi session that spawned
  it. Its original pi process gets first chance to report completion; if that
  process quits or switches sessions, another process attached to the same
  session may report it. Even if that other window was idle before the task
  was spawned, its 5s owner heartbeat discovers the new registry entry and
  reattaches its poller. Other sessions in the workspace never claim it.
- **Recovery report** — the next `session_start` of the **owning session**
  reports its unreported exits as `[task-event recovery]`. A different session
  may still inspect workspace tasks via `/tasks`, but cannot consume callbacks.
- **Footer** — publishes a `footer:block` snapshot of the registry over
  `pi.events` after every state-affecting event (and on each 3s poller tick
  while tasks run); `footer-composer` owns the format, live durations and the
  3s flash for tasks that just terminated (`✓`/`✗` + exit code, `⚠` for
  timeout/log-overflow). `cancelled` never shows (an explicit stop is not
  news). Re-sends on `footer:sync`. Details and killing stay in `/tasks`.
- **Prune** — two-tier: a terminal task is removed (registry entry + log/exit/
  usage/claim files) on the tick after its transition was delivered to the
  agent; the 7-day age-based prune remains as a fallback for entries without
  an auto-deliverable callback (`callback=false` or legacy ownerless tasks).
  Running tasks are never pruned.
- **Persistent log mirror (`log_file`)** — pass a path (absolute, or relative
  to the task `cwd`; parent dirs are created) and output is **tee'd** into it
  (append mode) in real time, while the managed per-task log remains the
  primary record (tail, overflow cap, cleanup all unchanged). The mirror
  accumulates across runs and is never pruned; only the managed
  registry/log/exit/usage/claim files are cleaned up.

## Why this design (the two gaps it fills)

Existing pi background-task extensions (pi-background-tasks, pi-tmux, etc.)
tie tasks to the *session process*. Close the TUI and the tracker is gone:
no one records the exit, no one wakes the agent later.

task-monitor's source of truth is **on disk** (`<project>/.pi/tasks/`):

```
.pi/tasks/
  registry.json          # task list + states + "reported" watermarks
  <id>.log               # stdout+stderr (20 MiB hard cap -> log_overflow kill)
  <id>.exit              # "<exit-code> <epoch-seconds>" sidecar
  <id>.usage.jsonl       # 3s-interval resource samples (2 MiB, 1-gen rotation)
  <id>.claim             # transient cross-process "I will report this" locks
  owners/<process-id>.json # live pi process + current session (5s heartbeat)
  .registry.lock         # transient single-writer lock (O_EXCL, stale-broken)
```

Mechanism per task:

```
bash -lc 'cd <cwd> && ( <command> ) > <log> 2>&1; printf "%s %s\n" $? "$(date +%s)" > <exit>'
```

With `log_file` set, the run becomes `set -o pipefail && ( <command> ) 2>&1 |
tee -a <log_file> > <log>` so `pipefail` preserves the real exit code.

spawned with `detached: true` + `unref()`. Bash becomes the process-group
leader, so `kill(-pid)` stops the whole tree (npm -> node -> ...). The command
runs in a **subshell** so a user `exit N` can't skip the sidecar write.

## Guarantees & documented trade-offs

- **Callback delivery is at-most-once, never duplicated.** Each task's
  transition is claimed (`O_EXCL` file, safe across pi processes), watermarked
  in the registry (durably, before the message is sent), then sent; a crash or
  session switch in the save→send window loses that one notification, and with
  it the task's record (delivered-looking tasks are pruned). The `/tasks` panel
  shows a task until it is delivered or aged out; the owning session's next
  start re-reports it if the watermark was never written.
- **Cancelled tasks never notify** (an explicit stop isn't news); the
  suppression is durable via the watermark.
- **`endedAt` accuracy:** the sidecar carries the real exit time, so durations
  are correct even when the exit is first observed after a restart. Tasks that
  died without a sidecar (OOM, external SIGKILL) show `exited(unknown)`.
- **Single writer:** all registry mutations go through `withRegistryLock`
  (in-process mutex + O_EXCL file lock with 2s stale-break, fresh read →
  mutate → atomic tmp+rename save). Two pi sessions on one project are safe.
- **Poller cost:** one 3s tick per project per open pi process while tasks run
  or a completion for that session is waiting for the original process to
  leave. A 5s presence heartbeat tracks which pi process still owns its
  session (30s stale threshold). Session-file mtime is not used: an idle agent
  may not write to its session file for hours. The 3s poller self-stops when
  idle, but the 5s heartbeat still checks for tasks created by other windows;
  `session_start` also settles.
- **GPU:** `nvidia-smi` auto-detected once per process; absent ⇒
  `gpu`/`vram` are `null` with zero overhead (AMD/ROCm is out of scope for v1).
- **Log cap:** 20 MiB hard cap, no rotation (avoids sparse-file / orphan-inode
  pitfalls); overflow kills the group and marks `log_overflow`.
- **Legacy entries:** tasks created before owner tracking lack session identity;
  they remain visible in `/tasks` but are not auto-delivered to a random
  session. The existing 7-day age-based prune still applies.
- **Custom `cwd`:** changes the command's execution directory only. New tasks
  are stored in the launching session's workspace registry, so `/tasks`, kill,
  and restart recovery find them. Older tasks previously stored inside a
  custom cwd are not migrated automatically.

## File map

| file | role |
|---|---|
| `index.ts` | extension entry: tools, `/tasks` panel, session hooks, delivery ctx |
| `registry.ts` | disk registry: atomic save, probe, single-writer lock |
| `spawner.ts` | detached spawn, wrapper, `killGroup`, `cancelTask` |
| `poller.ts` | `settleRegistry` (the only state-transition code), 3s heartbeat, prune |
| `usage.ts` | /proc CPU (jiffies Δ) + RSS, nvidia-smi GPU%/VRAM, JSONL sampling, exit-callback resource summary |
| `delivery.ts` | claim + watermark + send (at-most-once), recovery message builder |
| `ownership.ts` | session/process ownership and on-disk process presence |
| `format.ts` | display helpers (durations, labels, colors) and the `footer:block` mapper |

## Development

- Type-check: `tsc -p tsconfig.json` (paths point at the installed pi dist).
- Tests: `node task-monitor.test.mjs && node ownership.test.mjs`.
- Smoke test (mock pi, no LLM): `/tmp/tm-spike/smoke.mjs` — 41 checks covering
  spawn, callbacks, recovery, kill, prune, cross-tick concurrency. (Written for
  the pre-v1 tool set; the `monitor`-tool checks no longer apply.)
- Runtime deps: none (pure Node ≥ 22.19 builtins). Loaded by pi's jiti with the
  standard `@earendil-works/*` + `typebox` aliases.

## Known non-goals (v1)

- Interactive TUIs (use tmux via the `long-running-cli` skill for those).
- Windows.
- AMD/Intel GPU metrics.
- Cross-machine durability (the registry is per-project, on the local disk).
- Auto-routing to unrelated sessions in the same workspace or to fork/clone
  descendants. Restart the original session to receive its callback. An
  ephemeral `--no-session` run has no resumable session, so tasks still
  running when it closes have no automatic callback recipient.

// Ownership routing and extension lifecycle tests (no LLM, isolated temp workspace).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_PKG = path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
const { createJiti } = await import(path.join(PI_PKG, "node_modules", "jiti", "lib", "jiti.mjs"));
const requireFromPi = createRequire(path.join(PI_PKG, "dist", "core", "extensions", "loader.js"));
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": path.join(PI_PKG, "dist", "index.js"),
    "@earendil-works/pi-tui": path.join(PI_PKG, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
    typebox: requireFromPi.resolve("typebox"),
    "typebox/compile": requireFromPi.resolve("typebox/compile"),
    "typebox/value": requireFromPi.resolve("typebox/value"),
  },
});
const { SessionOwnership } = await jiti.import(fileURLToPath(new URL("./ownership.ts", import.meta.url)));
const registry = await jiti.import(fileURLToPath(new URL("./registry.ts", import.meta.url)));
const { ensurePoller, runTick, settleRegistry, stopPollerFor } = await jiti.import(fileURLToPath(new URL("./poller.ts", import.meta.url)));
const { deliverEvents } = await jiti.import(fileURLToPath(new URL("./delivery.ts", import.meta.url)));
const ext = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tm-ownership-"));
// A/B/C simulate separate pi processes within this test's single Node process.
const a = new SessionOwnership(randomUUID());
const b = new SessionOwnership(randomUUID());
const c = new SessionOwnership(randomUUID());
function task(id, owner) {
  const dir = registry.tasksDir(cwd);
  return {
    id, name: "build", command: "true", cwd, pid: 0,
    log: path.join(dir, `${id}.log`), exitFile: path.join(dir, `${id}.exit`),
    createdAt: Date.now() - 2000, timeoutSeconds: null, callback: true,
    state: "exited", exitCode: 0, endedAt: Date.now(), logBytes: 0,
    reported: { state: "running", logBytes: 0 }, owner,
  };
}
function dc(lease, sessionId, sent) {
  return {
    isCurrent: () => lease.current(cwd, sessionId),
    belongsToSession: (t) => lease.belongsToSession(t, sessionId),
    canDeliver: (t) => lease.canDeliver(cwd, t, sessionId),
    sendMessage: async (content) => { sent.push(content); },
    notify: () => {}, notifyFooter: () => {},
  };
}
function mock(sessionId, workspace = cwd) {
  const handlers = {};
  const tools = {};
  const sent = [];
  const pi = {
    on: (name, handler) => (handlers[name] ??= []).push(handler),
    registerTool: (def) => { tools[def.name] = def; },
    registerCommand: () => {},
    sendMessage: async (message, opts) => { sent.push({ message, opts }); },
  };
  ext.default(pi);
  const ctx = { cwd: workspace, hasUI: false, ui: { notify: () => {} }, sessionManager: { getSessionId: () => sessionId } };
  return { handlers, tools, sent, ctx };
}
try {
  registry.saveRegistry(cwd, { version: 1, tasks: [] });
  a.start(cwd, "s1"); b.start(cwd, "s1"); c.start(cwd, "s2");
  const owned = task("a01", a.owner("s1"));
  assert.equal(a.canDeliver(cwd, owned, "s1"), true, "original process in original session wins");
  assert.equal(b.canDeliver(cwd, owned, "s1"), false, "second window must yield to original");
  assert.equal(c.canDeliver(cwd, owned, "s2"), false, "other session cannot steal a callback");
  const ownerMarker = path.join(registry.tasksDir(cwd), "owners", `${a.processId}.json`);
  const staleMarker = JSON.parse(fs.readFileSync(ownerMarker, "utf8"));
  fs.writeFileSync(ownerMarker, JSON.stringify({ ...staleMarker, updatedAt: Date.now() - 31_000 }));
  assert.equal(b.canDeliver(cwd, owned, "s1"), true, "stale heartbeat cannot block same-session takeover");
  a.announce();
  assert.equal(b.canDeliver(cwd, owned, "s1"), false, "renewed heartbeat restores original priority");
  assert.equal(b.canDeliver(cwd, task("old"), "s1"), false, "legacy unowned tasks are not auto-claimed");
  const beforeReload = new SessionOwnership();
  const afterReload = new SessionOwnership();
  assert.equal(beforeReload.processId, afterReload.processId, "same pi process keeps priority across /reload");
  beforeReload.start(cwd, "reload-session");
  afterReload.start(cwd, "reload-session");
  beforeReload.stop();
  assert.equal(afterReload.canDeliver(cwd, task("reload", afterReload.owner("reload-session")), "reload-session"), true);
  assert.equal(fs.existsSync(path.join(registry.tasksDir(cwd), "owners", `${afterReload.processId}.json`)), true,
    "old runtime shutdown does not delete the new runtime's marker");
  afterReload.stop();
  a.start(cwd, "s2");
  assert.equal(b.canDeliver(cwd, owned, "s1"), true, "same pid after /new is not the old owner session");
  a.start(cwd, "s1");

  // The poller must not claim from the other window while A is still attached.
  registry.saveRegistry(cwd, { version: 1, tasks: [owned] });
  const bSent = [];
  await runTick(cwd, dc(b, "s1", bSent));
  assert.equal(bSent.length, 0);
  assert.equal(registry.loadRegistry(cwd).tasks[0].reported.state, "running");
  const cSent = [];
  await runTick(cwd, dc(c, "s2", cSent));
  assert.equal(cSent.length, 0);
  a.stop();
  await runTick(cwd, dc(b, "s1", bSent));
  assert.equal(bSent.length, 1, "same session takes over after original process exits");
  assert.equal(registry.loadRegistry(cwd).tasks.length, 0, "callback prunes after delivery");

  // Session replacement between claim and watermark must leave the task due.
  const raced = task("race", a.owner("s1"));
  registry.saveRegistry(cwd, { version: 1, tasks: [raced] });
  a.start(cwd, "s1");
  let unlock;
  let locked;
  const lockReady = new Promise((resolve) => { locked = resolve; });
  const held = registry.withRegistryLock(cwd, async () => {
    locked();
    await new Promise((resolve) => { unlock = resolve; });
  });
  await lockReady;
  const racedSent = [];
  const inFlight = deliverEvents(cwd, [raced], dc(a, "s1", racedSent), () => "raced callback");
  a.stop(); // /new or /resume before sendBatch gets the registry lock
  unlock();
  await held;
  await inFlight;
  assert.equal(racedSent.length, 0);
  assert.equal(registry.loadRegistry(cwd).tasks[0].reported.state, "running", "stale session did not watermark");
  assert.equal(fs.existsSync(path.join(registry.tasksDir(cwd), "race.claim")), false, "claim released on switch");
  await runTick(cwd, dc(b, "s1", bSent));
  assert.equal(bSent.length, 2, "same-session process delivers after old session switched");

  // A due but still-owned task must keep the other window's poller armed.
  a.start(cwd, "s1");
  registry.saveRegistry(cwd, { version: 1, tasks: [task("wait", a.owner("s1"))] });
  const waiting = [];
  ensurePoller(cwd, dc(b, "s1", waiting));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(waiting.length, 0);
  a.stop();
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.equal(waiting.length, 1, "waiting window delivers on next tick, without re-opening");
  stopPollerFor(cwd);

  // A task reservation (pid=0) must not be misreported during spawnTask's async gap.
  const reserved = task("reserved", b.owner("s1"));
  reserved.state = "running";
  reserved.pid = 0;
  registry.saveRegistry(cwd, { version: 1, tasks: [reserved] });
  assert.equal((await settleRegistry(cwd)).tasks[0].state, "running");
  assert.equal((await settleRegistry(cwd, reserved.createdAt + 16_000)).tasks[0].state, "exited");

  // A failed send has already been watermarked: the next tick must retry even
  // though it no longer appears in the fresh due set.
  registry.saveRegistry(cwd, { version: 1, tasks: [task("retry", b.owner("s1"))] });
  let sends = 0;
  const retryDc = dc(b, "s1", []);
  retryDc.sendMessage = async () => { if (++sends === 1) throw new Error("temporary send failure"); };
  await runTick(cwd, retryDc);
  assert.equal(sends, 1);
  assert.equal(registry.loadRegistry(cwd).tasks[0].reported.state, "exited");
  await runTick(cwd, retryDc);
  assert.equal(sends, 2, "pending batch retried despite no new transition");
  assert.equal(registry.loadRegistry(cwd).tasks.length, 0);

  // Recovery on a different session must not drain a terminal callback.
  const recoveryOwner = a.owner("s1");
  a.start(cwd, "s1");
  registry.saveRegistry(cwd, { version: 1, tasks: [task("r01", recoveryOwner)] });
  const foreign = mock("s2");
  await foreign.handlers.session_start[0]({ reason: "startup" }, foreign.ctx);
  assert.equal(foreign.sent.length, 0);
  assert.equal(registry.loadRegistry(cwd).tasks[0].reported.state, "running");
  await foreign.handlers.session_shutdown[0]({ reason: "quit" }, foreign.ctx);
  const same = mock("s1");
  await same.handlers.session_start[0]({ reason: "startup" }, same.ctx);
  assert.equal(same.sent.length, 0, "recovery yields to original active window");
  await same.handlers.session_shutdown[0]({ reason: "quit" }, same.ctx);
  a.stop();
  const resumed = mock("s1");
  await resumed.handlers.session_start[0]({ reason: "startup" }, resumed.ctx);
  assert.equal(resumed.sent.length, 1, "same-session recovery claims when original is gone");
  assert.equal(resumed.sent[0].opts.deliverAs, "nextTurn");
  await resumed.handlers.session_shutdown[0]({ reason: "quit" }, resumed.ctx);

  // Legacy tasks stay visible for /tasks, not claimed by a random session.
  registry.saveRegistry(cwd, { version: 1, tasks: [task("legacy")] });
  const legacy = mock("s1");
  await legacy.handlers.session_start[0]({ reason: "startup" }, legacy.ctx);
  assert.equal(legacy.sent.length, 0);
  assert.equal(registry.loadRegistry(cwd).tasks.length, 1);
  await legacy.handlers.session_shutdown[0]({ reason: "quit" }, legacy.ctx);

  // Optional command cwd changes execution directory, not registry location.
  registry.saveRegistry(cwd, { version: 1, tasks: [] });
  const subdir = path.join(cwd, "child");
  fs.mkdirSync(subdir);
  const spawning = mock("s1");
  await spawning.handlers.session_start[0]({ reason: "startup" }, spawning.ctx);
  const result = await spawning.tools.spawn_background.execute("call", { command: "sleep 30", cwd: "child" }, undefined, () => {}, spawning.ctx);
  const id = result.details.id;
  const stored = registry.loadRegistry(cwd).tasks.find((t) => t.id === id);
  assert.equal(stored.cwd, subdir);
  assert.equal(stored.owner.sessionId, "s1");
  assert.ok(stored.owner.processId);
  assert.equal(fs.existsSync(registry.registryPath(subdir)), false);
  await spawning.tools.kill_background.execute("call", { task_id: id }, undefined, () => {}, spawning.ctx);
  await spawning.handlers.session_shutdown[0]({ reason: "quit" }, spawning.ctx);

  // B starts before any task exists; A then starts and closes before its task
  // finishes. B must attach without requiring another session_start.
  const dormant = fs.mkdtempSync(path.join(os.tmpdir(), "tm-attach-"));
  const idleB = mock("s1", dormant);
  const idleForeign = mock("s2", dormant);
  const lateA = new SessionOwnership(randomUUID());
  try {
    await idleB.handlers.session_start[0]({ reason: "startup" }, idleB.ctx);
    await idleForeign.handlers.session_start[0]({ reason: "startup" }, idleForeign.ctx);
    registry.saveRegistry(dormant, { version: 1, tasks: [{
      ...task("late", lateA.owner("s1")), cwd: dormant,
      log: path.join(registry.tasksDir(dormant), "late.log"),
      exitFile: path.join(registry.tasksDir(dormant), "late.exit"),
    }] });
    lateA.start(dormant, "s1");
    lateA.stop();
    await new Promise((resolve) => setTimeout(resolve, 5500));
    assert.equal(idleB.sent.length, 1, "already-open B attaches and reports A's finished task");
    assert.equal(idleB.sent[0].message.customType, "task-event");
    assert.equal(idleB.sent[0].opts.triggerTurn, true, "live callback wakes idle B immediately");
    assert.equal(idleForeign.sent.length, 0, "another idle session must not attach to this callback");
  } finally {
    await idleForeign.handlers.session_shutdown[0]({ reason: "quit" }, idleForeign.ctx);
    await idleB.handlers.session_shutdown[0]({ reason: "quit" }, idleB.ctx);
    lateA.stop();
    fs.rmSync(dormant, { recursive: true, force: true });
  }
  console.log("PASS  task-monitor session ownership and recovery");
} finally {
  a.stop(); b.stop(); c.stop();
  fs.rmSync(cwd, { recursive: true, force: true });
}

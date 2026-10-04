// task-monitor footer block tests (toFooterBlock + duration helpers).
// Pure mapper tests; no registry on disk needed (tasks are plain objects).

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_PKG = path.resolve(
  path.dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
if (!fsSync.existsSync(PI_PKG)) {
  console.error(`pi-coding-agent not found at ${PI_PKG}. Run this test with the node that has pi installed (e.g. via nvm).`);
  process.exit(2);
}
const { createJiti } = await import(path.join(PI_PKG, "node_modules", "jiti", "lib", "jiti.mjs"));

// index.ts runtime-imports the pi-coding-agent root: mirror pi's loader
// getAliases() and use the async import form (see subagent.test.mjs header).
const requireFromPi = createRequire(path.join(PI_PKG, "dist", "core", "extensions", "loader.js"));
const typeboxRoot = requireFromPi.resolve("typebox");
const typeboxCompile = requireFromPi.resolve("typebox/compile");
const typeboxValue = requireFromPi.resolve("typebox/value");
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(PI_PKG, "dist", "index.js"),
		"@earendil-works/pi-tui": path.join(PI_PKG, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: typeboxRoot,
		"typebox/compile": typeboxCompile,
		"typebox/value": typeboxValue,
	},
});
const fmt = await jiti.import(fileURLToPath(new URL("./format.ts", import.meta.url)));

const NOW = 10_000_000;
const plain = { fg: (_c, t) => t, bold: (t) => t };

function makeTask(over = {}) {
  return {
    id: "tm01",
    name: "build",
    command: "npm run build",
    cwd: "/tmp",
    pid: 1,
    log: "/tmp/a.log",
    exitFile: "/tmp/a.exit",
    createdAt: NOW - 1_000_000,
    timeoutSeconds: null,
    callback: true,
    state: "running",
    exitCode: null,
    endedAt: null,
    logBytes: 0,
    reported: { state: "running", logBytes: 0 },
    ...over,
  };
}

const running1 = makeTask({ id: "tm01", name: "build", createdAt: NOW - 1_230_000 }); // 20m30s
const okTask = makeTask({ id: "tm02", name: "migrate", state: "exited", exitCode: 0, createdAt: NOW - 192_000, endedAt: NOW - 2_500 }); // 3m9s
const failTask = makeTask({ id: "tm03", name: "deploy", state: "exited", exitCode: 1, createdAt: NOW - 46_000, endedAt: NOW - 1_000 }); // 45s
const stale = makeTask({ id: "tm04", name: "old", state: "exited", exitCode: 0, createdAt: NOW - 600_000, endedAt: NOW - 10_000 });
const cancelled = makeTask({ id: "tm05", name: "stop", state: "cancelled", createdAt: NOW - 50_000, endedAt: NOW - 1_000 });

try {
  // --- mapping --------------------------------------------------------------
  const block = fmt.toFooterBlock([running1, okTask, failTask, stale, cancelled]);
  assert.equal(block.v, 1, "protocol version 1");
  assert.equal(block.id, "task-monitor");
  assert.equal(block.label, "Tasks");
  assert.deepEqual(block.items.map((i) => i.key), ["tm01", "tm02", "tm03", "tm04"], "cancelled never shows");
  assert.deepEqual(
    block.items[0],
    { key: "tm01", state: "running", title: "tm01", text: '"build"', startedAt: NOW - 1_230_000 },
    "running task has no endedAt",
  );
  assert.deepEqual(
    block.items[1],
    { key: "tm02", state: "success", title: "tm02", text: '"migrate" exited(0)', startedAt: NOW - 192_000, endedAt: NOW - 2_500 },
    "exit 0 -> success",
  );
  assert.equal(block.items[2].state, "error", "non-zero exit -> error");
  assert.equal(block.items[2].text, '"deploy" exited(1)');
  assert.equal(block.items[3].endedAt, NOW - 10_000, "stale terminal tasks are sent; the composer applies the flash window");
  const timedOut = makeTask({ id: "tm06", name: "watch", state: "timed_out", createdAt: NOW - 40_000, endedAt: NOW });
  assert.equal(fmt.toFooterBlock([timedOut]).items[0].state, "warning", "timed_out -> warning");
  const unknownExit = makeTask({ id: "tm08", state: "exited", exitCode: null, endedAt: null });
  assert.equal(fmt.toFooterBlock([unknownExit]).items[0].endedAt, unknownExit.createdAt, "missing endedAt falls back to createdAt");
  assert.deepEqual(fmt.toFooterBlock([]).items, [], "empty registry clears the block");

  // --- duration helpers -----------------------------------------------------
  assert.equal(fmt.durationOf(running1, NOW), "20m30s", "running duration at injected now");
  assert.equal(fmt.durationOf(makeTask({ createdAt: NOW - 90_000 }), NOW), "1m30s");
  assert.equal(fmt.fmtDur(0), "0s");
  assert.equal(fmt.stateLabel(failTask), "exited(1)");
  assert.equal(fmt.stateLabel(makeTask({ state: "exited", exitCode: null })), "exited(unknown)");

  console.log("PASS  task-monitor footer block");
} catch (error) {
  console.error("FAIL  task-monitor footer block");
  throw error;
}

// --- runtime smoke: index.ts publishes footer:block over pi.events --------
// Covers session_start publish, footer:sync resend and the no-UI guard.
// No pi spawn, no LLM.
{
	const extMod = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));
	const registry = await jiti.import(fileURLToPath(new URL("./registry.ts", import.meta.url)));

	const makePi = () => {
		const handlers = {};
		const listeners = {};
		const emitted = [];
		const pi = {
			on: (name, fn) => (handlers[name] ??= []).push(fn),
			registerTool: () => {},
			registerCommand: () => {},
			sendMessage: async () => {},
			events: {
				on: (channel, fn) => (listeners[channel] ??= []).push(fn),
				emit: (channel, data) => {
					emitted.push([channel, data]);
					for (const fn of listeners[channel] ?? []) fn(data);
				},
			},
		};
		extMod.default(pi);
		return { pi, handlers, emitted };
	};

	const cwd = fsSync.mkdtempSync(path.join(os.tmpdir(), "tm-footer-"));
	const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "footer-test" }, ui: { setStatus: () => {}, notify: () => {} } };
	const { pi, handlers, emitted } = makePi();
	const blocks = () => emitted.filter(([channel]) => channel === "footer:block").map(([, data]) => data);
	try {
		await handlers.session_start[0]({}, ctx);
		assert.ok(blocks().length > 0, "session_start publishes a block");
		assert.deepEqual(blocks().at(-1).items, [], "empty registry -> empty block");

		registry.saveRegistry(cwd, {
			version: 1,
			tasks: [makeTask({ id: "tm01", name: "build", createdAt: Date.now() - 120_000 })],
		});
		const before = blocks().length;
		pi.events.emit("footer:sync", {});
		assert.equal(blocks().length, before + 1, "footer:sync triggers a resend");
		assert.deepEqual(blocks().at(-1).items.map((i) => [i.key, i.state]), [["tm01", "running"]], "resend reads the on-disk registry");

		await handlers.session_shutdown[0]({}, ctx);
		const afterShutdown = blocks().length;
		pi.events.emit("footer:sync", {});
		assert.equal(blocks().length, afterShutdown, "no resend after session_shutdown");
		console.log("PASS  task-monitor footer smoke");
	} finally {
		fsSync.rmSync(cwd, { recursive: true, force: true });
	}

	const headlessCwd = fsSync.mkdtempSync(path.join(os.tmpdir(), "tm-footer-headless-"));
	const headless = makePi();
	try {
		await headless.handlers.session_start[0]({}, { ...ctx, cwd: headlessCwd, hasUI: false });
		headless.pi.events.emit("footer:sync", {});
		assert.equal(headless.emitted.filter(([channel]) => channel === "footer:block").length, 0, "headless session publishes nothing");
		await headless.handlers.session_shutdown[0]({}, { ...ctx, cwd: headlessCwd, hasUI: false });
		console.log("PASS  task-monitor footer headless");
	} finally {
		fsSync.rmSync(headlessCwd, { recursive: true, force: true });
	}
}

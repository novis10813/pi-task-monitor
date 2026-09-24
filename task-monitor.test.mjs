// task-monitor footer block tests (renderTaskBlock + duration helpers).
// Pure-formatter tests; no registry on disk needed (tasks are plain objects).

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

function recording() {
  const calls = [];
  return { calls, fg: (c, t) => (calls.push([c, t]), t), bold: (t) => t };
}

try {
  assert.equal(fmt.FINISH_FLASH_MS, 3000, "flash window is 3s");

  // --- visibility rules -----------------------------------------------------
  assert.equal(fmt.renderTaskBlock([], 80, plain, NOW), undefined, "no tasks -> no block");
  assert.equal(fmt.renderTaskBlock([stale], 80, plain, NOW), undefined, "terminal outside flash window -> no block");
  assert.equal(fmt.renderTaskBlock([cancelled], 80, plain, NOW), undefined, "cancelled never shows");
  const edge = makeTask({ id: "tm07", name: "edge", state: "exited", exitCode: 0, createdAt: NOW - 10_000, endedAt: NOW - 3_000 });
  assert.ok(fmt.renderTaskBlock([edge], 80, plain, NOW), "endedAt exactly at window edge still shows");

  // --- wide layout ----------------------------------------------------------
  assert.deepEqual(
    fmt.renderTaskBlock([running1], 80, plain, NOW),
    ["⎿ Tasks: 1 running", '  ▸ tm01 "build" 20m30s'],
    "single running task (wide)",
  );
  assert.deepEqual(
    fmt.renderTaskBlock([okTask, running1, failTask], 80, plain, NOW),
    [
      "⎿ Tasks: 1 running",
      '  ▸ tm01 "build" 20m30s',
      '  ✗ tm03 "deploy" exited(1) 45s',
      '  ✓ tm02 "migrate" exited(0) 3m10s',
    ],
    "running first, then finished by recency",
  );
  assert.deepEqual(
    fmt.renderTaskBlock([okTask, failTask], 80, plain, NOW),
    [
      "⎿ Tasks: 2 finished",
      '  ✗ tm03 "deploy" exited(1) 45s',
      '  ✓ tm02 "migrate" exited(0) 3m10s',
    ],
    "finished-only header",
  );
  const timedOut = makeTask({ id: "tm06", name: "watch", state: "timed_out", createdAt: NOW - 40_000, endedAt: NOW });
  assert.deepEqual(
    fmt.renderTaskBlock([timedOut], 80, plain, NOW),
    ["⎿ Tasks: 1 finished", '  ⚠ tm06 "watch" timed_out 40s'],
    "timed_out row",
  );

  // --- narrow layout --------------------------------------------------------
  assert.deepEqual(
    fmt.renderTaskBlock([running1], 40, plain, NOW),
    ["⎿ Tasks: 1 running · tm01 20m30s"],
    "narrow collapses to one line",
  );
  assert.deepEqual(
    fmt.renderTaskBlock([okTask, running1], 40, plain, NOW),
    ["⎿ Tasks: 1 running · tm01 20m30s"],
    "narrow prefers running over finished",
  );
  assert.deepEqual(
    fmt.renderTaskBlock([okTask], 40, plain, NOW),
    ["⎿ Tasks: 1 finished · tm02 exited(0)"],
    "narrow finished-only line",
  );

  // --- row cap --------------------------------------------------------------
  const many = Array.from({ length: 6 }, (_, i) => makeTask({ id: `tm${String(i + 1).padStart(2, "0")}`, name: `t${i}` }));
  const capped = fmt.renderTaskBlock(many, 80, plain, NOW);
  assert.equal(capped.length, 6, "header + 4 rows + overflow line");
  assert.equal(capped[5], "… +2 more", "overflow count");

  // --- colors ---------------------------------------------------------------
  const th = recording();
  fmt.renderTaskBlock([running1, okTask, failTask, timedOut], 80, th, NOW);
  const called = (c, t) => th.calls.some(([cc, tt]) => cc === c && tt === t);
  assert.ok(called("dim", "⎿ "), "header icon is dim");
  assert.ok(called("text", "Tasks: 1 running"), "header label is text");
  assert.ok(called("accent", "▸"), "running marker is accent");
  assert.ok(called("accent", "tm01"), "running id is accent");
  assert.ok(called("text", '"build"'), "name is text");
  assert.ok(called("dim", "20m30s"), "running duration is dim");
  assert.ok(called("success", "✓"), "exit 0 icon is success");
  assert.ok(called("success", "exited(0)"), "exit 0 label is success");
  assert.ok(called("error", "✗"), "exit 1 icon is error");
  assert.ok(called("error", "exited(1)"), "exit 1 label is error");
  assert.ok(called("warning", "⚠"), "timed_out icon is warning");
  assert.ok(called("warning", "timed_out"), "timed_out label is warning");

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

// --- runtime smoke: index.ts registers the footer-bus detail --------------
// Verifies pi-jiti resolves the cross-extension import ("../shared/footer-bus.js")
// and the detail renders from the on-disk registry. No pi spawn, no LLM.
{
	const extMod = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));
	const bus = await jiti.import(fileURLToPath(new URL("../shared/footer-bus.ts", import.meta.url)));
	const registry = await jiti.import(fileURLToPath(new URL("./registry.ts", import.meta.url)));

	bus.resetFooterDetails();
	const handlers = {};
	const pi = {
		on: (name, fn) => (handlers[name] ??= []).push(fn),
		registerTool: () => {},
		registerCommand: () => {},
		sendMessage: async () => {},
	};
	extMod.default(pi);

	const cwd = fsSync.mkdtempSync(path.join(os.tmpdir(), "tm-footer-"));
	const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "footer-test" }, ui: { setStatus: () => {}, notify: () => {} } };
	try {
		await handlers.session_start[0]({}, ctx);
		assert.ok(bus.getFooterDetails().has("task-monitor"), "session_start registers the footer detail");

		const render = () => bus.getFooterDetails().get("task-monitor").render({ width: 80, theme: plain });
		assert.equal(render(), undefined, "empty registry -> no block");

		registry.saveRegistry(cwd, {
			version: 1,
			tasks: [
				makeTask({ id: "tm01", name: "build", createdAt: Date.now() - 120_000 }),
				makeTask({ id: "tm02", name: "migrate", state: "exited", exitCode: 0, createdAt: Date.now() - 190_000, endedAt: Date.now() - 1_000 }),
			],
		});
		assert.deepEqual(
			render(),
			[
				"⎿ Tasks: 1 running",
				'  ▸ tm01 "build" 2m0s',
				'  ✓ tm02 "migrate" exited(0) 3m9s',
			],
			"detail renders from the on-disk registry (fresh read)",
		);

		await handlers.session_shutdown[0]({}, ctx);
		assert.equal(bus.getFooterDetails().has("task-monitor"), false, "session_shutdown unregisters the detail");
		console.log("PASS  task-monitor footer smoke");
	} finally {
		fsSync.rmSync(cwd, { recursive: true, force: true });
		bus.resetFooterDetails();
	}
}

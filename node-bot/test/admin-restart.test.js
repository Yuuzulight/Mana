const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANA_RESTART_EXIT_CODE,
  buildRestartAcceptedPayload,
  createRestartController,
  formatRestartClientResult,
  getRequestAddress,
  isLoopbackAddress,
  isRestartCommand,
} = require("../admin-restart");

test("isRestartCommand accepts Mana backend restart phrases", () => {
  assert.equal(isRestartCommand("/restart"), true);
  assert.equal(isRestartCommand("/soft-restart"), true);
  assert.equal(isRestartCommand("soft restart Mana"), true);
  assert.equal(isRestartCommand("restart Mana"), true);
});

test("isRestartCommand rejects unrelated restart requests", () => {
  assert.equal(isRestartCommand("restart the backend"), false);
  assert.equal(isRestartCommand("please restart my PC"), false);
});

test("isLoopbackAddress accepts loopback addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
});

test("isLoopbackAddress rejects private LAN addresses", () => {
  assert.equal(isLoopbackAddress("192.168.1.50"), false);
  assert.equal(isLoopbackAddress("10.0.0.2"), false);
});

test("buildRestartAcceptedPayload returns backend restart payload", () => {
  assert.deepEqual(buildRestartAcceptedPayload(), {
    ok: true,
    action: "restart",
    scope: "backend",
    exitCode: MANA_RESTART_EXIT_CODE,
    message: "Mana backend soft restart requested. The launcher or supervisor will start it again.",
  });
});

test("formatRestartClientResult describes restart outcomes", () => {
  assert.match(
    formatRestartClientResult({ ok: true }),
    /Mana backend soft restart requested/i,
  );
  assert.match(
    formatRestartClientResult({ ok: false }),
    /Mana backend is not reachable/,
  );
});

test("getRequestAddress reads express request addresses", () => {
  assert.equal(getRequestAddress({ ip: "127.0.0.1" }), "127.0.0.1");
  assert.equal(
    getRequestAddress({ socket: { remoteAddress: "::1" } }),
    "::1",
  );
});

test("createRestartController.buildAcceptedPayload returns the standard payload", () => {
  const controller = createRestartController();
  assert.deepEqual(controller.buildAcceptedPayload(), buildRestartAcceptedPayload());
});

test("createRestartController.scheduleRestart schedules the exit after the configured delay", () => {
  const calls = [];
  const controller = createRestartController({
    exitProcess: (code) => calls.push(["exit", code]),
    schedule: (fn, delayMs) => {
      calls.push(["schedule", delayMs]);
      fn();
    },
  });

  controller.scheduleRestart();

  assert.deepEqual(calls, [
    ["schedule", 250],
    ["exit", MANA_RESTART_EXIT_CODE],
  ]);
});

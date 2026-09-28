// utils/on-demand-process.js stop/restart (follow-up to #745, same bug #750
// fixed in llama-server-runtime). Fakes only: one port a single child can
// bind, children that exit a tick after being killed, taskkill as a fake
// execFile. No real process is started.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createOnDemandProcess } = require("../utils/on-demand-process");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeHarness({ exitOnKill = true, taskkillFails = false, platform = "win32", external = false } = {}) {
  const children = [];
  const taskkills = [];
  let holder = null;

  function terminate(child) {
    child.killed = true;
    if (exitOnKill) setImmediate(() => child.exit(1));
  }

  const service = createOnDemandProcess({
    name: "Fake service",
    healthUrl: () => "http://127.0.0.1:5999/health",
    command: () => ({ bin: "fake.exe", args: [], options: {} }),
    idleMs: () => 1000,
    platform,
    execFile: (cmd, args, options, callback) => {
      taskkills.push([cmd, ...args]);
      const child = !taskkillFails && children.find((c) => c.pid === Number(args[1]));
      if (child) terminate(child);
      setImmediate(() => callback(child ? null : new Error("not found")));
    },
    // Answers once a live child holds the port, from its second poll on.
    fetch: async () => ({ ok: external || Boolean(holder && !holder.killed && holder.polls++ >= 1) }),
    spawn: () => {
      const listeners = {};
      const child = {
        pid: 4000 + children.length,
        exitCode: null,
        signalCode: null,
        polls: 0,
        stderr: { on: () => {} },
        on: (event, cb) => (listeners[event] = listeners[event] || []).push(cb),
        once: (event, cb) => (listeners[event] = listeners[event] || []).push(cb),
        exit(code) {
          if (child.exitCode !== null) return;
          child.exitCode = code;
          if (holder === child) holder = null;
          (listeners.exit || []).forEach((cb) => cb(code));
        },
        kill: () => {
          child.killedDirectly = true;
          terminate(child);
        },
      };
      children.push(child);
      if (holder) setImmediate(() => child.exit(1)); // port already bound
      else holder = child;
      return child;
    },
    sleep: tick,
  });
  return { service, children, taskkills, live: () => children.filter((c) => c.exitCode === null) };
}

test("idle stop tree-kills on win32 and logs 'stopped' only once the process has exited", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  const { service, children, taskkills, live } = makeHarness();

  await service.ensure();
  t.mock.timers.tick(1000);

  assert.equal(taskkills.length, 1);
  assert.match(taskkills[0][0], /\\System32\\taskkill\.exe$/);
  assert.deepEqual(taskkills[0].slice(1), ["/PID", "4000", "/T", "/F"]);
  assert.equal(children[0].killedDirectly, undefined, "taskkill, not child.kill()");
  assert.ok(logs.some((l) => /idle for 1000ms, shutting it down \(pid 4000\)/.test(l)));
  assert.ok(!logs.some((l) => /stopped/.test(l)), "not claimed stopped before it exited");

  await tick();
  await tick();
  assert.deepEqual(live(), []);
  assert.ok(logs.some((l) => /\(pid 4000\) stopped/.test(l)));
});

test("stop() falls back to child.kill() when taskkill fails, and off Windows", async () => {
  for (const options of [{ taskkillFails: true }, { platform: "linux" }]) {
    const { service, children, taskkills, live } = makeHarness(options);
    await service.ensure();
    service.stop();
    await tick();
    await tick();
    assert.equal(children[0].killedDirectly, true);
    assert.equal(taskkills.length, options.platform === "linux" ? 0 : 1);
    assert.deepEqual(live(), []);
  }
});

test("a process still running after the stop bound is reported with its pid", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const { service } = makeHarness({ exitOnKill: false });

  await service.ensure();
  service.stop();
  t.mock.timers.tick(15000);
  await tick();

  assert.ok(warnings.some((w) => /Fake service \(pid 4000\) is still running 15000ms after being stopped/.test(w)));
});

test("a start right after idle stop waits for the old process to exit instead of failing to bind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, children, live } = makeHarness();

  await service.ensure();
  t.mock.timers.tick(1000);
  // Old process still tearing down (and holding the port) at this point.
  await service.ensure();

  assert.equal(children.length, 2);
  assert.equal(children[0].exitCode, 1);
  assert.deepEqual(live(), [children[1]]);
});

test("a server that was already running on the port is used but never killed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  const { service, children, taskkills } = makeHarness({ external: true });

  await service.ensure();
  service.touch();
  t.mock.timers.tick(1000);
  service.stop();
  await tick();

  assert.equal(children.length, 0);
  assert.equal(taskkills.length, 0);
  assert.ok(!logs.some((l) => /shutting it down/.test(l)));
});

test("overlapping ensure() calls spawn one process, also right after a stop", async () => {
  const { service, children, live } = makeHarness();

  await Promise.all([service.ensure(), service.ensure(), service.ensure()]);
  assert.equal(children.length, 1);

  service.stop();
  await Promise.all([service.ensure(), service.ensure()]);
  assert.equal(children.length, 2);
  assert.deepEqual(live(), [children[1]]);
});

test("a stale idle timer can't kill a start in progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, children, taskkills, live } = makeHarness();

  await service.ensure();
  t.mock.timers.tick(500);
  children[0].exit(1); // crashes; its idle timer is still pending
  const restart = service.ensure();
  await tick();
  t.mock.timers.tick(500); // stale timer fires mid-start
  await restart;

  assert.equal(taskkills.length, 0);
  assert.deepEqual(live(), [children[1]]);
});

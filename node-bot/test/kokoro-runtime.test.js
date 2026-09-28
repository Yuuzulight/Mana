// User decision (no dedicated issue; native side #694): Kokoro starts on
// demand and stops when idle. No real process is started -- spawn, fetch
// and fs are fakes.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createKokoroRuntime } = require("../kokoro-runtime");

function fakeChild() {
  const listeners = {};
  return {
    killed: false,
    stderr: { on: () => {} },
    on: (event, cb) => {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    emit: (event, ...args) => (listeners[event] || []).forEach((cb) => cb(...args)),
    kill() {
      this.killed = true;
    },
  };
}

const VENV_PYTHON = path.join("C:\\mana", "tts-service", "venv", "Scripts", "python.exe");
const PORTABLE_PYTHON = path.join("C:\\mana", "portable-python", "tts-service", "python.exe");

// A fake Kokoro service: healthy once spawned (or `up` from the start).
// `files` are the Python interpreters that exist.
function fakeKokoro({ up = false, files = [VENV_PYTHON], env = {}, spawnChild } = {}) {
  const calls = { spawn: [], health: [] };
  const child = fakeChild();
  const fake = {
    calls,
    child,
    up,
    runtime: null,
  };
  fake.runtime = createKokoroRuntime({
    env,
    rootDir: "C:\\mana",
    fs: { existsSync: (file) => files.includes(file) },
    spawn: (bin, args, opts) => {
      calls.spawn.push({ bin, args, opts });
      if (spawnChild) return spawnChild();
      fake.up = true;
      return child;
    },
    fetch: async (url) => {
      calls.health.push(url);
      return { ok: fake.up };
    },
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  return fake;
}

function quietly(fn) {
  return async () => {
    const warn = console.warn;
    const log = console.log;
    console.warn = () => {};
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.warn = warn;
      console.log = log;
    }
  };
}

test("ensure starts Kokoro from tts-service/venv once, hidden, and reuses it", quietly(async () => {
  const kokoro = fakeKokoro({ env: { MANA_KOKORO_IDLE_MS: "0" } });
  // Concurrent syntheses share one start.
  await Promise.all([kokoro.runtime.ensure(), kokoro.runtime.ensure()]);
  await kokoro.runtime.ensure();

  assert.equal(kokoro.calls.spawn.length, 1);
  const { bin, args, opts } = kokoro.calls.spawn[0];
  assert.equal(bin, VENV_PYTHON);
  assert.deepEqual(args, ["-m", "uvicorn", "kokoro_service:app", "--host", "127.0.0.1", "--port", "5011"]);
  assert.equal(opts.cwd, path.join("C:\\mana", "tts-service"));
  assert.equal(opts.windowsHide, true);
  assert.equal(kokoro.calls.health[0], "http://127.0.0.1:5011/health");
  kokoro.runtime.stop();
}));

test("an installer's bundled portable Python is preferred over the venv", quietly(async () => {
  const kokoro = fakeKokoro({ files: [PORTABLE_PYTHON, VENV_PYTHON], env: { MANA_KOKORO_IDLE_MS: "0" } });
  await kokoro.runtime.ensure();
  assert.equal(kokoro.calls.spawn[0].bin, PORTABLE_PYTHON);
  kokoro.runtime.stop();
}));

test("a Kokoro already answering the port is used and never spawned or stopped", quietly(async () => {
  const kokoro = fakeKokoro({ up: true, files: [], env: { MANA_KOKORO_IDLE_MS: "5" } });
  await kokoro.runtime.ensure();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await kokoro.runtime.ensure();
  assert.equal(kokoro.calls.spawn.length, 0);
  assert.equal(kokoro.child.killed, false);
}));

test("an adopted Kokoro that went away is replaced on the next use", quietly(async () => {
  const kokoro = fakeKokoro({ up: true, env: { MANA_KOKORO_IDLE_MS: "0" } });
  await kokoro.runtime.ensure();
  kokoro.up = false;
  await kokoro.runtime.ensure();
  assert.equal(kokoro.calls.spawn.length, 1);
  kokoro.runtime.stop();
}));

test("the Kokoro it started is stopped after MANA_KOKORO_IDLE_MS without use", quietly(async () => {
  const kokoro = fakeKokoro({ env: { MANA_KOKORO_IDLE_MS: "150" } });
  await kokoro.runtime.ensure();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await kokoro.runtime.ensure(); // use restarts the countdown
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(kokoro.child.killed, false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(kokoro.child.killed, true);
}));

test("a missing venv warns once with the setup step, rejects, and is not retried on every call", async () => {
  const kokoro = fakeKokoro({ files: [] });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await assert.rejects(kokoro.runtime.ensure(), /not set up/);
    await assert.rejects(kokoro.runtime.ensure(), /retrying later/);
  } finally {
    console.warn = warn;
  }
  assert.equal(kokoro.calls.spawn.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /python -m venv tts-service\/venv.*start_kokoro\.ps1/);
});

test("a Kokoro that dies during startup rejects and is not respawned during the cooldown", quietly(async () => {
  const kokoro = fakeKokoro({
    spawnChild: () => {
      const child = fakeChild();
      setImmediate(() => child.emit("exit", 1));
      return child;
    },
  });
  await assert.rejects(kokoro.runtime.ensure(), /did not start/);
  await assert.rejects(kokoro.runtime.ensure(), /retrying later/);
  assert.equal(kokoro.calls.spawn.length, 1);
}));

test("Kokoro is never managed under tests or for a non-loopback KOKORO_TTS_URL", async () => {
  for (const env of [
    { NODE_ENV: "test" },
    { NODE_TEST_CONTEXT: "child" },
    { KOKORO_TTS_URL: "http://192.168.1.50:5011" },
    { KOKORO_TTS_URL: "not a url" },
  ]) {
    const kokoro = fakeKokoro({ env });
    await kokoro.runtime.ensure();
    assert.equal(kokoro.calls.spawn.length, 0);
    assert.equal(kokoro.calls.health.length, 0);
  }
});

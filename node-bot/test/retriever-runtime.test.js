// #884: the Python retriever starts on demand and stops when idle
// (shorter while gaming). No real process is started --
// spawn, fetch and fs are fakes.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createRetrieverRuntime } = require("../ai/retriever-runtime");
const { GAMING_IDLE_MS } = require("../utils/gaming-watch");

const ROOT = "C:\\mana";
const SCRIPT = path.join(ROOT, "tools", "retriever_service.py");
const VENV_PYTHON = path.join(ROOT, "venv", "Scripts", "python.exe");
const INDEX = path.join(ROOT, "tools", "vector_store", "index.ann");
const METADATA = path.join(ROOT, "tools", "vector_store", "metadata.sqlite");

// Healthy once spawned. `files` are what exists on disk.
function fakeRetriever({ files = [SCRIPT, INDEX, METADATA, VENV_PYTHON], env = {}, gaming } = {}) {
  const fake = { up: false, spawns: [], health: [], children: [] };
  fake.runtime = createRetrieverRuntime({
    env,
    rootDir: ROOT,
    gaming,
    fs: { existsSync: (file) => files.includes(file) },
    spawn: (bin, args, opts) => {
      fake.spawns.push({ bin, args, opts });
      fake.up = true;
      const child = {
        killed: false,
        stderr: { on: () => {} },
        on: () => {},
        kill() {
          this.killed = true;
          fake.up = false;
        },
      };
      fake.children.push(child);
      return child;
    },
    fetch: async (url) => {
      fake.health.push(url);
      return { ok: fake.up };
    },
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  return fake;
}

function quietly(fn) {
  return async (t) => {
    const { log, warn } = console;
    console.log = console.warn = () => {};
    try {
      await fn(t);
    } finally {
      console.log = log;
      console.warn = warn;
    }
  };
}

test("ensure starts tools/retriever_service.py from the repo venv once, and reuses it", quietly(async () => {
  const r = fakeRetriever({ env: { MANA_RETRIEVER_IDLE_MS: "0" } });
  await Promise.all([r.runtime.ensure(), r.runtime.ensure()]);
  await r.runtime.ensure();

  assert.equal(r.spawns.length, 1);
  assert.equal(r.spawns[0].bin, VENV_PYTHON);
  assert.deepEqual(r.spawns[0].args, ["-u", SCRIPT]);
  assert.equal(r.spawns[0].opts.cwd, ROOT);
  assert.equal(r.health[0], "http://127.0.0.1:9000/health");
  r.runtime.stop();
}));

test("without the repo venv it runs python from PATH, like windows-launcher", quietly(async () => {
  const r = fakeRetriever({ files: [SCRIPT, INDEX, METADATA], env: { MANA_RETRIEVER_IDLE_MS: "0" } });
  await r.runtime.ensure();
  assert.equal(r.spawns[0].bin, "python");
  r.runtime.stop();
}));

test("without retriever_service.py, index.ann or metadata.sqlite it never starts", async () => {
  // metadata.json alone (a store from before #809) doesn't count.
  for (const files of [[INDEX, METADATA], [SCRIPT, METADATA], [SCRIPT, INDEX]]) {
    const r = fakeRetriever({ files: [...files, VENV_PYTHON] });
    await r.runtime.ensure();
    assert.equal(r.spawns.length, 0);
    assert.equal(r.health.length, 0);
  }
});

test("VECTOR_STORE_DIR moves where the index is looked for", quietly(async () => {
  const dir = path.join(ROOT, "stores", "new");
  const files = [SCRIPT, path.join(dir, "index.ann"), path.join(dir, "metadata.sqlite")];
  const r = fakeRetriever({ files, env: { VECTOR_STORE_DIR: dir, MANA_RETRIEVER_IDLE_MS: "0" } });
  await r.runtime.ensure();
  assert.equal(r.spawns.length, 1);
  r.runtime.stop();
}));

test("one already answering (MANA_START_RETRIEVER=1 in the launcher) is used and never stopped", quietly(async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fakeRetriever();
  r.up = true;
  await r.runtime.ensure();
  t.mock.timers.tick(600000);
  r.runtime.stop();
  assert.equal(r.spawns.length, 0);
  assert.equal(r.up, true);
}));

test("it stops after MANA_RETRIEVER_IDLE_MS (10 min default), GAMING_IDLE_MS while gaming", quietly(async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let gaming = true;
  const r = fakeRetriever({ gaming: () => gaming });
  await r.runtime.ensure();
  t.mock.timers.tick(GAMING_IDLE_MS - 1);
  assert.equal(r.children[0].killed, false);
  t.mock.timers.tick(1);
  assert.equal(r.children[0].killed, true);

  gaming = false;
  await r.runtime.ensure();
  assert.equal(r.spawns.length, 2);
  t.mock.timers.tick(600000 - 1);
  assert.equal(r.children[1].killed, false);
  t.mock.timers.tick(1);
  assert.equal(r.children[1].killed, true);
}));

test("never managed under tests, or for a remote / non-9000 RETRIEVER_URL", async () => {
  for (const env of [
    { NODE_ENV: "test" },
    { NODE_TEST_CONTEXT: "child" },
    { RETRIEVER_URL: "http://192.168.1.50:9000/retrieve" },
    { RETRIEVER_URL: "http://127.0.0.1:9100/retrieve" },
    { RETRIEVER_URL: "not a url" },
  ]) {
    const r = fakeRetriever({ env });
    await r.runtime.ensure();
    assert.equal(r.spawns.length, 0);
    assert.equal(r.health.length, 0);
  }
});

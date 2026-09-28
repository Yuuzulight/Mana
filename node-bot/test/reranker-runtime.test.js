// Issue #674: the optional CPU-only reranker. No real process is started --
// spawn and fetch are fakes; the model "file" is an empty temp file.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createReranker } = require("../ai/reranker-runtime");

function tempModel(name = "reranker.gguf") {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-reranker-")), name);
  fs.writeFileSync(file, "");
  return file;
}

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

// A fake llama-server: healthy once spawned, answering /v1/rerank with
// scores from `score(doc)`.
function fakeServer({ score = () => 0, rerankResponse = null } = {}) {
  const calls = { spawn: [], rerank: [] };
  let up = false;
  const child = fakeChild();
  return {
    calls,
    child,
    spawn: (bin, args, opts) => {
      calls.spawn.push({ bin, args, opts });
      up = true;
      return child;
    },
    fetch: async (url, init) => {
      if (url.endsWith("/health")) return { ok: up };
      const body = JSON.parse(init.body);
      calls.rerank.push(body);
      if (rerankResponse) return rerankResponse(body, init);
      return {
        ok: true,
        json: async () => ({
          results: body.documents.map((doc, index) => ({ index, relevance_score: score(doc) })),
        }),
      };
    },
  };
}

function makeReranker(server, env = {}) {
  return createReranker({
    env,
    spawn: server.spawn,
    fetch: server.fetch,
    findServerBin: () => "C:\\llama\\llama-server.exe",
    sleep: async () => {},
  });
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

test("reranker is off (input order, nothing spawned) without a usable MANA_RERANKER_MODEL", async () => {
  const server = fakeServer();
  const missing = path.join(os.tmpdir(), "definitely-not-here.gguf");
  for (const MANA_RERANKER_MODEL of [undefined, "relative\\model.gguf", missing, tempModel("model.bin")]) {
    const reranker = makeReranker(server, { MANA_RERANKER_MODEL });
    assert.equal(reranker.isEnabled(), false);
    const result = await reranker.rerank("q", ["a", "b"]);
    assert.deepEqual(result, { order: [0, 1], reranked: false, ms: 0, fallback: null });
  }
  assert.equal(server.calls.spawn.length, 0);
});

test("reranker is off under the test environment even with a model set", () => {
  const reranker = makeReranker(fakeServer(), {
    MANA_RERANKER_MODEL: tempModel(),
    NODE_ENV: "test",
  });
  assert.equal(reranker.isEnabled(), false);
});

test("rerank starts a CPU-only llama-server on demand and orders docs by score", quietly(async () => {
  const model = tempModel();
  const server = fakeServer({ score: (doc) => (doc.includes("GPU") ? 0.9 : 0.1) });
  const reranker = makeReranker(server, { MANA_RERANKER_MODEL: model, MANA_RERANKER_IDLE_MS: "0" });

  const result = await reranker.rerank("what graphics card?", ["snack: chips", "the user's GPU: RTX 5080"]);
  assert.deepEqual(result.order, [1, 0]);
  assert.equal(result.reranked, true);

  assert.equal(server.calls.spawn.length, 1);
  const { args, opts } = server.calls.spawn[0];
  assert.deepEqual(args.slice(0, 2), ["-m", model]);
  assert.ok(args.includes("--reranking"));
  assert.equal(args[args.indexOf("-ngl") + 1], "0");
  assert.ok(!args.includes("-hf"), "never a hub spec -- nothing is downloaded");
  assert.ok(!args.includes("--load-mode") && !args.includes("--no-mmap"), "CPU-only model: mmap stays on");
  assert.equal(opts.env.CUDA_VISIBLE_DEVICES, "-1");
  assert.equal(opts.windowsHide, true);

  // Already running: no second spawn.
  await reranker.rerank("q", ["a", "b"]);
  assert.equal(server.calls.spawn.length, 1);
}));

test("rerank truncates the query and documents it sends", quietly(async () => {
  const server = fakeServer();
  const reranker = makeReranker(server, { MANA_RERANKER_MODEL: tempModel(), MANA_RERANKER_IDLE_MS: "0" });
  await reranker.rerank("q".repeat(2000), ["d".repeat(2000), "e"]);
  assert.equal(server.calls.rerank[0].query.length, 500);
  assert.equal(server.calls.rerank[0].documents[0].length, 500);
}));

test("rerank scores only the 10 best-first candidates; the rest keep their order after them", quietly(async () => {
  const server = fakeServer({ score: (doc) => Number(doc.slice(1)) });
  const reranker = makeReranker(server, { MANA_RERANKER_MODEL: tempModel(), MANA_RERANKER_IDLE_MS: "0" });
  const docs = Array.from({ length: 20 }, (_, i) => `d${i}`);

  const result = await reranker.rerank("q", docs);

  assert.equal(server.calls.rerank[0].documents.length, 10);
  // Top 10 reordered by score (d9 highest), then 10..19 in input order.
  assert.deepEqual(result.order, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
}));

test("a timed-out, failed or malformed rerank returns the input order and logs why", async () => {
  const cases = [
    () => new Promise(() => {}),
    () => ({ ok: false, status: 500 }),
    () => ({ ok: true, json: async () => ({ results: [{ index: 99, relevance_score: 1 }] }) }),
  ];
  for (const rerankResponse of cases) {
    const server = fakeServer({ rerankResponse });
    const reranker = makeReranker(server, { MANA_RERANKER_MODEL: tempModel(), MANA_RERANKER_IDLE_MS: "0" });
    const warnings = [];
    const warn = console.warn;
    const log = console.log;
    console.warn = (...args) => warnings.push(args.join(" "));
    console.log = () => {};
    try {
      const result = await reranker.rerank("q", ["a", "b", "c"], { timeoutMs: 30 });
      assert.deepEqual(result.order, [0, 1, 2]);
      assert.equal(result.reranked, false);
      assert.ok(result.fallback);
      assert.ok(warnings.some((w) => /keeping input order/.test(w)));
    } finally {
      console.warn = warn;
      console.log = log;
    }
  }
});

test("a server that dies during startup is not respawned on every call", quietly(async () => {
  const server = fakeServer();
  let spawns = 0;
  const reranker = createReranker({
    env: { MANA_RERANKER_MODEL: tempModel() },
    spawn: () => {
      spawns++;
      const child = fakeChild();
      setImmediate(() => child.emit("exit", 1));
      return child;
    },
    fetch: async () => ({ ok: false }),
    findServerBin: () => "C:\\llama\\llama-server.exe",
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const first = await reranker.rerank("q", ["a", "b"], { timeoutMs: 200 });
  assert.match(first.fallback, /did not start/);
  const second = await reranker.rerank("q", ["a", "b"], { timeoutMs: 200 });
  assert.match(second.fallback, /retrying later/);
  assert.equal(spawns, 1);
  assert.equal(server.calls.spawn.length, 0);
}));

test("the reranker process is stopped after MANA_RERANKER_IDLE_MS without calls", quietly(async () => {
  const server = fakeServer();
  const reranker = makeReranker(server, { MANA_RERANKER_MODEL: tempModel(), MANA_RERANKER_IDLE_MS: "20" });
  await reranker.rerank("q", ["a", "b"]);
  assert.equal(server.child.killed, false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(server.child.killed, true);
}));

test("fewer than two documents never reaches the server", async () => {
  const server = fakeServer();
  const reranker = makeReranker(server, { MANA_RERANKER_MODEL: tempModel() });
  assert.deepEqual((await reranker.rerank("q", ["only"])).order, [0]);
  assert.equal(server.calls.spawn.length, 0);
});

test("a reranker already answering on the port (left from a killed backend) is reused, not respawned", quietly(async () => {
  const server = fakeServer({ score: (doc) => doc.length });
  server.spawn("pre-existing", [], {}); // marks the fake port healthy
  server.calls.spawn.length = 0;
  const reranker = makeReranker(server, { MANA_RERANKER_MODEL: tempModel(), MANA_RERANKER_IDLE_MS: "0" });
  const result = await reranker.rerank("q", ["a", "bbb"]);
  assert.deepEqual(result.order, [1, 0]);
  assert.equal(server.calls.spawn.length, 0);
}));

test("warm() starts the server ahead of the first rerank, once, and does nothing when off", quietly(async () => {
  const server = fakeServer({ score: (doc) => doc.length });
  const reranker = makeReranker(server, { MANA_RERANKER_MODEL: tempModel(), MANA_RERANKER_IDLE_MS: "0" });
  reranker.warm();
  reranker.warm();
  assert.deepEqual((await reranker.rerank("q", ["a", "bbb"])).order, [1, 0]);
  assert.equal(server.calls.spawn.length, 1);

  const off = fakeServer();
  makeReranker(off, {}).warm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(off.calls.spawn.length, 0);
}));

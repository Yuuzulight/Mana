// The optional GPU embedder. No real process is started -- spawn and fetch
// are fakes; the model "file" is an empty temp file. Spawn/reuse/idle-stop
// are utils/on-demand-process.js's, covered by reranker-runtime.test.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEmbedder } = require("../ai/embedder-runtime");

function tempModel() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-embedder-")), "embed.gguf");
  fs.writeFileSync(file, "");
  return file;
}

// A fake llama-server: healthy once spawned, answering /v1/embeddings with
// one [index, length] vector per input, in reverse order.
function fakeServer({ response = null } = {}) {
  const calls = { spawn: [], embed: [] };
  let up = false;
  return {
    calls,
    spawn: (bin, args, opts) => {
      calls.spawn.push({ bin, args, opts });
      up = true;
      return { stderr: { on: () => {} }, on: () => {}, kill: () => {} };
    },
    fetch: async (url, init) => {
      if (url.endsWith("/health")) return { ok: up };
      const body = JSON.parse(init.body);
      calls.embed.push({ url, body });
      if (response) return response();
      const data = body.input.map((text, index) => ({ index, embedding: [index, text.length] }));
      return { ok: true, json: async () => ({ data: data.reverse() }) };
    },
  };
}

function makeEmbedder(server, env = {}, supportsLoadMode = () => true) {
  return createEmbedder({
    env,
    spawn: server.spawn,
    fetch: server.fetch,
    findServerBin: () => "C:\\llama\\llama-server.exe",
    supportsLoadMode,
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

test("the embedder is off without a usable MANA_EMBEDDER_MODEL, and under the test environment", () => {
  const server = fakeServer();
  for (const model of [undefined, "", "relative\\embed.gguf", "C:\\missing\\embed.gguf"]) {
    const embedder = makeEmbedder(server, { MANA_EMBEDDER_MODEL: model });
    assert.equal(embedder.isEnabled(), false);
    assert.equal(embedder.modelId(), "");
  }
  assert.equal(makeEmbedder(server, { MANA_EMBEDDER_MODEL: tempModel(), NODE_ENV: "test" }).isEnabled(), false);
  assert.equal(server.calls.spawn.length, 0);
});

test("embed starts a GPU llama-server on demand and returns vectors in input order", quietly(async () => {
  const server = fakeServer();
  const model = tempModel();
  const embedder = makeEmbedder(server, { MANA_EMBEDDER_MODEL: model, MANA_EMBEDDER_IDLE_MS: "0" });
  assert.equal(embedder.modelId(), "llama:embed.gguf");

  const vectors = await embedder.embed(["a", "x".repeat(5000)]);

  assert.deepEqual(vectors, [[0, 1], [1, 2048]]);
  const { args } = server.calls.spawn[0];
  for (const flag of [["-m", model], ["--embedding"], ["--pooling", "last"], ["-ngl", "99"], ["--port", "8092"], ["--load-mode", "none"]]) {
    const at = args.indexOf(flag[0]);
    assert.ok(at >= 0, `missing ${flag[0]}`);
    assert.deepEqual(args.slice(at, at + flag.length), flag);
  }
  assert.equal(server.calls.embed[0].url, "http://127.0.0.1:8092/v1/embeddings");
}));

test("builds without --load-mode get --no-mmap", quietly(async () => {
  const server = fakeServer();
  const embedder = makeEmbedder(server, { MANA_EMBEDDER_MODEL: tempModel(), MANA_EMBEDDER_IDLE_MS: "0" }, () => false);
  await embedder.embed(["a"]);
  assert.ok(server.calls.spawn[0].args.includes("--no-mmap"));
  assert.ok(!server.calls.spawn[0].args.includes("--load-mode"));
}));

test("a failed or malformed response gives nulls, never throws", quietly(async () => {
  for (const response of [
    () => ({ ok: false, status: 500 }),
    () => ({ ok: true, json: async () => ({ unexpected: true }) }),
    () => {
      throw new Error("connection refused");
    },
  ]) {
    const embedder = makeEmbedder(fakeServer({ response }), { MANA_EMBEDDER_MODEL: tempModel(), MANA_EMBEDDER_IDLE_MS: "0" });
    assert.deepEqual(await embedder.embed(["a", "b"]), [null, null]);
  }
}));

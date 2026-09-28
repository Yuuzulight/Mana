// The optional GPU embedder. No real process is started -- spawn and fetch
// are fakes; the model "file" is an empty temp file. Spawn/reuse/idle-stop
// are utils/on-demand-process.js's, covered by reranker-runtime.test.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEmbedder, QUERY_PROMPT } = require("../ai/embedder-runtime");

function tempModel(name = "embed.gguf") {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-embedder-")), name);
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

  const vectors = await embedder.embed(["a", "x".repeat(2048)]);

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

function unit(v) {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

test("a document longer than one batch is embedded as overlapping chunks in one request and averaged", quietly(async () => {
  const server = fakeServer();
  const embedder = makeEmbedder(server, { MANA_EMBEDDER_MODEL: tempModel(), MANA_EMBEDDER_IDLE_MS: "0" });

  const [short, long] = await embedder.embed(["a", "x".repeat(5000)]);

  assert.equal(server.calls.embed.length, 1);
  // Chunks start every 2048 - 256 characters; the last one ends at the text's end.
  assert.deepEqual(server.calls.embed[0].body.input.map((t) => t.length), [1, 2048, 2048, 1416]);
  assert.deepEqual(short, [0, 1]);
  const [a, b, c] = [unit([1, 2048]), unit([2, 2048]), unit([3, 1416])];
  const expected = unit(a.map((_, k) => a[k] + b[k] + c[k]));
  long.forEach((x, k) => assert.ok(Math.abs(x - expected[k]) < 1e-12));

  // Chunks cut on code points, never between a surrogate pair.
  await embedder.embed(["\u{1F600}".repeat(2100)]);
  for (const chunk of server.calls.embed[1].body.input) {
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk));
  }
}));

test("a missing chunk vector leaves that document null", quietly(async () => {
  const data = [{ index: 0, embedding: [1, 0] }, { index: 2, embedding: [0, 1] }];
  const server = fakeServer({ response: () => ({ ok: true, json: async () => ({ data }) }) });
  const embedder = makeEmbedder(server, { MANA_EMBEDDER_MODEL: tempModel(), MANA_EMBEDDER_IDLE_MS: "0" });
  assert.deepEqual(await embedder.embed(["x".repeat(3000)]), [null]);
}));

test("queries get Qwen3-Embedding's instruction and are cut, never chunked; documents and other models go in bare", quietly(async () => {
  const server = fakeServer();
  const qwen = makeEmbedder(server, { MANA_EMBEDDER_MODEL: tempModel("Qwen3-Embedding-0.6B-Q8_0.gguf"), MANA_EMBEDDER_IDLE_MS: "0" });
  await qwen.embed(["what gpu do I have?", "y".repeat(5000)], { query: true });
  await qwen.embed(["rig: RTX 5080"]);
  const [queries, docs] = server.calls.embed.map((c) => c.body.input);
  assert.equal(queries.length, 2);
  assert.equal(queries[0], `${QUERY_PROMPT}what gpu do I have?`);
  assert.ok(queries[1].startsWith(QUERY_PROMPT));
  assert.equal(queries[1].length, 2048);
  assert.deepEqual(docs, ["rig: RTX 5080"]);

  const other = fakeServer();
  const nomic = makeEmbedder(other, { MANA_EMBEDDER_MODEL: tempModel("nomic-embed.gguf"), MANA_EMBEDDER_IDLE_MS: "0" });
  await nomic.embed(["q"], { query: true });
  assert.deepEqual(other.calls.embed[0].body.input, ["q"]);
}));

test("warm() starts the server ahead of the first embed, once, and does nothing when off", quietly(async () => {
  const server = fakeServer();
  const embedder = makeEmbedder(server, { MANA_EMBEDDER_MODEL: tempModel(), MANA_EMBEDDER_IDLE_MS: "0" });
  embedder.warm();
  embedder.warm();
  assert.deepEqual(await embedder.embed(["a"]), [[0, 1]]);
  assert.equal(server.calls.spawn.length, 1);

  const off = fakeServer();
  makeEmbedder(off, {}).warm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(off.calls.spawn.length, 0);
}));

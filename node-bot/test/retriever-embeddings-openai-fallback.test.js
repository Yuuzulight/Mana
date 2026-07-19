// computeEmbeddings() falls back to OpenAI's paid embeddings API when the
// local embedder is unreachable. That fallback must be an explicit opt-in
// (RETRIEVER_EMBEDDER_OPENAI_FALLBACK=1) -- merely having OPENAI_API_KEY set
// for an unrelated feature must never silently start billing OpenAI just
// because the local embedder happens to be down.
//
// retriever-index.js reads its env-derived settings into module-level
// consts at require time, and computeEmbeddings() itself short-circuits to
// nulls under NODE_ENV=test (see openai-compat-routes.test.js) -- both mean
// each scenario here needs its own fresh require with NODE_ENV cleared
// first, so this test file resolves and clears the module from the cache
// itself rather than requiring it once at the top.
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

// A port nothing is listening on, for a local embedder call that's meant to
// fail. Grabbing then immediately releasing an OS-assigned port (rather than
// a hardcoded low number like 1) guarantees a real, fast ECONNREFUSED
// instead of relying on how a given OS handles reserved/filtered ports.
async function closedLocalPort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function withFakeOpenAi(fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    // See test/helpers.js's withServer: fetch() keeps its socket alive for
    // reuse, so a bare server.close() pays Node's ~5s default
    // keepAliveTimeout waiting for it -- closeAllConnections() skips that.
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

// Fresh require with NODE_ENV cleared so computeEmbeddings() runs its real
// logic instead of the NODE_ENV=test short-circuit. Safe to clear here:
// llama-server-runtime's own spawn guard checks NODE_TEST_CONTEXT (set by
// node:test itself), not NODE_ENV, so nothing else in this process starts
// spawning real processes because of this.
function loadRetrieverIndex(envOverrides) {
  const modulePath = require.resolve("../tools/retriever-index");
  delete require.cache[modulePath];
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  Object.assign(process.env, envOverrides);
  try {
    return require("../tools/retriever-index");
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

test("computeEmbeddings does not call OpenAI when RETRIEVER_EMBEDDER_OPENAI_FALLBACK is unset, even with a key present", async () => {
  await withFakeOpenAi(async (baseUrl, requests) => {
    const closedPort = await closedLocalPort();
    const retrieverIndex = loadRetrieverIndex({
      USE_EMBEDDINGS: "1",
      RETRIEVER_EMBEDDER_URL: `http://127.0.0.1:${closedPort}`,
      OPENAI_API_KEY: "sk-test-unused",
      OPENAI_BASE_URL: baseUrl,
      RETRIEVER_EMBEDDER_OPENAI_FALLBACK: "",
    });

    const result = await retrieverIndex.computeEmbeddings(["hello"]);
    assert.deepEqual(result, [null]);
    assert.equal(requests.length, 0);
  });
});

test("computeEmbeddings calls OpenAI once RETRIEVER_EMBEDDER_OPENAI_FALLBACK=1 is explicitly set", async () => {
  await withFakeOpenAi(async (baseUrl, requests) => {
    const closedPort = await closedLocalPort();
    const retrieverIndex = loadRetrieverIndex({
      USE_EMBEDDINGS: "1",
      RETRIEVER_EMBEDDER_URL: `http://127.0.0.1:${closedPort}`,
      OPENAI_API_KEY: "sk-test-unused",
      OPENAI_BASE_URL: baseUrl,
      RETRIEVER_EMBEDDER_OPENAI_FALLBACK: "1",
    });

    const result = await retrieverIndex.computeEmbeddings(["hello"]);
    assert.deepEqual(result, [[0.1, 0.2, 0.3]]);
    assert.equal(requests.length, 1);
  });
});

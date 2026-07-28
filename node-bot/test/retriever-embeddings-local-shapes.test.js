// Issue #195: computeEmbeddings() must accept either response shape a local
// embedder might return -- {embeddings: [[float,...],...]} (local_embedder.py's
// current shape) or a bare [[float,...],...] array (huggingface/
// text-embeddings-inference's actual /embed response, a real candidate
// replacement) -- rather than silently returning nulls against a
// compatible-but-differently-shaped embedder.
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

async function withFakeLocalEmbedder(responseBody, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

// Same fresh-require-per-scenario pattern as
// retriever-embeddings-openai-fallback.test.js -- see that file's comment
// for why (module-level env-derived consts + NODE_ENV=test short-circuit).
async function withRetrieverIndex(envOverrides, fn) {
  const modulePath = require.resolve("../tools/retriever-index");
  delete require.cache[modulePath];
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  Object.assign(process.env, envOverrides);
  try {
    const retrieverIndex = require("../tools/retriever-index");
    await fn(retrieverIndex);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

test("computeEmbeddings accepts local_embedder.py's wrapped {embeddings: [...]} shape", async () => {
  await withFakeLocalEmbedder({ ok: true, embeddings: [[0.1, 0.2], [0.3, 0.4]] }, async (baseUrl) => {
    await withRetrieverIndex(
      { USE_EMBEDDINGS: "1", RETRIEVER_EMBEDDER_URL: baseUrl },
      async (retrieverIndex) => {
        const result = await retrieverIndex.computeEmbeddings(["hello", "world"]);
        assert.deepEqual(result, [[0.1, 0.2], [0.3, 0.4]]);
      },
    );
  });
});

test("computeEmbeddings accepts a bare array shape (text-embeddings-inference's actual /embed response)", async () => {
  await withFakeLocalEmbedder([[0.5, 0.6], [0.7, 0.8]], async (baseUrl) => {
    await withRetrieverIndex(
      { USE_EMBEDDINGS: "1", RETRIEVER_EMBEDDER_URL: baseUrl },
      async (retrieverIndex) => {
        const result = await retrieverIndex.computeEmbeddings(["hello", "world"]);
        assert.deepEqual(result, [[0.5, 0.6], [0.7, 0.8]]);
      },
    );
  });
});

test("computeEmbeddings returns nulls for a response matching neither known shape", async () => {
  await withFakeLocalEmbedder({ unexpected: "shape" }, async (baseUrl) => {
    await withRetrieverIndex(
      { USE_EMBEDDINGS: "1", RETRIEVER_EMBEDDER_URL: baseUrl },
      async (retrieverIndex) => {
        const result = await retrieverIndex.computeEmbeddings(["hello"]);
        assert.deepEqual(result, [null]);
      },
    );
  });
});

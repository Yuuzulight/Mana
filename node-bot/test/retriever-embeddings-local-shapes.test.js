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

test("a configured GPU embedder serves computeEmbeddings instead of RETRIEVER_EMBEDDER_URL, and names its model", async () => {
  await withFakeLocalEmbedder({ embeddings: [[9, 9]] }, async (baseUrl, requests) => {
    await withRetrieverIndex(
      { USE_EMBEDDINGS: "1", RETRIEVER_EMBEDDER_URL: baseUrl },
      async (retrieverIndex) => {
        let enabled = true;
        const embedded = [];
        retrieverIndex.useEmbedder({
          isEnabled: () => enabled,
          modelId: () => (enabled ? "llama:embed.gguf" : ""),
          embed: async (texts) => {
            embedded.push(texts);
            return texts.map(() => [1, 2]);
          },
        });
        assert.deepEqual(await retrieverIndex.computeEmbeddings(["hello"]), [[1, 2]]);
        assert.equal(retrieverIndex.embeddingModelId(), "llama:embed.gguf");
        assert.deepEqual(embedded, [["hello"]]);
        assert.equal(requests.length, 0);

        // Not configured (no model file): the URL service, as before.
        enabled = false;
        assert.deepEqual(await retrieverIndex.computeEmbeddings(["hello"]), [[9, 9]]);
        assert.equal(retrieverIndex.embeddingModelId(), "");
      },
    );
  });
});

test("the query flag reaches the GPU embedder, and local_embedder.py gets Qwen3's query prompt for queries only", async () => {
  const { QUERY_PROMPT } = require("../ai/embedder-runtime");
  await withFakeLocalEmbedder({ embeddings: [[9, 9]] }, async (baseUrl, requests) => {
    await withRetrieverIndex(
      { USE_EMBEDDINGS: "1", RETRIEVER_EMBEDDER_URL: baseUrl },
      async (retrieverIndex) => {
        await retrieverIndex.computeEmbeddings(["what gpu?"], { query: true });
        await retrieverIndex.computeEmbeddings(["rig: RTX 5080"]);
        assert.deepEqual(requests, [
          { inputs: ["what gpu?"], query_prompt: QUERY_PROMPT },
          { inputs: ["rig: RTX 5080"] },
        ]);

        const options = [];
        retrieverIndex.useEmbedder({
          isEnabled: () => true,
          modelId: () => "llama:embed.gguf",
          embed: async (texts, opts) => {
            options.push(opts);
            return texts.map(() => [1, 2]);
          },
        });
        await retrieverIndex.computeEmbedding("what gpu?", { query: true });
        await retrieverIndex.computeEmbeddings(["rig: RTX 5080"]);
        assert.deepEqual(options, [{ query: true }, { query: false }]);
      },
    );
  });
});

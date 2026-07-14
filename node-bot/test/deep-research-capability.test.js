const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const test = require("node:test");

const {
  createResearchJobStore,
  deepResearchCapability,
} = require("../capabilities/deep-research-capability");

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function waitFor(check, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test("POST /research/start returns a jobId immediately and GET /research/:jobId reaches done", async () => {
  const app = express();
  app.use(express.json());
  let jobIdCounter = 0;
  deepResearchCapability.registerRoutes(app, {
    searchWeb: async () => [
      { title: "R1", url: "https://example.com/1", snippet: "s1" },
    ],
    fetchPage: async (url) => ({ url, title: "T1", text: "page text" }),
    synthesize: async () => "final report [1]",
    makeJobId: () => `job-${++jobIdCounter}`,
  });

  await withServer(app, async (baseUrl) => {
    const startResp = await fetch(`${baseUrl}/research/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "what is X?", maxSources: 1 }),
    });
    const startBody = await startResp.json();

    assert.equal(startResp.status, 202);
    assert.equal(startBody.jobId, "job-1");
    assert.equal(startBody.status, "running");

    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/research/job-1`);
      const body = await res.json();
      return body.status === "done";
    });

    const finalResp = await fetch(`${baseUrl}/research/job-1`);
    const finalBody = await finalResp.json();
    assert.equal(finalResp.status, 200);
    assert.equal(finalBody.status, "done");
    assert.equal(finalBody.result.report, "final report [1]");
    assert.equal(finalBody.result.sources.length, 1);
  });
});

test("GET /research/:jobId returns 404 for an unknown job", async () => {
  const app = express();
  app.use(express.json());
  deepResearchCapability.registerRoutes(app, {
    synthesize: async () => "unused",
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research/does-not-exist`);
    assert.equal(response.status, 404);
  });
});

test("POST /research/start rejects a missing question", async () => {
  const app = express();
  app.use(express.json());
  deepResearchCapability.registerRoutes(app, {
    synthesize: async () => "unused",
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  });
});

test("POST /research/start reports 503 when no synthesize function is configured", async () => {
  const app = express();
  app.use(express.json());
  deepResearchCapability.registerRoutes(app, {});

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/research/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q" }),
    });
    assert.equal(response.status, 503);
  });
});

test("a job that errors reports status error with the failure message", async () => {
  const app = express();
  app.use(express.json());
  let jobIdCounter = 0;
  deepResearchCapability.registerRoutes(app, {
    searchWeb: async () => {
      throw new Error("SearXNG unreachable");
    },
    synthesize: async () => "unused",
    makeJobId: () => `job-${++jobIdCounter}`,
  });

  await withServer(app, async (baseUrl) => {
    await fetch(`${baseUrl}/research/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q" }),
    });

    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/research/job-1`);
      const body = await res.json();
      return body.status === "error";
    });

    const res = await fetch(`${baseUrl}/research/job-1`);
    const body = await res.json();
    assert.equal(body.status, "error");
    assert.match(body.error, /SearXNG unreachable/);
  });
});

test("deep research capability reports health based on synthesize availability", () => {
  const configured = deepResearchCapability.getHealth({ synthesize: async () => "x" });
  assert.equal(configured.status, "configured");
  assert.equal(configured.configured, true);

  const unavailable = deepResearchCapability.getHealth({});
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.configured, false);
});

test("createResearchJobStore returns an empty Map", () => {
  const store = createResearchJobStore();
  assert.equal(store.size, 0);
  assert.equal(typeof store.set, "function");
});

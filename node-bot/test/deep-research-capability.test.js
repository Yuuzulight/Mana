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

test("POST /research/:jobId/cancel stops a running job between steps", async () => {
  const app = express();
  app.use(express.json());
  let jobIdCounter = 0;
  let releaseFirstRead;
  const firstReadStarted = new Promise((resolveStarted) => {
    let started = false;
    deepResearchCapability.registerRoutes(app, {
      searchWeb: async () => [
        { title: "R1", url: "https://example.com/1", snippet: "s1" },
        { title: "R2", url: "https://example.com/2", snippet: "s2" },
      ],
      fetchPage: (url) =>
        new Promise((resolveRead) => {
          if (!started) {
            started = true;
            releaseFirstRead = () => resolveRead({ url, title: "t", text: "x" });
            resolveStarted();
            return;
          }
          resolveRead({ url, title: "t", text: "x" });
        }),
      synthesize: async () => "should never be reached",
      makeJobId: () => `job-${++jobIdCounter}`,
    });
  });

  await withServer(app, async (baseUrl) => {
    await fetch(`${baseUrl}/research/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q", maxSources: 2 }),
    });

    // Wait until the job is genuinely mid-read, then cancel while it hangs.
    await firstReadStarted;
    const cancelResp = await fetch(`${baseUrl}/research/job-1/cancel`, { method: "POST" });
    const cancelBody = await cancelResp.json();
    assert.equal(cancelResp.status, 200);
    assert.equal(cancelBody.cancelRequested, true);

    releaseFirstRead();
    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/research/job-1`);
      return (await res.json()).status === "cancelled";
    });

    const finalBody = await (await fetch(`${baseUrl}/research/job-1`)).json();
    assert.equal(finalBody.status, "cancelled");
    assert.equal(finalBody.result, null);

    // Cancelling an already-finished job is an idempotent no-op.
    const again = await fetch(`${baseUrl}/research/job-1/cancel`, { method: "POST" });
    assert.equal((await again.json()).status, "cancelled");

    const missing = await fetch(`${baseUrl}/research/nope/cancel`, { method: "POST" });
    assert.equal(missing.status, 404);
  });
});

test("POST /research/start records the finished report to session memory when sessionId is provided", async () => {
  const app = express();
  app.use(express.json());
  let jobIdCounter = 0;
  const appendedTurns = [];
  const acpMemoryStore = {
    appendTurn: async (turn) => {
      appendedTurns.push(turn);
    },
  };
  deepResearchCapability.registerRoutes(app, {
    acpMemoryStore,
    searchWeb: async () => [
      { title: "R1", url: "https://example.com/1", snippet: "s1" },
    ],
    fetchPage: async (url) => ({ url, title: "T1", text: "page text" }),
    synthesize: async () => "final report [1]",
    makeJobId: () => `job-${++jobIdCounter}`,
  });

  await withServer(app, async (baseUrl) => {
    await fetch(`${baseUrl}/research/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "what is X?", sessionId: "sess-1" }),
    });
    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/research/job-1`);
      return (await res.json()).status === "done";
    });
  });

  assert.equal(appendedTurns.length, 1);
  assert.deepEqual(appendedTurns[0], {
    sessionId: "sess-1",
    user: "what is X?",
    assistant: "final report [1]",
  });
});

test("POST /research/start does not touch session memory when sessionId is omitted", async () => {
  const app = express();
  app.use(express.json());
  let jobIdCounter = 0;
  let appendCalled = false;
  const acpMemoryStore = {
    appendTurn: async () => {
      appendCalled = true;
    },
  };
  deepResearchCapability.registerRoutes(app, {
    acpMemoryStore,
    searchWeb: async () => [],
    synthesize: async () => "report",
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
      return (await res.json()).status === "done";
    });
  });

  assert.equal(appendCalled, false);
});

test("a cancelled research job does not record anything to session memory", async () => {
  const app = express();
  app.use(express.json());
  let jobIdCounter = 0;
  let appendCalled = false;
  const acpMemoryStore = {
    appendTurn: async () => {
      appendCalled = true;
    },
  };
  let releaseFirstRead;
  const firstReadStarted = new Promise((resolveStarted) => {
    let started = false;
    deepResearchCapability.registerRoutes(app, {
      acpMemoryStore,
      searchWeb: async () => [
        { title: "R1", url: "https://example.com/1", snippet: "s1" },
        { title: "R2", url: "https://example.com/2", snippet: "s2" },
      ],
      fetchPage: (url) =>
        new Promise((resolveRead) => {
          if (!started) {
            started = true;
            releaseFirstRead = () => resolveRead({ url, title: "t", text: "x" });
            resolveStarted();
            return;
          }
          resolveRead({ url, title: "t", text: "x" });
        }),
      synthesize: async () => "should never be reached",
      makeJobId: () => `job-${++jobIdCounter}`,
    });
  });

  await withServer(app, async (baseUrl) => {
    await fetch(`${baseUrl}/research/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q", sessionId: "sess-1", maxSources: 2 }),
    });

    await firstReadStarted;
    await fetch(`${baseUrl}/research/job-1/cancel`, { method: "POST" });
    releaseFirstRead();

    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/research/job-1`);
      return (await res.json()).status === "cancelled";
    });
  });

  assert.equal(appendCalled, false);
});

test("MANA_RESEARCH_MAX_PER_DOMAIN env var sets the default maxPerDomain when the request omits it", async () => {
  const app = express();
  app.use(express.json());
  const seen = {};
  let jobIdCounter = 0;
  deepResearchCapability.registerRoutes(app, {
    env: { MANA_RESEARCH_MAX_PER_DOMAIN: "1" },
    runDeepResearch: async (question, options) => {
      seen.maxPerDomain = options.maxPerDomain;
      return { question, subQueries: [], sources: [], report: "report", bounds: {} };
    },
    synthesize: async () => "report",
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
      return (await res.json()).status === "done";
    });
  });
  assert.equal(seen.maxPerDomain, 1);
});

test("MANA_RESEARCH_* env vars set the default bounds when the request omits them", async () => {
  const app = express();
  app.use(express.json());
  const seen = {};
  let jobIdCounter = 0;
  deepResearchCapability.registerRoutes(app, {
    env: { MANA_RESEARCH_MAX_SOURCES: "2" },
    searchWeb: async (query, options) => {
      seen.limit = options.limit;
      return [];
    },
    synthesize: async () => "report",
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
      return (await res.json()).status === "done";
    });
    assert.equal(seen.limit, 2, "env default should flow through to the search limit");
  });
});

test("finished jobs are pruned from the store after the TTL", async () => {
  const app = express();
  app.use(express.json());
  let jobIdCounter = 0;
  deepResearchCapability.registerRoutes(app, {
    jobTtlMs: 25,
    searchWeb: async () => [],
    synthesize: async () => "report",
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
      return (await res.json()).status === "done";
    });

    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/research/job-1`);
      return res.status === 404;
    });
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

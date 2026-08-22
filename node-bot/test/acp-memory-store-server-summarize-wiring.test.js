// Regression test for a confirmed pre-existing bug: server.js's real
// acpMemoryStore (built at module load time, outside registerRoutes) has a
// summarizeFn that calls runOpenAIReply when shouldUseRemoteAi() is true --
// but runOpenAIReply only exists inside registerRoutes's function scope.
// Every real invocation threw "ReferenceError: runOpenAIReply is not
// defined", silently caught by summarizeFn's own try/catch, permanently
// falling back to the stale summary. Remote-AI-triggered session
// compaction has never actually worked.
//
// The fix: a module-level runOpenAIReplyPublic reference, assigned once
// registerRoutes runs (mirroring the already-established
// runSkillProposalPublic pattern for the same class of bug), which
// summarizeFn calls through instead of referencing runOpenAIReply directly.
//
// This drives the REAL automatic compaction trigger (acp-memory-store.js's
// own 90%-of-maxSummaryTokens check inside appendTurn) against server.js's
// REAL summarizeFn, through a real createApp() and a fake OpenAI-compatible
// upstream -- not a mock of summarizeFn itself, which would only prove
// acp-memory-store.js's generic trigger mechanism works (already covered by
// test/acp-memory-store.test.js) without touching the actual bug.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");
const { withRawServer } = require("./helpers");

function waitFor(check, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
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

test("automatic remote-AI session-summary compaction actually reaches the provider and updates the session (regression)", async () => {
  const originalDataDir = process.env.MANA_ACP_MEMORY_DIR;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-acp-memory-"));
  process.env.MANA_ACP_MEMORY_DIR = tempDataDir;

  let upstreamCalls = 0;
  const handler = (req, res) => {
    upstreamCalls += 1;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "a fresh, compacted summary" } }],
          usage: { prompt_tokens: 200, completion_tokens: 40 },
        }),
      );
    });
  };

  try {
    await withRawServer(handler, async ({ url }) => {
      // A loopback host is exempt from needing MANA_ALLOW_REMOTE_AI/an API
      // key (see shouldUseRemoteAi in ai/local-ai.js), so no extra env
      // setup is needed to reach the remote-AI branch.
      process.env.OPENAI_BASE_URL = url;

      const app = createApp({});
      const store = app.locals.acpMemoryStore;
      const sessionId = "sess-summarize-wiring";

      store.ensureSession({ sessionId });
      // Directly seed a summary long enough to cross the real compaction
      // threshold (maxSummaryTokens defaults to 1000 here since server.js's
      // module-level acpMemoryStore doesn't override it; the trigger is 90%
      // of that, and the store's heuristic token estimator is ~chars/4) --
      // reaching that state through real chat turns alone would take
      // hundreds of appendTurn calls.
      const sessionFile = path.join(
        store.sessionsDir,
        `${Buffer.from(sessionId).toString("base64url")}.json`,
      );
      const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      session.summary = "x".repeat(3700);
      fs.writeFileSync(sessionFile, JSON.stringify(session));

      // appendTurn's compaction check fires fire-and-forget (not awaited),
      // so wait for the fake upstream to actually see the resulting call --
      // proof the whole pipeline (trigger -> summarizeFn -> the fixed
      // runOpenAIReplyPublic indirection -> the real HTTP call -> saveSession)
      // completed, not just that some intermediate step happened. (Not
      // waiting on the summary text itself: appendTurn synchronously grows
      // it with a short incremental note before the async compaction ever
      // fires, so "did the summary change" alone would false-positive
      // before the real remote call happens.)
      await store.appendTurn({ sessionId, user: "hi", assistant: "hello" });
      await waitFor(() => upstreamCalls >= 1);
      // The upstream response only lands in the session after summarizeFn's
      // returned promise resolves and acp-memory-store.js's own async
      // continuation calls saveSession -- give that one more tick.
      await waitFor(() => store.getSession(sessionId).summary === "a fresh, compacted summary");

      assert.equal(upstreamCalls, 1);
      const finalSession = store.getSession(sessionId);
      assert.equal(finalSession.summary, "a fresh, compacted summary");
      assert.equal(finalSession.lastSummarizedTurnIndex, finalSession.turns.length);
    });
  } finally {
    if (originalDataDir === undefined) delete process.env.MANA_ACP_MEMORY_DIR;
    else process.env.MANA_ACP_MEMORY_DIR = originalDataDir;
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBaseUrl;
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

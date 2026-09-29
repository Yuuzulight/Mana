// Issue #643: a cron agent job runs through the real buildAssistantReply,
// so its prompt carries the same memory a chat turn gets (the job
// session's conversation memory, pinned and related facts, with unverified
// facts left out) -- not just the result written back afterward. Q27: and
// only confirmed facts, never pending (unconfirmed) ones.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Before requiring server.js: its module-level memory store reads this.
process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-cron-memory-"));

const { createApp } = require("../server");
const cronPlugin = require("../../plugins/cron-scheduler");

test("a cron agent job's prompt includes remembered facts and its result is still written back", async () => {
  const calls = [];
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, policy, opts) => {
      calls.push(opts);
      return { content: "Here is your RTX 5080 driver check.", toolCalls: [], rounds: 1 };
    },
  });
  const store = app.locals.acpMemoryStore;
  store.rememberFact({ key: "the user's GPU", text: "NVIDIA RTX 5080 graphics card", sessionId: "sess-other" });
  store.rememberFact({ key: "the user's favorite game", text: "FFXIV", sessionId: "sess-other" });
  store.setFactPinned("the user's favorite game", true);
  store.rememberFact({
    key: "the user's driver version",
    text: "an unverified guess",
    sessionId: "sess-other",
    unverifiedSource: true,
  });
  store.rememberFact({
    key: "graphics card",
    text: "a pending guess nobody confirmed",
    sessionId: "sess-other",
    origin: { kind: "model_inferred" },
  });
  store.appendTurn({ sessionId: "cron-643", user: "keep an eye on my drivers", assistant: "will do" });

  // createApp already built the singleton against the real data dir; rebuild
  // it on a temp dir, wired to the server's real reply pipeline and store.
  cronPlugin._resetForTests();
  let now = 1000;
  // onResult's write-back is fire-and-forget; keep its promise to await it.
  let written = null;
  const scheduler = cronPlugin._getSchedulerForTests({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-cron-643-")),
    now: () => now,
    buildAssistantReply: app.locals.buildAssistantReply,
    acpMemoryStore: { appendTurn: (turn) => (written = store.appendTurn(turn)) },
  });
  scheduler.addJob({
    name: "Driver check",
    jobType: "agent",
    prompt: "Check for a new driver for my graphics card and tell me the user's driver version.",
    sessionId: "cron-643",
    schedule: { type: "interval", everyMs: 100 },
  });
  now = 1200;
  await scheduler.runDueJobs();
  await written;
  cronPlugin._resetForTests();

  assert.ok(calls.length >= 1);
  const late = calls[0].extraMessages.late.map((m) => m.content).join("\n");
  assert.match(late, /RTX 5080/); // related fact, recalled from the job's prompt
  assert.match(late, /FFXIV/); // pinned fact
  assert.match(late, /keep an eye on my drivers/); // the job session's own memory
  assert.doesNotMatch(late, /an unverified guess/);
  assert.doesNotMatch(late, /a pending guess/);
  // ...which a chat turn does get, marked unconfirmed.
  await app.locals.buildAssistantReply("what about my graphics card?", "", "", "default", "chat", null, null, {});
  assert.match(calls.at(-1).extraMessages.late.map((m) => m.content).join("\n"), /a pending guess.*unconfirmed/);

  const turns = store.getSession("cron-643").turns;
  assert.equal(turns.at(-1).user, "[scheduled: Driver check]");
  assert.equal(turns.at(-1).assistant, "Here is your RTX 5080 driver check.");
});

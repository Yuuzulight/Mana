"use strict";

// #1287: Mana's self-work training records.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createTraceStore, toChatLines } = require("../self-work-traces");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mana-traces-"));
const conversation = (text) => ({
  review: false,
  messages: [
    { role: "system", content: "You are Mana." },
    { role: "user", content: text },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "coding__read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "assistant", content: "Done." },
  ],
});
const record = (pr, fields = {}) => ({
  pr,
  source: "local",
  issue: { number: 1, title: "t", body: "b" },
  conversations: [conversation(`Fix #${pr}`)],
  diff: "+x",
  outcome: { testsPassed: true, reviewPassed: true, merged: false, reverted: false },
  ...fields,
});

test("saves a local run, scrubbed of secrets and local paths; skips any other source", () => {
  const dir = tmp();
  const env = { DISCORD_TOKEN: "super-secret-token-value" };
  const store = createTraceStore({ dir, env });
  const saved = store.save(record(5, { diff: "token super-secret-token-value in C:\\Users\\me\\secret.txt and ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
  assert.ok(saved.saved);
  const text = fs.readFileSync(saved.saved, "utf8");
  assert.doesNotMatch(text, /super-secret-token-value|ghp_abc|Users/);
  assert.deepEqual(store.save(record(6, { source: "gemini-cli" })), { skipped: "source gemini-cli" });
  assert.equal(store.list().length, 1);
});

test("MANA_SELF_WORK_TRACES=0 turns it off", () => {
  const dir = tmp();
  const store = createTraceStore({ dir, env: { MANA_SELF_WORK_TRACES: "0" } });
  assert.equal(store.enabled(), false);
  assert.deepEqual(store.save(record(5)), { skipped: "off" });
  assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length, 0);
});

test("over the size cap, the oldest records go first", () => {
  const dir = tmp();
  // A cap of ~1 KB: each record is ~0.6 KB.
  const store = createTraceStore({ dir, env: { MANA_SELF_WORK_TRACES_MAX_MB: String(1 / 1024) } });
  store.save(record(1, { diff: "a".repeat(300) }));
  fs.utimesSync(path.join(dir, "pr-1.json"), new Date(1000), new Date(1000));
  store.save(record(2, { diff: "b".repeat(300) }));
  assert.deepEqual(fs.readdirSync(dir), ["pr-2.json"]);
});

test("outcome labels: merged and reverted decide what's exported", () => {
  const dir = tmp();
  const store = createTraceStore({ dir, env: {} });
  store.save(record(1));
  store.save(record(2));
  store.save(record(3));
  assert.equal(store.mark(1, { merged: true }), true);
  assert.equal(store.mark(1, { merged: true }), false, "already so");
  assert.equal(store.mark(99, { merged: true }), false, "no record");
  store.mark(2, { merged: true });
  store.mark(2, { reverted: true });
  const lines = toChatLines(store.list());
  assert.equal(lines.length, 1);
  const { messages } = JSON.parse(lines[0]);
  assert.equal(messages[1].content, "Fix #1");
  assert.equal(messages[2].tool_calls[0].function.name, "coding__read");
  // Unmerged but tests and review passed, on request.
  assert.equal(toChatLines(store.list(), { unmerged: true }).length, 2);
});

test("the exporter script writes chat-format JSONL", () => {
  const dir = tmp();
  const store = createTraceStore({ dir, env: {} });
  store.save(record(1));
  store.mark(1, { merged: true });
  const out = path.join(dir, "out.jsonl");
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "export-self-work-traces.js"), out, "--dir", dir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const lines = fs.readFileSync(out, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).messages.length, 5);
});

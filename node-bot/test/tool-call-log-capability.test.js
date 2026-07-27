const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const test = require("node:test");

const { toolCallLogCapability } = require("../capabilities/tool-call-log-capability");
const { createToolCallLog } = require("../tool-call-log");
const { withServer } = require("./helpers");

function createTempLogPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-tool-call-log-cap-")), "tool-calls.jsonl");
}

function buildApp(toolCallLog) {
  const app = express();
  toolCallLogCapability.registerRoutes(app, { toolCallLog });
  return app;
}

test("GET /tool-calls/recent starts empty", async () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  const app = buildApp(log);
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/tool-calls/recent`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.calls, []);
  });
});

test("GET /tool-calls/recent returns logged calls, most recent last, respecting ?limit", async () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  log.append({ name: "read_file", args: { path: "a.txt" }, ok: true });
  log.append({ name: "read_file", args: { path: "b.txt" }, ok: true });
  const app = buildApp(log);
  await withServer(app, async (baseUrl) => {
    const all = await (await fetch(`${baseUrl}/tool-calls/recent`)).json();
    assert.equal(all.calls.length, 2);

    const limited = await (await fetch(`${baseUrl}/tool-calls/recent?limit=1`)).json();
    assert.equal(limited.calls.length, 1);
    assert.deepEqual(JSON.parse(limited.calls[0].args), { path: "b.txt" });
  });
});

test("getHealth reports the current logged-call count", () => {
  const log = createToolCallLog({ logPath: createTempLogPath() });
  const empty = toolCallLogCapability.getHealth({ toolCallLog: log });
  assert.equal(empty.count, 0);
  assert.match(empty.message, /No tool calls logged yet/);

  log.append({ name: "read_file", args: {}, ok: true });
  const withOne = toolCallLogCapability.getHealth({ toolCallLog: log });
  assert.equal(withOne.count, 1);
});

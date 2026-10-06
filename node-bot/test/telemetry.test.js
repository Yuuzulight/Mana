// #1382: telemetry from what she already measures -- aggregation, missing
// vs zero, transport vs task failures, redaction, bounded storage, stale
// data, config changes, advice-only routing, and the route.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-telemetry-"));

const { buildTelemetry, recommendRoute, plannerSummary, reportRow } = require("../telemetry");
const { createToolCallLog, resultOutcome, wrapWithToolCallLog } = require("../tool-call-log");

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

test("a returned result is judged by what it says; a plain string proves nothing", () => {
  assert.equal(resultOutcome("here's the page text"), "returned");
  assert.equal(resultOutcome(JSON.stringify({ status: "pending" })), "pending");
  assert.equal(resultOutcome(JSON.stringify({ status: "denied" })), "denied");
  assert.equal(resultOutcome({ error: "404" }), "task-failed");
  assert.equal(resultOutcome({ ok: true }), "succeeded");
});

test("the log records outcome and model, still redacts, and stays bounded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-tool-log-"));
  const log = createToolCallLog({ logPath: path.join(dir, "calls.jsonl"), maxBytes: 4000 });
  const policy = wrapWithToolCallLog(
    { tools: [], executeTool: async (name) => (name === "boom" ? Promise.reject(new Error("token=abc")) : JSON.stringify({ error: "not found" })) },
    log,
    null,
    () => ({ model: "qwen.gguf" }),
  );
  await policy.executeTool("web_read", { api_key: "sk-123456789012345678901" });
  await assert.rejects(policy.executeTool("boom", {}));
  const [read, boom] = log.readRecent();
  assert.deepEqual([read.ok, read.outcome, read.model], [true, "task-failed", "qwen.gguf"]);
  assert.match(read.args, /\[redacted\]/);
  assert.deepEqual([boom.ok, boom.outcome], [false, "threw"]);

  for (let i = 0; i < 200; i += 1) log.append({ name: `t${i}`, ok: true });
  assert.ok(fs.statSync(log.logPath).size <= 4000 + 200);
  assert.equal(log.readRecent().at(-1).name, "t199");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("aggregation keeps missing apart from zero and transport apart from task failures", () => {
  const t = buildTelemetry({
    now: NOW,
    toolCalls: [
      { at: ago(1), name: "web_read", model: "9b", ok: true, outcome: "task-failed", durationMs: 100 },
      { at: ago(1), name: "web_read", model: "9b", ok: true, outcome: "succeeded", durationMs: 300 },
      { at: ago(2), name: "old_tool", ok: true, durationMs: 50 }, // logged before outcomes
      { at: ago(40), name: "ancient", ok: true, outcome: "succeeded" }, // outside the window
    ],
  });
  const web = t.tools.find((x) => x.tool === "web_read");
  assert.equal(web.samples, 2);
  assert.equal(web.transportFailures, 0);
  assert.equal(web.taskFailureRate, 0.5);
  assert.equal(web.p50Ms, 300);
  const old = t.tools.find((x) => x.tool === "old_tool");
  assert.equal(old.taskFailureRate, null);
  assert.equal(old.taskFailureInterval, null);
  assert.ok(!t.tools.some((x) => x.tool === "ancient"));
  assert.match(t.missing.join("\n"), /user corrections/);
  assert.match(t.missing.join("\n"), /1 older tool calls/);
  assert.match(t.missing.join("\n"), /benchmarks: no report/);
  assert.equal(t.version, 1);
});

test("stale data is flagged, and a config change is its own row", () => {
  const t = buildTelemetry({
    now: NOW,
    toolCalls: [{ at: ago(10), name: "web_read", ok: true, outcome: "returned" }],
    reports: [
      { kind: "coding", model: "9b", context: 16384, at: ago(1), runs: 27, passes: 9 },
      { kind: "coding", model: "9b", context: 32768, at: ago(1), runs: 27, passes: 12 },
      { kind: "coding", model: "9b", context: 16384, at: ago(3), runs: 27, passes: 3 }, // older, replaced
    ],
  });
  assert.equal(t.tools[0].stale, true);
  assert.deepEqual(t.models.map((m) => [m.context, m.passes ?? m.runs, Math.round(m.passRate * 100)]), [[16384, 27, 33], [32768, 27, 44]]);
  assert.match(plannerSummary(t), /coding 9b @32768: 44% of 27 runs/);
});

test("routing is advice: needs evidence, respects local-only and never picks an unapproved cloud model", () => {
  const t = buildTelemetry({
    now: NOW,
    reports: [
      { kind: "coding", model: "9b", at: ago(1), runs: 30, passes: 9 },
      { kind: "coding", model: "30b", at: ago(1), runs: 30, passes: 24 },
      { kind: "coding", model: "Gemini CLI", at: ago(1), runs: 30, passes: 29 },
      { kind: "coding", model: "7b", at: ago(1), runs: 3, passes: 3 },
    ],
  });
  const candidates = [{ model: "9b", local: true }, { model: "30b", local: true }, { model: "7b", local: true }, { model: "Gemini CLI", local: false }];
  const r = recommendRoute(t, { kind: "coding", current: "9b", candidates });
  assert.equal(r.recommend, "30b");
  assert.match(r.reason, /80% of 30 coding runs/);
  // Approved and allowed: the cloud model wins on evidence...
  assert.equal(recommendRoute(t, { kind: "coding", current: "9b", candidates, approvedFallbacks: ["Gemini CLI"] }).recommend, "Gemini CLI");
  // ...but local-only rules it out even when approved.
  assert.equal(recommendRoute(t, { kind: "coding", current: "9b", candidates, approvedFallbacks: ["Gemini CLI"], localOnly: true }).recommend, "30b");
  // Too few runs for the current model: keep it and say why.
  const thin = recommendRoute(t, { kind: "coding", current: "7b", candidates });
  assert.equal(thin.keep, "7b");
  assert.match(thin.reason, /not enough fresh coding runs for 7b \(3, need 10\)/);
});

test("bench and eval reports become rows by their own shape", () => {
  assert.deepEqual(reportRow({ model: "9b.gguf", context: 16384, passed: 9, total: 27, summary: { runs: 27 } }, ago(0), "r1"), {
    kind: "coding", model: "9b.gguf", context: 16384, at: ago(0), runs: 27, passes: 9, source: "r1",
  });
  assert.equal(reportRow({ model: "9b.gguf", gate: { passed: true }, results: [{ passed: true }, { passed: false }] }, ago(0), "b").kind, "behavior");
  assert.equal(reportRow({ passed: 1 }, ago(0), "x"), null);
});

test("GET /telemetry gives the summary, advice and planner lines", async () => {
  const { createApp } = require("../server");
  const { useTestAdminToken, withServer } = require("./helpers");
  const fetch = useTestAdminToken();
  const app = createApp({
    toolCallLog: { readRecent: () => [{ at: new Date().toISOString(), name: "web_read", ok: true, outcome: "succeeded", durationMs: 120 }], append() {} },
    llamaServerRuntime: { isEnabled: () => false, getStatus: () => ({ model: "D:\\models\\9b.gguf" }) },
  });
  await withServer(app, async (base) => {
    const body = await (await fetch(`${base}/telemetry`)).json();
    assert.equal(body.version, 1);
    assert.equal(body.tools[0].tool, "web_read");
    assert.ok(Array.isArray(body.recommendations));
    assert.match(body.planner, /web_read: 1 calls/);
  });
});

// #1381: behaviour evals -- scoring, intervals, the gate and baseline, the
// scenario files, and the hook that answers tool calls in her reply path.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-behavior-eval-"));

const { loadScenarios, score, wilson, judge, writeReport } = require("../bench/behavior-eval");

const turn = (over = {}) => ({ reply: "", calls: [], approvals: [], ...over });

test("score keeps what she did apart from what she said", () => {
  const s = { turns: [{ user: "x", expect: { called: ["^web_search$"], said: ["31"], notSaid: ["snow"] } }] };
  const both = score(s, { turns: [turn({ reply: "It's 31C.", calls: [{ name: "web_search" }] })] });
  assert.deepEqual([both.passed, both.actionsOk, both.textOk], [true, true, true]);
  // The right answer without looking it up: text right, action wrong.
  const guessed = score(s, { turns: [turn({ reply: "It's 31C." })] });
  assert.deepEqual([guessed.passed, guessed.actionsOk, guessed.textOk], [false, false, true]);
  assert.deepEqual(guessed.failed, ["turn 1: called /^web_search$/"]);
});

test("a call held for approval counts as one she made; approval and errors are checked", () => {
  const s = { turns: [{ user: "x", expect: { called: ["exec_shell_command"], approval: true } }] };
  assert.equal(score(s, { turns: [turn({ approvals: [{ actionType: "tool-destructive", name: "exec_shell_command" }] })] }).passed, true);
  assert.equal(score(s, { turns: [turn({ calls: [{ name: "exec_shell_command" }] })] }).passed, false);
  const broken = score(s, { error: "exit 1" });
  assert.equal(broken.passed, false);
  assert.match(broken.failed[0], /error: exit 1/);
});

test("wilson gives a 95% interval that narrows with more runs", () => {
  const [lo3, hi3] = wilson(3, 3);
  const [lo30, hi30] = wilson(30, 30);
  assert.equal(hi3, 1);
  assert.ok(lo3 > 0.4 && lo3 < 0.5);
  assert.ok(lo30 > lo3 && hi30 === 1);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test("the gate: each scenario's minimum, and only clear drops against the baseline", () => {
  const scenarios = [{ id: "a", kind: "recall" }, { id: "b", kind: "risky", minPass: 1 }];
  const rows = (id, passes, n) => Array.from({ length: n }, (_, i) => ({ id, passed: i < passes, actionsOk: true, textOk: i < passes }));
  const now = judge(scenarios, [...rows("a", 2, 3), ...rows("b", 2, 3)]);
  assert.equal(now.scenarios[0].gateOk, true);
  assert.equal(now.scenarios[1].gateOk, false);
  assert.equal(now.gate.passed, false);
  assert.match(now.gate.failures[0], /^b: 2\/3 is under its gate of 100%/);

  const base = judge(scenarios, [...rows("a", 20, 20), ...rows("b", 20, 20)]);
  // One miss in three runs isn't proof of anything...
  assert.equal(judge(scenarios, [...rows("a", 2, 3), ...rows("b", 3, 3)], base).scenarios[0].baseline.regressed, false);
  // ...ten misses in twenty is.
  const worse = judge(scenarios, [...rows("a", 10, 20), ...rows("b", 20, 20)], base);
  assert.equal(worse.scenarios[0].baseline.regressed, true);
  assert.match(worse.gate.failures.join("\n"), /a: worse than the baseline \(50% vs 100%\)/);
});

test("the report shows actions and text separately, held-out cases and the limits", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mana-behavior-report-"));
  const scenarios = [{ id: "a", kind: "recall", heldOut: true }];
  const rows = [{ id: "a", kind: "recall", repeat: 1, passed: false, actionsOk: false, textOk: true, failed: ["turn 1: called /x/"], tokens: { prompt: 1, completion: 1, peak: 1 } }];
  writeReport(rows, judge(scenarios, rows), out, { label: "t", ref: "abc", model: "m.gguf", seed: "not fixed" });
  const md = fs.readFileSync(path.join(out, "report.md"), "utf8");
  assert.match(md, /\| a \| recall \| yes \| 0\/1 \|/);
  assert.match(md, /Gate: failed/);
  assert.match(md, /a \(run 1\): turn 1: called \/x\//);
  assert.match(md, /voice turn-taking/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")).gate.passed, false);
  fs.rmSync(out, { recursive: true, force: true });
});

test("every scenario file is well formed, and each kind from the issue is covered", () => {
  const scenarios = loadScenarios();
  const ids = new Set();
  for (const s of scenarios) {
    assert.ok(/^[\w-]+$/.test(s.id) && !ids.has(s.id), s.id);
    ids.add(s.id);
    assert.ok(s.turns.length && s.turns.every((t) => typeof t.user === "string"), s.id);
    assert.ok(s.turns.some((t) => t.expect), `${s.id} checks nothing`);
    for (const t of s.turns) for (const r of [...(t.expect?.said || []), ...(t.expect?.notSaid || []), ...(t.expect?.called || []), ...(t.expect?.notCalled || [])]) new RegExp(r, "i");
  }
  const kinds = new Set(scenarios.map((s) => s.kind));
  for (const k of ["recall", "correction", "continuity", "tool-choice", "delegation", "mcp", "approval", "risky"]) assert.ok(kinds.has(k), k);
  assert.ok(scenarios.some((s) => s.heldOut));
});

test("evalTools answers her tool calls inside the risk gate, which my simulated answers pass or stop", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const { createApp } = require("../server");
    const { createApprovalGate } = require("../approval-gate");
    const { simulateMe } = require("../bench/behavior-eval");
    const me = simulateMe(createApprovalGate({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-eval-gate-")) }), ["^exec_shell_command$"]);
    const seen = [];
    let offered = [];
    const results = [];
    const app = createApp({
      env: { ...process.env, MANA_TOOL_APPROVAL: "smart" },
      approvalGate: me.gate,
      llamaServerRuntime: { isEnabled: () => true },
      evalTools: (policy) => ({
        ...policy,
        tools: [...policy.tools, { type: "function", function: { name: "notes__search", parameters: { type: "object", properties: {} } } }],
        executeTool: async (name) => {
          seen.push(name);
          return "from the fixture";
        },
      }),
      runToolAwareReply: async (prompt, toolPolicy) => {
        offered = toolPolicy.tools.map((t) => t.function?.name);
        results.push(await toolPolicy.executeTool("notes__search", { query: "dentist" }));
        results.push(await Promise.resolve(toolPolicy.executeTool("exec_shell_command", { command: "rmdir /s /q D:\\Logs" })).catch((e) => e.message));
        return { content: "done", toolCalls: [], rounds: 2 };
      },
    });
    await app.locals.buildAssistantReply("check my notes", "", "", "default", "eval-hook", null, null, {});
    assert.ok(offered.includes("notes__search"));
    // An unlisted tool asks in smart mode: approved, then answered by the fixture.
    assert.deepEqual(seen, ["notes__search"]);
    assert.match(String(results[0]), /from the fixture/);
    // The denied command never reached the fixture (let alone a shell).
    assert.deepEqual(me.approvals.map((a) => [a.name, a.denied]), [["notes__search", false], ["exec_shell_command", true]]);
    assert.doesNotMatch(String(results[1]), /from the fixture/);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAgenticCodingController,
  PHASES,
  classifyVerificationResult,
  compactAgenticResult,
  validateAction,
} = require("../ai/agentic-coding-controller");

const edit = { path: "src/add.js", old_text: "return a - b;", new_text: "return a + b;" };
const testArgs = { path: "test/add.test.js" };

test("requires verification after a bounded edit batch", () => {
  const c = createAgenticCodingController();
  c.before("coding__propose_edit", edit);
  c.after("coding__propose_edit", edit, JSON.stringify({ status: "ok" }));
  assert.equal(c.snapshot().phase, PHASES.VERIFY);
  c.after("coding__propose_edit", { ...edit, new_text: "return b + a;" }, JSON.stringify({ status: "ok" }));
  c.after("coding__propose_edit", { ...edit, new_text: "return a * b;" }, JSON.stringify({ status: "ok" }));
  assert.throws(() => c.before("coding__propose_edit", { ...edit, new_text: "return a / b;" }), /reached 3 edits/);
  c.before("coding__run_tests", testArgs);
  c.after("coding__run_tests", testArgs, JSON.stringify({ passed: false }));
  assert.equal(c.snapshot().phase, PHASES.DIAGNOSE);
  assert.doesNotThrow(() => c.before("coding__propose_edit", { ...edit, new_text: "return b + a;" }));
});

test("forces review after a passing verification and permits completion only after all passes", () => {
  const c = createAgenticCodingController({ reviewPasses: 3 });
  c.after("coding__propose_edit", edit, JSON.stringify({ status: "ok" }));
  c.after("coding__run_tests", testArgs, JSON.stringify({ passed: true }));
  assert.equal(c.snapshot().phase, PHASES.REVIEW);
  assert.throws(() => c.before("session_goal__finish", { reason: "done" }), /correctness, then edge cases, then scope/);
  for (const pass of ["correctness", "edge cases", "scope"]) {
    c.before("self_work__review", { pass });
    c.after("self_work__review", { pass }, "review");
  }
  c.before("session_goal__finish", { reason: "done" });
  c.after("session_goal__finish", { reason: "done" }, JSON.stringify({ finished: true }));
  assert.equal(c.snapshot().phase, PHASES.COMPLETE);
});

test("rejects identical inspection and identical test retries without poisoning the run", () => {
  const c = createAgenticCodingController();
  const read = { path: "src/add.js", start_line: 1, end_line: 20 };
  c.before("self_work__read", read);
  c.after("self_work__read", read, "source");
  assert.throws(() => c.before("self_work__read", read), error => {
    assert.match(error.message, /already performed/);
    assert.equal(error.recoveryCode, "DUPLICATE_ACTION");
    assert.ok(error.nextActions.includes("self_work__search"));
    return true;
  });
  assert.equal(c.snapshot().phase, PHASES.INSPECT);
  c.after("coding__run_tests", testArgs, JSON.stringify({ passed: false }));
  assert.throws(() => c.before("coding__run_tests", testArgs), error => {
    assert.match(error.message, /already run/);
    assert.equal(error.recoveryCode, "DUPLICATE_TEST");
    return true;
  });
  assert.notEqual(c.snapshot().phase, PHASES.BLOCKED);
});

test("classifies verification failures for recovery and escalation", () => {
  assert.deepEqual(classifyVerificationResult(JSON.stringify({ passed: true })), { kind: "passed", retryable: false });
  assert.deepEqual(classifyVerificationResult(JSON.stringify({ error: "missing fixture: test/data/input.json" })), { kind: "harness", retryable: false });
  assert.deepEqual(classifyVerificationResult(JSON.stringify({ error: "Requested tokens exceed context window" })), { kind: "environment", retryable: true });
  assert.deepEqual(classifyVerificationResult(JSON.stringify({ output: "AssertionError: expected 2" })), { kind: "model_or_code", retryable: true });
});

test("blocks repeated non-progressing actions while preserving recovery", () => {
  const c = createAgenticCodingController({ repeatLimit: 2 });
  const read = { path: "src/add.js", start_line: 1, end_line: 5 };
  c.before("self_work__read", read);
  c.after("self_work__read", read, "source");
  assert.throws(() => c.before("self_work__read", read), /already performed/);
  const search = { text: "return", path: "src" };
  c.before("self_work__search", search);
  c.after("self_work__search", search, "match");
  assert.throws(() => c.before("self_work__search", search), /already performed/);
  assert.notEqual(c.snapshot().phase, PHASES.BLOCKED);
});

test("requires a plan before edits when production mode enables plan gating", () => {
  const c = createAgenticCodingController({ requirePlan: true });
  assert.throws(() => c.before("coding__propose_edit", edit), /short plan/);
  const plan = { steps: ["inspect the target", "edit and verify"] };
  c.before("self_work__plan", plan);
  c.after("self_work__plan", plan, "[ ] 1. inspect the target\n[ ] 2. edit and verify");
  assert.doesNotThrow(() => c.before("coding__propose_edit", edit));
});

test("does not allow a planned run to loop on plan summaries", () => {
  const c = createAgenticCodingController({ requirePlan: true });
  const plan = { steps: ["inspect the target", "edit and verify"] };
  c.before("self_work__plan", plan);
  c.after("self_work__plan", plan, "plan");
  assert.throws(() => c.before("self_work__plan", { summary: "restating the same plan" }), error => {
    assert.equal(error.recoveryCode, "PLAN_ALREADY_SET");
    assert.ok(!error.nextActions.includes("self_work__plan"));
    assert.ok(error.nextActions.includes("self_work__read"));
    return true;
  });
});

test("validates action payloads before they can reach workspace executors", () => {
  assert.throws(() => validateAction("self_work__read", { path: "src/a.js", start_line: 0 }), /positive line/);
  assert.throws(() => validateAction("self_work__search", { text: 3 }), /text must be a string/);
  assert.throws(() => validateAction("coding__propose_edit", { path: "src/a.js", new_text: 3 }), /new_text must be a string/);
  assert.doesNotThrow(() => validateAction("self_work__search", { text: "return", path: "src" }));
});

test("compacts oversized tool results while preserving beginning and failure tail", () => {
  const compacted = compactAgenticResult(JSON.stringify({ output: "BEGIN\n" + "x".repeat(20000) + "\nEND" }), 1200);
  const parsed = JSON.parse(compacted);
  assert.match(parsed.output, /BEGIN/);
  assert.match(parsed.output, /END/);
  assert.match(parsed.output, /context compacted/);
  assert.ok(compacted.length <= 1200);
});

test("publishes legal next actions for each phase", () => {
  const c = createAgenticCodingController({ requirePlan: true });
  assert.deepEqual(c.snapshot().allowedActions, ["self_work__plan", "self_work__files", "self_work__search", "self_work__read"]);
  const plan = { steps: ["inspect", "edit and verify"] };
  c.after("self_work__plan", plan, "plan");
  c.after("coding__propose_edit", edit, JSON.stringify({ status: "ok" }));
  assert.deepEqual(c.snapshot().allowedActions, ["coding__run_tests", "coding__propose_edit"]);
  c.after("coding__run_tests", testArgs, JSON.stringify({ passed: false, output: "AssertionError" }));
  assert.ok(c.snapshot().allowedActions.includes("coding__propose_edit"));
  assert.throws(() => c.before("self_work__review", { pass: "correctness" }), /diagnose phase/);
});

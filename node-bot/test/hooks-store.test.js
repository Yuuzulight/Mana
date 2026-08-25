const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createHooksStore, wrapWithHooks, runPostCommandHook, HOOK_COMMAND_TIMEOUT_MS } = require("../hooks-store");
const { createApprovalGate } = require("../approval-gate");
const { createSnapshotStore } = require("../snapshot-store");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-hooks-store-"));
}

function fakeApprovalGate() {
  const executors = new Map();
  const pending = new Map();
  let nextId = 1;
  return {
    executors,
    registerExecutor: (actionType, fn) => executors.set(actionType, fn),
    requestApproval: async (actionType, details) => {
      const id = String(nextId++);
      pending.set(id, { actionType, payload: details.payload });
      return { status: "pending", requestId: id, summary: details.summary || "", flags: [] };
    },
    decide: async (id, decision) => {
      const entry = pending.get(id);
      if (!entry) return null;
      pending.delete(id);
      if (decision === "deny") return { status: "denied", requestId: id };
      const fn = executors.get(entry.actionType);
      const result = await fn(entry.payload);
      return { status: "approved", requestId: id, result };
    },
  };
}

// ---- createHooksStore: CRUD + persistence ----

test("listRules returns an empty array when no config file exists yet", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  assert.deepEqual(store.listRules(), []);
});

test("listRules falls back to an empty array for a malformed config file", () => {
  const dataDir = createTempDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "hooks.json"), "{ not valid json", "utf8");
  const store = createHooksStore({ dataDir });
  assert.deepEqual(store.listRules(), []);
});

test("addRule persists a deny rule and assigns it an id", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  const rule = store.addRule({ phase: "pre", action: "deny", toolName: "file_write", pathContains: ".env" });
  assert.equal(typeof rule.id, "string");
  assert.equal(rule.phase, "pre");
  assert.equal(rule.action, "deny");
  assert.deepEqual(store.listRules(), [rule]);
});

test("addRule rejects an action that doesn't belong to its phase", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  assert.throws(() => store.addRule({ phase: "pre", action: "run-command", toolName: "file_write", command: "x" }), /action for phase "pre"/);
  assert.throws(() => store.addRule({ phase: "post", action: "deny", toolName: "file_write" }), /action for phase "post"/);
});

test("addRule requires toolName and a command for run-command rules", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  assert.throws(() => store.addRule({ phase: "pre", action: "deny" }), /toolName is required/);
  assert.throws(() => store.addRule({ phase: "post", action: "run-command", toolName: "file_write" }), /command is required/);
});

test("removeRule deletes a persisted rule and returns false for an unknown id", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  const rule = store.addRule({ phase: "pre", action: "ask", toolName: "file_write", pathContains: "package.json" });
  assert.equal(store.removeRule(rule.id), true);
  assert.deepEqual(store.listRules(), []);
  assert.equal(store.removeRule("nope"), false);
});

test("rules persist across a fresh store instance pointed at the same dataDir", () => {
  const dataDir = createTempDir();
  const storeA = createHooksStore({ dataDir });
  storeA.addRule({ phase: "pre", action: "deny", toolName: "file_write" });

  const storeB = createHooksStore({ dataDir });
  assert.equal(storeB.listRules().length, 1);
});

test("matchRules filters by phase, tool name, and path substring", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  store.addRule({ phase: "pre", action: "deny", toolName: "file_write", pathContains: ".env" });
  store.addRule({ phase: "pre", action: "ask", toolName: "file_write", pathContains: "package.json" });
  store.addRule({ phase: "post", action: "run-command", toolName: "file_write", command: "prettier" });

  assert.equal(store.matchRules("file_write", "pre", { path: "src/.env" }).length, 1);
  assert.equal(store.matchRules("file_write", "pre", { path: "src/.env" })[0].action, "deny");
  assert.equal(store.matchRules("file_write", "pre", { path: "package.json" })[0].action, "ask");
  assert.equal(store.matchRules("file_write", "pre", { path: "readme.md" }).length, 0);
  assert.equal(store.matchRules("file_write", "post", { path: "readme.md" }).length, 1);
  assert.equal(store.matchRules("other_tool", "pre", { path: ".env" }).length, 0);
});

test("matchRules on a path-scoped rule never matches a call with no path arg", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  store.addRule({ phase: "pre", action: "deny", toolName: "file_write", pathContains: ".env" });
  assert.equal(store.matchRules("file_write", "pre", {}).length, 0);
  assert.equal(store.matchRules("file_write", "pre", undefined).length, 0);
});

test("a toolName ending in * matches as a prefix glob", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  store.addRule({ phase: "pre", action: "deny", toolName: "skill__*" });
  assert.equal(store.matchRules("skill__create", "pre", {}).length, 1);
  assert.equal(store.matchRules("memory__remember", "pre", {}).length, 0);
});

// ---- #426 review: enabled/disabled + lastRun visibility ----

test("addRule defaults enabled to true; a new rule matches immediately", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  const rule = store.addRule({ phase: "pre", action: "deny", toolName: "file_write" });
  assert.equal(rule.enabled, true);
  assert.equal(store.matchRules("file_write", "pre", {}).length, 1);
});

test("setRuleEnabled(false) makes a rule stop matching without deleting it; setRuleEnabled(true) resumes it", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  const rule = store.addRule({ phase: "pre", action: "deny", toolName: "file_write" });

  const disabled = store.setRuleEnabled(rule.id, false);
  assert.equal(disabled.enabled, false);
  assert.equal(store.matchRules("file_write", "pre", {}).length, 0);
  assert.equal(store.listRules().length, 1, "disabling must not delete the rule");

  const reenabled = store.setRuleEnabled(rule.id, true);
  assert.equal(reenabled.enabled, true);
  assert.equal(store.matchRules("file_write", "pre", {}).length, 1);
});

test("setRuleEnabled returns null for an unknown id and does not throw", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  assert.equal(store.setRuleEnabled("nope", false), null);
});

test("setRuleEnabled persists across a fresh store instance pointed at the same dataDir", () => {
  const dataDir = createTempDir();
  const storeA = createHooksStore({ dataDir });
  const rule = storeA.addRule({ phase: "pre", action: "deny", toolName: "file_write" });
  storeA.setRuleEnabled(rule.id, false);

  const storeB = createHooksStore({ dataDir });
  assert.equal(storeB.listRules()[0].enabled, false);
});

test("recordRunOutcome persists lastRun and is silent for an unknown id", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  const rule = store.addRule({ phase: "post", action: "run-command", toolName: "file_write", command: "prettier" });

  store.recordRunOutcome(rule.id, { ok: true });
  assert.equal(store.listRules()[0].lastRun.ok, true);

  store.recordRunOutcome(rule.id, { ok: false, error: "not found" });
  assert.equal(store.listRules()[0].lastRun.ok, false);
  assert.equal(store.listRules()[0].lastRun.error, "not found");

  assert.doesNotThrow(() => store.recordRunOutcome("nope", { ok: true }));
});

test("a run-command hook's outcome is recorded on the rule when hooksStore is wired into runPostCommandHook", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "post", action: "run-command", toolName: "file_write", command: "prettier", args: ["{path}"] });
  const policy = basePolicy();
  const fakeExecFile = (cmd, args, opts, cb) => cb(new Error("prettier not found"));
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), { execFile: fakeExecFile });

  await wrapped.executeTool("file_write", { path: "src/app.js" });

  const [rule] = hooksStore.listRules();
  assert.equal(rule.lastRun.ok, false);
  assert.match(rule.lastRun.error, /prettier not found/);
});

// ---- wrapWithHooks ----

function basePolicy(fn) {
  const calls = [];
  return {
    calls,
    tools: [{ type: "function", function: { name: "file_write" } }],
    isKnownTool: () => true,
    executeTool: async (name, args) => {
      calls.push({ name, args });
      return fn ? fn(name, args) : `wrote ${args && args.path}`;
    },
  };
}

test("a deny rule short-circuits before the base policy's executeTool ever runs", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "pre", action: "deny", toolName: "file_write", pathContains: ".env", reason: "no .env writes" });
  const policy = basePolicy();
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate());

  await assert.rejects(() => wrapped.executeTool("file_write", { path: ".env" }), /no \.env writes/);
  assert.equal(policy.calls.length, 0, "the base executeTool must never run for a denied call");
});

test("a call with no matching deny/ask rule passes through untouched", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "pre", action: "deny", toolName: "file_write", pathContains: ".env" });
  const policy = basePolicy();
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate());

  const result = await wrapped.executeTool("file_write", { path: "readme.md" });
  assert.equal(result, "wrote readme.md");
  assert.equal(policy.calls.length, 1);
});

test("tools and isKnownTool pass through unchanged", () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  const policy = basePolicy();
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate());
  assert.strictEqual(wrapped.tools, policy.tools);
  assert.strictEqual(wrapped.isKnownTool, policy.isKnownTool);
});

test("an ask rule routes through the approval gate and does not run the base call while pending", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "pre", action: "ask", toolName: "file_write", pathContains: "package.json" });
  const policy = basePolicy();
  const gate = fakeApprovalGate();
  const wrapped = wrapWithHooks(policy, hooksStore, gate);

  const raw = await wrapped.executeTool("file_write", { path: "package.json" });
  const outcome = JSON.parse(raw);
  assert.equal(outcome.status, "pending");
  assert.equal(policy.calls.length, 0, "the base executeTool must not run until approved");

  const decided = await gate.decide(outcome.requestId, "allow-once");
  assert.equal(decided.status, "approved");
  assert.equal(decided.result, "wrote package.json");
  assert.equal(policy.calls.length, 1, "approving must run the real call exactly once");
});

test("an ask rule that gets denied never runs the base call", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "pre", action: "ask", toolName: "file_write", pathContains: "package.json" });
  const policy = basePolicy();
  const gate = fakeApprovalGate();
  const wrapped = wrapWithHooks(policy, hooksStore, gate);

  const raw = await wrapped.executeTool("file_write", { path: "package.json" });
  const outcome = JSON.parse(raw);
  await gate.decide(outcome.requestId, "deny");
  assert.equal(policy.calls.length, 0);
});

test("a post run-command rule fires only after a successful matching call", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({
    phase: "post",
    action: "run-command",
    toolName: "file_write",
    command: "prettier",
    args: ["--write", "{path}"],
  });
  const policy = basePolicy();
  const execCalls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    execCalls.push({ cmd, args });
    cb(null, "", "");
  };
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), { execFile: fakeExecFile });

  await wrapped.executeTool("file_write", { path: "src/app.js" });
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].cmd, "prettier");
  assert.deepEqual(execCalls[0].args, ["--write", "src/app.js"]);
});

test("a post run-command rule does not fire when the base call throws", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "post", action: "run-command", toolName: "file_write", command: "prettier", args: ["{path}"] });
  const policy = basePolicy(() => {
    throw new Error("disk full");
  });
  const execCalls = [];
  const fakeExecFile = (...args) => execCalls.push(args);
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), { execFile: fakeExecFile });

  await assert.rejects(() => wrapped.executeTool("file_write", { path: "src/app.js" }), /disk full/);
  assert.equal(execCalls.length, 0);
});

test("a failing post run-command hook is swallowed and does not affect the tool result", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "post", action: "run-command", toolName: "file_write", command: "prettier", args: ["{path}"] });
  const policy = basePolicy();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const fakeExecFile = (cmd, args, opts, cb) => cb(new Error("prettier not found"));
    const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), { execFile: fakeExecFile });

    const result = await wrapped.executeTool("file_write", { path: "src/app.js" });
    assert.equal(result, "wrote src/app.js", "the tool's own result must be unaffected by a failing hook");
    assert.ok(warnings.length >= 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("runPostCommandHook substitutes {path} with the call's args.path, as its own argv entry", () => {
  const calls = [];
  runPostCommandHook(
    { command: "prettier", args: ["--write", "{path}"] },
    { path: "a; rm -rf /" },
    (cmd, args, opts, cb) => {
      calls.push({ cmd, args, opts });
      cb(null);
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "prettier");
  // The dangerous string lands as ONE argv element, never concatenated into
  // a shell command line.
  assert.deepEqual(calls[0].args, ["--write", "a; rm -rf /"]);
  assert.equal(calls[0].opts.shell, false);
});

test("runPostCommandHook passes the hang-prevention timeout ceiling to execFile", () => {
  const calls = [];
  runPostCommandHook({ command: "prettier", args: [] }, {}, (cmd, args, opts, cb) => {
    calls.push(opts);
    cb(null);
  });
  assert.equal(calls[0].timeout, HOOK_COMMAND_TIMEOUT_MS);
});

test("a post run-command hook that times out is swallowed like any other failure", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "post", action: "run-command", toolName: "file_write", command: "slow-formatter", args: ["{path}"] });
  const policy = basePolicy();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    // Simulates what child_process.execFile does when a command exceeds
    // its `timeout` option: it kills the child and calls back with an
    // ETIMEDOUT-flavored error instead of ever completing.
    const timeoutExecFile = (cmd, args, opts, cb) => {
      const err = new Error("command timed out");
      err.killed = true;
      err.signal = "SIGTERM";
      cb(err);
    };
    const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), { execFile: timeoutExecFile });

    const result = await wrapped.executeTool("file_write", { path: "src/app.js" });
    assert.equal(result, "wrote src/app.js", "a hung/timed-out hook must not affect the tool's own result");
    assert.ok(warnings.length >= 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("two rules matching the same pre-phase call: deny wins over ask", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "pre", action: "deny", toolName: "file_write", pathContains: ".env" });
  hooksStore.addRule({ phase: "pre", action: "ask", toolName: "file_write", pathContains: ".env" });
  const policy = basePolicy();
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate());

  await assert.rejects(() => wrapped.executeTool("file_write", { path: ".env" }));
  assert.equal(policy.calls.length, 0);
});

test("an ask rule blocks and later resumes through the real approval-gate.js, not just a fake", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "pre", action: "ask", toolName: "file_write", pathContains: "package.json" });
  const policy = basePolicy();
  const gate = createApprovalGate({ dataDir: createTempDir() });
  const wrapped = wrapWithHooks(policy, hooksStore, gate);

  const raw = await wrapped.executeTool("file_write", { path: "package.json" });
  const outcome = JSON.parse(raw);
  assert.equal(outcome.status, "pending");
  assert.equal(policy.calls.length, 0);
  assert.equal(gate.listPending().length, 1);

  const decided = await gate.decide(outcome.requestId, "allow-once");
  assert.equal(decided.status, "approved");
  assert.equal(decided.result, "wrote package.json");
  assert.equal(policy.calls.length, 1);
});

test("every matching post rule runs, not just the first", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "post", action: "run-command", toolName: "file_write", command: "prettier", args: ["{path}"] });
  hooksStore.addRule({ phase: "post", action: "run-command", toolName: "file_write", command: "eslint", args: ["{path}"] });
  const policy = basePolicy();
  const execCalls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    execCalls.push(cmd);
    cb(null);
  };
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), { execFile: fakeExecFile });

  await wrapped.executeTool("file_write", { path: "src/app.js" });
  assert.deepEqual(execCalls.sort(), ["eslint", "prettier"]);
});

// ---- #426 sub-project 4: rollback-on-failure ----

test("addRule requires a command for a rollback-on-failure rule, same as run-command", () => {
  const store = createHooksStore({ dataDir: createTempDir() });
  assert.throws(
    () => store.addRule({ phase: "post", action: "rollback-on-failure", toolName: "file_write" }),
    /command is required/,
  );
});

test("a rollback-on-failure rule restores the file's newest snapshot when its command fails", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({
    phase: "post",
    action: "rollback-on-failure",
    toolName: "file_write",
    command: "eslint",
    args: ["{path}"],
  });
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-hooks-rollback-"));
  const filePath = path.join(targetDir, "app.js");
  fs.writeFileSync(filePath, "const x = 2; // broken", "utf8");
  snapshotStore.recordSnapshot({
    kind: "file",
    key: "app.js",
    scope: targetDir,
    payload: "const x = 1; // working",
    summary: "file_write overwrite",
    source: "agent",
  });

  const policy = basePolicy();
  const fakeExecFile = (cmd, args, opts, cb) => cb(new Error("lint failed"));
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), {
    execFile: fakeExecFile,
    snapshotStore,
  });

  await wrapped.executeTool("file_write", { path: filePath });
  // The rollback runs in the execFile callback, asynchronously from
  // executeTool's own return -- wait a tick for it to land.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fs.readFileSync(filePath, "utf8"), "const x = 1; // working");
});

test("a rollback-on-failure rule does not roll back when its command succeeds", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "post", action: "rollback-on-failure", toolName: "file_write", command: "eslint", args: ["{path}"] });
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-hooks-rollback-ok-"));
  const filePath = path.join(targetDir, "app.js");
  fs.writeFileSync(filePath, "const x = 2; // fine", "utf8");
  snapshotStore.recordSnapshot({ kind: "file", key: "app.js", scope: targetDir, payload: "const x = 1;" });

  const policy = basePolicy();
  const fakeExecFile = (cmd, args, opts, cb) => cb(null);
  const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), { execFile: fakeExecFile, snapshotStore });

  await wrapped.executeTool("file_write", { path: filePath });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fs.readFileSync(filePath, "utf8"), "const x = 2; // fine", "a successful command must not trigger a rollback");
});

test("a rollback-on-failure rule with no matching snapshot and no snapshotStore wired in is a silent no-op, same as run-command", async () => {
  const hooksStore = createHooksStore({ dataDir: createTempDir() });
  hooksStore.addRule({ phase: "post", action: "rollback-on-failure", toolName: "file_write", command: "eslint", args: ["{path}"] });
  const policy = basePolicy();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const fakeExecFile = (cmd, args, opts, cb) => cb(new Error("lint failed"));
    // No snapshotStore in options -- behaves exactly like a plain run-command.
    const wrapped = wrapWithHooks(policy, hooksStore, fakeApprovalGate(), { execFile: fakeExecFile });

    const result = await wrapped.executeTool("file_write", { path: "src/app.js" });
    assert.equal(result, "wrote src/app.js");
  } finally {
    console.warn = originalWarn;
  }
});

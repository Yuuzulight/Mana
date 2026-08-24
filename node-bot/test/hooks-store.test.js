const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createHooksStore, wrapWithHooks, runPostCommandHook } = require("../hooks-store");
const { createApprovalGate } = require("../approval-gate");

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

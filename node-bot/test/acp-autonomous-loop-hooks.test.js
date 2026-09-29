// #838: the user's hooks.json rules in Pipeline B (acp-autonomous-loop.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  executeAutonomousStep,
  resetSessionToolCounts,
  MAX_TOOL_CALLS_PER_SESSION,
} = require("../acp-autonomous-loop");
const { createHooksStore } = require("../hooks-store");
const { waitForPendingFile } = require("./helpers");

function hooksWith(...rules) {
  const store = createHooksStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-pb-hooks-")) });
  for (const rule of rules) store.addRule(rule);
  return store;
}

const step = (tool, args) => JSON.stringify([{ tool, args }]);

test("a modify-input rewrite still goes through the tool's own guards", async () => {
  const hooksStore = hooksWith({ phase: "pre", action: "modify-input", toolName: "file_read", set: { path: "../../outside.txt" } });

  const res = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-rewrite", { hooksStore });

  assert.equal(res.results[0].status, "error");
  assert.equal(res.results[0].detail, "path_outside_repo");
});

test("a deny rule is reported as a result and still counts toward the #396 cap", async () => {
  resetSessionToolCounts("pb-deny");
  const hooksStore = hooksWith({ phase: "pre", action: "deny", toolName: "file_read", reason: "no reading today" });

  const first = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-deny", { hooksStore });
  assert.deepEqual(first.results[0], { tool: "file_read", status: "denied", detail: "no reading today" });

  let last;
  for (let i = 0; i < MAX_TOOL_CALLS_PER_SESSION; i++) {
    last = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-deny", { hooksStore });
  }
  assert.equal(last.results[0].detail, "session_cap_exceeded");
  resetSessionToolCounts("pb-deny");
});

test("an ask rule waits for a person: approved runs the call, a timeout rejects it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-pb-ask-"));
  const saved = { dir: process.env.MANA_PENDING_WRITES_DIR, timeout: process.env.FILE_WRITE_APPROVAL_TIMEOUT_MS };
  process.env.MANA_PENDING_WRITES_DIR = dir;
  try {
    const hooksStore = hooksWith({ phase: "pre", action: "ask", toolName: "file_read", reason: "check reads" });

    const running = executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-ask", { hooksStore });
    const pendingFile = await waitForPendingFile(dir);
    const pending = JSON.parse(fs.readFileSync(path.join(dir, pendingFile), "utf8"));
    assert.equal(pending.kind, "hook-ask");
    assert.equal(pending.tool, "file_read");
    assert.equal(pending.reason, "check reads");
    fs.writeFileSync(path.join(dir, pendingFile.replace(/\.json$/, ".approved.json")), JSON.stringify({ approver: "test" }));
    const approved = await running;
    assert.equal(approved.results[0].status, "ok");

    process.env.FILE_WRITE_APPROVAL_TIMEOUT_MS = "30";
    const timedOut = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-ask", { hooksStore });
    assert.deepEqual(timedOut.results[0], { tool: "file_read", status: "rejected", detail: "approval_timeout" });
  } finally {
    for (const [key, value] of [["MANA_PENDING_WRITES_DIR", saved.dir], ["FILE_WRITE_APPROVAL_TIMEOUT_MS", saved.timeout]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deny wins over ask, matched on the rewritten args", async () => {
  const hooksStore = hooksWith(
    { phase: "pre", action: "modify-input", toolName: "file_read", set: { path: "secret.txt" } },
    { phase: "pre", action: "ask", toolName: "file_read" },
    { phase: "pre", action: "deny", toolName: "file_read", pathContains: "secret", reason: "not that one" },
  );

  const res = await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-order", { hooksStore });

  assert.deepEqual(res.results[0], { tool: "file_read", status: "denied", detail: "not that one" });
});

// ---- #838 step 2: post hooks ----

function fakeFileWriteFs(t, existing = true) {
  const saved = {
    stat: fs.promises.stat,
    readFile: fs.promises.readFile,
    writeFile: fs.promises.writeFile,
    appendFile: fs.promises.appendFile,
    mkdir: fs.promises.mkdir,
    env: { allow: process.env.ALLOW_FILE_WRITE, approval: process.env.FILE_WRITE_REQUIRE_APPROVAL },
  };
  process.env.ALLOW_FILE_WRITE = "1";
  process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
  fs.promises.stat = async () => {
    if (!existing) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { isFile: () => true, size: 5 };
  };
  fs.promises.readFile = async () => "old content";
  fs.promises.writeFile = async () => {};
  fs.promises.appendFile = async () => {};
  fs.promises.mkdir = async () => {};
  t.after(() => {
    Object.assign(fs.promises, {
      stat: saved.stat,
      readFile: saved.readFile,
      writeFile: saved.writeFile,
      appendFile: saved.appendFile,
      mkdir: saved.mkdir,
    });
    for (const [key, value] of [["ALLOW_FILE_WRITE", saved.env.allow], ["FILE_WRITE_REQUIRE_APPROVAL", saved.env.approval]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("a post run-command rule runs from the repo root after a successful call only", async () => {
  const hooksStore = hooksWith(
    { phase: "post", action: "run-command", toolName: "file_read", command: "echo", args: ["{path}"] },
    { phase: "pre", action: "deny", toolName: "file_read", pathContains: "blocked" },
  );
  const calls = [];
  const execFile = (cmd, args, opts) => calls.push({ cmd, args, cwd: opts.cwd, shell: opts.shell });

  await executeAutonomousStep(step("file_read", { path: "README.md" }), "pb-post", { hooksStore, execFile });
  await executeAutonomousStep(step("file_read", { path: "blocked.md" }), "pb-post", { hooksStore, execFile });
  await executeAutonomousStep(step("file_read", { path: "missing-file.md" }), "pb-post", { hooksStore, execFile });

  assert.deepEqual(calls, [{ cmd: "echo", args: ["README.md"], cwd: path.resolve(__dirname, "..", ".."), shell: false }]);
});

test("rollback-on-failure after a file_write overwrite restores that write's own snapshot", async (t) => {
  fakeFileWriteFs(t);
  const hooksStore = hooksWith({ phase: "post", action: "rollback-on-failure", toolName: "write", command: "eslint", args: ["{path}"] });
  const restored = [];
  const snapshotStore = {
    recordSnapshot: () => ({ id: "snap-this-write" }),
    restoreSnapshot: async (id) => restored.push(id),
  };
  const execFile = (cmd, args, opts, cb) => cb(new Error("lint failed"));
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
  });

  const res = await executeAutonomousStep(
    step("file_write", { path: "src/pb-out.txt", content: "new", mode: "overwrite" }),
    "pb-rollback",
    { hooksStore, execFile, snapshotStore },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.results[0].snapshotId, "snap-this-write");
  assert.deepEqual(restored, ["snap-this-write"]);

  // An append takes no snapshot, so there is nothing to roll back.
  await executeAutonomousStep(
    step("file_write", { path: "src/pb-out.txt", content: "more", mode: "append" }),
    "pb-rollback",
    { hooksStore, execFile, snapshotStore },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(restored, ["snap-this-write"]);
});

// ---- #838 step 4: adversarial review of file_write, and one prompt ----

// Fakes only the write target, so the real pending-request files still land
// in the approval dir.
function fakeTarget(t, target) {
  const saved = {
    stat: fs.promises.stat,
    readFile: fs.promises.readFile,
    writeFile: fs.promises.writeFile,
    mkdir: fs.promises.mkdir,
  };
  const writes = [];
  const hit = (p) => String(p).includes(target);
  fs.promises.stat = async (p, ...rest) => (hit(p) ? { isFile: () => true, size: 3 } : saved.stat(p, ...rest));
  fs.promises.readFile = async (p, ...rest) => (hit(p) ? "old" : saved.readFile(p, ...rest));
  fs.promises.writeFile = async (p, content, ...rest) => (hit(p) ? writes.push(content) : saved.writeFile(p, content, ...rest));
  fs.promises.mkdir = async (p, ...rest) => (hit(p) ? undefined : saved.mkdir(p, ...rest));
  t.after(() => Object.assign(fs.promises, saved));
  return writes;
}

function approvalEnv(t, requireApproval) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-pb-review-"));
  const saved = {
    ALLOW_FILE_WRITE: process.env.ALLOW_FILE_WRITE,
    FILE_WRITE_REQUIRE_APPROVAL: process.env.FILE_WRITE_REQUIRE_APPROVAL,
    MANA_PENDING_WRITES_DIR: process.env.MANA_PENDING_WRITES_DIR,
  };
  Object.assign(process.env, { ALLOW_FILE_WRITE: "1", FILE_WRITE_REQUIRE_APPROVAL: requireApproval, MANA_PENDING_WRITES_DIR: dir });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function approveNext(dir) {
  const pendingFile = await waitForPendingFile(dir);
  const payload = JSON.parse(fs.readFileSync(path.join(dir, pendingFile), "utf8"));
  fs.writeFileSync(path.join(dir, pendingFile.replace(/\.json$/, ".approved.json")), JSON.stringify({ approver: "test" }));
  // Wait for the loop to consume (archive) it before the next one appears.
  for (let i = 0; i < 100 && fs.existsSync(path.join(dir, pendingFile)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return payload;
}

test("a refuted source-file write asks, even with approved:true and approvals off", async (t) => {
  const dir = approvalEnv(t, "0");
  const writes = fakeTarget(t, "pb-review.js");
  const reviewed = [];
  const reviewWrite = async (input) => {
    reviewed.push(input);
    return { verdict: "refuted", failingCase: "an empty list crashes it", reason: "" };
  };

  const running = executeAutonomousStep(
    step("file_write", { path: "src/pb-review.js", content: "new", mode: "overwrite", approved: true }),
    "pb-review",
    { reviewWrite, hooksStore: hooksWith(), snapshotStore: { recordSnapshot: () => ({ id: "s" }) } },
  );
  const pending = await approveNext(dir);
  const res = await running;

  assert.deepEqual(reviewed, [{ path: path.join("src", "pb-review.js"), before: "old", after: "new", summary: "file_write (overwrite)" }]);
  assert.equal(pending.adversarialReview.failingCase, "an empty list crashes it");
  assert.equal(res.results[0].status, "ok");
  assert.deepEqual(writes, ["new"]);
});

test("a write the review holds, or a non-source file, needs no extra approval", async (t) => {
  approvalEnv(t, "0");
  fakeTarget(t, "pb-review");
  const reviewed = [];
  const reviewWrite = async (input) => {
    reviewed.push(input.path);
    return { verdict: "holds", failingCase: "", reason: "" };
  };
  const options = { reviewWrite, hooksStore: hooksWith(), snapshotStore: { recordSnapshot: () => ({ id: "s" }) } };

  const js = await executeAutonomousStep(step("file_write", { path: "src/pb-review.js", content: "x" }), "pb-review", options);
  const txt = await executeAutonomousStep(step("file_write", { path: "src/pb-review.txt", content: "x" }), "pb-review", options);

  assert.equal(js.results[0].status, "ok");
  assert.equal(txt.results[0].status, "ok");
  assert.deepEqual(reviewed, [path.join("src", "pb-review.js")], "only the source file is reviewed");
});

test("one prompt: an approved hook ask is the write's approval, unless the review refutes it", async (t) => {
  const dir = approvalEnv(t, "1");
  fakeTarget(t, "pb-review.js");
  let verdict = "holds";
  const options = {
    reviewWrite: async () => ({ verdict, failingCase: verdict === "refuted" ? "breaks on null" : "", reason: "" }),
    hooksStore: hooksWith({ phase: "pre", action: "ask", toolName: "write", reason: "check writes" }),
    snapshotStore: { recordSnapshot: () => ({ id: "s" }) },
  };
  const write = () => executeAutonomousStep(step("file_write", { path: "src/pb-review.js", content: "x" }), "pb-review", options);

  const once = write();
  assert.equal((await approveNext(dir)).kind, "hook-ask");
  assert.equal((await once).results[0].status, "ok", "no second prompt after the approved ask");

  verdict = "refuted";
  const twice = write();
  assert.equal((await approveNext(dir)).kind, "hook-ask");
  const second = await approveNext(dir);
  assert.equal(second.adversarialReview.failingCase, "breaks on null");
  assert.equal((await twice).results[0].status, "ok");
});

// ---- #838 step 5: a broken hooks.json fails closed ----

test("a broken hooks.json refuses file_write, snapshot_restore and run_tests; reads still work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-pb-broken-"));
  fs.writeFileSync(path.join(dir, "hooks.json"), "[{ half written");
  const hooksStore = createHooksStore({ dataDir: dir });
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await executeAutonomousStep(
      JSON.stringify([
        { tool: "file_write", args: { path: "src/x.js", content: "x" } },
        { tool: "snapshot_restore", args: { id: "s1" } },
        { tool: "run_tests", args: { command: "npm test" } },
        { tool: "file_read", args: { path: "README.md" } },
      ]),
      "pb-broken",
      { hooksStore },
    );

    assert.deepEqual(
      res.results.map((r) => [r.tool, r.status, r.detail]),
      [
        ["file_write", "error", "hooks_config_unreadable"],
        ["snapshot_restore", "error", "hooks_config_unreadable"],
        ["run_tests", "error", "hooks_config_unreadable"],
        ["file_read", "ok", undefined],
      ],
    );
  } finally {
    console.error = originalError;
  }
});

// ---- #838 step 6: the finish hook ----

test("finish runs my finish rules and reports them to the ACP client, without blocking the finish", async () => {
  const hooksStore = hooksWith({ phase: "finish", action: "run-command", command: "npm", args: ["test"] });
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    cb(Object.assign(new Error("exit 1"), { code: 1 }), "2 failing\n", "");
  };

  const res = await executeAutonomousStep(step("finish", { reason: "done" }), "pb-finish", { hooksStore, execFile });

  assert.equal(res.status, "finished");
  assert.equal(res.reason, "done");
  assert.deepEqual(calls, [{ cmd: "npm", args: ["test"], cwd: path.resolve(__dirname, "..", "..") }]);
  assert.equal(res.finishChecks.length, 1);
  assert.deepEqual(
    [res.finishChecks[0].ok, res.finishChecks[0].exitCode, res.finishChecks[0].output],
    [false, 1, "2 failing\n"],
  );

  const none = await executeAutonomousStep(step("finish", {}), "pb-finish", { hooksStore: hooksWith(), execFile });
  assert.equal(none.status, "finished");
  assert.equal(none.finishChecks, undefined);
});

test("finish with a broken hooks.json reports that the checks couldn't run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-pb-broken-finish-"));
  fs.writeFileSync(path.join(dir, "hooks.json"), "not json");
  const res = await executeAutonomousStep(step("finish", {}), "pb-finish", {
    hooksStore: createHooksStore({ dataDir: dir }),
    execFile: () => assert.fail("no command should run"),
  });
  assert.deepEqual(res.finishChecks, [{ ok: false, detail: "hooks_config_unreadable" }]);
});

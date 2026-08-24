const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const fs = require("fs");
const os = require("node:os");
const path = require("node:path");

const {
  executeAutonomousStep,
  resetSessionTestRetryCounts,
  MAX_TEST_RETRY_ATTEMPTS,
} = require("../acp-autonomous-loop");
const { createSnapshotStore } = require("../snapshot-store");

// This test suite monkeypatches axios.post and fs.promises in-process to provide deterministic,
// dependency-free unit tests for the autonomous loop without any external libs.

function makeMockPost(behavior) {
  return async function mockPost(url, body, opts) {
    // simple routing based on body.query
    const q = body && body.query ? String(body.query) : "";
    // allow async simulation
    await new Promise((r) => setTimeout(r, 0));

    if (behavior[q]) {
      const resp = behavior[q];
      if (resp instanceof Error) throw resp;
      return { data: resp };
    }

    // Default: return empty array
    return { data: [] };
  };
}

test("acp-autonomous-loop: single local_retrieve executes and returns context", async (t) => {
  const originalPost = axios.post;
  try {
    axios.post = makeMockPost({
      "server.js port": [
        {
          meta: { filepath: "server.js", text: "server listens on port 5005" },
        },
      ],
    });

    const mockModelReply =
      'Looking that up:\n[{"tool":"local_retrieve","args":{"query":"server.js port","k":1}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.equal(res.status, "tools_executed");
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 1);
    const first = res.results[0];
    assert.equal(first.tool, "local_retrieve");
    assert.equal(first.status, "ok");
    assert.equal(first.hits, 1);
    assert.ok(first.injectedContext.includes("server.js"));
    assert.ok(res.combinedInjectedContext.includes("server.js"));
  } finally {
    axios.post = originalPost;
  }
});

test("acp-autonomous-loop: multiple local_retrieve actions aggregate results", async (t) => {
  const originalPost = axios.post;
  try {
    axios.post = makeMockPost({
      "alpha query": [
        { meta: { filepath: "alpha.txt", text: "alpha content" } },
      ],
      "beta query": [{ meta: { filepath: "beta.txt", text: "beta content" } }],
    });

    const mockModelReply =
      'Seq:\n[{"tool":"local_retrieve","args":{"query":"alpha query","k":1}},{"tool":"local_retrieve","args":{"query":"beta query","k":1}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.equal(res.status, "tools_executed");
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].tool, "local_retrieve");
    assert.equal(res.results[1].tool, "local_retrieve");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[1].status, "ok");
    assert.ok(res.combinedInjectedContext.includes("alpha content"));
    assert.ok(res.combinedInjectedContext.includes("beta content"));
    // ensure separator exists between two contexts
    assert.ok(res.combinedInjectedContext.includes("\n\n---\n\n"));
  } finally {
    axios.post = originalPost;
  }
});

test("acp-autonomous-loop: one failing tool does not block others", async (t) => {
  const originalPost = axios.post;
  try {
    axios.post = makeMockPost({
      "fail query": new Error("simulated retriever failure"),
      "ok query": [{ meta: { filepath: "ok.txt", text: "ok content" } }],
    });

    const mockModelReply =
      'Seq:\n[{"tool":"local_retrieve","args":{"query":"fail query","k":1}},{"tool":"local_retrieve","args":{"query":"ok query","k":1}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    // Should include both results and mark the first as error, the second as ok
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].tool, "local_retrieve");
    assert.equal(res.results[0].status, "error");
    assert.ok(res.results[0].detail.includes("simulated retriever failure"));
    assert.equal(res.results[1].status, "ok");
    assert.ok(res.combinedInjectedContext.includes("ok content"));
  } finally {
    axios.post = originalPost;
  }
});

// New file_read tests

test("acp-autonomous-loop: file_read reads a file within repo root", async (t) => {
  const origStat = fs.promises.stat;
  const origRead = fs.promises.readFile;
  try {
    // Monkeypatch stat and readFile
    fs.promises.stat = async (p) => ({ isFile: () => true, size: 42 });
    fs.promises.readFile = async (p, opts) => "console.log('hello world')\n";

    const mockModelReply =
      'Fetch file:\n[{"tool":"file_read","args":{"path":"src/index.js"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.equal(res.status, "tools_executed");
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 1);
    const r = res.results[0];
    assert.equal(r.tool, "file_read");
    assert.equal(r.status, "ok");
    assert.equal(r.path, "src/index.js");
    assert.equal(r.size, 42);
    assert.ok(r.injectedContext.includes("console.log('hello world')"));
  } finally {
    fs.promises.stat = origStat;
    fs.promises.readFile = origRead;
  }
});

test("acp-autonomous-loop: file_read blocks paths outside repo", async (t) => {
  const origStat = fs.promises.stat;
  const origRead = fs.promises.readFile;
  try {
    // These should not be called, but stub to be safe
    fs.promises.stat = async (p) => ({ isFile: () => true, size: 10 });
    fs.promises.readFile = async (p, opts) => "should not read";

    const mockModelReply =
      'Fetch file:\n[{"tool":"file_read","args":{"path":"C:\\Windows\\system.ini"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    // Should return idle or results with error for file_read
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_read");
    assert.equal(res.results[0].status, "error");
    assert.ok(
      res.results[0].detail === "path_outside_repo" ||
        typeof res.results[0].detail === "string",
    );
  } finally {
    fs.promises.stat = origStat;
    fs.promises.readFile = origRead;
  }
});

// file_write tests

test("acp-autonomous-loop: file_write forbidden when disabled", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  try {
    process.env.ALLOW_FILE_WRITE = "0";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/out.txt","content":"x"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_write");
    assert.equal(res.results[0].status, "forbidden");
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
  }
});

test("acp-autonomous-loop: file_write append succeeds when enabled", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  const origStat = fs.promises.stat;
  const origAppend = fs.promises.appendFile;
  try {
    process.env.ALLOW_FILE_WRITE = "1";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    // simulate existing file size 10
    fs.promises.stat = async (p) => ({ isFile: () => true, size: 10 });
    let appended = false;
    fs.promises.appendFile = async (p, content, opts) => {
      appended = true;
    };

    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/log.txt","content":"abc","mode":"append"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_write");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[0].action, "appended");
    assert.equal(res.results[0].size, 13);
    assert.ok(appended);
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
    fs.promises.stat = origStat;
    fs.promises.appendFile = origAppend;
  }
});

test("acp-autonomous-loop: file_write overwrite records a restorable snapshot instead of a .bak file", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  const origStat = fs.promises.stat;
  const origRead = fs.promises.readFile;
  const origWrite = fs.promises.writeFile;
  try {
    process.env.ALLOW_FILE_WRITE = "1";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    let lastWriteSize = null;

    // stat behaves: before write -> exists with size 10; after write -> returns {size: lastWriteSize}
    fs.promises.stat = async (p) => {
      if (lastWriteSize === null) return { isFile: () => true, size: 10 };
      return { isFile: () => true, size: lastWriteSize };
    };
    fs.promises.readFile = async (p, enc) => "previous content";
    fs.promises.writeFile = async (p, content, opts) => {
      lastWriteSize = Buffer.byteLength(content, "utf8");
    };

    const recorded = [];
    const fakeSnapshotStore = {
      recordSnapshot: (record) => {
        recorded.push(record);
        return { id: "snap-fake-1", ...record };
      },
    };

    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/out.txt","content":"hello world","mode":"overwrite"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session", {
      snapshotStore: fakeSnapshotStore,
    });

    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_write");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[0].action, "overwritten");
    assert.equal(res.results[0].size, Buffer.byteLength("hello world", "utf8"));

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].kind, "file");
    assert.equal(recorded[0].key, path.join("src", "out.txt"));
    assert.equal(recorded[0].payload, "previous content");
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
    fs.promises.stat = origStat;
    fs.promises.readFile = origRead;
    fs.promises.writeFile = origWrite;
  }
});

// REPO_ROOT is resolved once at module load (acp-autonomous-loop.js top
// level), so it can't be redirected per-test via process.env -- this test
// exercises the exact record shape file_write now produces (kind: "file",
// a repo-relative key, REPO_ROOT as scope, prior content as payload)
// directly against a real snapshot store and a real temp target directory,
// rather than fighting that fixed REPO_ROOT to drive the restore through
// executeAutonomousStep itself.
test("a file_write snapshot's record shape round-trips through the real snapshot store", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-autonomous-loop-restore-"));
  const snapshotStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-autonomous-loop-snapshots-"));
  fs.writeFileSync(path.join(targetDir, "out.txt"), "new content", "utf8");
  try {
    const snapshotStore = createSnapshotStore({ dataDir: snapshotStoreDir });
    const recorded = snapshotStore.recordSnapshot({
      kind: "file",
      key: "out.txt",
      scope: targetDir,
      payload: "previous content",
      summary: "file_write overwrite",
    });

    await snapshotStore.restoreSnapshot(recorded.id);
    assert.equal(fs.readFileSync(path.join(targetDir, "out.txt"), "utf8"), "previous content");
    assert.equal(snapshotStore.getSnapshot(recorded.id), null);
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(snapshotStoreDir, { recursive: true, force: true });
  }
});

test("a tool that runs past the per-session cap is refused (issue #396)", async () => {
  const { resetSessionToolCounts, MAX_TOOL_CALLS_PER_SESSION } = require("../acp-autonomous-loop");
  resetSessionToolCounts("cap-session");

  const step = JSON.stringify([{ tool: "unknown_tool", args: {} }]);
  let last;
  for (let i = 0; i < MAX_TOOL_CALLS_PER_SESSION + 1; i++) {
    last = await executeAutonomousStep(step, "cap-session");
  }

  const capped = last.results.find((r) => r.detail === "session_cap_exceeded");
  assert.ok(capped, "the call past the cap should be refused");
  assert.equal(capped.status, "error");
  assert.equal(capped.cap, MAX_TOOL_CALLS_PER_SESSION);
  resetSessionToolCounts("cap-session");
});

test("the cap is counted per session, not globally (issue #396)", async () => {
  const { resetSessionToolCounts, MAX_TOOL_CALLS_PER_SESSION } = require("../acp-autonomous-loop");
  resetSessionToolCounts();

  const step = JSON.stringify([{ tool: "unknown_tool", args: {} }]);
  for (let i = 0; i < MAX_TOOL_CALLS_PER_SESSION; i++) {
    await executeAutonomousStep(step, "session-a");
  }

  // One conversation's runaway loop must not spend another's budget.
  const other = await executeAutonomousStep(step, "session-b");
  assert.ok(!other.results.some((r) => r.detail === "session_cap_exceeded"));
  resetSessionToolCounts();
});

test("resetSessionToolCounts clears a session's budget (issue #396)", async () => {
  const { resetSessionToolCounts, MAX_TOOL_CALLS_PER_SESSION } = require("../acp-autonomous-loop");
  resetSessionToolCounts("reset-session");

  const step = JSON.stringify([{ tool: "unknown_tool", args: {} }]);
  for (let i = 0; i < MAX_TOOL_CALLS_PER_SESSION + 1; i++) {
    await executeAutonomousStep(step, "reset-session");
  }
  resetSessionToolCounts("reset-session");

  const after = await executeAutonomousStep(step, "reset-session");
  assert.ok(!after.results.some((r) => r.detail === "session_cap_exceeded"));
  resetSessionToolCounts("reset-session");
});

// Issue #401: this loop is driven externally (Zed, or any other ACP
// client), so it can't literally stop itself the way the main voice-chat
// tool-calling loop's session_goal__finish can -- "finish" is a signal
// executeAutonomousStep reports back, for the caller to act on.
test("a 'finish' action reports status:finished with the given reason, instead of tools_executed/idle", async () => {
  const step = JSON.stringify([{ tool: "finish", args: { reason: "Login bug is fixed." } }]);
  const res = await executeAutonomousStep(step, "finish-session");

  assert.equal(res.status, "finished");
  assert.equal(res.reason, "Login bug is fixed.");
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].tool, "finish");
  assert.equal(res.results[0].status, "ok");
});

test("a 'finish' action with no reason still finishes, with a default reason", async () => {
  const step = JSON.stringify([{ tool: "finish", args: {} }]);
  const res = await executeAutonomousStep(step, "finish-session-2");

  assert.equal(res.status, "finished");
  assert.equal(res.reason, "goal achieved");
});

test("a step with 'finish' alongside other actions still reports status:finished overall", async () => {
  const step = JSON.stringify([
    { tool: "finish", args: { reason: "Done." } },
    { tool: "unknown_tool", args: {} },
  ]);
  const res = await executeAutonomousStep(step, "finish-session-3");

  // Every action in the array is still reported in results (the loop
  // doesn't break early mid-array), but the overall status is "finished"
  // regardless of what else was in this same step -- a client respecting
  // the signal stops calling mana/agent/run again either way.
  assert.equal(res.status, "finished");
  assert.equal(res.results.length, 2);
  assert.ok(res.results.some((r) => r.tool === "finish" && r.status === "ok"));
  assert.ok(res.results.some((r) => r.tool === "unknown_tool" && r.status === "unsupported"));
});

// Issue #419: run_tests wires acp-test-runner into this loop. An explicit,
// model-called tool -- not auto-triggered after file_write -- so every test
// here drives it directly via a step array, same as every other tool.
function fakeTestRunner(behavior) {
  return {
    run: async (command, opts) => {
      const result = typeof behavior === "function" ? behavior(command, opts) : behavior;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// Issue #422: run_tests now makes a real scratch copy of REPO_ROOT (the
// actual worktree) before running. Without faking this, every run_tests
// test below would spend real seconds doing real disk I/O against the real
// repo instead of testing this loop's own retry/reporting logic -- fast and
// deterministic here, with workspace-scratch-copy.test.js covering the real
// copy/junction/cleanup behavior directly.
function fakeScratchWorkspace() {
  return {
    createScratchWorkspaceCopy: () => "C:\\fake-scratch-dir",
    removeScratchWorkspaceCopy: () => {},
  };
}

test("run_tests creates a scratch copy, runs the test command inside it, and always cleans up", async () => {
  resetSessionTestRetryCounts("run-tests-scratch-wiring");
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "npm test" } }]);
  const calls = { create: [], remove: [], runCwd: null };

  await executeAutonomousStep(step, "run-tests-scratch-wiring", {
    testRunner: {
      run: async (command, opts) => {
        calls.runCwd = opts.cwd;
        return { command, exitCode: 0, ok: true, stdout: "", stderr: "" };
      },
    },
    createScratchWorkspaceCopy: (sourceRoot) => {
      calls.create.push(sourceRoot);
      return "C:\\fake-scratch-dir";
    },
    removeScratchWorkspaceCopy: (scratchDir) => {
      calls.remove.push(scratchDir);
    },
  });

  assert.strictEqual(calls.create.length, 1);
  assert.strictEqual(calls.remove.length, 1);
  assert.strictEqual(calls.remove[0], "C:\\fake-scratch-dir");
  // The test command must run inside the scratch copy, not the real repo.
  assert.ok(calls.runCwd.startsWith("C:\\fake-scratch-dir"));
});

test("run_tests still cleans up the scratch copy when the test command itself fails", async () => {
  resetSessionTestRetryCounts("run-tests-scratch-cleanup-fail");
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "npm test" } }]);
  const calls = { remove: [] };

  await executeAutonomousStep(step, "run-tests-scratch-cleanup-fail", {
    testRunner: fakeTestRunner({ command: "npm test", exitCode: 1, ok: false, stdout: "fail", stderr: "" }),
    createScratchWorkspaceCopy: () => "C:\\fake-scratch-dir",
    removeScratchWorkspaceCopy: (scratchDir) => calls.remove.push(scratchDir),
  });

  assert.strictEqual(calls.remove.length, 1);
});

test("run_tests still cleans up the scratch copy when the test runner throws", async () => {
  resetSessionTestRetryCounts("run-tests-scratch-cleanup-throw");
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "npm test" } }]);
  const calls = { remove: [] };

  await executeAutonomousStep(step, "run-tests-scratch-cleanup-throw", {
    testRunner: fakeTestRunner(() => {
      throw new Error("test command timed out after 120000ms");
    }),
    createScratchWorkspaceCopy: () => "C:\\fake-scratch-dir",
    removeScratchWorkspaceCopy: (scratchDir) => calls.remove.push(scratchDir),
  });

  assert.strictEqual(calls.remove.length, 1);
});

test("run_tests reports scratch_copy_failed and does not call the test runner when the copy itself fails", async () => {
  resetSessionTestRetryCounts("run-tests-scratch-copy-error");
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "npm test" } }]);
  let runnerCalled = false;

  const res = await executeAutonomousStep(step, "run-tests-scratch-copy-error", {
    testRunner: fakeTestRunner(() => {
      runnerCalled = true;
      return { command: "npm test", exitCode: 0, ok: true, stdout: "", stderr: "" };
    }),
    createScratchWorkspaceCopy: () => {
      throw new Error("disk full");
    },
  });

  assert.strictEqual(res.results[0].status, "error");
  assert.strictEqual(res.results[0].detail, "scratch_copy_failed");
  assert.strictEqual(runnerCalled, false);
});

test("run_tests requires a command arg", async () => {
  const step = JSON.stringify([{ tool: "run_tests", args: {} }]);
  const res = await executeAutonomousStep(step, "run-tests-missing-cmd");

  assert.equal(res.results[0].tool, "run_tests");
  assert.equal(res.results[0].status, "error");
  assert.equal(res.results[0].detail, "missing_command_arg");
});

test("run_tests rejects a cwd that escapes the repo root", async () => {
  const step = JSON.stringify([
    { tool: "run_tests", args: { command: "npm test", cwd: "C:\\Windows\\System32" } },
  ]);
  const res = await executeAutonomousStep(step, "run-tests-bad-cwd", {
    testRunner: fakeTestRunner(() => {
      throw new Error("should never be called");
    }),
  });

  assert.equal(res.results[0].status, "error");
  assert.equal(res.results[0].detail, "path_outside_repo");
});

test("run_tests reports a pass and injects a short confirmation, not the full output", async () => {
  resetSessionTestRetryCounts("run-tests-pass");
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "npm test" } }]);
  const res = await executeAutonomousStep(step, "run-tests-pass", {
    testRunner: fakeTestRunner({ command: "npm test", exitCode: 0, ok: true, stdout: "all good", stderr: "" }),
    ...fakeScratchWorkspace(),
  });

  assert.equal(res.status, "tools_executed");
  const result = res.results[0];
  assert.equal(result.tool, "run_tests");
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.match(result.injectedContext, /Tests passed/);
});

test("run_tests reports a failure, folds the output tail into injectedContext, and counts a retry attempt", async () => {
  resetSessionTestRetryCounts("run-tests-fail");
  const failingOutput = "x".repeat(3000) + "AssertionError: expected true to be false";
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "node --test" } }]);
  const res = await executeAutonomousStep(step, "run-tests-fail", {
    testRunner: fakeTestRunner({ command: "node --test", exitCode: 1, ok: false, stdout: failingOutput, stderr: "" }),
    ...fakeScratchWorkspace(),
  });

  const result = res.results[0];
  assert.equal(result.status, "fail");
  assert.equal(result.attempt, 1);
  assert.equal(result.retriesRemaining, MAX_TEST_RETRY_ATTEMPTS - 1);
  // Tail, not head -- the actual assertion detail (at the end of the
  // fixture's output) must survive truncation; the leading "x" filler must not.
  assert.match(result.injectedContext, /AssertionError: expected true to be false/);
  assert.ok(!result.injectedContext.includes("x".repeat(3000)));
});

test("run_tests resets the retry counter after a pass following failures", async () => {
  resetSessionTestRetryCounts("run-tests-reset");
  const failStep = JSON.stringify([{ tool: "run_tests", args: { command: "npm test" } }]);
  const runner = fakeTestRunner((command, opts) => runner._nextResult);
  runner._nextResult = { command: "npm test", exitCode: 1, ok: false, stdout: "fail", stderr: "" };

  await executeAutonomousStep(failStep, "run-tests-reset", { testRunner: runner, ...fakeScratchWorkspace() });
  runner._nextResult = { command: "npm test", exitCode: 0, ok: true, stdout: "pass", stderr: "" };
  const passRes = await executeAutonomousStep(failStep, "run-tests-reset", { testRunner: runner, ...fakeScratchWorkspace() });
  assert.equal(passRes.results[0].status, "ok");

  // A subsequent failure after the reset should be attempt 1 again, not 2.
  runner._nextResult = { command: "npm test", exitCode: 1, ok: false, stdout: "fail again", stderr: "" };
  const failAgainRes = await executeAutonomousStep(failStep, "run-tests-reset", { testRunner: runner, ...fakeScratchWorkspace() });
  assert.equal(failAgainRes.results[0].attempt, 1);
});

test("run_tests refuses to run once the per-session retry cap is exhausted", async () => {
  resetSessionTestRetryCounts("run-tests-exhausted");
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "npm test" } }]);
  const runner = fakeTestRunner({ command: "npm test", exitCode: 1, ok: false, stdout: "fail", stderr: "" });

  for (let i = 0; i < MAX_TEST_RETRY_ATTEMPTS; i++) {
    const res = await executeAutonomousStep(step, "run-tests-exhausted", { testRunner: runner, ...fakeScratchWorkspace() });
    assert.equal(res.results[0].status, "fail");
  }

  const exhausted = await executeAutonomousStep(step, "run-tests-exhausted", { testRunner: runner, ...fakeScratchWorkspace() });
  assert.equal(exhausted.results[0].status, "retry_exhausted");
  assert.equal(exhausted.results[0].cap, MAX_TEST_RETRY_ATTEMPTS);
  resetSessionTestRetryCounts("run-tests-exhausted");
});

test("run_tests: a disallowed-command rejection does not consume a retry attempt", async () => {
  resetSessionTestRetryCounts("run-tests-disallowed");
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "rm -rf /" } }]);
  const runner = fakeTestRunner(() => {
    throw new Error("test command is not allowed: rm -rf /");
  });

  // Calling it more times than the retry cap should still never exhaust the
  // budget, since none of these attempts are real test failures.
  for (let i = 0; i < MAX_TEST_RETRY_ATTEMPTS + 2; i++) {
    const res = await executeAutonomousStep(step, "run-tests-disallowed", { testRunner: runner, ...fakeScratchWorkspace() });
    assert.equal(res.results[0].status, "error");
    assert.notEqual(res.results[0].status, "retry_exhausted");
  }
  resetSessionTestRetryCounts("run-tests-disallowed");
});

test("run_tests: a timeout rejection does consume a retry attempt", async () => {
  resetSessionTestRetryCounts("run-tests-timeout");
  const step = JSON.stringify([{ tool: "run_tests", args: { command: "npm test" } }]);
  const runner = fakeTestRunner(() => {
    throw new Error("test command timed out after 120000ms");
  });

  for (let i = 0; i < MAX_TEST_RETRY_ATTEMPTS; i++) {
    const res = await executeAutonomousStep(step, "run-tests-timeout", { testRunner: runner, ...fakeScratchWorkspace() });
    assert.equal(res.results[0].status, "error");
  }

  const exhausted = await executeAutonomousStep(step, "run-tests-timeout", { testRunner: runner, ...fakeScratchWorkspace() });
  assert.equal(exhausted.results[0].status, "retry_exhausted");
  resetSessionTestRetryCounts("run-tests-timeout");
});

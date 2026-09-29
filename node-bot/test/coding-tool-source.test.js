const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CODING_TOOL_PREFIX,
  CODING_TEST_TOOL_NAME,
  TOOL_SCHEMAS,
  isCodingToolName,
  detectTestCommand,
  runTestCommand,
  createCodingToolSource,
} = require("../ai/coding-tool-source");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-coding-tool-test-"));
}

function fakeEditors({ createEditProposalImpl, applied = [], workspace = { path: os.tmpdir() } } = {}) {
  return {
    getWorkspace: () => workspace,
    createEditProposal:
      createEditProposalImpl ||
      (({ path: p, proposedContent, summary }) => ({
        id: "proposal-1",
        relativePath: p,
        summary: summary || "",
        diff: `--- ${p}\n+++ ${p}\n-old\n+${proposedContent}\n`,
      })),
    approveEditProposal: (id) => {
      applied.push(id);
      throw new Error("approveEditProposal must never be called by coding-tool-source");
    },
  };
}

test("createCodingToolSource requires editors", () => {
  assert.throws(() => createCodingToolSource({}), /editors is required/);
});

test("isCodingToolName distinguishes coding tool names from anything else", () => {
  assert.equal(isCodingToolName(`${CODING_TOOL_PREFIX}propose_edit`), true);
  assert.equal(isCodingToolName("memory__remember"), false);
  assert.equal(isCodingToolName(undefined), false);
});

test("listToolSchemas offers run_tests only with an approval gate, and nothing without a workspace", () => {
  const names = (source) => source.listToolSchemas().map((t) => t.function.name);
  assert.deepEqual(names(createCodingToolSource({ editors: fakeEditors() })), [`${CODING_TOOL_PREFIX}propose_edit`]);
  const gated = createCodingToolSource({ editors: fakeEditors(), approvalGate: fakeGate() });
  assert.deepEqual(gated.listToolSchemas(), TOOL_SCHEMAS);
  assert.deepEqual(names(createCodingToolSource({ editors: fakeEditors({ workspace: null }), approvalGate: fakeGate() })), []);
});

test("propose_edit writes the diff to a scratch file and returns its path, never touching the real file", async () => {
  const diffsDir = tempDir();
  const applied = [];
  const source = createCodingToolSource({ editors: fakeEditors({ applied }), diffsDir });

  const result = await source.executeTool(`${CODING_TOOL_PREFIX}propose_edit`, {
    path: "src/foo.js",
    proposedContent: "const x = 2;",
    summary: "bump x to 2",
  });
  const parsed = JSON.parse(result);

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.relativePath, "src/foo.js");
  assert.equal(parsed.summary, "bump x to 2");
  assert.equal(parsed.proposalId, "proposal-1");
  assert.ok(fs.existsSync(parsed.diffPath), "diff file should exist on disk");
  assert.match(fs.readFileSync(parsed.diffPath, "utf8"), /const x = 2;/);

  // The whole point of this tool is that it never applies the change.
  assert.deepEqual(applied, []);
});

test("propose_edit returns a JSON error instead of throwing when there's no active workspace", async () => {
  const editors = fakeEditors({
    createEditProposalImpl: () => {
      throw new Error("active workspace is not set");
    },
  });
  const source = createCodingToolSource({ editors, diffsDir: tempDir() });

  const result = await source.executeTool(`${CODING_TOOL_PREFIX}propose_edit`, {
    path: "src/foo.js",
    proposedContent: "const x = 2;",
  });
  assert.deepEqual(JSON.parse(result), { status: "error", error: "active workspace is not set" });
});

// Issue #268's own vulnerability class: createEditProposal reads whatever
// file the model names inside the workspace, a different code path from
// read_file's allowedRoot/credential check -- must refuse the same way.
test("propose_edit refuses a credential-shaped path without ever calling createEditProposal", async () => {
  let createEditProposalCalled = false;
  const editors = fakeEditors({
    createEditProposalImpl: () => {
      createEditProposalCalled = true;
      return { id: "x", relativePath: ".env", summary: "", diff: "" };
    },
  });
  const source = createCodingToolSource({ editors, diffsDir: tempDir() });

  const result = await source.executeTool(`${CODING_TOOL_PREFIX}propose_edit`, {
    path: ".env",
    proposedContent: "SECRET=leaked",
  });

  assert.deepEqual(JSON.parse(result), { status: "error", error: "refusing to read a credential file" });
  assert.equal(createEditProposalCalled, false);
});

test("propose_edit writes the diff even when diffsDir's parent directory doesn't exist yet", async () => {
  const diffsDir = path.join(tempDir(), "nested", "diffs");
  const source = createCodingToolSource({ editors: fakeEditors(), diffsDir });

  const result = await source.executeTool(`${CODING_TOOL_PREFIX}propose_edit`, {
    path: "src/foo.js",
    proposedContent: "const x = 2;",
  });
  const parsed = JSON.parse(result);

  assert.equal(parsed.status, "ok");
  assert.ok(fs.existsSync(parsed.diffPath));
});

test("executeTool rejects an unrecognized coding tool name", async () => {
  const source = createCodingToolSource({ editors: fakeEditors() });
  await assert.rejects(
    () => source.executeTool(`${CODING_TOOL_PREFIX}delete_everything`, {}),
    /unknown coding tool/,
  );
});

// Issue #622: the adversarial verdict reaches the model (tool result) and
// the user (proposal + a header line on the .diff file) before approval.
test("propose_edit runs reviewEdit before writing the diff and surfaces its verdict", async () => {
  const review = { verdict: "refuted", failingCase: "x is read before it's set", reason: "" };
  const reviewed = [];
  const source = createCodingToolSource({
    editors: fakeEditors(),
    diffsDir: tempDir(),
    reviewEdit: async (proposal) => {
      reviewed.push(proposal.id);
      return review;
    },
  });

  const parsed = JSON.parse(
    await source.executeTool(`${CODING_TOOL_PREFIX}propose_edit`, { path: "src/foo.js", proposedContent: "const x = 2;" }),
  );

  assert.deepEqual(reviewed, ["proposal-1"]);
  assert.deepEqual(parsed.adversarialReview, review);
  assert.equal(
    fs.readFileSync(parsed.diffPath, "utf8"),
    "# Adversarial review (#622): REFUTED -- x is read before it's set\n--- src/foo.js\n+++ src/foo.js\n-old\n+const x = 2;\n",
  );
});

// #787: coding__run_tests.
function fakeGate({ granted = false } = {}) {
  const executors = new Map();
  const requests = [];
  return {
    requests,
    registerExecutor: (type, fn) => executors.set(type, fn),
    requestApproval: async (type, request) => {
      requests.push({ type, ...request });
      if (!granted) return { status: "pending", requestId: "r1", summary: request.summary };
      return { status: "approved", actionType: type, result: await executors.get(type)(request.payload) };
    },
  };
}

function fakeFs(files) {
  return {
    readdirSync: () => Object.keys(files),
    readFileSync: (p) => {
      const name = path.basename(p);
      if (!(name in files)) throw new Error("ENOENT");
      return files[name];
    },
  };
}

test("detectTestCommand picks the folder's own test runner", () => {
  const detect = (files, env = {}) => detectTestCommand("/ws", { env, fsImpl: fakeFs(files) });
  assert.equal(detect({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }), "npm test");
  assert.equal(detect({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), null);
  assert.equal(detect({ "App.sln": "" }), "dotnet test");
  assert.equal(detect({ "pyproject.toml": "[tool.pytest.ini_options]", "test_x.py": "" }), "python -m pytest -q");
  assert.equal(detect({ "test_stats.py": "" }), "python -m unittest discover -v");
  assert.equal(detect({ "README.md": "" }), null);
  assert.equal(detect({ "README.md": "" }, { MANA_CODING_TEST_COMMAND: "make check" }), "make check");
});

test("run_tests asks first, and runs the detected command in the workspace once granted", async () => {
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const ran = [];
  const runTests = async (command, cwd) => {
    ran.push({ command, cwd });
    return { exitCode: 1, timedOut: false, output: "# fail 1" };
  };

  const pending = fakeGate();
  const asking = createCodingToolSource({ editors: fakeEditors({ workspace: { path: ws } }), approvalGate: pending, runTests });
  assert.equal(JSON.parse(await asking.executeTool(CODING_TEST_TOOL_NAME, {})).status, "pending");
  assert.equal(pending.requests[0].type, "coding-run-tests");
  assert.equal(pending.requests[0].grantKey, `coding-run-tests:${path.resolve(ws)}|npm test`);
  assert.deepEqual(ran, []);

  const source = createCodingToolSource({ editors: fakeEditors({ workspace: { path: ws } }), approvalGate: fakeGate({ granted: true }), runTests });
  const result = JSON.parse(await source.executeTool(CODING_TEST_TOOL_NAME, {}));
  assert.equal(result.passed, false);
  assert.equal(result.output, "# fail 1");
  assert.deepEqual(ran, [{ command: "npm test", cwd: path.resolve(ws) }]);
});

test("run_tests refuses a path outside the workspace", async () => {
  const source = createCodingToolSource({ editors: fakeEditors({ workspace: { path: tempDir() } }), approvalGate: fakeGate({ granted: true }) });
  const result = JSON.parse(await source.executeTool(CODING_TEST_TOOL_NAME, { path: ".." }));
  assert.deepEqual(result, { status: "error", error: "path must be inside the workspace" });
});

// Live, models asked for run_tests("test") and run_tests("test/range.test.js").
test("run_tests finds the project above a subfolder, and narrows npm test to one file", async () => {
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(ws, "test"));
  fs.writeFileSync(path.join(ws, "test", "range.test.js"), "");
  const ran = [];
  const runTests = async (command, cwd) => {
    ran.push({ command, cwd });
    return { exitCode: 0, timedOut: false, output: "" };
  };
  const source = createCodingToolSource({ editors: fakeEditors({ workspace: { path: ws } }), approvalGate: fakeGate({ granted: true }), runTests });

  await source.executeTool(CODING_TEST_TOOL_NAME, { path: "test" });
  await source.executeTool(CODING_TEST_TOOL_NAME, { path: "test/range.test.js" });
  assert.deepEqual(ran, [
    { command: "npm test", cwd: path.resolve(ws) },
    { command: 'npm test -- "test/range.test.js"', cwd: path.resolve(ws) },
  ]);
});

test("runTestCommand kills the run on timeout and keeps only the output's tail", async () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const killed = [];
  const run = runTestCommand("npm test", "/ws", {
    spawnImpl: () => child,
    killTree: (c) => killed.push(c), // never reports 'close': must still settle
    timeoutMs: 10,
  });
  child.stdout.emit("data", "x".repeat(5000) + "TAIL");
  const result = await run;
  assert.deepEqual(killed, [child]);
  assert.equal(result.timedOut, true);
  assert.ok(result.output.endsWith("TAIL"));
  assert.ok(result.output.startsWith("...[1004 earlier chars cut]\n"));
});

# Zed Agent Full Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mana's Zed External Agent capable of local coding workflows with workspace tools, approval-backed edits, explicit autonomous edit/test loops, outside-path allowlisting, and registry-ready ACP metadata.

**Architecture:** Add focused support modules around the existing ACP entry point: an ACP backend bridge for local HTTP editor/reply APIs, a path guard for workspace plus allowed outside paths, a guarded test runner, and an autonomous loop coordinator. Wire these into `mana-acp-agent.js` through namespaced JSON-RPC methods while keeping manual mode safe by default and autonomous mode explicit through `MANA_AGENT_AUTONOMOUS=1`.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, local filesystem APIs, `child_process.spawn`, existing Mana backend editor APIs, Zed ACP JSON-RPC over stdio.

---

## File Structure

- Create `node-bot/acp-backend-bridge.js`: local backend HTTP wrapper, URL normalization, editor/reply API helpers, and clear errors.
- Create `node-bot/acp-path-guard.js`: active workspace plus `MANA_AGENT_ALLOWED_PATHS` root normalization and file-root checks.
- Create `node-bot/acp-test-runner.js`: command allowlist, destructive-command rejection, timeout handling, and shell-free process execution.
- Create `node-bot/acp-autonomous-loop.js`: bounded autonomous loop orchestration using bridge, path guard, test runner, and local coding model responses.
- Modify `node-bot/mana-acp-agent.js`: add manual/autonomous mode reporting and namespaced Mana JSON-RPC methods.
- Add tests:
  - `node-bot/test/acp-backend-bridge.test.js`
  - `node-bot/test/acp-path-guard.test.js`
  - `node-bot/test/acp-test-runner.test.js`
  - `node-bot/test/acp-autonomous-loop.test.js`
  - extend `node-bot/test/mana-acp-agent.test.js`
- Add `zed-agent/mana-agent.json`: registry-ready ACP metadata candidate.
- Modify `docs/zed_external_agent.md`: current capabilities, manual mode, autonomous mode, guardrails, outside-path allowlist, registry packaging.
- Create `docs/roadmap/zed-agent-full-capability.md`: feature note and verification.

## Task 1: ACP Path Guard

**Files:**
- Create: `node-bot/acp-path-guard.js`
- Create: `node-bot/test/acp-path-guard.test.js`

- [ ] **Step 1: Write failing path guard tests**

Create `node-bot/test/acp-path-guard.test.js`:

```js
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  createAcpPathGuard,
  parseAllowedPathList,
} = require("../acp-path-guard");

test("parseAllowedPathList splits Windows semicolon separated roots", () => {
  assert.deepEqual(
    parseAllowedPathList("C:\\ManaAI\\Mana;D:\\Shared", "win32"),
    [path.resolve("C:\\ManaAI\\Mana"), path.resolve("D:\\Shared")],
  );
});

test("path guard allows active workspace files", () => {
  const workspace = path.join("C:", "ManaAI", "Mana");
  const guard = createAcpPathGuard({
    workspacePath: workspace,
    allowedPaths: "",
    platform: "win32",
  });

  const checked = guard.resolveAllowedPath("node-bot/server.js");

  assert.equal(checked.allowed, true);
  assert.equal(
    checked.fullPath,
    path.resolve(workspace, "node-bot/server.js"),
  );
  assert.equal(checked.rootType, "workspace");
});

test("path guard rejects outside paths by default", () => {
  const guard = createAcpPathGuard({
    workspacePath: path.join("C:", "ManaAI", "Mana"),
    allowedPaths: "",
    platform: "win32",
  });

  assert.throws(
    () => guard.resolveAllowedPath(path.join("D:", "Shared", "note.txt")),
    /path is outside the active workspace and allowed roots/i,
  );
});

test("path guard allows outside paths under configured roots", () => {
  const externalRoot = path.join("D:", "Shared");
  const guard = createAcpPathGuard({
    workspacePath: path.join("C:", "ManaAI", "Mana"),
    allowedPaths: externalRoot,
    platform: "win32",
  });

  const checked = guard.resolveAllowedPath(path.join(externalRoot, "note.txt"));

  assert.equal(checked.allowed, true);
  assert.equal(checked.rootType, "allowed");
  assert.equal(checked.rootPath, path.resolve(externalRoot));
});

test("path guard rejects sibling paths with a shared prefix", () => {
  const guard = createAcpPathGuard({
    workspacePath: path.join("C:", "ManaAI", "Mana"),
    allowedPaths: path.join("C:", "ManaAI", "ManaTools"),
    platform: "win32",
  });

  assert.throws(
    () => guard.resolveAllowedPath(path.join("C:", "ManaAI", "ManaTools2", "x.js")),
    /path is outside the active workspace and allowed roots/i,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\acp-path-guard.test.js
```

Expected: FAIL because `node-bot/acp-path-guard.js` does not exist.

- [ ] **Step 3: Implement the path guard**

Create `node-bot/acp-path-guard.js`:

```js
const path = require("node:path");

function parseAllowedPathList(value = "", platform = process.platform) {
  const separator = platform === "win32" ? ";" : ":";
  return String(value || "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function isInsideRoot(targetPath, rootPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function createAcpPathGuard({
  workspacePath,
  allowedPaths = "",
  platform = process.platform,
} = {}) {
  const workspaceRoot = workspacePath ? path.resolve(workspacePath) : null;
  const allowedRoots = parseAllowedPathList(allowedPaths, platform);

  function resolveAllowedPath(targetPath) {
    if (!targetPath || typeof targetPath !== "string") {
      throw new Error("path is required");
    }

    const fullPath = workspaceRoot && !path.isAbsolute(targetPath)
      ? path.resolve(workspaceRoot, targetPath)
      : path.resolve(targetPath);

    if (workspaceRoot && isInsideRoot(fullPath, workspaceRoot)) {
      return {
        allowed: true,
        fullPath,
        rootPath: workspaceRoot,
        rootType: "workspace",
      };
    }

    const matchedRoot = allowedRoots.find((root) => isInsideRoot(fullPath, root));
    if (matchedRoot) {
      return {
        allowed: true,
        fullPath,
        rootPath: matchedRoot,
        rootType: "allowed",
      };
    }

    throw new Error("path is outside the active workspace and allowed roots");
  }

  return {
    allowedRoots,
    resolveAllowedPath,
    workspaceRoot,
  };
}

module.exports = {
  createAcpPathGuard,
  isInsideRoot,
  parseAllowedPathList,
};
```

- [ ] **Step 4: Run test to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\acp-path-guard.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
git add node-bot\acp-path-guard.js node-bot\test\acp-path-guard.test.js
git commit -m "feat: add acp path guard"
```

## Task 2: ACP Backend Bridge

**Files:**
- Create: `node-bot/acp-backend-bridge.js`
- Create: `node-bot/test/acp-backend-bridge.test.js`

- [ ] **Step 1: Write failing backend bridge tests**

Create `node-bot/test/acp-backend-bridge.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const { createAcpBackendBridge } = require("../acp-backend-bridge");

function createJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("backend bridge normalizes base URLs and sends coding replies", async () => {
  const calls = [];
  const bridge = createAcpBackendBridge({
    backendUrl: "http://127.0.0.1:5005/",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return createJsonResponse({ reply: "local reply" });
    },
  });

  const reply = await bridge.reply("fix this", "coding");

  assert.equal(reply, "local reply");
  assert.equal(calls[0].url, "http://127.0.0.1:5005/reply");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    text: "fix this",
    modelProfile: "coding",
  });
});

test("backend bridge exposes workspace editor operations", async () => {
  const calls = [];
  const bridge = createAcpBackendBridge({
    backendUrl: "http://127.0.0.1:5005",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/editors/workspace")) {
        return createJsonResponse({ workspace: { path: "C:\\ManaAI\\Mana" } });
      }
      if (url.includes("/editors/workspace/file")) {
        return createJsonResponse({ relativePath: "app.js", content: "code" });
      }
      if (url.endsWith("/editors/workspace/proposals")) {
        return createJsonResponse({ proposal: { id: "proposal-1" } });
      }
      return createJsonResponse({ proposal: { id: "proposal-1", status: "applied" } });
    },
  });

  assert.equal((await bridge.getWorkspace()).workspace.path, "C:\\ManaAI\\Mana");
  assert.equal((await bridge.readWorkspaceFile("app.js")).content, "code");
  assert.equal((await bridge.createEditProposal({
    path: "app.js",
    proposedContent: "new code",
    summary: "update",
  })).proposal.id, "proposal-1");
  assert.equal((await bridge.approveEditProposal("proposal-1")).proposal.status, "applied");
  assert.equal(calls.some((call) => call.url.includes("path=app.js")), true);
});

test("backend bridge converts HTTP failures into clear errors", async () => {
  const bridge = createAcpBackendBridge({
    backendUrl: "http://127.0.0.1:5005",
    fetchImpl: async () => createJsonResponse({ error: "bad request" }, 400),
  });

  await assert.rejects(
    () => bridge.getWorkspace(),
    /Mana backend request failed: GET .* HTTP 400: bad request/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\acp-backend-bridge.test.js
```

Expected: FAIL because `node-bot/acp-backend-bridge.js` does not exist.

- [ ] **Step 3: Implement the backend bridge**

Create `node-bot/acp-backend-bridge.js`:

```js
const DEFAULT_BACKEND_URL = "http://127.0.0.1:5005";

function normalizeBackendUrl(backendUrl = DEFAULT_BACKEND_URL) {
  return String(backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

async function parseJsonResponse(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function createAcpBackendBridge({
  backendUrl = DEFAULT_BACKEND_URL,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = normalizeBackendUrl(backendUrl);

  async function request(method, path, body) {
    const options = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await fetchImpl(`${baseUrl}${path}`, options);
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      const message = payload?.error || JSON.stringify(payload) || "request failed";
      throw new Error(
        `Mana backend request failed: ${method} ${path} HTTP ${response.status}: ${message}`,
      );
    }
    return payload;
  }

  function getWorkspace() {
    return request("GET", "/editors/workspace");
  }

  function setWorkspace({ path: workspacePath, editor = "zed" } = {}) {
    return request("POST", "/editors/workspace", {
      path: workspacePath,
      editor,
    });
  }

  function listWorkspaceFiles() {
    return request("GET", "/editors/workspace/files");
  }

  function readWorkspaceFile(filePath) {
    return request(
      "GET",
      `/editors/workspace/file?path=${encodeURIComponent(filePath)}`,
    );
  }

  function createEditProposal({ path: proposalPath, proposedContent, summary } = {}) {
    return request("POST", "/editors/workspace/proposals", {
      path: proposalPath,
      proposedContent,
      summary,
    });
  }

  function listEditProposals() {
    return request("GET", "/editors/workspace/proposals");
  }

  function getEditProposal(id) {
    return request("GET", `/editors/workspace/proposals/${encodeURIComponent(id)}`);
  }

  function approveEditProposal(id) {
    return request(
      "POST",
      `/editors/workspace/proposals/${encodeURIComponent(id)}/approve`,
    );
  }

  async function reply(prompt, modelProfile = "coding") {
    const payload = await request("POST", "/reply", {
      text: String(prompt || ""),
      modelProfile,
    });
    if (typeof payload.reply !== "string") {
      throw new Error("Local Mana backend reply did not include text.");
    }
    return payload.reply;
  }

  return {
    approveEditProposal,
    baseUrl,
    createEditProposal,
    getEditProposal,
    getWorkspace,
    listEditProposals,
    listWorkspaceFiles,
    readWorkspaceFile,
    reply,
    request,
    setWorkspace,
  };
}

module.exports = {
  DEFAULT_BACKEND_URL,
  createAcpBackendBridge,
  normalizeBackendUrl,
};
```

- [ ] **Step 4: Run test to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\acp-backend-bridge.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
git add node-bot\acp-backend-bridge.js node-bot\test\acp-backend-bridge.test.js
git commit -m "feat: add acp backend bridge"
```

## Task 3: Guarded Test Runner

**Files:**
- Create: `node-bot/acp-test-runner.js`
- Create: `node-bot/test/acp-test-runner.test.js`

- [ ] **Step 1: Write failing test runner tests**

Create `node-bot/test/acp-test-runner.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAcpTestRunner,
  isDisallowedCommand,
  parseCommandLine,
} = require("../acp-test-runner");

test("parseCommandLine parses quoted arguments without shell execution", () => {
  assert.deepEqual(parseCommandLine('node --check "server file.js"'), {
    command: "node",
    args: ["--check", "server file.js"],
  });
});

test("test runner rejects destructive and unapproved commands", async () => {
  assert.equal(isDisallowedCommand("git reset --hard"), true);
  assert.equal(isDisallowedCommand("Remove-Item -Recurse ."), true);
  const runner = createAcpTestRunner({ spawnImpl: () => { throw new Error("not called"); } });

  await assert.rejects(() => runner.run("git reset --hard", { cwd: "C:\\ManaAI\\Mana" }), /not allowed/i);
  await assert.rejects(() => runner.run("npm install", { cwd: "C:\\ManaAI\\Mana" }), /not allowed/i);
});

test("test runner executes allowed commands with no shell", async () => {
  const calls = [];
  const runner = createAcpTestRunner({
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: { on: (event, handler) => event === "data" && handler(Buffer.from("ok")) },
        stderr: { on: () => {} },
        on: (event, handler) => event === "close" && handler(0),
        kill: () => {},
      };
    },
  });

  const result = await runner.run("node --test", { cwd: "C:\\ManaAI\\Mana" });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(calls[0].command, "node");
  assert.deepEqual(calls[0].args, ["--test"]);
  assert.equal(calls[0].options.shell, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\acp-test-runner.test.js
```

Expected: FAIL because `node-bot/acp-test-runner.js` does not exist.

- [ ] **Step 3: Implement the guarded test runner**

Create `node-bot/acp-test-runner.js`:

```js
const { spawn } = require("node:child_process");

const DEFAULT_ALLOWED_COMMANDS = [
  "npm test",
  "npm run test",
  "node --test",
  "node --check",
];
const DISALLOWED_PATTERN =
  /\b(rm|del|erase|rmdir|remove-item|move-item|mv|git\s+reset|git\s+checkout|git\s+clean|format)\b/i;

function parseCommandLine(commandLine) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(commandLine || ""))) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return {
    command: parts[0] || "",
    args: parts.slice(1),
  };
}

function normalizeCommand(commandLine) {
  return String(commandLine || "").trim().replace(/\s+/g, " ");
}

function isDisallowedCommand(commandLine) {
  return DISALLOWED_PATTERN.test(normalizeCommand(commandLine));
}

function createAcpTestRunner(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const allowedCommands = new Set(
    (options.allowedCommands || DEFAULT_ALLOWED_COMMANDS).map(normalizeCommand),
  );
  const timeoutMs = Number(options.timeoutMs || 120000);

  function assertAllowed(commandLine) {
    const normalized = normalizeCommand(commandLine);
    if (!normalized || isDisallowedCommand(normalized) || !allowedCommands.has(normalized)) {
      throw new Error(`test command is not allowed: ${commandLine}`);
    }
    return normalized;
  }

  function run(commandLine, { cwd } = {}) {
    const normalized = assertAllowed(commandLine);
    const parsed = parseCommandLine(normalized);
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawnImpl(parsed.command, parsed.args, {
        cwd,
        shell: false,
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (typeof child.kill === "function") child.kill();
        reject(new Error(`test command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          command: normalized,
          exitCode,
          ok: exitCode === 0,
          stdout,
          stderr,
        });
      });
    });
  }

  return {
    allowedCommands: [...allowedCommands],
    assertAllowed,
    run,
    timeoutMs,
  };
}

module.exports = {
  DEFAULT_ALLOWED_COMMANDS,
  createAcpTestRunner,
  isDisallowedCommand,
  parseCommandLine,
};
```

- [ ] **Step 4: Run test to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\acp-test-runner.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
git add node-bot\acp-test-runner.js node-bot\test\acp-test-runner.test.js
git commit -m "feat: add guarded acp test runner"
```

## Task 4: Autonomous Loop Coordinator

**Files:**
- Create: `node-bot/acp-autonomous-loop.js`
- Create: `node-bot/test/acp-autonomous-loop.test.js`

- [ ] **Step 1: Write failing autonomous loop tests**

Create `node-bot/test/acp-autonomous-loop.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const { createAcpAutonomousLoop } = require("../acp-autonomous-loop");

test("autonomous loop refuses to run when disabled", async () => {
  const loop = createAcpAutonomousLoop({ autonomousEnabled: false });

  await assert.rejects(
    () => loop.run({ objective: "fix tests", workspacePath: "C:\\ManaAI\\Mana" }),
    /autonomous mode is disabled/i,
  );
});

test("autonomous loop refuses to run without a workspace", async () => {
  const loop = createAcpAutonomousLoop({ autonomousEnabled: true });

  await assert.rejects(
    () => loop.run({ objective: "fix tests" }),
    /workspace is required/i,
  );
});

test("autonomous loop applies proposals and runs allowed tests", async () => {
  const calls = [];
  const loop = createAcpAutonomousLoop({
    autonomousEnabled: true,
    maxIterations: 2,
    backendBridge: {
      reply: async () => JSON.stringify({
        summary: "Update app.js and run tests.",
        proposals: [
          { path: "app.js", proposedContent: "new code", summary: "update app" },
        ],
        testCommand: "node --test",
        done: true,
      }),
      createEditProposal: async (proposal) => {
        calls.push({ type: "proposal", proposal });
        return { proposal: { id: "proposal-1", relativePath: proposal.path } };
      },
      approveEditProposal: async (id) => {
        calls.push({ type: "approve", id });
        return { proposal: { id, status: "applied" } };
      },
    },
    testRunner: {
      run: async (command, options) => {
        calls.push({ type: "test", command, options });
        return { ok: true, exitCode: 0, stdout: "pass", stderr: "" };
      },
    },
  });

  const result = await loop.run({
    objective: "fix tests",
    workspacePath: "C:\\ManaAI\\Mana",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 1);
  assert.equal(result.proposalsApplied.length, 1);
  assert.equal(result.testRuns[0].ok, true);
  assert.deepEqual(calls.map((call) => call.type), ["proposal", "approve", "test"]);
});

test("autonomous loop stops when model response is not parseable", async () => {
  const loop = createAcpAutonomousLoop({
    autonomousEnabled: true,
    backendBridge: {
      reply: async () => "I need more context.",
    },
    testRunner: {
      run: async () => {
        throw new Error("not called");
      },
    },
  });

  const result = await loop.run({
    objective: "fix tests",
    workspacePath: "C:\\ManaAI\\Mana",
  });

  assert.equal(result.status, "stopped");
  assert.match(result.summary, /I need more context/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\acp-autonomous-loop.test.js
```

Expected: FAIL because `node-bot/acp-autonomous-loop.js` does not exist.

- [ ] **Step 3: Implement the autonomous loop**

Create `node-bot/acp-autonomous-loop.js`:

```js
function parseActionResponse(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function createAcpAutonomousLoop(options = {}) {
  const autonomousEnabled = options.autonomousEnabled === true;
  const maxIterations = Math.max(1, Number(options.maxIterations || 3));
  const maxFilesChanged = Math.max(1, Number(options.maxFilesChanged || 5));
  const backendBridge = options.backendBridge;
  const testRunner = options.testRunner;

  async function run({ objective, workspacePath } = {}) {
    if (!autonomousEnabled) {
      throw new Error("autonomous mode is disabled");
    }
    if (!workspacePath) {
      throw new Error("workspace is required for autonomous mode");
    }
    if (!backendBridge?.reply) {
      throw new Error("backend bridge is required");
    }

    const proposalsApplied = [];
    const testRuns = [];
    let summary = "";

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const prompt = [
        "You are Mana's local coding loop.",
        `Objective: ${objective}`,
        `Workspace: ${workspacePath}`,
        "Return JSON with optional proposals, optional testCommand, optional summary, and done boolean.",
      ].join("\n");
      const reply = await backendBridge.reply(prompt, "coding");
      const action = parseActionResponse(reply);
      if (!action) {
        return {
          status: "stopped",
          iterations: iteration,
          proposalsApplied,
          testRuns,
          summary: String(reply || ""),
        };
      }

      summary = String(action.summary || summary || "");
      const proposals = Array.isArray(action.proposals) ? action.proposals : [];
      if (proposalsApplied.length + proposals.length > maxFilesChanged) {
        throw new Error("autonomous file change limit exceeded");
      }

      for (const proposal of proposals) {
        const created = await backendBridge.createEditProposal(proposal);
        const proposalId = created?.proposal?.id;
        const applied = await backendBridge.approveEditProposal(proposalId);
        proposalsApplied.push(applied.proposal || { id: proposalId });
      }

      if (action.testCommand) {
        if (!testRunner?.run) {
          throw new Error("test runner is required");
        }
        testRuns.push(await testRunner.run(action.testCommand, { cwd: workspacePath }));
      }

      if (action.done === true) {
        return {
          status: "completed",
          iterations: iteration,
          proposalsApplied,
          testRuns,
          summary,
        };
      }
    }

    return {
      status: "stopped",
      iterations: maxIterations,
      proposalsApplied,
      testRuns,
      summary: summary || "Autonomous loop stopped after reaching the iteration limit.",
    };
  }

  return {
    maxFilesChanged,
    maxIterations,
    run,
  };
}

module.exports = {
  createAcpAutonomousLoop,
  parseActionResponse,
};
```

- [ ] **Step 4: Run test to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\acp-autonomous-loop.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
git add node-bot\acp-autonomous-loop.js node-bot\test\acp-autonomous-loop.test.js
git commit -m "feat: add acp autonomous coding loop"
```

## Task 5: Wire ACP Methods

**Files:**
- Modify: `node-bot/mana-acp-agent.js`
- Modify: `node-bot/test/mana-acp-agent.test.js`

- [ ] **Step 1: Write failing ACP method tests**

In `node-bot/test/mana-acp-agent.test.js`, add:

```js
test("createManaAcpAgent reports manual and autonomous agent capabilities", async () => {
  const manual = createManaAcpAgent({ env: {} });
  const autonomous = createManaAcpAgent({
    env: {
      MANA_AGENT_AUTONOMOUS: "1",
      MANA_AGENT_ALLOWED_PATHS: "C:\\Shared",
    },
  });

  const manualInit = await manual.handleJsonRpc({
    jsonrpc: "2.0",
    id: 10,
    method: "initialize",
  });
  const autoInit = await autonomous.handleJsonRpc({
    jsonrpc: "2.0",
    id: 11,
    method: "initialize",
  });

  assert.equal(manualInit.result.capabilities.autonomous.enabled, false);
  assert.equal(autoInit.result.capabilities.autonomous.enabled, true);
  assert.deepEqual(autoInit.result.capabilities.filesystem.outsidePaths, {
    mode: "allowlist",
    configured: true,
  });
});

test("createManaAcpAgent exposes backend-backed workspace and edit methods", async () => {
  const calls = [];
  const agent = createManaAcpAgent({
    env: {},
    backendBridge: {
      getWorkspace: async () => ({ workspace: { path: "C:\\ManaAI\\Mana" } }),
      setWorkspace: async (payload) => {
        calls.push({ method: "setWorkspace", payload });
        return { workspace: { path: payload.path } };
      },
      listWorkspaceFiles: async () => ({ files: [{ relativePath: "app.js" }] }),
      readWorkspaceFile: async (filePath) => ({ relativePath: filePath, content: "code" }),
      createEditProposal: async (payload) => ({ proposal: { id: "proposal-1", ...payload } }),
      listEditProposals: async () => ({ proposals: [{ id: "proposal-1" }] }),
      getEditProposal: async (id) => ({ proposal: { id } }),
      approveEditProposal: async (id) => ({ proposal: { id, status: "applied" } }),
    },
  });

  assert.equal((await agent.handleJsonRpc({ jsonrpc: "2.0", id: 20, method: "mana/workspace/status" })).result.workspace.path, "C:\\ManaAI\\Mana");
  assert.equal((await agent.handleJsonRpc({ jsonrpc: "2.0", id: 21, method: "mana/workspace/set", params: { path: "C:\\ManaAI\\Mana" } })).result.workspace.path, "C:\\ManaAI\\Mana");
  assert.equal((await agent.handleJsonRpc({ jsonrpc: "2.0", id: 22, method: "mana/workspace/files" })).result.files[0].relativePath, "app.js");
  assert.equal((await agent.handleJsonRpc({ jsonrpc: "2.0", id: 23, method: "mana/workspace/read", params: { path: "app.js" } })).result.content, "code");
  assert.equal((await agent.handleJsonRpc({ jsonrpc: "2.0", id: 24, method: "mana/edit/propose", params: { path: "app.js", proposedContent: "new", summary: "change" } })).result.proposal.id, "proposal-1");
  assert.equal((await agent.handleJsonRpc({ jsonrpc: "2.0", id: 25, method: "mana/edit/list" })).result.proposals[0].id, "proposal-1");
  assert.equal((await agent.handleJsonRpc({ jsonrpc: "2.0", id: 26, method: "mana/edit/get", params: { id: "proposal-1" } })).result.proposal.id, "proposal-1");
  assert.equal((await agent.handleJsonRpc({ jsonrpc: "2.0", id: 27, method: "mana/edit/approve", params: { id: "proposal-1" } })).result.proposal.status, "applied");
  assert.equal(calls[0].method, "setWorkspace");
});

test("createManaAcpAgent gates test runs and autonomous loop by mode", async () => {
  const manual = createManaAcpAgent({
    env: {},
    testRunner: { run: async () => ({ ok: true }) },
  });
  const autonomous = createManaAcpAgent({
    env: { MANA_AGENT_AUTONOMOUS: "1" },
    autonomousLoop: {
      run: async (payload) => ({ status: "completed", objective: payload.objective }),
    },
    testRunner: { run: async () => ({ ok: true, command: "node --test" }) },
  });

  const rejected = await manual.handleJsonRpc({
    jsonrpc: "2.0",
    id: 30,
    method: "mana/test/run",
    params: { command: "node --test" },
  });
  const testRun = await autonomous.handleJsonRpc({
    jsonrpc: "2.0",
    id: 31,
    method: "mana/test/run",
    params: { command: "node --test", cwd: "C:\\ManaAI\\Mana" },
  });
  const loopRun = await autonomous.handleJsonRpc({
    jsonrpc: "2.0",
    id: 32,
    method: "mana/agent/run",
    params: { objective: "fix tests", workspacePath: "C:\\ManaAI\\Mana" },
  });

  assert.match(rejected.error.message, /autonomous mode is disabled/i);
  assert.equal(testRun.result.ok, true);
  assert.equal(loopRun.result.status, "completed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\mana-acp-agent.test.js
```

Expected: FAIL because the new Mana-specific methods and capability metadata are missing.

- [ ] **Step 3: Wire new modules into `mana-acp-agent.js`**

In `node-bot/mana-acp-agent.js`, import:

```js
const { createAcpAutonomousLoop } = require("./acp-autonomous-loop");
const { createAcpBackendBridge } = require("./acp-backend-bridge");
const { createAcpTestRunner } = require("./acp-test-runner");
const { parseAllowedPathList } = require("./acp-path-guard");
```

Add helpers:

```js
function isAutonomousEnabled(env = process.env) {
  return String(env.MANA_AGENT_AUTONOMOUS || "").trim() === "1";
}

function getAgentLimits(env = process.env) {
  return {
    autonomousEnabled: isAutonomousEnabled(env),
    maxIterations: Math.max(1, Number(env.MANA_AGENT_MAX_ITERATIONS || 3)),
    maxFilesChanged: Math.max(1, Number(env.MANA_AGENT_MAX_FILES_CHANGED || 5)),
    allowedPaths: parseAllowedPathList(env.MANA_AGENT_ALLOWED_PATHS || ""),
  };
}
```

Inside `createManaAcpAgent`, create default dependencies:

```js
  const agentLimits = getAgentLimits(env);
  const backendBridge =
    options.backendBridge ||
    createAcpBackendBridge({
      backendUrl: options.backendUrl || env.MANA_BACKEND_URL,
      fetchImpl: options.fetch,
    });
  const testRunner =
    options.testRunner ||
    createAcpTestRunner({
      timeoutMs: Number(env.MANA_AGENT_TEST_TIMEOUT_MS || 120000),
    });
  const autonomousLoop =
    options.autonomousLoop ||
    createAcpAutonomousLoop({
      autonomousEnabled: agentLimits.autonomousEnabled,
      maxIterations: agentLimits.maxIterations,
      maxFilesChanged: agentLimits.maxFilesChanged,
      backendBridge,
      testRunner,
    });
```

In the `initialize` result, extend `capabilities`:

```js
          filesystem: {
            read: "explicit-bounded",
            write: "approval-required",
            outsidePaths: {
              mode: "allowlist",
              configured: agentLimits.allowedPaths.length > 0,
            },
          },
          autonomous: {
            enabled: agentLimits.autonomousEnabled,
            maxIterations: agentLimits.maxIterations,
            maxFilesChanged: agentLimits.maxFilesChanged,
          },
          tools: [
            "mana/workspace/status",
            "mana/workspace/set",
            "mana/workspace/files",
            "mana/workspace/read",
            "mana/edit/propose",
            "mana/edit/list",
            "mana/edit/get",
            "mana/edit/approve",
            "mana/test/run",
            "mana/agent/run",
          ],
```

Before the `shutdown` branch, add method handlers:

```js
    if (message.method === "mana/workspace/status") {
      return createJsonRpcResult(message.id, await backendBridge.getWorkspace());
    }
    if (message.method === "mana/workspace/set") {
      return createJsonRpcResult(message.id, await backendBridge.setWorkspace(message.params || {}));
    }
    if (message.method === "mana/workspace/files") {
      return createJsonRpcResult(message.id, await backendBridge.listWorkspaceFiles());
    }
    if (message.method === "mana/workspace/read") {
      return createJsonRpcResult(message.id, await backendBridge.readWorkspaceFile(message.params?.path));
    }
    if (message.method === "mana/edit/propose") {
      return createJsonRpcResult(message.id, await backendBridge.createEditProposal(message.params || {}));
    }
    if (message.method === "mana/edit/list") {
      return createJsonRpcResult(message.id, await backendBridge.listEditProposals());
    }
    if (message.method === "mana/edit/get") {
      return createJsonRpcResult(message.id, await backendBridge.getEditProposal(message.params?.id));
    }
    if (message.method === "mana/edit/approve") {
      return createJsonRpcResult(message.id, await backendBridge.approveEditProposal(message.params?.id));
    }
    if (message.method === "mana/test/run") {
      if (!agentLimits.autonomousEnabled) {
        return createJsonRpcError(message.id, -32000, "autonomous mode is disabled");
      }
      return createJsonRpcResult(
        message.id,
        await testRunner.run(message.params?.command, { cwd: message.params?.cwd }),
      );
    }
    if (message.method === "mana/agent/run") {
      return createJsonRpcResult(message.id, await autonomousLoop.run(message.params || {}));
    }
```

Wrap the method-dispatch body in `try/catch` so backend/tool errors become JSON-RPC errors:

```js
    try {
      // existing method branches
    } catch (error) {
      return createJsonRpcError(message.id ?? null, -32000, error.message);
    }
```

Export `getAgentLimits` and `isAutonomousEnabled`.

- [ ] **Step 4: Run ACP tests to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\mana-acp-agent.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
git add node-bot\mana-acp-agent.js node-bot\test\mana-acp-agent.test.js
git commit -m "feat: expose full mana acp agent tools"
```

## Task 6: Registry Packaging And Docs

**Files:**
- Create: `zed-agent/mana-agent.json`
- Create: `node-bot/test/zed-agent-package.test.js`
- Modify: `docs/zed_external_agent.md`
- Create: `docs/roadmap/zed-agent-full-capability.md`

- [ ] **Step 1: Write failing registry metadata test**

Create `node-bot/test/zed-agent-package.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("zed agent registry metadata is valid and local-first", () => {
  const manifestPath = path.join(__dirname, "..", "..", "zed-agent", "mana-agent.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.id, "mana");
  assert.equal(manifest.name, "Mana");
  assert.equal(manifest.command, "node");
  assert.deepEqual(manifest.args, ["node-bot/mana-acp-agent.js", "--acp"]);
  assert.equal(manifest.env.MANA_ALLOW_REMOTE_AI, "0");
  assert.equal(manifest.env.MANA_DEFAULT_EDITOR, "zed");
  assert.equal(manifest.capabilities.autonomous, true);
  assert.equal(manifest.capabilities.approvalRequiredWrites, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\zed-agent-package.test.js
```

Expected: FAIL because `zed-agent/mana-agent.json` does not exist.

- [ ] **Step 3: Add registry metadata**

Create `zed-agent/mana-agent.json`:

```json
{
  "id": "mana",
  "name": "Mana",
  "version": "0.1.0",
  "description": "Local-first Mana ACP agent for Zed with workspace tools, approval-backed edits, and explicit autonomous coding loops.",
  "command": "node",
  "args": ["node-bot/mana-acp-agent.js", "--acp"],
  "env": {
    "MANA_ALLOW_REMOTE_AI": "0",
    "MANA_DEFAULT_EDITOR": "zed",
    "MANA_AGENT_AUTONOMOUS": "0"
  },
  "capabilities": {
    "localOnlyDefault": true,
    "workspaceTools": true,
    "approvalRequiredWrites": true,
    "autonomous": true,
    "outsidePathAllowlist": true
  },
  "docs": "docs/zed_external_agent.md",
  "repository": "https://github.com/Yuuzulight/Mana"
}
```

- [ ] **Step 4: Update Zed External Agent docs**

In `docs/zed_external_agent.md`, replace `## Current Limits` and its bullet list with:

```md
## Current Capabilities

- Zed can launch Mana over stdio through `agent_servers`.
- Mana supports basic ACP lifecycle methods and Mana-specific workspace/edit/test methods.
- `session/prompt` uses the local backend reply endpoint with `modelProfile: "coding"`.
- Manual mode can inspect workspace files and create reviewable edit proposals.
- Autonomous mode can apply proposals and run allowed tests repeatedly after explicit opt-in.
- Writes still go through Mana's proposal conflict checks.

## Manual Mode

Manual mode is the default. Leave `MANA_AGENT_AUTONOMOUS` unset or set it to `0`.

In manual mode, Mana can list files, read bounded file content, and create edit proposals. It cannot run tests or approve proposals through ACP.

## Autonomous Mode

Set `MANA_AGENT_AUTONOMOUS=1` only when you want Mana to run a bounded local coding loop.

Optional controls:

- `MANA_AGENT_MAX_ITERATIONS`: default `3`.
- `MANA_AGENT_MAX_FILES_CHANGED`: default `5`.
- `MANA_AGENT_TEST_TIMEOUT_MS`: default `120000`.
- `MANA_AGENT_ALLOWED_PATHS`: absolute outside-workspace roots allowed for file access.

Autonomous mode can approve proposals and run allowed tests without per-step approval, but only inside the configured guardrails.

## Guardrails

- Local-only remains the default.
- Outside-workspace file access is denied unless the path is under `MANA_AGENT_ALLOWED_PATHS`.
- Test commands must be allowlisted.
- Destructive commands are rejected.
- Test commands run without shell expansion.
- Proposal approval still checks for file-content conflicts before writing.

## Registry Packaging

Mana includes registry-ready metadata at `zed-agent/mana-agent.json`. Public registry publication may require a separate Zed-side submission or review process.
```

- [ ] **Step 5: Add roadmap note**

Create `docs/roadmap/zed-agent-full-capability.md`:

```md
# Zed Agent Full Capability

## Goal

Make Mana's Zed External Agent capable of local coding workflows with workspace tools, approval-backed edits, explicit autonomous edit/test loops, and registry-ready ACP metadata.

## Implementation Notes

- Added ACP backend bridge helpers for local backend editor and reply APIs.
- Added active workspace plus outside-path allowlist guardrails.
- Added a guarded test runner for allowlisted test commands.
- Added an explicit autonomous coding loop.
- Added Mana-specific ACP methods for workspace, edit, test, and autonomous agent operations.
- Added registry-ready metadata under `zed-agent/`.

## Verification

- `node --test test\mana-acp-agent.test.js test\acp-backend-bridge.test.js test\acp-path-guard.test.js test\acp-test-runner.test.js test\acp-autonomous-loop.test.js test\zed-agent-package.test.js`
- `node --check mana-acp-agent.js`
- `node --check acp-backend-bridge.js`
- `node --check acp-path-guard.js`
- `node --check acp-test-runner.js`
- `node --check acp-autonomous-loop.js`
- `npm test`
- Forbidden external-project reference scan.
```

- [ ] **Step 6: Run metadata and docs checks**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\zed-agent-package.test.js
```

Expected: PASS.

Then run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
$pattern = ('Open' + 'Cl' + 'aw') + '|' + ('open' + 'cl' + 'aw') + '|' + ('cl' + 'aw')
rg -n $pattern README.md node-bot docs zed-agent
```

Expected: no matches.

- [ ] **Step 7: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
git add zed-agent\mana-agent.json node-bot\test\zed-agent-package.test.js docs\zed_external_agent.md docs\roadmap\zed-agent-full-capability.md
git commit -m "docs: add zed acp packaging metadata"
```

## Task 7: Final Verification And PR

**Files:**
- No source edits unless verification exposes a defect.

- [ ] **Step 1: Run focused ACP tests**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --test test\mana-acp-agent.test.js test\acp-backend-bridge.test.js test\acp-path-guard.test.js test\acp-test-runner.test.js test\acp-autonomous-loop.test.js test\zed-agent-package.test.js test\zed-integration.test.js
```

Expected: PASS.

- [ ] **Step 2: Run syntax checks**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
node --check mana-acp-agent.js
node --check acp-backend-bridge.js
node --check acp-path-guard.js
node --check acp-test-runner.js
node --check acp-autonomous-loop.js
```

Expected: no output and exit code 0 for each command.

- [ ] **Step 3: Run full backend tests**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability\node-bot
npm test
```

Expected: PASS for the full `node --test` suite.

- [ ] **Step 4: Run forbidden-reference scan**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
$pattern = ('Open' + 'Cl' + 'aw') + '|' + ('open' + 'cl' + 'aw') + '|' + ('cl' + 'aw')
rg -n $pattern README.md node-bot docs zed-agent
```

Expected: no matches.

- [ ] **Step 5: Check git status**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
git status --short --branch
```

Expected: branch is clean and ahead of `origin/main`.

- [ ] **Step 6: Push and create PR**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
git push -u origin feature/zed-agent-full-capability
gh pr create --base main --head feature/zed-agent-full-capability --title "Make Mana a full local Zed external coding agent" --body-file docs\roadmap\zed-agent-full-capability.md
```

Expected: PR is opened.

- [ ] **Step 7: Merge if checks are clean**

Run:

```powershell
gh pr view --json number,mergeStateStatus,state,isDraft,statusCheckRollup,url
gh pr merge --squash --delete-branch
```

Expected: PR is merged into `main`.

- [ ] **Step 8: Clean up worktree**

Run:

```powershell
cd C:\ManaAI\Mana
git worktree remove C:\ManaAI\Mana\.worktrees\zed-agent-full-capability
```

Expected: the worktree is removed. Do not switch or reset the primary checkout.

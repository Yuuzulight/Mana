const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertLocalAiPolicy,
  buildZedAgentServerConfig,
  createDefaultManaAcpAgent,
  createManaAcpAgent,
  getAgentLimits,
  isAutonomousEnabled,
} = require("../mana-acp-agent");

test("buildZedAgentServerConfig creates a local-only Zed agent server snippet", () => {
  const config = buildZedAgentServerConfig({
    repoRoot: "C:\\ManaAI\\Mana",
    nodeCommand: "node",
  });

  assert.deepEqual(config, {
    agent_servers: {
      mana: {
        command: "node",
        args: ["C:\\ManaAI\\Mana\\node-bot\\mana-acp-agent.js", "--acp"],
        env: {
          MANA_ALLOW_REMOTE_AI: "0",
          MANA_DEFAULT_EDITOR: "zed",
        },
      },
    },
  });
});

test("assertLocalAiPolicy blocks remote AI unless explicitly allowed", () => {
  assert.deepEqual(assertLocalAiPolicy({}), {
    remoteAllowed: false,
    mode: "local",
  });

  assert.throws(
    () => assertLocalAiPolicy({ MANA_ALLOW_REMOTE_AI: "1" }),
    /remote AI is disabled for the Zed External Agent/i,
  );

  assert.deepEqual(
    assertLocalAiPolicy(
      { MANA_ALLOW_REMOTE_AI: "1" },
      { allowRemoteOverride: true },
    ),
    {
      remoteAllowed: true,
      mode: "remote-opt-in",
    },
  );
});

test("createManaAcpAgent handles initialize with local metadata", async () => {
  const agent = createManaAcpAgent({
    env: {},
    workspace: { path: "C:\\ManaAI\\Mana", editor: "zed" },
  });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: { name: "Zed" },
    },
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, 1);
  assert.equal(response.result.agentInfo.name, "Mana");
  assert.equal(response.result.capabilities.filesystem.read, "explicit-bounded");
  assert.equal(response.result.capabilities.filesystem.write, "approval-required");
  assert.equal(response.result.capabilities.autonomous.enabled, false);
  assert.equal(response.result.localAi.remoteAllowed, false);
  assert.equal(response.result.workspace.path, "C:\\ManaAI\\Mana");
});

test("agent limit helpers parse autonomous mode and outside path settings", () => {
  assert.equal(isAutonomousEnabled({}), false);
  assert.equal(isAutonomousEnabled({ MANA_AGENT_AUTONOMOUS: "1" }), true);

  const limits = getAgentLimits({
    MANA_AGENT_AUTONOMOUS: "1",
    MANA_AGENT_MAX_ITERATIONS: "4",
    MANA_AGENT_MAX_FILES_CHANGED: "7",
    MANA_AGENT_ALLOWED_PATHS: "C:\\Shared",
  });

  assert.equal(limits.autonomousEnabled, true);
  assert.equal(limits.maxIterations, 4);
  assert.equal(limits.maxFilesChanged, 7);
  assert.equal(limits.allowedPaths.length, 1);
});

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
  assert.equal(
    autoInit.result.capabilities.tools.includes("mana/agent/run"),
    true,
  );
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

  assert.equal(
    (await agent.handleJsonRpc({ jsonrpc: "2.0", id: 20, method: "mana/workspace/status" })).result.workspace.path,
    "C:\\ManaAI\\Mana",
  );
  assert.equal(
    (await agent.handleJsonRpc({
      jsonrpc: "2.0",
      id: 21,
      method: "mana/workspace/set",
      params: { path: "C:\\ManaAI\\Mana" },
    })).result.workspace.path,
    "C:\\ManaAI\\Mana",
  );
  assert.equal(
    (await agent.handleJsonRpc({ jsonrpc: "2.0", id: 22, method: "mana/workspace/files" })).result.files[0].relativePath,
    "app.js",
  );
  assert.equal(
    (await agent.handleJsonRpc({
      jsonrpc: "2.0",
      id: 23,
      method: "mana/workspace/read",
      params: { path: "app.js" },
    })).result.content,
    "code",
  );
  assert.equal(
    (await agent.handleJsonRpc({
      jsonrpc: "2.0",
      id: 24,
      method: "mana/edit/propose",
      params: { path: "app.js", proposedContent: "new", summary: "change" },
    })).result.proposal.id,
    "proposal-1",
  );
  assert.equal(
    (await agent.handleJsonRpc({ jsonrpc: "2.0", id: 25, method: "mana/edit/list" })).result.proposals[0].id,
    "proposal-1",
  );
  assert.equal(
    (await agent.handleJsonRpc({
      jsonrpc: "2.0",
      id: 26,
      method: "mana/edit/get",
      params: { id: "proposal-1" },
    })).result.proposal.id,
    "proposal-1",
  );
  assert.equal(
    (await agent.handleJsonRpc({
      jsonrpc: "2.0",
      id: 27,
      method: "mana/edit/approve",
      params: { id: "proposal-1" },
    })).result.proposal.status,
    "applied",
  );
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
  const loopRejected = await manual.handleJsonRpc({
    jsonrpc: "2.0",
    id: 31,
    method: "mana/agent/run",
    params: { objective: "fix tests", workspacePath: "C:\\ManaAI\\Mana" },
  });
  const testRun = await autonomous.handleJsonRpc({
    jsonrpc: "2.0",
    id: 32,
    method: "mana/test/run",
    params: { command: "node --test", cwd: "C:\\ManaAI\\Mana" },
  });
  const loopRun = await autonomous.handleJsonRpc({
    jsonrpc: "2.0",
    id: 33,
    method: "mana/agent/run",
    params: { objective: "fix tests", workspacePath: "C:\\ManaAI\\Mana" },
  });

  assert.match(rejected.error.message, /autonomous mode is disabled/i);
  assert.match(loopRejected.error.message, /autonomous mode is disabled/i);
  assert.equal(testRun.result.ok, true);
  assert.equal(loopRun.result.status, "completed");
});

test("createManaAcpAgent sends prompts through the local coding reply bridge", async () => {
  const calls = [];
  const agent = createManaAcpAgent({
    env: {},
    buildAssistantReply: async (prompt, screenContext, marketContext, options) => {
      calls.push({ prompt, screenContext, marketContext, options });
      return "Use a small focused patch.";
    },
  });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      prompt: [{ type: "text", text: "Change app.js" }],
    },
  });

  assert.equal(response.id, 2);
  assert.equal(response.result.stopReason, "end_turn");
  assert.equal(response.result.content[0].text, "Use a small focused patch.");
  assert.deepEqual(calls, [
    {
      prompt: "Change app.js",
      screenContext: "",
      marketContext: "",
      options: {
        modelProfile: "coding",
        source: "zed-external-agent",
      },
    },
  ]);
});

test("createManaAcpAgent falls back to proposal-only text when no reply bridge is connected", async () => {
  const agent = createManaAcpAgent({ env: {} });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      prompt: [{ type: "text", text: "Change app.js" }],
    },
  });

  assert.equal(response.id, 3);
  assert.equal(response.result.stopReason, "end_turn");
  assert.match(response.result.content[0].text, /local coding model bridge is not connected/i);
  assert.match(response.result.content[0].text, /reviewable edit proposals/i);
});

test("createDefaultManaAcpAgent sends prompts to the local backend reply endpoint", async () => {
  const calls = [];
  const agent = createDefaultManaAcpAgent({
    env: {},
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ reply: "Backend local reply" }),
      };
    },
  });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: {
      prompt: [{ type: "text", text: "Refactor this function" }],
    },
  });

  assert.equal(response.result.content[0].text, "Backend local reply");
  assert.equal(calls[0].url, "http://127.0.0.1:5005/reply");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    text: "Refactor this function",
    modelProfile: "coding",
  });
});

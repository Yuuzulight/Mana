const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  assertLocalAiPolicy,
  buildZedAgentServerConfig,
  createDefaultManaAcpAgent,
  createManaAcpAgent,
  createStdioAcpServer,
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
        type: "custom",
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
  assert.deepEqual(response.result.authMethods, []);
  assert.deepEqual(response.result.agentCapabilities, {
    loadSession: false,
  });
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

test("createManaAcpAgent accepts no-op local authentication", async () => {
  const agent = createManaAcpAgent({ env: {} });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 12,
    method: "authenticate",
    params: { methodId: "local" },
  });

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 12,
    result: {},
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
  const notifications = [];
  const agent = createManaAcpAgent({
    env: {},
    memoryStore: false,
    notifyClient: async (method, params) => {
      notifications.push({ method, params });
    },
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
      sessionId: "session-1",
      prompt: [{ type: "text", text: "Change app.js" }],
    },
  });

  assert.equal(response.id, 2);
  assert.equal(response.result.stopReason, "end_turn");
  assert.equal(Object.hasOwn(response.result, "content"), false);
  assert.deepEqual(notifications, [
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Use a small focused patch.",
          },
        },
      },
    },
  ]);
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

test("createManaAcpAgent injects prior local ACP memory into later prompts", async () => {
  const calls = [];
  const agent = createManaAcpAgent({
    env: {},
    memoryStore: {
      ensureSession: () => {},
      buildPromptMemory: (sessionId) =>
        sessionId === "session-memory" ? "Conversation memory:\n- User prefers Zed locally." : "",
      appendTurn: ({ sessionId, user, assistant }) => {
        calls.push({ type: "appendTurn", sessionId, user, assistant });
      },
    },
    buildAssistantReply: async (prompt) => {
      calls.push({ type: "reply", prompt });
      return "Use Zed for local editor work.";
    },
  });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 70,
    method: "session/prompt",
    params: {
      sessionId: "session-memory",
      prompt: [{ type: "text", text: "Which editor should Mana use here?" }],
    },
  });

  assert.equal(response.result.stopReason, "end_turn");
  assert.match(calls[0].prompt, /Conversation memory/);
  assert.match(calls[0].prompt, /User prefers Zed locally/);
  assert.match(calls[0].prompt, /User request:/);
  assert.match(calls[0].prompt, /Which editor should Mana use here/);
  assert.deepEqual(calls[1], {
    type: "appendTurn",
    sessionId: "session-memory",
    user: "Which editor should Mana use here?",
    assistant: "Use Zed for local editor work.",
  });
});

test("createManaAcpAgent includes workspace README context for README prompts", async () => {
  const calls = [];
  const agent = createManaAcpAgent({
    env: {},
    memoryStore: false,
    workspaceContext: {
      readReadme: async (cwd) => ({
        path: `${cwd}\\README.md`,
        content: "# Mana\nLocal assistant repository.",
      }),
    },
    buildAssistantReply: async (prompt, screenContext, marketContext, options) => {
      calls.push({ prompt, screenContext, marketContext, options });
      return "Mana summary";
    },
  });

  await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 50,
    method: "session/new",
    params: {
      sessionId: "session-readme",
      cwd: "C:\\ManaAI\\Mana",
    },
  });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 51,
    method: "session/prompt",
    params: {
      sessionId: "session-readme",
      prompt: [
        {
          type: "text",
          text: "use the current repository's readme as context and answer later questions",
        },
      ],
    },
  });

  assert.equal(response.result.stopReason, "end_turn");
  assert.match(calls[0].prompt, /Repository README/);
  assert.match(calls[0].prompt, /# Mana/);
  assert.match(calls[0].prompt, /User request:/);
  assert.ok(calls[0].prompt.length < 5000);
});

test("createManaAcpAgent summarizes README prompts locally without model call", async () => {
  let modelCalls = 0;
  const notifications = [];
  const agent = createManaAcpAgent({
    env: {},
    memoryStore: false,
    notifyClient: async (method, params) => {
      notifications.push({ method, params });
    },
    workspaceContext: {
      readReadme: async () => ({
        path: "C:\\ManaAI\\Mana\\README.md",
        content: [
          "# Mana",
          "",
          "Mana is a local-first AI assistant for Windows.",
          "",
          "## Highlights",
          "- **Local AI by default**: Mana uses local llama.cpp models.",
          "- **Voice loop**: wake Mana once.",
          "",
          "## Architecture",
          "- `windows-launcher`: Electron desktop launcher.",
          "- `node-bot`: local backend API.",
        ].join("\n"),
      }),
    },
    buildAssistantReply: async () => {
      modelCalls += 1;
      return "model reply";
    },
  });

  await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 60,
    method: "session/new",
    params: {
      sessionId: "session-local-summary",
      cwd: "C:\\ManaAI\\Mana",
    },
  });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 61,
    method: "session/prompt",
    params: {
      sessionId: "session-local-summary",
      prompt: [
        {
          type: "text",
          text: "can you read the current repository's readme and give me a summary of what this repository is for?",
        },
      ],
    },
  });

  assert.equal(response.result.stopReason, "end_turn");
  assert.equal(modelCalls, 0);
  assert.match(notifications[0].params.update.content.text, /local-first AI assistant/i);
  assert.match(notifications[0].params.update.content.text, /windows-launcher/i);
  assert.match(notifications[0].params.update.content.text, /node-bot/i);
});

test("createManaAcpAgent falls back to proposal-only text when no reply bridge is connected", async () => {
  const agent = createManaAcpAgent({ env: {}, memoryStore: false });

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
});

test("createDefaultManaAcpAgent sends prompts to the local backend reply endpoint", async () => {
  const calls = [];
  const notifications = [];
  const agent = createDefaultManaAcpAgent({
    env: {},
    memoryStore: false,
    notifyClient: async (method, params) => {
      notifications.push({ method, params });
    },
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
      sessionId: "session-2",
      prompt: [{ type: "text", text: "Refactor this function" }],
    },
  });

  assert.equal(response.result.stopReason, "end_turn");
  assert.equal(Object.hasOwn(response.result, "content"), false);
  assert.equal(notifications[0].method, "session/update");
  assert.equal(notifications[0].params.sessionId, "session-2");
  assert.equal(notifications[0].params.update.content.text, "Backend local reply");
  assert.equal(calls[0].url, "http://127.0.0.1:5005/reply");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    text: "Refactor this function",
    modelProfile: "coding",
    includeContext: false,
  });
});

test("createDefaultManaAcpAgent degrades gracefully when local backend is unavailable", async () => {
  const notifications = [];
  const agent = createDefaultManaAcpAgent({
    env: {},
    memoryStore: false,
    notifyClient: async (method, params) => {
      notifications.push({ method, params });
    },
    fetch: async () => {
      throw new Error("fetch failed");
    },
  });

  const response = await agent.handleJsonRpc({
    jsonrpc: "2.0",
    id: 5,
    method: "session/prompt",
    params: {
      sessionId: "session-3",
      prompt: [{ type: "text", text: "Refactor this function" }],
    },
  });

  assert.equal(response.result.stopReason, "end_turn");
  assert.equal(response.error, undefined);
  assert.match(notifications[0].params.update.content.text, /local Mana backend is not available/i);
  assert.match(notifications[0].params.update.content.text, /fetch failed/i);
});

test("stdio ACP server replies with line-delimited JSON for line-delimited input", async () => {
  const input = new EventEmitter();
  input.setEncoding = () => {};
  const chunks = [];
  const output = {
    write: (chunk) => {
      chunks.push(String(chunk));
    },
  };
  const server = createStdioAcpServer({
    input,
    output,
    errorOutput: { write: () => {} },
    agent: createManaAcpAgent({ env: {} }),
  });

  await server.handleData(
    `${JSON.stringify({ jsonrpc: "2.0", id: 40, method: "initialize" })}\n`,
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startsWith("Content-Length:"), false);
  assert.doesNotThrow(() => JSON.parse(chunks[0]));
});

test("stdio ACP server writes opt-in debug log entries outside stdout", async () => {
  const input = new EventEmitter();
  input.setEncoding = () => {};
  const stdoutChunks = [];
  const debugChunks = [];
  const server = createStdioAcpServer({
    input,
    output: {
      write: (chunk) => {
        stdoutChunks.push(String(chunk));
      },
    },
    errorOutput: { write: () => {} },
    debugLog: {
      write: (chunk) => {
        debugChunks.push(String(chunk));
      },
    },
    agent: createManaAcpAgent({ env: {} }),
  });

  await server.handleData(
    `${JSON.stringify({ jsonrpc: "2.0", id: 41, method: "initialize" })}\n`,
  );

  assert.equal(stdoutChunks.length, 1);
  assert.match(debugChunks.join(""), /"direction":"in"/);
  assert.match(debugChunks.join(""), /"method":"initialize"/);
  assert.match(debugChunks.join(""), /"direction":"out"/);
  assert.match(debugChunks.join(""), /"hasResult":true/);
});

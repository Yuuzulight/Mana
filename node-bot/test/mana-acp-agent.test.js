const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertLocalAiPolicy,
  buildZedAgentServerConfig,
  createDefaultManaAcpAgent,
  createManaAcpAgent,
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
  assert.equal(response.result.localAi.remoteAllowed, false);
  assert.equal(response.result.workspace.path, "C:\\ManaAI\\Mana");
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

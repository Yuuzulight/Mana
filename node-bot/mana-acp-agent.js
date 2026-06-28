const os = require("node:os");
const path = require("node:path");

const ACP_PROTOCOL_VERSION = 1;
const AGENT_NAME = "Mana";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:5005";

function assertLocalAiPolicy(env = process.env, options = {}) {
  const remoteRequested = String(env.MANA_ALLOW_REMOTE_AI || "").trim() === "1";
  if (remoteRequested && !options.allowRemoteOverride) {
    throw new Error(
      "Remote AI is disabled for the Zed External Agent. Unset MANA_ALLOW_REMOTE_AI or pass an explicit remote override.",
    );
  }

  return {
    remoteAllowed: remoteRequested,
    mode: remoteRequested ? "remote-opt-in" : "local",
  };
}

function buildZedAgentServerConfig(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, "..");
  const nodeCommand = options.nodeCommand || "node";

  return {
    agent_servers: {
      mana: {
        command: nodeCommand,
        args: [path.join(repoRoot, "node-bot", "mana-acp-agent.js"), "--acp"],
        env: {
          MANA_ALLOW_REMOTE_AI: "0",
          MANA_DEFAULT_EDITOR: "zed",
        },
      },
    },
  };
}

function normalizeWorkspace(workspace = null) {
  if (!workspace?.path) {
    return null;
  }

  return {
    path: workspace.path,
    editor: workspace.editor || "zed",
  };
}

function extractPromptText(params = {}) {
  const prompt = params.prompt || params.messages || params.content || [];
  if (typeof prompt === "string") {
    return prompt;
  }
  if (!Array.isArray(prompt)) {
    return "";
  }

  return prompt
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      return part?.text || part?.content || "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function createJsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function createJsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function createManaAcpAgent(options = {}) {
  const env = options.env || process.env;
  const buildAssistantReply = options.buildAssistantReply || null;
  const localAi = assertLocalAiPolicy(env, {
    allowRemoteOverride: options.allowRemoteOverride === true,
  });
  const workspace = normalizeWorkspace(options.workspace);

  async function handleJsonRpc(message = {}) {
    if (message.jsonrpc !== "2.0" || !message.method) {
      return createJsonRpcError(message.id ?? null, -32600, "Invalid JSON-RPC request.");
    }

    if (message.method === "initialize") {
      return createJsonRpcResult(message.id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentInfo: {
          name: AGENT_NAME,
          version: "0.1.0",
        },
        capabilities: {
          filesystem: {
            read: "explicit-bounded",
            write: "proposal-only",
          },
        },
        localAi,
        workspace,
      });
    }

    if (message.method === "session/new" || message.method === "session/create") {
      return createJsonRpcResult(message.id, {
        sessionId: message.params?.sessionId || `mana-${Date.now().toString(36)}`,
        workspace,
      });
    }

    if (message.method === "session/prompt" || message.method === "prompt") {
      const promptText = extractPromptText(message.params);
      if (buildAssistantReply) {
        const reply = await buildAssistantReply(promptText, "", "", {
          modelProfile: "coding",
          source: "zed-external-agent",
        });
        return createJsonRpcResult(message.id, {
          stopReason: "end_turn",
          content: [
            {
              type: "text",
              text: String(reply || "").trim(),
            },
          ],
        });
      }

      const suffix = promptText ? ` Received: ${promptText}` : "";
      return createJsonRpcResult(message.id, {
        stopReason: "end_turn",
        content: [
          {
            type: "text",
            text:
              "Mana's Zed External Agent entry point is running locally. The local coding model bridge is not connected in this first slice, so code changes remain limited to reviewable edit proposals and no files are modified silently." +
              suffix,
          },
        ],
      });
    }

    if (message.method === "shutdown") {
      return createJsonRpcResult(message.id, null);
    }

    return createJsonRpcError(message.id ?? null, -32601, `Unsupported ACP method: ${message.method}`);
  }

  return {
    handleJsonRpc,
    localAi,
    workspace,
  };
}

async function requestLocalBackendReply({
  prompt,
  modelProfile = "coding",
  backendUrl = DEFAULT_BACKEND_URL,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = String(backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
  const response = await fetchImpl(`${baseUrl}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: String(prompt || ""),
      modelProfile,
    }),
  });

  if (!response.ok) {
    throw new Error(`Local Mana backend reply failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  if (typeof body.reply !== "string") {
    throw new Error("Local Mana backend reply did not include text.");
  }

  return body.reply;
}

function createDefaultManaAcpAgent(options = {}) {
  return createManaAcpAgent({
    ...options,
    buildAssistantReply: async (prompt, screenContext, marketContext, replyOptions = {}) =>
      requestLocalBackendReply({
        prompt,
        backendUrl: options.backendUrl || options.env?.MANA_BACKEND_URL,
        fetchImpl: options.fetch,
        modelProfile: replyOptions.modelProfile || "coding",
      }),
  });
}

function encodeJsonRpcMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseContentLengthFrames(buffer) {
  const messages = [];
  let remaining = buffer;

  while (remaining.length) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      break;
    }

    const header = remaining.slice(0, headerEnd);
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) {
      break;
    }

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) {
      break;
    }

    const body = remaining.slice(bodyStart, bodyEnd);
    messages.push(JSON.parse(body));
    remaining = remaining.slice(bodyEnd);
  }

  return { messages, remaining };
}

function parseLineDelimitedJson(buffer) {
  const lines = buffer.split(/\r?\n/);
  const trailing = lines.pop() || "";
  const messages = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { messages, remaining: trailing };
}

function createStdioAcpServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const errorOutput = options.errorOutput || process.stderr;
  const agent = options.agent || createDefaultManaAcpAgent(options);
  let buffer = "";

  async function handleData(chunk) {
    buffer += chunk.toString("utf8");
    const parsed = buffer.includes("Content-Length:")
      ? parseContentLengthFrames(buffer)
      : parseLineDelimitedJson(buffer);
    buffer = parsed.remaining;

    for (const message of parsed.messages) {
      const response = await agent.handleJsonRpc(message);
      if (message.id !== undefined && message.id !== null) {
        output.write(encodeJsonRpcMessage(response));
      }
    }
  }

  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    handleData(chunk).catch((error) => {
      errorOutput.write(`Mana ACP error: ${error.message}${os.EOL}`);
    });
  });

  return {
    agent,
    handleData,
  };
}

function printHelp(output = process.stdout) {
  output.write(
    [
      "Mana Zed External Agent",
      "",
      "Usage:",
      "  node mana-acp-agent.js --acp",
      "  node mana-acp-agent.js --print-zed-config",
      "",
      "The --acp mode starts a local stdio JSON-RPC agent for Zed agent_servers.",
      "",
    ].join(os.EOL),
  );
}

if (require.main === module) {
  if (process.argv.includes("--print-zed-config")) {
    process.stdout.write(`${JSON.stringify(buildZedAgentServerConfig(), null, 2)}${os.EOL}`);
  } else if (process.argv.includes("--acp")) {
    createStdioAcpServer();
  } else {
    printHelp();
  }
}

module.exports = {
  assertLocalAiPolicy,
  buildZedAgentServerConfig,
  createDefaultManaAcpAgent,
  createManaAcpAgent,
  createStdioAcpServer,
  encodeJsonRpcMessage,
  requestLocalBackendReply,
};

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { createAcpAutonomousLoop } = require("./acp-autonomous-loop");
const { createAcpBackendBridge } = require("./acp-backend-bridge");
const { createAcpMemoryStore } = require("./acp-memory-store");
const { parseAllowedPathList } = require("./acp-path-guard");
const { createAcpTestRunner } = require("./acp-test-runner");

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
        type: "custom",
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

function shouldIncludeReadmeContext(promptText) {
  return /\breadme\b/i.test(String(promptText || ""));
}

function shouldSummarizeReadmeLocally(promptText) {
  return (
    /\breadme\b/i.test(String(promptText || "")) &&
    /\b(summary|summarize|what.*for|what.*is|purpose|about)\b/i.test(
      String(promptText || ""),
    )
  );
}

function extractReadmeSection(content, heading) {
  const lines = String(content || "").split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim()),
  );
  if (start === -1) {
    return [];
  }
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) {
      break;
    }
    if (line.trim()) {
      section.push(line.trim());
    }
  }
  return section;
}

function summarizeReadme(readme) {
  const content = String(readme?.content || "");
  const firstParagraph =
    content
      .split(/\r?\n\r?\n/)
      .map((part) => part.replace(/^#\s+.+$/m, "").trim())
      .find(Boolean) || "This repository contains Mana.";
  const highlights = extractReadmeSection(content, "Highlights")
    .filter((line) => line.startsWith("-"))
    .slice(0, 5)
    .map((line) => line.replace(/^-+\s*/, ""));
  const architecture = extractReadmeSection(content, "Architecture")
    .filter((line) => line.startsWith("-"))
    .slice(0, 5)
    .map((line) => line.replace(/^-+\s*/, ""));

  return [
    firstParagraph,
    "",
    highlights.length ? "Key points:" : "",
    ...highlights.map((line) => `- ${line}`),
    architecture.length ? "" : "",
    architecture.length ? "Main pieces:" : "",
    ...architecture.map((line) => `- ${line}`),
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .trim();
}

function createWorkspaceContext(options = {}) {
  const maxReadmeBytes = Math.max(1, Number(options.maxReadmeBytes || 4096));

  async function readReadme(cwd) {
    const workspacePath = typeof cwd === "string" ? cwd.trim() : "";
    if (!workspacePath) {
      return null;
    }

    for (const filename of ["README.md", "README.txt", "README"]) {
      const filePath = path.join(workspacePath, filename);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        continue;
      }
      const buffer = fs.readFileSync(filePath);
      return {
        path: filePath,
        content: buffer.subarray(0, maxReadmeBytes).toString("utf8"),
        truncated: buffer.length > maxReadmeBytes,
      };
    }

    return null;
  }

  return {
    readReadme,
  };
}

async function addWorkspaceContextToPrompt(
  promptText,
  session,
  workspaceContext,
  triggerText = promptText,
) {
  if (
    !shouldIncludeReadmeContext(triggerText) ||
    !workspaceContext?.readReadme
  ) {
    return promptText;
  }

  const readme = await workspaceContext.readReadme(session?.cwd);
  if (!readme?.content) {
    return promptText;
  }

  return [
    "Repository README:",
    `Path: ${readme.path}`,
    "```markdown",
    readme.content,
    readme.truncated ? "\n[README truncated]" : "",
    "```",
    "",
    "User request:",
    promptText,
  ].join("\n");
}

function addMemoryContextToPrompt(promptText, memoryBlock) {
  const memory = String(memoryBlock || "").trim();
  if (!memory) {
    return promptText;
  }

  return [memory, "", "User request:", promptText].join("\n");
}

async function notifyAgentText(notifyClient, sessionId, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || !sessionId || typeof notifyClient !== "function") {
    return;
  }

  await notifyClient("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: trimmed,
      },
    },
  });
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

function createManaAcpAgent(options = {}) {
  const env = options.env || process.env;
  const buildAssistantReply = options.buildAssistantReply || null;
  const notifyClient = options.notifyClient || null;
  const workspaceContext =
    options.workspaceContext || createWorkspaceContext(options);
  const memoryStore =
    options.memoryStore === false
      ? null
      : options.memoryStore ||
        createAcpMemoryStore({
          dataDir: options.memoryDataDir,
        });
  const sessions = new Map();
  const localAi = assertLocalAiPolicy(env, {
    allowRemoteOverride: options.allowRemoteOverride === true,
  });
  const workspace = normalizeWorkspace(options.workspace);
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

  async function handleJsonRpc(message = {}) {
    if (message.jsonrpc !== "2.0" || !message.method) {
      return createJsonRpcError(
        message.id ?? null,
        -32600,
        "Invalid JSON-RPC request.",
      );
    }

    try {
      if (message.method === "initialize") {
        return createJsonRpcResult(message.id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentInfo: {
            name: AGENT_NAME,
            version: "0.1.0",
          },
          agentCapabilities: {
            loadSession: false,
          },
          authMethods: [],
          capabilities: {
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
          },
          localAi,
          workspace,
        });
      }

      if (
        message.method === "session/new" ||
        message.method === "session/create"
      ) {
        const sessionId =
          message.params?.sessionId || `mana-${Date.now().toString(36)}`;
        const cwd = message.params?.cwd || workspace?.path || process.cwd();
        sessions.set(sessionId, {
          cwd,
        });
        try {
          memoryStore?.ensureSession({
            sessionId,
            cwd,
            editor: workspace?.editor || env.MANA_DEFAULT_EDITOR || "zed",
          });
        } catch {
          // Memory should improve ACP replies, not prevent Zed from opening a session.
        }
        return createJsonRpcResult(message.id, {
          sessionId,
          workspace,
        });
      }

      if (message.method === "authenticate") {
        return createJsonRpcResult(message.id, {});
      }

      if (message.method === "session/prompt" || message.method === "prompt") {
        const promptText = extractPromptText(message.params);
        const sessionId = message.params?.sessionId;
        const session = sessions.get(sessionId) || {
          cwd: workspace?.path || process.cwd(),
        };
        try {
          if (sessionId) {
            memoryStore?.ensureSession({
              sessionId,
              cwd: session.cwd,
              editor: workspace?.editor || env.MANA_DEFAULT_EDITOR || "zed",
            });
          }
        } catch {
          // A memory write failure should not block a local model reply.
        }
        if (shouldSummarizeReadmeLocally(promptText)) {
          const readme = await workspaceContext.readReadme(session.cwd);
          if (readme?.content) {
            const reply = summarizeReadme(readme);
            await notifyAgentText(notifyClient, sessionId, reply);
            try {
              if (memoryStore && typeof memoryStore.appendTurn === "function") {
                await memoryStore.appendTurn({
                  sessionId,
                  user: promptText,
                  assistant: reply,
                });
              }
            } catch (e) {
              // Ignore local memory failures while serving the current prompt.
              console.warn("ACP memory appendTurn failed:", e?.message || e);
            }
            return createJsonRpcResult(message.id, {
              stopReason: "end_turn",
            });
          }
        }
        let memoryBlock = "";
        try {
          memoryBlock = sessionId
            ? await (memoryStore?.buildPromptMemory(sessionId) || "")
            : "";
        } catch (memErr) {
          memoryBlock = "";
        }
        const promptWithMemory = addMemoryContextToPrompt(
          promptText,
          memoryBlock,
        );
        const promptWithContext = await addWorkspaceContextToPrompt(
          promptWithMemory,
          session,
          workspaceContext,
          promptText,
        );
        if (buildAssistantReply) {
          let reply = "";
          try {
            reply = await buildAssistantReply(promptWithContext, "", "", {
              modelProfile: "coding",
              source: "zed-external-agent",
            });
          } catch (error) {
            reply =
              "The local Mana backend is not available, so Mana cannot produce a local AI reply from Zed yet. " +
              `Start the local backend and try again. Details: ${error.message}`;
          }
          await notifyAgentText(notifyClient, sessionId, reply);
          try {
            if (memoryStore && typeof memoryStore.appendTurn === "function") {
              await memoryStore.appendTurn({
                sessionId,
                user: promptText,
                assistant: reply,
              });
            }
          } catch (e) {
            // Ignore local memory failures while serving the current prompt.
            console.warn("ACP memory appendTurn failed:", e?.message || e);
          }
          return createJsonRpcResult(message.id, {
            stopReason: "end_turn",
          });
        }

        const suffix = promptText ? ` Received: ${promptText}` : "";
        await notifyAgentText(
          notifyClient,
          sessionId,
          "Mana's Zed External Agent entry point is running locally. The local coding model bridge is not connected in this first slice, so code changes remain limited to reviewable edit proposals and no files are modified silently." +
            suffix,
        );
        return createJsonRpcResult(message.id, {
          stopReason: "end_turn",
        });
      }

      if (message.method === "mana/workspace/status") {
        return createJsonRpcResult(
          message.id,
          await backendBridge.getWorkspace(),
        );
      }
      if (message.method === "mana/workspace/set") {
        return createJsonRpcResult(
          message.id,
          await backendBridge.setWorkspace(message.params || {}),
        );
      }
      if (message.method === "mana/workspace/files") {
        return createJsonRpcResult(
          message.id,
          await backendBridge.listWorkspaceFiles(),
        );
      }
      if (message.method === "mana/workspace/read") {
        return createJsonRpcResult(
          message.id,
          await backendBridge.readWorkspaceFile(message.params?.path),
        );
      }
      if (message.method === "mana/edit/propose") {
        return createJsonRpcResult(
          message.id,
          await backendBridge.createEditProposal(message.params || {}),
        );
      }
      if (message.method === "mana/edit/list") {
        return createJsonRpcResult(
          message.id,
          await backendBridge.listEditProposals(),
        );
      }
      if (message.method === "mana/edit/get") {
        return createJsonRpcResult(
          message.id,
          await backendBridge.getEditProposal(message.params?.id),
        );
      }
      if (message.method === "mana/edit/approve") {
        return createJsonRpcResult(
          message.id,
          await backendBridge.approveEditProposal(message.params?.id),
        );
      }
      if (message.method === "mana/test/run") {
        if (!agentLimits.autonomousEnabled) {
          return createJsonRpcError(
            message.id,
            -32000,
            "autonomous mode is disabled",
          );
        }
        return createJsonRpcResult(
          message.id,
          await testRunner.run(message.params?.command, {
            cwd: message.params?.cwd,
          }),
        );
      }
      if (message.method === "mana/agent/run") {
        if (!agentLimits.autonomousEnabled) {
          return createJsonRpcError(
            message.id,
            -32000,
            "autonomous mode is disabled",
          );
        }
        return createJsonRpcResult(
          message.id,
          await autonomousLoop.run(message.params || {}),
        );
      }

      if (message.method === "shutdown") {
        return createJsonRpcResult(message.id, null);
      }

      return createJsonRpcError(
        message.id ?? null,
        -32601,
        `Unsupported ACP method: ${message.method}`,
      );
    } catch (error) {
      return createJsonRpcError(message.id ?? null, -32000, error.message);
    }
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
      includeContext: false,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Local Mana backend reply failed with HTTP ${response.status}.`,
    );
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
    buildAssistantReply: async (
      prompt,
      screenContext,
      marketContext,
      replyOptions = {},
    ) =>
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
    if (!header) {
      break;
    }

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

function encodeLineDelimitedJsonMessage(message) {
  return `${JSON.stringify(message)}\n`;
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

function createDebugLogWriter(options = {}) {
  if (options.debugLog) {
    return options.debugLog;
  }

  const debugLogPath =
    options.env?.MANA_ACP_DEBUG_LOG || process.env.MANA_ACP_DEBUG_LOG;
  if (!debugLogPath) {
    return null;
  }

  try {
    fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
    return fs.createWriteStream(debugLogPath, { flags: "a" });
  } catch {
    return null;
  }
}

function writeDebugLog(debugLog, entry) {
  if (!debugLog) {
    return;
  }

  debugLog.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    })}${os.EOL}`,
  );
}

function createStdioAcpServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const errorOutput = options.errorOutput || process.stderr;
  const debugLog = createDebugLogWriter(options);
  let currentFraming = "line-json";
  const notifyClient =
    options.notifyClient ||
    ((method, params) => {
      const notification = {
        jsonrpc: "2.0",
        method,
        params,
      };
      output.write(
        currentFraming === "content-length"
          ? encodeJsonRpcMessage(notification)
          : encodeLineDelimitedJsonMessage(notification),
      );
    });
  const agent =
    options.agent ||
    createDefaultManaAcpAgent({
      ...options,
      notifyClient,
    });
  let buffer = "";

  async function handleData(chunk) {
    buffer += chunk.toString("utf8");
    const usesContentLengthFrames = buffer.includes("Content-Length:");
    currentFraming = usesContentLengthFrames ? "content-length" : "line-json";
    const parsed = usesContentLengthFrames
      ? parseContentLengthFrames(buffer)
      : parseLineDelimitedJson(buffer);
    buffer = parsed.remaining;

    for (const message of parsed.messages) {
      writeDebugLog(debugLog, {
        direction: "in",
        id: message.id ?? null,
        method: message.method || null,
        framing: usesContentLengthFrames ? "content-length" : "line-json",
      });
      const response = await agent.handleJsonRpc(message);
      writeDebugLog(debugLog, {
        direction: "out",
        id: response.id ?? null,
        method: message.method || null,
        hasResult: Object.prototype.hasOwnProperty.call(response, "result"),
        hasError: Object.prototype.hasOwnProperty.call(response, "error"),
        errorMessage: response.error?.message || null,
      });
      if (message.id !== undefined && message.id !== null) {
        output.write(
          usesContentLengthFrames
            ? encodeJsonRpcMessage(response)
            : encodeLineDelimitedJsonMessage(response),
        );
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
    process.stdout.write(
      `${JSON.stringify(buildZedAgentServerConfig(), null, 2)}${os.EOL}`,
    );
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
  encodeLineDelimitedJsonMessage,
  getAgentLimits,
  isAutonomousEnabled,
  requestLocalBackendReply,
};

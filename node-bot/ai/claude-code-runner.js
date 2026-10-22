// #1406: the official Claude Code, run the way Zed runs it (its ACP adapter,
// with Yuuzulight signed in inside Claude Code), as one more runner for her
// self-work loop: runner(prompt, tools, opts) like remoteToolReply's.
//
// Claude gets none of Claude Code's own tools. Its only tools are hers,
// through a local MCP endpoint that calls her policy's executeTool, so her
// guardrails, sandboxed tests and reviewer hold exactly as for DeepSeek. Mana
// never touches a Claude credential: Claude Code reads its own login, and no
// ANTHROPIC_* / CLAUDE* variable of hers reaches it (an API key would bill
// the API; a host app's variables point it at that app's session).
//
// ACP v1 is newline-delimited JSON-RPC 2.0 on stdio; the few calls a client
// makes are below, instead of a dependency.
const { spawn, execFile } = require("node:child_process");
const readline = require("node:readline");
const { startPolicyMcpServer } = require("./policy-mcp-server");
const { killProcessTree } = require("../utils/kill-process-tree");

// Claude Code's own tools, all switched off (tools: [] already does; this is the belt to its braces).
const DENIED_BUILTINS = ["Bash", "BashOutput", "KillShell", "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "TodoWrite", "ExitPlanMode", "SlashCommand", "Skill"];
const NOT_INSTALLED = "Claude Code isn't installed for Mana (its ACP adapter is missing from node-bot's packages)";
const SIGN_IN = "Claude Code isn't signed in: run `claude`, then `/login` with your Claude account";
const LIMIT_RE = /usage limit|limit reached|rate limit/i;
const OWN_TOOL_RE = /^mcp__mana__/;

const cleanEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE|USE_(LOCAL|STAGING)_OAUTH)/i.test(k)));

function defaultAdapter(env) {
  return [env.MANA_CLAUDE_ACP_ADAPTER || require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")];
}

// JSON-RPC over the child's stdio: requests out, requests and notifications in.
function connect(child) {
  let next = 1;
  const pending = new Map();
  const handlers = {};
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  readline.createInterface({ input: child.stdout }).on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a protocol line
    }
    if (msg.method) {
      const handler = handlers[msg.method];
      if (msg.id === undefined) return handler?.(msg.params);
      if (!handler) return send({ id: msg.id, error: { code: -32601, message: `${msg.method} isn't supported` } });
      return send({ id: msg.id, result: await handler(msg.params) });
    }
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    if (msg.error) waiting.reject(Object.assign(new Error(msg.error.message || "Claude Code error"), { code: msg.error.code }));
    else waiting.resolve(msg.result);
  });
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Claude Code stopped")));
  return {
    on: (method, handler) => (handlers[method] = handler),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      }),
  };
}

// Her tools, and nothing else.
function decide({ toolCall, options }) {
  const allowed = OWN_TOOL_RE.test(String(toolCall?.title || ""));
  const pick = options.find((o) => o.kind === (allowed ? "allow_once" : "reject_once")) || options.find((o) => o.kind.startsWith(allowed ? "allow" : "reject"));
  return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
}

function briefFor(prompt, opts) {
  return [
    opts.overrideSystemPrompt,
    opts.goal ? `Goal: ${opts.goal}.` : "",
    "Your only tools are the mana ones (mcp__mana__*): her worktree tools, her sandboxed tests, her review passes and session_goal__finish. Work only through them, and call session_goal__finish when the change is done and its tests pass.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createClaudeCodeRunner({ model = "sonnet", command = process.execPath, args = null, env = process.env, worktree }) {
  return async function claudeCodeRunner(prompt, tools, opts = {}) {
    let adapterArgs;
    try {
      adapterArgs = args || defaultAdapter(env);
    } catch {
      return { content: "", rounds: 0, messages: null, unavailable: NOT_INSTALLED };
    }
    const server = await startPolicyMcpServer(tools);
    const child = spawn(command, adapterArgs, { cwd: worktree, env: cleanEnv(env), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const rpc = connect(child);
    let content = "";
    let rounds = 0;
    rpc.on("session/request_permission", decide);
    rpc.on("session/update", ({ update } = {}) => {
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") content += update.content.text;
      if (update?.sessionUpdate === "tool_call") rounds += 1;
    });
    try {
      await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      const options = { model, tools: [], disallowedTools: DENIED_BUILTINS, settingSources: [], strictMcpConfig: true, ...(Number.isFinite(opts.maxRounds) ? { maxTurns: opts.maxRounds } : {}) };
      const { sessionId } = await rpc.request("session/new", {
        cwd: worktree,
        mcpServers: [{ type: "http", name: "mana", url: server.url, headers: [{ name: "Authorization", value: server.headers.Authorization }] }],
        _meta: { claudeCode: { options } },
      });
      const result = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: briefFor(prompt, opts) }] });
      return { content: content.trim(), rounds, messages: null, usage: result?.usage || null };
    } catch (e) {
      if (e.code === -32000 && /auth/i.test(e.message)) return { content: content.trim(), rounds, messages: null, unavailable: SIGN_IN };
      // A limit stops the run without failing it: she picks it up after the reset.
      if (LIMIT_RE.test(e.message)) return { content: `${content.trim()}\n${e.message}`.trim(), rounds, messages: null, usageLimit: true };
      throw e;
    } finally {
      killProcessTree(child);
      await server.close();
    }
  };
}

// Whether a handoff can run at all, before she asks Yuuzulight: null, or why not.
function claudeCodeAvailable({ command = process.execPath, args = null, env = process.env } = {}) {
  let adapterArgs;
  try {
    adapterArgs = args || defaultAdapter(env);
  } catch {
    return Promise.resolve(NOT_INSTALLED);
  }
  return new Promise((resolve) => {
    execFile(command, [...adapterArgs, "--cli", "auth", "status", "--json"], { env: cleanEnv(env), timeout: 30000, windowsHide: true }, (error, stdout) => {
      try {
        resolve(JSON.parse(String(stdout)).loggedIn === true ? null : SIGN_IN);
      } catch {
        resolve(error && /Cannot find module|ENOENT/.test(String(error.message)) ? NOT_INSTALLED : SIGN_IN);
      }
    });
  });
}

module.exports = { createClaudeCodeRunner, claudeCodeAvailable, DENIED_BUILTINS, NOT_INSTALLED, SIGN_IN };

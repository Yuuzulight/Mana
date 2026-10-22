// A stand-in for the Claude Code ACP adapter (newline-delimited JSON-RPC on
// stdio), shaped like what the real one sent in the #1406 spike. FAKE_ACP_MODE:
// finish | limit | signed-out. FAKE_ACP_LOG: a file it appends what it saw to.
const fs = require("node:fs");
const readline = require("node:readline");

const mode = process.env.FAKE_ACP_MODE || "finish";
const logFile = process.env.FAKE_ACP_LOG;
const record = (entry) => logFile && fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);

// `--cli auth status --json`, as the adapter forwards it to Claude Code.
if (process.argv.includes("--cli")) {
  process.stdout.write(JSON.stringify({ loggedIn: mode !== "signed-out", authMethod: mode === "signed-out" ? "none" : "claude.ai" }));
  process.exit(0);
}

record({ env: Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE|USE_)/i.test(k)) });
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const say = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });

async function prompt(id, params) {
  const sessionId = params.sessionId;
  if (mode === "signed-out") return send({ id, error: { code: -32000, message: "Authentication required" } });
  if (mode === "limit") {
    say(sessionId, "Working on it...");
    return send({ id, error: { code: -32603, message: "Claude usage limit reached. Your limit will reset at 5pm." } });
  }
  // Her tool, through the MCP endpoint session/new was given.
  const server = record.server;
  const call = await fetch(server.url, { method: "POST", headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "self_work__read", arguments: { path: "a.js" } } }) });
  record({ toolCall: call.status });
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "mcp__mana__self_work__read", kind: "other", status: "pending" } } });
  const allowed = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "t1", title: "mcp__mana__self_work__read" }, options: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "Reject", kind: "reject_once" }] });
  const shell = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "t2", title: "Bash" }, options: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "Reject", kind: "reject_once" }] });
  record({ permissions: { mana: allowed.outcome, shell: shell.outcome } });
  say(sessionId, "I fixed add() ");
  say(sessionId, "and the tests pass.");
  send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 30, cachedWriteTokens: 40, totalTokens: 100 } } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) return waiting.get(msg.id)?.(msg.result);
  if (msg.method === "initialize") return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } });
  if (msg.method === "session/new") {
    record({ sessionNew: msg.params });
    const http = (msg.params.mcpServers || []).find((s) => s.type === "http");
    record.server = http && { url: http.url, headers: Object.fromEntries(http.headers.map((h) => [h.name, h.value])) };
    return send({ id: msg.id, result: { sessionId: "s1" } });
  }
  if (msg.method === "session/prompt") return prompt(msg.id, msg.params);
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
});

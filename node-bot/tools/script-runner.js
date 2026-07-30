// Issue #142: a general-purpose primitive for collapsing a multi-step tool
// chain into a single generated script, instead of one model round-trip per
// tool call. The script runs in an isolated forked child process (no
// network/file access of its own -- see script-runner-worker.js); the only
// thing it can do is call one of the named functions in `options.tools`,
// which actually execute here in the parent (where the real capability
// functions -- web search, memory queries, etc. -- already live) and
// round-trip their result back over IPC.
//
// Deliberately not wired into any specific capability yet: audited against
// deep-research-capability.js (issue #142's suggested first caller) and
// found its source-gathering loop already runs as plain sequential JS with
// only two model calls total (decompose, synthesize) -- it doesn't have the
// per-call round-trip cost this primitive exists to remove. Kept standalone,
// ready for the next feature that actually chains several model-facing tool
// calls (e.g. a future multi-round extension of runToolAwareReply, or #145's
// subagent delegation).
const { fork } = require("node:child_process");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 15000;
const WORKER_PATH = path.join(__dirname, "script-runner-worker.js");

async function runToolScript(code, options = {}) {
  const tools = options.tools || {};
  const toolNames = Object.keys(tools).filter(
    (name) => typeof tools[name] === "function",
  );
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const forkFn = options.fork || fork;
  const workerPath = options.workerPath || WORKER_PATH;

  return new Promise((resolve, reject) => {
    const child = forkFn(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let settled = false;
    const logs = [];
    let logsCharCount = 0;
    // A script looping console.log() for the full timeout could otherwise
    // buffer unbounded output into this long-lived parent process before
    // the timeout fires -- cap total buffered log size the same way every
    // other unbounded-text sink in this codebase does (a fixed char cap).
    const MAX_LOGS_CHARS = 20000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`script execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    }

    child.on("message", async (msg) => {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "tool-call") {
        const toolFn = tools[msg.name];
        if (typeof toolFn !== "function") {
          child.send({
            type: "tool-result",
            callId: msg.callId,
            error: `unknown tool: ${msg.name}`,
          });
          return;
        }
        try {
          const result = await toolFn(...(msg.args || []));
          child.send({ type: "tool-result", callId: msg.callId, result });
        } catch (e) {
          child.send({
            type: "tool-result",
            callId: msg.callId,
            error: (e && e.message) || String(e),
          });
        }
        return;
      }

      if (msg.type === "log") {
        if (logsCharCount < MAX_LOGS_CHARS) {
          const line = (msg.args || []).join(" ");
          logs.push(line);
          logsCharCount += line.length;
        }
        return;
      }

      if (msg.type === "done") {
        finish(() => resolve({ result: msg.result, logs }));
        return;
      }

      if (msg.type === "error") {
        finish(() => reject(Object.assign(new Error(msg.error), { logs })));
        return;
      }
    });

    child.on("error", (e) => finish(() => reject(e)));
    child.on("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`script process exited early (code ${exitCode})`));
    });

    child.send({ type: "run", code, toolNames });
  });
}

module.exports = { runToolScript, DEFAULT_TIMEOUT_MS };

// Forked child-process entry point for script-runner.js -- never required
// directly, only ever launched via child_process.fork(). Runs Mana-authored
// code inside a vm context whose only capability is the whitelisted `tools`
// proxy: no `require`, no `process`, no `fs`/network globals of its own, so
// the only thing the script can do beyond plain JS is call a named tool,
// which round-trips over IPC to the real function running in the parent.
//
// That comment was the intended design, but plain `vm` does not actually
// enforce it: any object or function value that crosses from this trusted
// parent realm into the sandbox keeps its outer `.constructor` chain, and
// `someInjectedValue.constructor.constructor("return process")()` reaches
// the OUTER Function constructor -- fully escaping the vm context with real
// process/fs/network access, no different from running the string directly
// in this file. Verified empirically before this fix landed. `seal()` below
// strips the prototype off every injected object/function (recursively) so
// there is no `.constructor` to walk back through; nothing here relies on
// Node's `vm` module as a hard security boundary against genuinely hostile
// code, only as isolation from Mana's own generated scripts making an
// honest mistake.
const vm = require("node:vm");

function seal(value, seen = new Set()) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.setPrototypeOf(value, null);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    seal(value[key], seen);
  }
  return value;
}

let nextCallId = 0;
const pending = new Map();

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const callId = ++nextCallId;
    pending.set(callId, { resolve, reject });
    process.send({ type: "tool-call", callId, name, args });
  });
}

async function runScript(code, toolNames) {
  const tools = {};
  for (const name of toolNames) {
    tools[name] = (...args) => callTool(name, args);
  }

  const sandbox = {
    tools,
    console: {
      log: (...args) =>
        process.send({ type: "log", args: args.map(String) }),
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    // Deliberately not injecting the outer `Promise` -- a fresh vm context
    // already gets its own realm-native Promise for async/await and `new
    // Promise(...)` to work with (verified), and injecting the outer one
    // would just be another instance of the same escape `seal()` exists to
    // close.
  };
  seal(sandbox);
  vm.createContext(sandbox);

  try {
    const wrapped = `(async () => {\n${code}\n})()`;
    const script = new vm.Script(wrapped, { filename: "mana-generated-script.js" });
    // The vm timeout only bounds synchronous execution (e.g. a `while
    // (true) {}` before the first await) -- the real wall-clock timeout
    // for the whole script (including awaited tool calls) is enforced by
    // script-runner.js killing this whole process from the parent side.
    const result = await script.runInContext(sandbox, { timeout: 10000 });
    process.send({ type: "done", result });
  } catch (e) {
    process.send({ type: "error", error: (e && e.message) || String(e) });
  }
  process.exitCode = 0;
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "tool-result" && pending.has(msg.callId)) {
    const { resolve, reject } = pending.get(msg.callId);
    pending.delete(msg.callId);
    if (msg.error) reject(new Error(msg.error));
    else resolve(msg.result);
    return;
  }
  if (msg.type === "run") {
    runScript(msg.code, msg.toolNames || []);
  }
});

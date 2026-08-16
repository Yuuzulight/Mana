// Issue #188: one shared audit/trace record for every tool call, regardless
// of source (local read_file, browser-automation, or a remote MCP tool) --
// so there's one place to see what any tool actually did, instead of each
// capability's own scattered console.log. JSON-lines, same "one line per
// event" pattern windows-launcher's voice-crash.log already uses.
const fs = require("fs");
const path = require("path");

const DEFAULT_LOG_PATH = path.join(__dirname, "data", "tool-call-log", "tool-calls.jsonl");
const DEFAULT_RECENT_LIMIT = 200;
// Caps a call's serialized args in the log -- large tool inputs (e.g. a
// long file path list or page text passed to a browser-automation tool)
// shouldn't make one log line dominate the file. Matches the same
// size-capping instinct as MAX_TEXT_CHARS/MAX_TRANSCRIPT_CHARS_FOR_PROMPT
// elsewhere in this codebase.
const MAX_ARGS_CHARS = 2000;

// Issue #348: a tool call can carry a credential in its own arguments (a
// key passed to an HTTP tool, a token pulled out of a config value), and a
// thrown error can echo one back in its message. Both land in
// tool-calls.jsonl in plaintext. Redacting here rather than at each call
// site means a newly-added tool source can't forget to do it.
const REDACTED = "[redacted]";

// Matched against argument *names*. Deliberately does not include a bare
// "key" -- the remember tool's `key` argument is a memory key, not a
// credential, and blanking it would destroy the most useful field in the
// audit trail while protecting nothing.
const SECRET_KEY_PATTERNS = [
  /secret/i,
  /token/i,
  /passwo?rd/i,
  /\bpwd\b/i,
  /credential/i,
  /authorization/i,
  /api[_\-.]?key/i,
  /access[_\-.]?key/i,
  /private[_\-.]?key/i,
];

function isSecretKey(name) {
  return SECRET_KEY_PATTERNS.some((re) => re.test(name));
}

function redactSecrets(value, seen = new Set()) {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  if (!value || typeof value !== "object") return value;
  // JSON.stringify would throw on a cycle and serializeArgs would fall back
  // to String(args); this walk has to stop on its own before that happens.
  // `seen` tracks the current ancestor chain, not everything ever visited --
  // the same object referenced twice side by side is a plain shared
  // reference, not a cycle, and marking it "[circular]" would silently drop
  // a real argument from the audit trail.
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const out = {};
  for (const [name, item] of Object.entries(value)) {
    out[name] = isSecretKey(name) ? REDACTED : redactSecrets(item, seen);
  }
  seen.delete(value);
  return out;
}

// Value-level pass for credentials that aren't under a credential-shaped
// name -- a token embedded in a URL query string, or quoted back inside an
// error message. Narrow, well-known token shapes only: a general
// "looks high-entropy" heuristic would also flag file hashes and session
// ids, which are legitimate audit data, and a rule that fires on those
// trains you to ignore it.
const SECRET_VALUE_RE =
  /(Bearer\s+[A-Za-z0-9._~+/-]{16,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|[?&](?:api[_-]?key|token|access_token)=[^&"\s]+)/gi;

function redactText(text) {
  return String(text ?? "").replace(SECRET_VALUE_RE, REDACTED);
}

function serializeArgs(args) {
  let text;
  try {
    text = JSON.stringify(redactSecrets(args ?? {}));
  } catch (e) {
    text = String(args);
  }
  // After redaction, so truncation can never cut a redaction in half and
  // leave the tail of a real secret behind.
  text = redactText(text);
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}...[truncated]` : text;
}

// options.logPath: injectable so tests never write into node-bot's real
// data directory (same pattern as acp-memory-store.js/telegram-bridge.js).
function createToolCallLog(options = {}) {
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const now = options.now || (() => new Date().toISOString());

  function append(entry) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const record = { at: now(), ...entry, args: serializeArgs(entry.args) };
    // A thrown error's message routinely quotes back the request that
    // failed, credential included (issue #348).
    if (typeof record.error === "string") record.error = redactText(record.error);
    const line = JSON.stringify(record);
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  }

  function readRecent(limit = DEFAULT_RECENT_LIMIT) {
    if (!fs.existsSync(logPath)) return [];
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  }

  return { logPath, append, readRecent };
}

// Wraps any {tools, isKnownTool, executeTool}-shaped tool policy so every
// executeTool() call gets logged -- name, args, ok/error, duration -- no
// matter which source (local, browser-automation, MCP) actually owns the
// tool. Applied last in server.js's merge chain, after every other source
// has already been folded in, so this one wrap catches everything.
function wrapWithToolCallLog(policy, toolCallLog) {
  return {
    tools: policy.tools,
    isKnownTool: policy.isKnownTool,
    executeTool: async (name, args) => {
      const startedAt = Date.now();
      try {
        const result = await policy.executeTool(name, args);
        toolCallLog.append({ name, args, ok: true, durationMs: Date.now() - startedAt });
        return result;
      } catch (e) {
        toolCallLog.append({ name, args, ok: false, error: e.message, durationMs: Date.now() - startedAt });
        throw e;
      }
    },
  };
}

module.exports = { DEFAULT_LOG_PATH, createToolCallLog, wrapWithToolCallLog };

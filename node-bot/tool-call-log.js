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

function serializeArgs(args) {
  let text;
  try {
    text = JSON.stringify(args ?? {});
  } catch (e) {
    text = String(args);
  }
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}...[truncated]` : text;
}

// options.logPath: injectable so tests never write into node-bot's real
// data directory (same pattern as acp-memory-store.js/telegram-bridge.js).
function createToolCallLog(options = {}) {
  const logPath = options.logPath || DEFAULT_LOG_PATH;
  const now = options.now || (() => new Date().toISOString());

  function append(entry) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify({ at: now(), ...entry, args: serializeArgs(entry.args) });
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

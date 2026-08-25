// Issue #426: user-configurable PreToolUse/PostToolUse-style hooks --
// deterministic checks the user declares themselves (e.g. "block writes
// under .env," "ask before touching package.json," "run prettier after a
// write"), additive to the fixed internal gates approval-gate.js (#152) and
// tool-call-log.js (#188) already provide, not a replacement for either.
//
// Only the three concrete rule shapes the issue's own Proposal names:
//   - phase "pre",  action "deny"        -- blocks the call outright
//   - phase "pre",  action "ask"         -- routes through the approval gate
//   - phase "post", action "run-command" -- runs a command after a matching
//                                           call succeeds
// Claude Code's own "modify-input" hook action is prior-art background, not
// something this issue's Proposal asks for -- deliberately not built here.
//
// Persistence: one JSON array file, atomic tmp+rename write, dataDir
// injectable for tests -- same shape as plugin-settings-store.js.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const DEFAULT_DATA_DIR = path.join(__dirname, "data", "hooks");
const PHASES = ["pre", "post"];
const ACTIONS_BY_PHASE = { pre: ["deny", "ask"], post: ["run-command"] };
// Fire-and-forget post-hook commands still need a ceiling -- an unbounded
// prettier/lint command hanging forever would leak a child process per
// write forever.
const HOOK_COMMAND_TIMEOUT_MS = 15000;

function readRules(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // Malformed config file (hand-edited, half-written) -- fall back to "no
    // rules" rather than crashing every tool call the server makes.
    return [];
  }
}

function writeRules(filePath, rules) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

// toolName matches exactly, or as a "prefix*" glob -- e.g. "skill__*"
// matches every skill tool. "*" (or an unset toolName) matches anything.
function ruleMatchesTool(rule, toolName) {
  if (!rule.toolName || rule.toolName === "*") return true;
  if (rule.toolName.endsWith("*")) {
    return String(toolName || "").startsWith(rule.toolName.slice(0, -1));
  }
  return rule.toolName === toolName;
}

// Path-scoped rules (the .env/package.json examples) match against the
// call's `args.path` -- the shape both acp-autonomous-loop.js's file_write
// and ai/coding-tool-source.js's coding__propose_edit use for the file a
// call targets. A rule with no pathContains matches every call to that
// tool; a call with no args.path never matches a path-scoped rule.
function ruleMatchesPath(rule, args) {
  if (!rule.pathContains) return true;
  const candidate = String((args && args.path) || "");
  if (!candidate) return false;
  return candidate.toLowerCase().includes(rule.pathContains.toLowerCase());
}

// options.dataDir: injectable so tests never write into node-bot's real
// data directory (same pattern as plugin-settings-store.js/approval-gate.js).
function createHooksStore(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const filePath = path.join(dataDir, "hooks.json");
  const makeId = options.makeId || (() => crypto.randomBytes(4).toString("hex"));
  const now = options.now || (() => new Date().toISOString());

  function listRules() {
    return readRules(filePath);
  }

  function addRule(rule) {
    if (!rule || typeof rule !== "object") {
      throw new Error("rule is required");
    }
    if (!PHASES.includes(rule.phase)) {
      throw new Error('phase must be "pre" or "post"');
    }
    const allowedActions = ACTIONS_BY_PHASE[rule.phase];
    if (!allowedActions.includes(rule.action)) {
      throw new Error(`action for phase "${rule.phase}" must be one of: ${allowedActions.join(", ")}`);
    }
    const toolName = String(rule.toolName || "").trim();
    if (!toolName) {
      throw new Error("toolName is required");
    }
    if (rule.action === "run-command" && !String(rule.command || "").trim()) {
      throw new Error("command is required for a run-command rule");
    }

    const entry = {
      id: makeId(),
      phase: rule.phase,
      action: rule.action,
      toolName,
      createdAt: now(),
    };
    if (rule.pathContains) entry.pathContains = String(rule.pathContains);
    if (rule.command) entry.command = String(rule.command);
    // Each element is passed to child_process.execFile as its own argv
    // entry (shell: false) -- see runPostCommandHook below. The literal
    // string "{path}" is substituted with the real call's args.path at run
    // time; nothing here is ever concatenated into a shell string.
    if (Array.isArray(rule.args)) entry.args = rule.args.map(String);
    if (rule.reason) entry.reason = String(rule.reason);

    const rules = listRules();
    rules.push(entry);
    writeRules(filePath, rules);
    return entry;
  }

  function removeRule(id) {
    const rules = listRules();
    const next = rules.filter((r) => r.id !== id);
    if (next.length === rules.length) return false;
    writeRules(filePath, next);
    return true;
  }

  // Every persisted rule whose phase/toolName/pathContains all match. Two
  // rules matching the same call is expected, not an error -- wrapWithHooks
  // below decides precedence (deny wins on the pre phase; every matching
  // post rule runs).
  function matchRules(toolName, phase, args) {
    return listRules().filter(
      (rule) => rule.phase === phase && ruleMatchesTool(rule, toolName) && ruleMatchesPath(rule, args),
    );
  }

  return { dataDir, listRules, addRule, removeRule, matchRules };
}

// Runs a post-hook's command with execFile (shell: false) -- args are
// passed as a real argv array, never string-concatenated into a shell
// command line, so a tool-call argument the hook substitutes in (a file
// path from `args.path`) can't break out into a second command even if it
// contains shell metacharacters. Fire-and-forget: never blocks or fails the
// tool call it ran after; a failing hook command is logged and swallowed,
// same convention as snapshot-store.js/acp-memory-store.js's
// catch-and-console.warn on best-effort side work.
function runPostCommandHook(rule, args, execFileFn) {
  const resolvedPath = String((args && args.path) || "");
  const cmdArgs = (rule.args || []).map((a) => (a === "{path}" ? resolvedPath : a));
  execFileFn(rule.command, cmdArgs, { timeout: HOOK_COMMAND_TIMEOUT_MS, shell: false }, (err) => {
    if (err) {
      console.warn(`hook run-command "${rule.command}" failed:`, err.message || err);
    }
  });
}

// Wraps any {tools, isKnownTool, executeTool}-shaped tool policy so every
// executeTool() call is checked against the user's own hook rules first.
// Deliberately applied *inside* wrapWithToolCallLog in server.js (a hook's
// deny/ask decision is itself an audited event), not after it -- see
// server.js's own comment at the call site.
//
// "ask" rules reuse the existing approval gate rather than inventing a
// parallel mechanism -- registers a "hook-ask" executor at construction
// time, same pattern ai/skill-tool-source.js uses for "skill-run".
// Re-registering on every call (this runs once per reply, like
// createSkillToolSource does) just overwrites the previous closure in the
// gate's executor map with the latest `policy`; a "hook-ask" request
// approved asynchronously later always runs against whichever policy was
// most recently wired in, the same pre-existing tradeoff "skill-run" already
// has for a genuinely concurrent request.
function wrapWithHooks(policy, hooksStore, approvalGate, options = {}) {
  const execFileFn = options.execFile || execFile;
  approvalGate.registerExecutor("hook-ask", ({ name, args }) => policy.executeTool(name, args));

  return {
    tools: policy.tools,
    isKnownTool: policy.isKnownTool,
    executeTool: async (name, args) => {
      const preRules = hooksStore.matchRules(name, "pre", args);

      // Deny short-circuits before the base policy's executeTool ever runs
      // -- no side effect happens. Checked ahead of "ask": a call both
      // denied and ask-gated by two different rules should never prompt a
      // human to approve something the config also says to block outright.
      const denyRule = preRules.find((rule) => rule.action === "deny");
      if (denyRule) {
        throw new Error(denyRule.reason || `blocked by hook rule for "${name}"`);
      }

      const askRule = preRules.find((rule) => rule.action === "ask");
      if (askRule) {
        const outcome = await approvalGate.requestApproval("hook-ask", {
          summary: askRule.reason || `Hook rule asks before calling "${name}"`,
          payload: { name, args },
        });
        // Matches ai/skill-tool-source.js's own ask-gated return shape: the
        // approval outcome itself is the tool result the model sees
        // (pending/approved/blocked), not a bare pass-through of the real
        // call's result. Post-hooks intentionally do not fire on this path
        // -- a "pending" outcome has no real result yet to run a post-hook
        // against, and an immediately-approved one (already-trusted) is
        // simple enough to leave for a later pass if it's ever needed.
        return JSON.stringify(outcome);
      }

      const result = await policy.executeTool(name, args);

      const postRules = hooksStore.matchRules(name, "post", args);
      for (const rule of postRules) {
        if (rule.action === "run-command") {
          runPostCommandHook(rule, args, execFileFn);
        }
      }

      return result;
    },
  };
}

module.exports = { createHooksStore, wrapWithHooks, runPostCommandHook, HOOK_COMMAND_TIMEOUT_MS };

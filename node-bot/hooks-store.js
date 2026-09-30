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
// #486 adds a fourth, "pre"/"modify-input" (see wrapWithInputHooks below).
//
// Persistence: one JSON array file, atomic tmp+rename write, dataDir
// injectable for tests -- same shape as plugin-settings-store.js.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const DEFAULT_DATA_DIR = path.join(__dirname, "data", "hooks");
// #838 decision 6: "finish" runs when Pipeline B's loop sends finish.
const PHASES = ["pre", "post", "finish"];
// #426 sub-project 4: "rollback-on-failure" is run-command's sibling -- same
// shape (a command that runs after a matching call succeeds), but on
// failure it also restores the file's pre-write snapshot instead of only
// logging. Requires the same `command`/`args` fields as run-command.
// #486: "modify-input" shallow-merges the rule's `set` object over the
// call's args (see wrapWithInputHooks).
const ACTIONS_BY_PHASE = {
  pre: ["deny", "ask", "modify-input"],
  post: ["run-command", "rollback-on-failure"],
  finish: ["run-command"],
};
// Fire-and-forget post-hook commands still need a ceiling -- an unbounded
// prettier/lint command hanging forever would leak a child process per
// write forever.
const HOOK_COMMAND_TIMEOUT_MS = 15000;
// A finish check is typically the test suite and is awaited, so it gets the
// ACP test runner's default instead (MANA_AGENT_TEST_TIMEOUT_MS's 120 s).
const FINISH_HOOK_TIMEOUT_MS = 120000;
// The tail of a finish check's output that goes back to the ACP client.
const FINISH_HOOK_OUTPUT_CHARS = 2000;

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

// #838 decision 2: one rule covers both pipelines' write tools.
const WRITE_TOOLS = ["file_write", "coding__propose_edit"];

// toolName matches exactly, or as a "prefix*" glob -- e.g. "skill__*"
// matches every skill tool. "*" (or an unset toolName) matches anything.
// "write" matches every tool in WRITE_TOOLS.
function ruleMatchesTool(rule, toolName) {
  if (!rule.toolName || rule.toolName === "*") return true;
  if (rule.toolName === "write") return WRITE_TOOLS.includes(toolName);
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

// Validates a rule's user-editable fields and returns only those, normalized
// -- shared by addRule and updateRule so an edit can never store a rule that
// adding it would have rejected.
function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") {
    throw new Error("rule is required");
  }
  if (!PHASES.includes(rule.phase)) {
    throw new Error('phase must be "pre", "post" or "finish"');
  }
  const allowedActions = ACTIONS_BY_PHASE[rule.phase];
  if (!allowedActions.includes(rule.action)) {
    throw new Error(`action for phase "${rule.phase}" must be one of: ${allowedActions.join(", ")}`);
  }
  // A finish rule isn't about a tool call; it matches the finish signal.
  const toolName = String(rule.toolName || (rule.phase === "finish" ? "finish" : "")).trim();
  if (!toolName) {
    throw new Error("toolName is required");
  }
  if ((rule.action === "run-command" || rule.action === "rollback-on-failure") && !String(rule.command || "").trim()) {
    throw new Error(`command is required for a ${rule.action} rule`);
  }
  const isArgsObject = rule.set && typeof rule.set === "object" && !Array.isArray(rule.set);
  if (rule.action === "modify-input" && !(isArgsObject && Object.keys(rule.set).length)) {
    throw new Error("set (an object of argument values) is required for a modify-input rule");
  }
  // #838: Pipeline B's file_write skips its approval on args.approved ===
  // true, so a rewrite must never be able to set it.
  if (rule.action === "modify-input" && Object.prototype.hasOwnProperty.call(rule.set, "approved")) {
    throw new Error("a modify-input rule may not set approved");
  }

  const entry = { phase: rule.phase, action: rule.action, toolName };
  if (rule.pathContains) entry.pathContains = String(rule.pathContains);
  if (rule.command) entry.command = String(rule.command);
  // Each element is passed to child_process.execFile as its own argv
  // entry (shell: false) -- see runPostCommandHook below. The literal
  // string "{path}" is substituted with the real call's args.path at run
  // time; nothing here is ever concatenated into a shell string.
  if (Array.isArray(rule.args)) entry.args = rule.args.map(String);
  if (rule.action === "modify-input") entry.set = { ...rule.set };
  if (rule.reason) entry.reason = String(rule.reason);
  return entry;
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

  // #838 decision 5: why hooks.json can't be used -- it exists but won't
  // parse, or isn't an array -- else null. listRules still reads such a file
  // as "no rules" (Pipeline A); Pipeline B refuses side effects instead.
  function configError() {
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) return null;
      return Array.isArray(JSON.parse(raw)) ? null : "hooks.json is not a list of rules";
    } catch (e) {
      return `hooks.json is unreadable: ${e.message}`;
    }
  }

  function addRule(rule) {
    const entry = {
      id: makeId(),
      ...normalizeRule(rule),
      createdAt: now(),
      // Lets a rule be paused for iteration (tuning a pathContains pattern,
      // testing a command) without losing its id or lastRun history the way
      // delete-and-re-add would.
      enabled: rule.enabled === false ? false : true,
    };

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

  function findRuleIndex(rules, id) {
    return rules.findIndex((r) => r.id === id);
  }

  // Pause/resume without losing the rule's id, command, or lastRun history
  // -- the destructive-only removeRule forced a delete-and-re-add for what
  // is usually just "stop this one while I fix the pattern."
  function setRuleEnabled(id, enabled) {
    const rules = listRules();
    const idx = findRuleIndex(rules, id);
    if (idx === -1) return null;
    rules[idx] = { ...rules[idx], enabled: Boolean(enabled) };
    writeRules(filePath, rules);
    return rules[idx];
  }

  // #486: edit a rule in place (keeps its id, createdAt and position, so
  // modify-input ordering is stable). The patch is merged over the stored
  // rule and re-validated exactly like addRule; lastRun is dropped because
  // it described the rule's previous command.
  function updateRule(id, patch) {
    const rules = listRules();
    const idx = findRuleIndex(rules, id);
    if (idx === -1) return null;
    const current = rules[idx];
    rules[idx] = {
      id: current.id,
      ...normalizeRule({ ...current, ...patch }),
      createdAt: current.createdAt,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled !== false,
    };
    writeRules(filePath, rules);
    return rules[idx];
  }

  // Best-effort: a run-command/rollback-on-failure outcome is fire-and-forget
  // by design (see runPostCommandHook), so this is purely for visibility --
  // a write failure here must never surface as a hook failure itself.
  function recordRunOutcome(id, { ok, error } = {}) {
    try {
      const rules = listRules();
      const idx = findRuleIndex(rules, id);
      if (idx === -1) return;
      rules[idx] = {
        ...rules[idx],
        lastRun: { at: now(), ok: Boolean(ok), error: ok ? undefined : String(error || "") },
      };
      writeRules(filePath, rules);
    } catch (e) {
      console.warn("hooks-store: recording run outcome failed:", e?.message || e);
    }
  }

  // Every persisted, enabled rule whose phase/toolName/pathContains all
  // match. Two rules matching the same call is expected, not an error --
  // wrapWithHooks below decides precedence (deny wins on the pre phase;
  // every matching post rule runs).
  function matchRules(toolName, phase, args) {
    return listRules().filter(
      (rule) =>
        rule.enabled !== false &&
        rule.phase === phase &&
        ruleMatchesTool(rule, toolName) &&
        ruleMatchesPath(rule, args),
    );
  }

  return { dataDir, listRules, configError, addRule, removeRule, setRuleEnabled, updateRule, recordRunOutcome, matchRules };
}

// #426 sub-project 4, fixed in #838: restores only the snapshot the call
// itself recorded (hooks.snapshotId). The old newest-snapshot-with-the-same-
// basename search could restore an unrelated older file whenever the call
// took no snapshot (an append, a new file, a proposal not yet applied).
function rollbackSnapshot(snapshotStore, snapshotId, label) {
  Promise.resolve()
    .then(() => snapshotStore.restoreSnapshot(snapshotId, { confirmStale: true }))
    .catch((e) => console.warn(`hook rollback for "${label}" failed:`, e?.message || e));
}

// Runs a post-hook's command with execFile (shell: false) -- args are
// passed as a real argv array, never string-concatenated into a shell
// command line, so a tool-call argument the hook substitutes in (a file
// path from `args.path`) can't break out into a second command even if it
// contains shell metacharacters. Fire-and-forget: never blocks or fails the
// tool call it ran after; a failing hook command is logged and swallowed,
// same convention as snapshot-store.js/acp-memory-store.js's
// catch-and-console.warn on best-effort side work. hooks.hooksStore (if
// given) records the outcome for later visibility; a "rollback-on-failure"
// rule restores hooks.snapshotId from hooks.snapshotStore on failure.
// hooks.cwd: Pipeline B's paths are repo-relative, so it runs from there.
function runPostCommandHook(rule, args, execFileFn, hooks = {}) {
  const resolvedPath = String((args && args.path) || "");
  const cmdArgs = (rule.args || []).map((a) => (a === "{path}" ? resolvedPath : a));
  const options = { timeout: HOOK_COMMAND_TIMEOUT_MS, shell: false, ...(hooks.cwd ? { cwd: hooks.cwd } : {}) };
  execFileFn(rule.command, cmdArgs, options, (err) => {
    if (err) {
      console.warn(`hook ${rule.action} "${rule.command}" failed:`, err.message || err);
    }
    if (hooks.hooksStore) {
      hooks.hooksStore.recordRunOutcome(rule.id, { ok: !err, error: err && (err.message || String(err)) });
    }
    if (err && rule.action === "rollback-on-failure") {
      if (hooks.snapshotStore && hooks.snapshotId) {
        rollbackSnapshot(hooks.snapshotStore, hooks.snapshotId, resolvedPath);
      } else {
        console.warn(`hook rollback for "${resolvedPath}": the call took no snapshot, nothing to roll back`);
      }
    }
  });
}

// The snapshot id a tool reports in its (JSON) result, if any.
function snapshotIdOf(result) {
  try {
    return JSON.parse(result)?.snapshotId || null;
  } catch {
    return null;
  }
}

// #838 decision 6: runs a finish rule's command and resolves with what the
// ACP client is told -- never rejects. Same argv-only execFile as the post
// hooks, but awaited, because the result is the point.
function runFinishCommand(rule, execFileFn, hooks = {}) {
  return new Promise((resolve) => {
    // maxBuffer: a verbose test run can print more than execFile's 1 MB
    // default, which would kill it and misreport a pass as a failure.
    const options = {
      timeout: FINISH_HOOK_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      ...(hooks.cwd ? { cwd: hooks.cwd } : {}),
    };
    execFileFn(rule.command, (rule.args || []).map(String), options, (err, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}${err && !stdout && !stderr ? err.message || String(err) : ""}`;
      if (hooks.hooksStore) {
        hooks.hooksStore.recordRunOutcome(rule.id, { ok: !err, error: err && (err.message || String(err)) });
      }
      resolve({
        rule: rule.id,
        command: [rule.command, ...(rule.args || [])].join(" "),
        ok: !err,
        exitCode: err ? (typeof err.code === "number" ? err.code : null) : 0,
        output: output.slice(-FINISH_HOOK_OUTPUT_CHARS),
      });
    });
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
  // #426 sub-project 4: optional -- a "rollback-on-failure" rule is a no-op
  // (behaves exactly like run-command) when no snapshotStore is wired in.
  const snapshotStore = options.snapshotStore || null;
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
        if (rule.action === "run-command" || rule.action === "rollback-on-failure") {
          runPostCommandHook(rule, args, execFileFn, { hooksStore, snapshotStore, snapshotId: snapshotIdOf(result) });
        }
      }

      return result;
    },
  };
}

// #486: applies "modify-input" rules. server.js wraps this *outside* the
// risk gate (#669), wrapWithHooks and the audit log, so every one of them
// sees -- and gates, and logs -- the rewritten call, never the original: a
// rewrite can't slip a call past the approval gate. Matching rules apply in
// file order, each shallow-merging its `set` over the args so far (same
// ordered-chain idea as #677's plugin input hooks, minus the timeout: a
// static merge can't hang). Non-object args (a model's malformed call) pass
// through untouched rather than being spread into index keys.
function wrapWithInputHooks(policy, hooksStore) {
  return {
    tools: policy.tools,
    isKnownTool: policy.isKnownTool,
    executeTool: async (name, args) =>
      policy.executeTool(name, applyInputRules(hooksStore.matchRules(name, "pre", args), name, args)),
  };
}

// The modify-input merge itself, shared with Pipeline B
// (acp-autonomous-loop.js, #838): every modify-input rule among `rules`, in
// order, shallow-merged over args. Logs key names only, never values.
function applyInputRules(rules, name, args) {
  if (args != null && (typeof args !== "object" || Array.isArray(args))) return args;
  let next = args;
  for (const rule of rules) {
    if (rule.action !== "modify-input") continue;
    next = { ...next, ...rule.set };
    console.log(`[hooks] modify-input rule ${rule.id} set ${Object.keys(rule.set).join(", ")} on ${name}`);
  }
  return next;
}

module.exports = {
  createHooksStore,
  wrapWithHooks,
  wrapWithInputHooks,
  applyInputRules,
  runPostCommandHook,
  runFinishCommand,
  HOOK_COMMAND_TIMEOUT_MS,
};

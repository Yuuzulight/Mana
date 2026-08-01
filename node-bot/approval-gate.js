// Issue #152: a shared approval primitive for agent-*authored* content --
// a skill file (#140), a generated script (#142) -- so it surfaces for a
// quick approve/deny before it's trusted, rather than landing silently.
// Deliberately not a general command-level approval for every tool call
// Mana already makes (web search, memory reads, etc.) -- see the issue's
// "out of scope" section -- just the write path for content she authored
// herself.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createToolCallLog } = require("./tool-call-log");

const DEFAULT_DATA_DIR = path.join(__dirname, "data", "approval-gate");

// Simple keyword/pattern heuristics, off by default (issue #152's optional
// content scan) -- flags a pending request for the human approver's
// attention, never auto-denies. A real static analyzer is out of scope for
// a "lightweight" gate; this is a tripwire, not a sandbox.
const SCAN_PATTERNS = [
  { flag: "shell-execution", pattern: /\b(child_process|exec\(|execSync|spawn\()/ },
  { flag: "filesystem-write", pattern: /\b(fs\.(writeFile|unlink|rmdir|rm)\w*|rm\s+-rf)\b/ },
  { flag: "remote-code-fetch", pattern: /\b(curl|wget)\b.*\|\s*(sh|bash)/ },
  { flag: "credential-like-string", pattern: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i },
];

function scanContent(text) {
  const value = String(text || "");
  return SCAN_PATTERNS.filter(({ pattern }) => pattern.test(value)).map((p) => p.flag);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

// options.dataDir: injectable so tests never write into node-bot's real
// data directory (same pattern as acp-memory-store.js/cron-scheduler.js).
// options.contentScanEnabled: off by default, per the issue.
// options.guardianEnabled/guardianPreCheck (issue #284): off by default,
// same convention as contentScanEnabled. guardianPreCheck is an injected
// async (actionType, {summary, payload, scanText}) => {safe, reason} --
// server.js wires the real model-judged one (ai/guardian-precheck.js),
// tests inject a fake. options.guardianAuditLog: injectable
// tool-call-log.js instance so tests never write into the real data dir;
// defaults to its own file under dataDir.
function createApprovalGate(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const alwaysAllowPath = path.join(dataDir, "always-allow.json");
  const now = options.now || (() => new Date().toISOString());
  const makeId = options.makeId || (() => crypto.randomBytes(4).toString("hex"));
  const contentScanEnabled = Boolean(options.contentScanEnabled);
  const guardianEnabled = Boolean(options.guardianEnabled);
  const guardianPreCheck =
    typeof options.guardianPreCheck === "function" ? options.guardianPreCheck : null;
  const guardianAuditLog =
    options.guardianAuditLog ||
    createToolCallLog({ logPath: path.join(dataDir, "guardian-audit.jsonl"), now });

  // Executors are registered once per actionType at wiring time (server.js),
  // not stored per-request -- a pending request only needs to remember its
  // plain-JSON-serializable payload, not a closure.
  const executors = new Map();
  // Pending requests are intentionally in-memory only: they represent a
  // live "waiting on a human right now" state, not a durable queue that
  // should survive a server restart.
  const pending = new Map();

  function registerExecutor(actionType, fn) {
    executors.set(actionType, fn);
  }

  function loadAlwaysAllowed() {
    return readJson(alwaysAllowPath, []);
  }

  function isAlwaysAllowed(actionType) {
    return loadAlwaysAllowed().includes(actionType);
  }

  function persistAlwaysAllow(actionType) {
    const list = loadAlwaysAllowed();
    if (!list.includes(actionType)) {
      list.push(actionType);
      writeJson(alwaysAllowPath, list);
    }
  }

  async function runExecutor(actionType, payload) {
    const fn = executors.get(actionType);
    if (typeof fn !== "function") {
      throw new Error(`no executor registered for action type: ${actionType}`);
    }
    return fn(payload);
  }

  // The entry point every gated write goes through. Already-trusted action
  // types execute immediately; everything else pauses as a pending request
  // until a human decides.
  async function requestApproval(actionType, { summary, payload, scanText } = {}) {
    if (!actionType) throw new Error("actionType is required");

    if (isAlwaysAllowed(actionType)) {
      const result = await runExecutor(actionType, payload);
      return { status: "approved", actionType, result };
    }

    const flags = contentScanEnabled ? scanContent(scanText ?? JSON.stringify(payload)) : [];

    // Issue #284: Guardian pre-check. Deliberately skipped when the
    // deterministic content scan already flagged something -- that scan
    // exists specifically to catch shell-exec/filesystem-write/credential
    // patterns, and a model's own risk judgment shouldn't be able to
    // override a hit on those. Any Guardian failure (exception, unclear
    // verdict) falls straight through to the normal pending path below.
    if (guardianEnabled && guardianPreCheck && !flags.length) {
      let verdict = null;
      try {
        verdict = await guardianPreCheck(actionType, { summary, payload, scanText });
      } catch (e) {
        // fall through to the human queue -- a Guardian failure must never
        // block the request or silently auto-approve it
        verdict = null;
      }
      if (verdict && verdict.safe) {
        // Not caught here, deliberately -- if the executor itself throws,
        // that's a real failure that should propagate exactly like it
        // already does on the isAlwaysAllowed path above, rather than
        // silently falling to the pending queue and risking the executor
        // running a second time once a human later approves it.
        const result = await runExecutor(actionType, payload);
        guardianAuditLog.append({
          name: actionType,
          args: payload,
          ok: true,
          guardianCleared: true,
          summary: summary || "",
        });
        return { status: "approved", actionType, result, guardianCleared: true };
      }
    }

    const id = makeId();
    pending.set(id, { id, actionType, summary: summary || "", payload, flags, createdAt: now() });
    return { status: "pending", requestId: id, summary: summary || "", flags };
  }

  function listPending() {
    return [...pending.values()];
  }

  // decision: "allow-once" | "always-allow" | "deny"
  async function decide(requestId, decision) {
    const entry = pending.get(requestId);
    if (!entry) return null;

    if (decision === "deny") {
      pending.delete(requestId);
      return { status: "denied", requestId, actionType: entry.actionType };
    }
    if (decision === "always-allow") {
      persistAlwaysAllow(entry.actionType);
    } else if (decision !== "allow-once") {
      throw new Error(`unknown decision: ${decision}`);
    }

    // Only removed from `pending` once the executor actually succeeds --
    // if it throws, the entry stays retrievable instead of being silently
    // lost (a thrown skill-write executor would otherwise strand the
    // approved request nowhere: not pending, not written).
    const result = await runExecutor(entry.actionType, entry.payload);
    pending.delete(requestId);
    return { status: "approved", requestId, actionType: entry.actionType, result };
  }

  return {
    registerExecutor,
    requestApproval,
    listPending,
    decide,
    isAlwaysAllowed,
    guardianAuditLog,
  };
}

module.exports = { createApprovalGate, scanContent };

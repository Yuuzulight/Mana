// #1000: Mana's own guardrails. Her coding agent (Pipeline B's file_write,
// goal mode's coding__propose_edit) refuses to write these in any Mana
// checkout -- the live one or a worktree -- even with approvals on or
// auto-approved. Changing them takes a flagged PR I approve myself.
const fs = require("node:fs");
const path = require("node:path");

// Paths relative to the checkout root; a trailing "/" covers a folder.
const PROTECTED_PATHS = [
  // Approval gate, hooks, tool risk tiers and review.
  "node-bot/approval-gate.js",
  "node-bot/capabilities/approval-gate-capability.js",
  "node-bot/hooks-store.js",
  "node-bot/capabilities/hooks-capability.js",
  "node-bot/ai/tool-risk.js",
  "node-bot/ai/tool-policy.js",
  "node-bot/ai/guardian-precheck.js",
  "node-bot/ai/adversarial-verifier.js",
  "node-bot/ai/tool-context-guard.js",
  // Pipeline B's own guards.
  "node-bot/acp-autonomous-loop.js",
  "node-bot/acp-path-guard.js",
  "node-bot/acp-test-runner.js",
  "node-bot/workspace-scratch-copy.js",
  // Her self-work runner's own checks (#1006).
  "node-bot/self-work.js",
  // Local-only mode, the admin key, auth and secrets.
  "node-bot/local-only.js",
  "node-bot/admin-key.js",
  "node-bot/request-guard.js",
  "node-bot/request-validation.js",
  "node-bot/auth-store.js",
  "node-bot/mobile-auth.js",
  "node-bot/totp.js",
  "node-bot/dpapi.js",
  "node-bot/load-env.js",
  "node-bot/osv-malware-check.js",
  "windows-native-launcher/ManaProcessManager.cs",
  "windows-native-launcher/ManaSettingsStore.cs",
  // Memory safety and redaction, and the audit trail.
  "node-bot/utils/sensitive-text.js",
  "node-bot/bridge-output-sanitizer.js",
  "node-bot/utils/reply-verifier.js",
  "node-bot/tool-call-log.js",
  "node-bot/snapshot-store.js",
  // Her data (hooks.json, approvals, memory), CI, git, and this list.
  "node-bot/data/",
  ".github/",
  ".git/",
  "node-bot/protected-paths.js",
];

// Windows drops trailing dots and spaces from each name, matches case
// insensitively, and a link or 8.3 short name can reach the same file:
// compare the path the OS would actually open.
function canonical(fullPath) {
  const parts = path.resolve(fullPath).split(/[\\/]+/).map((p, i) => (i === 0 ? p : p.replace(/[.\s]+$/, "")));
  let existing = parts.join(path.sep);
  const rest = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try {
    existing = fs.realpathSync.native(existing);
  } catch {
    // Keep it as written.
  }
  const full = path.join(existing, ...rest);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

// The Mana checkout holding this path, or null.
function manaRootOf(fullPath) {
  for (let dir = path.dirname(fullPath); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "node-bot", "server.js")) && fs.existsSync(path.join(dir, "windows-native-launcher"))) {
      return dir;
    }
  }
  return null;
}

// The protected entry a write to fullPath would touch, or null.
function protectedPathFor(fullPath) {
  const target = canonical(fullPath);
  const root = manaRootOf(target);
  if (!root) return null;
  const relative = path.relative(root, target).split(path.sep).join("/");
  const key = process.platform === "win32" ? (p) => p.toLowerCase() : (p) => p;
  return (
    PROTECTED_PATHS.find((entry) =>
      entry.endsWith("/") ? `${key(relative)}/`.startsWith(key(entry)) : key(relative) === key(entry),
    ) || null
  );
}

function protectedPathMessage(entry) {
  return `${entry} is one of my guardrails, so I won't change it myself. It takes a flagged PR that Yuuzulight approves.`;
}

module.exports = { PROTECTED_PATHS, canonical, protectedPathFor, protectedPathMessage };

// #1000: Mana's coding agent won't write her own guardrails.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { protectedPathFor } = require("../protected-paths");

// A throwaway checkout: node-bot/server.js plus windows-native-launcher/ is
// what marks a folder as a Mana checkout (the live one or a worktree).
function fakeCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-protected-"));
  fs.mkdirSync(path.join(root, "node-bot", "ai"), { recursive: true });
  fs.mkdirSync(path.join(root, "windows-native-launcher"));
  fs.writeFileSync(path.join(root, "node-bot", "server.js"), "");
  fs.writeFileSync(path.join(root, "node-bot", "approval-gate.js"), "");
  return root;
}

test("#1000 guardrail files and folders are protected in any Mana checkout", () => {
  const root = fakeCheckout();
  try {
    assert.equal(protectedPathFor(path.join(root, "node-bot", "approval-gate.js")), "node-bot/approval-gate.js");
    assert.equal(protectedPathFor(path.join(root, "node-bot", "ai", "tool-risk.js")), "node-bot/ai/tool-risk.js");
    assert.equal(protectedPathFor(path.join(root, "node-bot", "data", "hooks", "hooks.json")), "node-bot/data/");
    assert.equal(protectedPathFor(path.join(root, ".github", "workflows", "ci.yml")), ".github/");
    assert.equal(protectedPathFor(path.join(root, "node-bot", "protected-paths.js")), "node-bot/protected-paths.js");
    assert.equal(protectedPathFor(path.join(root, "node-bot", "proactive.js")), null);
    assert.equal(protectedPathFor(path.join(root, "node-bot", "data-export.js")), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1000 the name Windows would really open is what counts", { skip: process.platform !== "win32" }, () => {
  const root = fakeCheckout();
  try {
    assert.equal(protectedPathFor(path.join(root, "NODE-BOT", "Approval-Gate.JS")), "node-bot/approval-gate.js");
    assert.equal(protectedPathFor(path.join(root, "node-bot", "approval-gate.js. ")), "node-bot/approval-gate.js");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1000 a folder that isn't a Mana checkout is left alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-mana-"));
  try {
    assert.equal(protectedPathFor(path.join(root, "node-bot", "approval-gate.js")), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

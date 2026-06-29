const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("zed agent registry metadata is valid and local-first", () => {
  const manifestPath = path.join(__dirname, "..", "..", "zed-agent", "mana-agent.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.id, "mana");
  assert.equal(manifest.name, "Mana");
  assert.equal(manifest.command, "node");
  assert.deepEqual(manifest.args, ["node-bot/mana-acp-agent.js", "--acp"]);
  assert.equal(manifest.env.MANA_ALLOW_REMOTE_AI, "0");
  assert.equal(manifest.env.MANA_DEFAULT_EDITOR, "zed");
  assert.equal(manifest.env.MANA_AGENT_AUTONOMOUS, "0");
  assert.equal(manifest.capabilities.autonomous, true);
  assert.equal(manifest.capabilities.approvalRequiredWrites, true);
});

// #1383: her self-inventory -- why something is unavailable, approvals
// described not granted, no credentials, fresh on every call, bounded.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-inventory-"));

const { NAME, MAX_CHARS, buildInventory, createInventoryToolSource } = require("../ai/capability-inventory");

const tool = (name, description = "") => ({ type: "function", function: { name, description } });

test("off and unhealthy plugins say why; healthy ones don't; credentials never appear", () => {
  const inv = buildInventory({
    capabilities: [
      { key: "browser", name: "Browser", getHealth() {} },
      { key: "mail", name: "Email", getHealth() {} },
      { key: "music", name: "Music", getHealth() {} },
      { key: "notes", name: "Notes", getHealth() {} },
    ],
    isEnabled: (c) => c.key !== "browser",
    health: { mail: { status: "unconfigured", message: "Sign in to Gmail in Settings > Accounts" }, music: { status: "configured", message: "ok" } },
    modelStatus: { activeProfile: "default", localOnly: false, brain: { apiKey: "sk-secret-123", hasApiKey: true }, cloudFallbackEnabled: true },
  });
  const by = Object.fromEntries(inv.plugins.map((p) => [p.key, p]));
  assert.deepEqual([by.browser.status, by.browser.why], ["off", "turned off in Settings > Plugins"]);
  assert.equal(by.mail.why, "Sign in to Gmail in Settings > Accounts");
  assert.equal(by.music.why, undefined);
  // A health check that hasn't reported is unknown, not healthy.
  assert.equal(by.notes.status, "unknown");
  assert.doesNotMatch(JSON.stringify(inv), /sk-secret|apiKey|hasApiKey/);
  assert.match(inv.models.cost, /may cost money/);
  assert.match(inv.note, /isn't permission/);
});

test("approval is described from the risk gate's tiers and the mode, not granted", () => {
  const tools = [tool("read_file"), tool("notes__save"), tool("git__push"), tool("exec_shell_command")];
  const smart = Object.fromEntries(buildInventory({ tools, approvalMode: "smart" }).tools.map((t) => [t.name, t.approval]));
  assert.deepEqual(smart, {
    read_file: "runs without asking",
    notes__save: "asks first",
    git__push: "asks for itself when it needs to",
    exec_shell_command: "depends on the command",
  });
  // A permission change shows up as soon as the mode does.
  const off = buildInventory({ tools, approvalMode: "off" }).tools.find((t) => t.name === "notes__save");
  assert.equal(off.approval, "runs without asking");
});

test("unknown costs and model status are said to be unknown", () => {
  const inv = buildInventory({});
  assert.deepEqual(inv.models, { status: "not reported", cost: "unknown" });
  assert.equal(buildInventory({ modelStatus: { localOnly: true } }).models.cost, "local only: no paid calls");
});

test("`about` narrows it, and it stays within its size however much there is", () => {
  const tools = Array.from({ length: 400 }, (_, i) => tool(`plugin_${i}__do_something`, "A long description of what this tool does. ".repeat(4)));
  const big = buildInventory({ tools: [...tools, tool("calendar__events", "Read my calendar")] });
  assert.ok(JSON.stringify(big).length <= MAX_CHARS);
  assert.ok(big.leftOut.tools > 0);
  const narrow = buildInventory({ tools: [...tools, tool("calendar__events", "Read my calendar")], about: "calendar" });
  assert.deepEqual(narrow.tools.map((t) => t.name), ["calendar__events"]);
  assert.equal(narrow.leftOut, undefined);
});

test("the tool reads everything again on each call, so health and settings are never stale", async () => {
  let enabled = true;
  let health = { browser: { status: "configured" } };
  const source = createInventoryToolSource({
    tools: () => [tool(NAME)],
    capabilities: () => [{ key: "browser", getHealth() {} }],
    health: () => health,
    isEnabled: () => enabled,
    mcpServers: () => [{ name: "notes", transport: { kind: "stdio", command: "notes.exe", env: { TOKEN: "x" } }, allowedTools: ["search"] }],
    modelStatus: () => null,
    approvalMode: () => "smart",
  });
  const first = JSON.parse(await source.executeTool(NAME, {}));
  assert.equal(first.plugins[0].status, "configured");
  assert.deepEqual(first.mcpServers, [{ name: "notes", transport: "stdio", tools: 1, health: "not tracked" }]);
  enabled = false;
  health = {};
  const second = JSON.parse(await source.executeTool(NAME, {}));
  assert.equal(second.plugins[0].status, "off");
  assert.doesNotMatch(JSON.stringify(second), /notes\.exe|TOKEN/);
});

test("in her reply path it lists the tools she really has this turn and runs without asking", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const { createApp } = require("../server");
    let result;
    let memory;
    let all;
    const app = createApp({
      env: { ...process.env, MANA_TOOL_APPROVAL: "smart" },
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy) => {
        result = JSON.parse(await toolPolicy.executeTool(NAME, { about: "inventory" }));
        memory = JSON.parse(await toolPolicy.executeTool(NAME, { about: "memory" }));
        all = JSON.parse(await toolPolicy.executeTool(NAME, {}));
        return { content: "ok", toolCalls: [], rounds: 2 };
      },
    });
    await app.locals.buildAssistantReply("what can you do?", "", "", "default", "inventory", null, null, {});
    assert.ok(result.tools.some((t) => t.name === NAME && t.approval === "runs without asking"));
    assert.ok(memory.tools.some((t) => t.name === "memory__remember"));
    // Everything at once stays within its size.
    assert.ok(JSON.stringify(all).length <= MAX_CHARS);
    assert.ok(all.plugins.length > 0 || all.leftOut?.plugins > 0);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});

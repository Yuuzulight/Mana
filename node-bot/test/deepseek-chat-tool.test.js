// #1406: DeepSeek for a coding request in my chat, only when I ask: Flash
// unless I say Pro, her coding tools through this turn's policy, its cost
// in API spending as chat, and nothing when it's off or local-only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createDeepSeekChatToolSource, NAME } = require("../ai/deepseek-chat-tool");
const { createApiSpending } = require("../api-spending");

const ON = { enabled: true, baseUrl: "https://api.deepseek.test", apiKey: "sk-test" };
const coding = [
  { type: "function", function: { name: "coding__read_file", parameters: {} } },
  { type: "function", function: { name: "coding__propose_edit", parameters: {} } },
];

function setup({ settings = ON, env = {} } = {}) {
  const loops = [];
  const policyCalls = [];
  const spending = createApiSpending({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-ds-chat-")), "s.json"), now: () => new Date("2026-10-07T12:00:00Z") });
  const runtime = {
    remoteToolReply: (config) => async (prompt, sub, opts) => {
      loops.push({ config, prompt, tools: sub.tools.map((t) => t.function.name), opts });
      config.onResponse({ usage: { prompt_tokens: 2000, prompt_cache_hit_tokens: 1500, prompt_cache_miss_tokens: 500, completion_tokens: 300 } });
      await sub.executeTool("coding__read_file", { path: "a.js" });
      await sub.executeTool("coding__propose_edit", { path: "a.js" });
      await assert.rejects(() => sub.executeTool("git__push", {}), /isn't one of the coding tools/);
      return { content: "I proposed one edit to a.js.", toolCalls: [{ name: "coding__read_file", ok: true }, { name: "coding__propose_edit", ok: true }] };
    },
  };
  const tool = createDeepSeekChatToolSource({
    settings: () => settings,
    runtime,
    spending,
    codingSchemas: () => coding,
    policy: () => ({ executeTool: async (name, args) => (policyCalls.push({ name, args }), "ok") }),
    env,
  });
  const ask = async (args) => JSON.parse(await tool.executeTool(NAME, args));
  return { tool, ask, loops, policyCalls, spending };
}

test("Flash by default, Pro when asked; her coding tools go through this turn's policy", async () => {
  const s = setup();
  assert.equal(s.tool.isKnownToolName(NAME), true);
  const out = await s.ask({ request: "Fix the off-by-one in a.js" });
  assert.equal(out.status, "ok");
  assert.equal(out.model, "DeepSeek Flash");
  assert.equal(out.proposals, 1);
  assert.match(out.cost, /2k in \(2k cached\)|2k in/);
  assert.match(out.cost, /off-peak$/);
  assert.equal(s.loops[0].config.model, "deepseek-flash");
  assert.equal(s.loops[0].config.apiKey, "sk-test");
  assert.deepEqual(s.loops[0].tools, ["coding__read_file", "coding__propose_edit"]);
  assert.deepEqual(s.policyCalls.map((c) => c.name), ["coding__read_file", "coding__propose_edit"]);
  assert.equal(s.spending.summary().today.byUse.chat.cacheMiss, 500);

  await s.ask({ request: "Same, but with Pro", model: "pro" });
  assert.equal(s.loops[1].config.model, "deepseek-v4-pro");
});

test("off, no key, local-only or an empty request: nothing is sent", async () => {
  for (const [opts, why] of [
    [{ settings: { ...ON, enabled: false } }, /switched off/],
    [{ settings: { ...ON, apiKey: "" } }, /no DeepSeek key/],
    [{ env: { MANA_LOCAL_ONLY: "1" } }, /local-only/],
  ]) {
    const s = setup(opts);
    const out = await s.ask({ request: "Fix it" });
    assert.equal(out.status, "unavailable");
    assert.match(out.reason, why);
    assert.equal(s.loops.length, 0);
  }
  assert.equal((await setup().ask({ request: "  " })).status, "error");
});

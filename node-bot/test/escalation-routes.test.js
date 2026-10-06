// #1406: Settings' routes for API spending and the DeepSeek escalation.
// The key goes in and never comes back out.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-escalation-routes-"));
process.env.MANA_MODEL_SETTINGS_DIR = dir;
process.env.MANA_ACP_MEMORY_DIR = dir;

const { createApp } = require("../server");
const { useTestAdminToken, withServer } = require("./helpers");
const { createApiSpending } = require("../api-spending");

test("escalation settings: off by default, the key is stored but never returned", async () => {
  const fetch = useTestAdminToken();
  const apiSpending = createApiSpending({ file: path.join(dir, "spending.json") });
  apiSpending.record({ model: "deepseek-flash", use: "chat", usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 2 } });
  await withServer(createApp({ apiSpending }), async (base) => {
    const before = await (await fetch(`${base}/self-work/escalation`)).json();
    assert.deepEqual([before.enabled, before.hasKey, before.baseUrl], [false, false, "https://api.deepseek.com"]);
    const post = (body) => fetch(`${base}/self-work/escalation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const saved = await (await post({ enabled: true, apiKey: "sk-secret-123" })).json();
    assert.deepEqual([saved.enabled, saved.hasKey], [true, true]);
    assert.doesNotMatch(JSON.stringify(saved), /sk-secret/);
    assert.doesNotMatch(JSON.stringify(await (await fetch(`${base}/self-work/escalation`)).json()), /sk-secret/);
    assert.equal((await post({ enabled: "yes" })).status, 400);
    const spending = await (await fetch(`${base}/api-spending`)).json();
    assert.equal(spending.total.requests, 1);
    assert.equal(spending.total.byUse.chat.cacheMiss, 10);
  });
});

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
  await withServer(createApp({ apiSpending, readBalance: async () => ({ currency: "USD", total: 4, granted: 0, toppedUp: 4, available: true }) }), async (base) => {
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
    assert.equal(spending.daily.length, 90);
    assert.equal(spending.balance.total, 4);
    assert.equal(spending.runway.low, false);
  });
});

// #1441: any added provider, with up to two models picked from its list.
test("escalation takes any added provider and its picked models; DeepSeek's two until then", async () => {
  const fetch = useTestAdminToken();
  await withServer(createApp({}), async (base) => {
    const post = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const view = await (await fetch(`${base}/self-work/escalation`)).json();
    assert.deepEqual(view.models, ["deepseek-flash", "deepseek-v4-pro"]);
    assert.ok(Array.isArray(view.stats));
    assert.equal((await post("/models/providers", { preset: "lmstudio", baseUrl: "http://127.0.0.1:1/v1" })).status, 200);
    const picked = await (await post("/self-work/escalation", { providerId: "lmstudio", models: ["qwen3-coder"] })).json();
    assert.deepEqual([picked.providerId, picked.preset, picked.models], ["lmstudio", "lmstudio", ["qwen3-coder"]]);
    const switched = await (await post("/self-work/escalation", { providerId: "deepseek-none" })).json();
    assert.match(switched.error, /isn't added/);
    assert.equal((await post("/self-work/escalation", { models: ["a", "b", "c"] })).status, 400);
    assert.equal((await post("/self-work/escalation", { models: "qwen" })).status, 400);
  });
});

test("prices routes: set, list, refuse a bad one, remove (#1441)", async () => {
  const fetch = useTestAdminToken();
  const apiSpending = createApiSpending({ file: path.join(dir, "prices-spending.json") });
  await withServer(createApp({ apiSpending }), async (base) => {
    const post = (body) => fetch(`${base}/api-spending/prices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const set = await (await post({ model: "qwen/qwen3-coder", in: 0.2, out: 0.8 })).json();
    assert.deepEqual(set.set["qwen/qwen3-coder"], { hit: 0.2, miss: 0.2, out: 0.8 });
    assert.deepEqual((await (await fetch(`${base}/api-spending/prices`)).json()).set, set.set);
    assert.equal((await post({ model: "qwen/qwen3-coder", in: "lots", out: 1 })).status, 400);
    assert.deepEqual((await (await post({ model: "qwen/qwen3-coder", remove: true })).json()).set, {});
  });
});

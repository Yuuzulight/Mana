const test = require("node:test");
const assert = require("node:assert/strict");
const { checkToolLoop } = require("../provider-check");

// A fake provider: its model list, which models chat, and whether it can
// call tools and stream.
function fakeProvider({ models = ["text-embedding-3", "babbage-002", "old-model", "good-model"], chats = ["good-model"], tools = true, stream = true } = {}) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers });
    if (url.endsWith("/models")) return json({ data: models.map((id) => ({ id })) });
    const body = JSON.parse(init.body);
    if (!chats.includes(body.model)) return json({ error: "not a chat model" }, 404);
    if (body.stream) {
      const lines = stream ? ["1", "2", "3"].map((n) => `data: ${JSON.stringify({ choices: [{ delta: { content: n } }] })}`).concat("data: [DONE]") : [];
      return { ok: true, status: 200, text: async () => lines.join("\n\n") };
    }
    if (body.tools) {
      const message = tools ? { tool_calls: [{ function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] } : { content: "It's sunny." };
      return json({ choices: [{ message }] });
    }
    return json({ choices: [{ message: { content: "ready" } }] });
  };
  return { fetchImpl, calls };
}

const conn = { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", preset: "openai" };

test("passes all three steps, skipping non-chat models and trying the next that chats", async () => {
  const { fetchImpl } = fakeProvider();
  const r = await checkToolLoop(conn, { fetchImpl });
  assert.deepEqual(r, { ok: true, model: "good-model", chat: true, tools: true, stream: true });
});

test("the model a use picked is checked as is, without reading the list", async () => {
  const { fetchImpl, calls } = fakeProvider({ chats: ["picked"] });
  const r = await checkToolLoop({ ...conn, model: "picked" }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(!calls.some((c) => c.url.endsWith("/models")));
});

test("a provider that chats but can't call tools or stream says so", async () => {
  const { fetchImpl } = fakeProvider({ tools: false, stream: false });
  const r = await checkToolLoop(conn, { fetchImpl });
  assert.equal(r.ok, false);
  assert.deepEqual([r.chat, r.tools, r.stream], [true, false, false]);
  assert.match(r.error, /^Tool call: it didn't call the tool/);
});

test("no model that chats: chat fails with the last model tried", async () => {
  const { fetchImpl } = fakeProvider({ chats: [] });
  const r = await checkToolLoop(conn, { fetchImpl });
  assert.deepEqual([r.ok, r.chat, r.model], [false, false, "good-model"]);
  assert.match(r.error, /^Chat: answered 404/);
});

test("Anthropic gets its own key headers too", async () => {
  const { fetchImpl, calls } = fakeProvider();
  await checkToolLoop({ ...conn, preset: "anthropic" }, { fetchImpl });
  assert.equal(calls[0].headers["x-api-key"], "sk-test");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
});

test("an unreachable provider fails before any step", async () => {
  const r = await checkToolLoop(conn, { fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.deepEqual([r.ok, r.chat], [false, false]);
  assert.match(r.error, /ECONNREFUSED/);
});

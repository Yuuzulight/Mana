// #1406: her tool loop on a remote OpenAI-compatible model (DeepSeek):
// the request goes to the endpoint with the key, the tier's model and
// thinking; each turn's reasoning is sent back while tools are on; usage
// reaches onResponse; local-only refuses it.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createLlamaServerRuntime } = require("../ai/llama-server-runtime");

function setup(env = {}) {
  const requests = [];
  const replies = [
    { message: { content: null, reasoning_content: "I should read it first.", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] } },
    { message: { content: "It says hello.", reasoning_content: "Done." } },
  ];
  const fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.deepseek.test")) throw new Error(`unexpected request to ${url}`);
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const { message } = replies[requests.length - 1];
    return { ok: true, json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 10 } }) };
  };
  const runtime = createLlamaServerRuntime({
    env,
    fetch,
    spawn: () => {
      throw new Error("a remote loop never starts llama-server");
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });
  return { runtime, requests };
}

const policy = {
  tools: [{ type: "function", function: { name: "read_file", description: "read a file", parameters: { type: "object", properties: {} } } }],
  executeTool: async () => "hello",
};

test("the loop runs on the remote model with its key, model and thinking, and sends reasoning back", async () => {
  const { runtime, requests } = setup();
  const seen = [];
  const run = runtime.remoteToolReply({ baseUrl: "https://api.deepseek.test/", apiKey: "sk-test", model: "deepseek-flash", thinking: true, onResponse: (json) => seen.push(json.usage) });
  const reply = await run("what does notes.txt say?", policy);
  assert.match(reply.content, /hello/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.deepseek.test/chat/completions");
  assert.equal(requests[0].headers.Authorization, "Bearer sk-test");
  assert.equal(requests[0].body.model, "deepseek-flash");
  assert.deepEqual(requests[0].body.thinking, { type: "enabled" });
  assert.equal(requests[0].body.temperature, undefined, "no local sampling settings");
  const assistant = requests[1].body.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.reasoning_content, "I should read it first.");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].prompt_cache_hit_tokens, 80);
});

test("thinking off: no reasoning goes back, and the request says disabled", async () => {
  const { runtime, requests } = setup();
  await runtime.remoteToolReply({ baseUrl: "https://api.deepseek.test", apiKey: "sk-test", model: "deepseek-v4-pro", thinking: false })("read it", policy);
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.equal(requests[1].body.messages.find((m) => m.role === "assistant").reasoning_content, undefined);
});

test("local-only mode or a missing key refuses before anything is sent", () => {
  const { runtime } = setup({ MANA_LOCAL_ONLY: "1" });
  assert.throws(() => runtime.remoteToolReply({ baseUrl: "https://api.deepseek.test", apiKey: "sk-test", model: "deepseek-flash" }), /local-only/);
  const { runtime: r2 } = setup();
  assert.throws(() => r2.remoteToolReply({ baseUrl: "https://api.deepseek.test", apiKey: "", model: "deepseek-flash" }), /API key/);
});

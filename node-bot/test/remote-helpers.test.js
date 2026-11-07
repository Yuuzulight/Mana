// #1467: the two helper calls her loop makes besides the model's own turn (is it really done, and repairing a tool call
// that came back unreadable) on a DeepSeek helper model instead of her local llama-server. A failed or garbled helper
// reply never blocks or throws into the loop.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createRemoteHelpers } = require("../ai/llama/remote-helpers");

const tools = [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const noGaps = () => ({ gaps: [], tests: "" });
const schemaOf = (ts) => ({ type: "object", tools: ts.map((t) => t.function.name) });

function make(reply, extra = {}) {
  const requests = [];
  const usage = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply(requests.length) : reply;
    if (r instanceof Error) throw r;
    return r;
  };
  const helpers = createRemoteHelpers({
    baseUrl: "https://api.deepseek.test/",
    apiKey: "sk-test",
    model: "deepseek-flash",
    fetchImpl,
    sleep: async () => {},
    onResponse: (json) => usage.push(json.usage),
    goalEvidence: noGaps,
    buildToolCallRepairSchema: schemaOf,
    ...extra,
  });
  return { helpers, requests, usage };
}
const ok = (content, usage = { prompt_tokens: 10 }) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) });
const goalArgs = { prompt: "do it", goal: "fix the bug", toolCalls: [], toolNames: ["coding__propose_edit"], draft: "done", maxTokens: 300, profile: "default" };

test("goal check returns the helper's verdict and sends a Flash json_object request without thinking", async () => {
  const { helpers, requests, usage } = make(ok('{"complete":false,"missing":["the test"]}', { prompt_tokens: 7 }));
  assert.deepEqual(await helpers.reviewGoalCompletion(goalArgs), { complete: false, missing: ["the test"] });
  assert.equal(requests[0].url, "https://api.deepseek.test/chat/completions");
  assert.equal(requests[0].headers.Authorization, "Bearer sk-test");
  assert.equal(requests[0].body.model, "deepseek-flash");
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.match(JSON.stringify(requests[0].body.messages), /json/i, "DeepSeek's JSON mode needs the word json in the prompt");
  assert.deepEqual(usage, [{ prompt_tokens: 7 }]);
});

test("an evidence gap decides the goal check without asking the helper", async () => {
  const { helpers, requests } = make(ok("{}"), { goalEvidence: () => ({ gaps: ["no edit was made yet"], tests: "" }) });
  assert.deepEqual(await helpers.reviewGoalCompletion(goalArgs), { complete: false, missing: ["no edit was made yet"], evidence: true });
  assert.equal(requests.length, 0);
});

test("a garbled, empty, failing or throwing helper reply gives null for the goal check and no calls for repair, never an error", async () => {
  const bad = [ok(""), ok("not json"), ok('{"complete":"yes"}'), { ok: false, status: 400, json: async () => ({}) }, new Error("fetch failed")];
  for (const reply of bad) {
    const { helpers } = make(reply, { retries: 0 });
    assert.equal(await helpers.reviewGoalCompletion(goalArgs), null);
    assert.deepEqual(await helpers.repairToolCalls([{ role: "user", content: "x" }], tools, 300), []);
  }
});

test("an overloaded helper is retried with backoff, then the answer is used", async () => {
  const waits = [];
  const { helpers, requests } = make((n) => (n < 3 ? { ok: false, status: 503, json: async () => ({}) } : ok('{"complete":true,"missing":[]}')), { retries: 3, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await helpers.reviewGoalCompletion(goalArgs), { complete: true, missing: [] });
  assert.equal(requests.length, 3);
  assert.deepEqual(waits, [2000, 4000]);
});

test("repair turns the helper's JSON into OpenAI-style tool calls with string arguments, and does nothing without tools", async () => {
  const { helpers, requests } = make(ok('{"tool_calls":[{"name":"read_file","arguments":{"path":"a.js"}}]}'));
  const calls = await helpers.repairToolCalls([{ role: "user", content: "read a.js" }], tools, 300);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "function");
  assert.equal(calls[0].function.name, "read_file");
  assert.equal(calls[0].function.arguments, '{"path":"a.js"}');
  assert.match(JSON.stringify(requests[0].body.messages.at(-1)), /read_file/, "the tools are described to the helper");
  const none = make(ok("{}"));
  assert.deepEqual(await none.helpers.repairToolCalls([], [], 300), []);
  assert.equal(none.requests.length, 0);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildSamplingParams } = require("../ai/sampler-presets");
const { createLlamaServerRuntime } = require("../ai/llama-server-runtime");
const { wantsThinkHarder } = require("../ai/local-ai");

// Issue #675: per-request sampler presets and per-profile/per-task thinking.

test("default profile gets Stable with thinking off", () => {
  const { params, thinking } = buildSamplingParams({ profile: "default", maxTokens: 256, env: {} });
  assert.equal(thinking, false);
  assert.deepEqual(params, {
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    max_tokens: 256,
    chat_template_kwargs: { enable_thinking: false },
  });
});

test("quality profile thinks within a budget added on top of max_tokens", () => {
  const { params, thinking } = buildSamplingParams({ profile: "quality", maxTokens: 256, env: {} });
  assert.equal(thinking, true);
  assert.deepEqual(params.chat_template_kwargs, { enable_thinking: true });
  assert.equal(params.thinking_budget_tokens, 512);
  assert.match(params.reasoning_budget_message, /answer the user directly/);
  assert.equal(params.max_tokens, 256 + 512);
});

test("coding profile gets Precise and thinking on", () => {
  const { params, thinking } = buildSamplingParams({ profile: "coding", maxTokens: 100, env: {} });
  assert.equal(params.temperature, 0.2);
  assert.equal(thinking, true);
});

test("tasks turn thinking off regardless of profile", () => {
  for (const task of ["tools", "stream", "vision", "bestofn", "utility"]) {
    const { params, thinking } = buildSamplingParams({ profile: "quality", task, maxTokens: 64, env: {} });
    assert.equal(thinking, false, task);
    assert.equal(params.max_tokens, 64, task);
    assert.equal("thinking_budget_tokens" in params, false, task);
    assert.equal("reasoning_budget_message" in params, false, task);
  }
});

test("tool task drops DRY and XTC even from a Creative preset", () => {
  const env = { MANA_SAMPLER_PRESET: "creative" };
  const chat = buildSamplingParams({ profile: "default", maxTokens: 64, env }).params;
  assert.equal(chat.dry_multiplier, 0.8);
  assert.equal(chat.xtc_probability, 0.5);
  const tools = buildSamplingParams({ profile: "default", task: "tools", maxTokens: 64, env }).params;
  assert.deepEqual(Object.keys(tools).filter((k) => /^(dry|xtc)_/.test(k)), []);
  assert.equal(tools.temperature, 0.8);
});

test("env overrides: per-profile beats global, unknown names fall back", () => {
  const env = { MANA_SAMPLER_PRESET: "creative", MANA_SAMPLER_PRESET_CODING: "stable" };
  assert.equal(buildSamplingParams({ profile: "coding", maxTokens: 1, env }).params.temperature, 0.7);
  assert.equal(buildSamplingParams({ profile: "fast", maxTokens: 1, env }).params.temperature, 0.8);
  const bogus = { MANA_SAMPLER_PRESET: "constructor" };
  assert.equal(buildSamplingParams({ profile: "coding", maxTokens: 1, env: bogus }).params.temperature, 0.2);
});

test("thinking env: per-task beats per-profile; budget per profile or global", () => {
  const env = {
    MANA_THINKING_DEFAULT: "on",
    MANA_THINKING_QUALITY: "off",
    MANA_THINKING_STREAM: "on",
    MANA_REASONING_BUDGET: "300",
    MANA_REASONING_BUDGET_DEFAULT: "100",
  };
  const def = buildSamplingParams({ profile: "default", maxTokens: 10, env });
  assert.equal(def.thinking, true);
  assert.equal(def.params.thinking_budget_tokens, 100);
  assert.equal(buildSamplingParams({ profile: "quality", maxTokens: 10, env }).thinking, false);
  const stream = buildSamplingParams({ profile: "quality", task: "stream", maxTokens: 10, env });
  assert.equal(stream.thinking, true);
  assert.equal(stream.params.thinking_budget_tokens, 300);
  const badBudget = buildSamplingParams({ profile: "quality", maxTokens: 10, env: { MANA_REASONING_BUDGET: "-5" } });
  assert.equal(badBudget.params.thinking_budget_tokens, 512);
});

test("MANA_LLAMA_REASONING=on|off keeps the launch flag in charge (no thinking fields)", () => {
  for (const value of ["on", "OFF"]) {
    const { params, thinking } = buildSamplingParams({ profile: "quality", maxTokens: 10, env: { MANA_LLAMA_REASONING: value } });
    assert.equal(thinking, false);
    assert.equal("chat_template_kwargs" in params, false);
  }
  const auto = buildSamplingParams({ profile: "quality", maxTokens: 10, env: { MANA_LLAMA_REASONING: "auto" } });
  assert.equal(auto.thinking, true);
});

test("preset none + MANA_LLAMA_REASONING=off reproduces the pre-#675 body", () => {
  const { params } = buildSamplingParams({
    profile: "quality",
    maxTokens: 256,
    env: { MANA_SAMPLER_PRESET: "none", MANA_LLAMA_REASONING: "off" },
  });
  assert.deepEqual(params, { max_tokens: 256 });
});

test("an explicit thinking override wins", () => {
  const { params, thinking } = buildSamplingParams({ profile: "quality", maxTokens: 10, thinking: false, env: {} });
  assert.equal(thinking, false);
  assert.deepEqual(params.chat_template_kwargs, { enable_thinking: false });
});

// Runtime wiring, against a fake fetch/spawn -- never a real llama-server.
// No LLAMA_MODEL and an empty tools dir make every profile resolve to the
// same model, i.e. one shared llama-server process.
function makeRuntime(env, reply, { promptTokens = 100 } = {}) {
  const bodies = [];
  let spawns = 0;
  let serverUp = false;
  const runtime = createLlamaServerRuntime({
    env: Object.assign(env, {
      LLAMA_SERVER_BIN: "C:\\llama\\llama-server.exe",
      LLAMA_SERVER_PORT: "8099",
      LLAMA_SERVER_VRAM_GUARD: "0",
    }),
    detectGpuVramUsage: () => null,
    fs: { existsSync: (target) => target === "C:\\llama\\llama-server.exe" },
    toolsDir: "C:\\mana-test-no-models",
    fetch: async (url, init) => {
      if (String(url).endsWith("/health")) return { ok: serverUp };
      if (String(url).endsWith("/props")) return { ok: false, status: 404, json: async () => ({}) };
      if (String(url).endsWith("/tokenize")) return { ok: true, json: async () => ({ tokens: new Array(promptTokens).fill(1) }) };
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.stream) {
        const frame = JSON.stringify({ choices: [{ delta: reply(body) }] });
        return { ok: true, body: (async function* () { yield `data: ${frame}\n\ndata: [DONE]\n\n`; })() };
      }
      return { ok: true, json: async () => ({ choices: [{ message: reply(body) }] }) };
    },
    spawn: () => {
      spawns += 1;
      serverUp = true;
      return {
        exitCode: null,
        stderr: { on: () => {} },
        on: () => {},
        once: () => {},
        kill() {},
      };
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });
  return { runtime, bodies, spawns: () => spawns };
}

test("quality thinks and default doesn't, on one shared server; presets switch without a restart", async () => {
  const env = {};
  const { runtime, bodies, spawns } = makeRuntime(env, () => ({ content: "hi" }));
  await runtime.runLocalAssistantReply("a", 64, "quality");
  await runtime.runLocalAssistantReply("b", 64, "default");
  env.MANA_SAMPLER_PRESET_DEFAULT = "creative";
  await runtime.runLocalAssistantReply("c", 64, "default");

  assert.equal(spawns(), 1);
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: true });
  assert.equal(bodies[0].thinking_budget_tokens, 512);
  assert.deepEqual(bodies[1].chat_template_kwargs, { enable_thinking: false });
  assert.equal(bodies[1].temperature, 0.7);
  assert.equal(bodies[2].dry_multiplier, 0.8);
});

test("an empty reply with thinking on is retried once with thinking off", async () => {
  const { runtime, bodies } = makeRuntime({}, (body) =>
    body.chat_template_kwargs.enable_thinking
      ? { content: "", reasoning_content: "hmm..." }
      : { content: "real answer" },
  );
  assert.equal(await runtime.runLocalAssistantReply("q", 64, "quality"), "real answer");
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].chat_template_kwargs, { enable_thinking: false });
  assert.equal(bodies[1].max_tokens, 64);
});

test("tool-loop and repair requests never carry DRY/XTC or thinking", async () => {
  const { runtime, bodies } = makeRuntime({ MANA_SAMPLER_PRESET: "creative" }, (body) =>
    // Doubled brace: not valid JSON, so the text-form parser (#787) passes and repair runs.
    body.response_format ? { content: '{"tool_calls":[]}' } : { content: '{{"name": "x", "arguments": {}}' },
  );
  const toolPolicy = {
    tools: [{ type: "function", function: { name: "x", parameters: { type: "object" } } }],
    executeTool: () => "ok",
  };
  await runtime.runToolAwareReply("q", toolPolicy, { profile: "quality" });
  assert.ok(bodies.some((b) => b.response_format), "repair request was made");
  for (const body of bodies) {
    assert.deepEqual(Object.keys(body).filter((k) => /^(dry|xtc)_/.test(k)), []);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  }
});

test("Best-of-N keeps its temperature ladder and judge temperature on top of the preset", async () => {
  const { runtime, bodies } = makeRuntime({}, (body) => ({ content: body.temperature === 0 ? "1" : "code" }));
  await runtime.runBestOfNReply("q", { n: 3 });
  assert.deepEqual(bodies.map((b) => b.temperature), [0.2, 0.6, 1, 0]);
  for (const body of bodies) {
    assert.equal(body.top_k, 20);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  }
});

test("data/sampler-presets.json tunes and adds presets; a missing or broken file keeps the defaults", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-sampler-presets-"));
  const file = path.join(dir, "sampler-presets.json");
  const pick = (preset) =>
    buildSamplingParams({ profile: "default", maxTokens: 1, env: { MANA_SAMPLER_PRESETS_DIR: dir, MANA_SAMPLER_PRESET: preset } }).params;
  try {
    assert.equal(pick("").temperature, 0.7);
    fs.writeFileSync(
      file,
      '{"Creative": {"temperature": 0.9}, "mine": {"min_p": 0.05, "repeat_penalty": 1.1, "stream": true, "top_k": "40"}, "none": {"temperature": 1}}',
    );
    const creative = pick("creative");
    assert.equal(creative.temperature, 0.9);
    assert.equal(creative.dry_multiplier, 0.8, "unlisted fields keep the built-in value");
    const offThinking = { max_tokens: 1, chat_template_kwargs: { enable_thinking: false } };
    assert.deepEqual(pick("mine"), { min_p: 0.05, repeat_penalty: 1.1, ...offThinking }, "only numeric sampler fields");
    assert.deepEqual(pick("none"), offThinking);
    assert.equal(pick("").temperature, 0.7);
    fs.writeFileSync(file, "{not json");
    assert.equal(pick("creative").temperature, 0.8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("think harder: forced thinking reaches streamed and plain requests; MANA_LLAMA_REASONING=on|off still wins", async () => {
  const { runtime, bodies } = makeRuntime({}, () => ({ content: "<think>hmm</think>Sure." }));
  assert.equal(await runtime.streamLocalAssistantReply("q", { maxTokens: 64, thinking: true }), "Sure.");
  assert.equal(await runtime.runLocalAssistantReply("q", 64, "default", null, null, null, true), "Sure.");
  for (const body of bodies) {
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(body.thinking_budget_tokens, 1024);
    assert.match(body.reasoning_budget_message, /answer the user directly/, "closes thinking cleanly when the budget runs out");
    assert.equal(body.max_tokens, 64 + 1024);
  }
  assert.equal(bodies[0].stream, true);
  const forced = buildSamplingParams({ maxTokens: 1, thinking: true, env: { MANA_LLAMA_REASONING: "off" } });
  assert.equal(forced.params.chat_template_kwargs, undefined);
  const own = buildSamplingParams({ maxTokens: 10, thinking: true, env: { MANA_THINK_HARDER_BUDGET: "300", MANA_REASONING_BUDGET: "7" } });
  assert.equal(own.params.thinking_budget_tokens, 300);
  // Q43: a tool round thinks at most 512, and never more than the budget set.
  assert.equal(buildSamplingParams({ task: "tools", maxTokens: 10, thinking: true, env: {} }).params.thinking_budget_tokens, 512);
  const lowTools = buildSamplingParams({ task: "tools", maxTokens: 10, thinking: true, env: { MANA_THINK_HARDER_BUDGET: "300" } });
  assert.equal(lowTools.params.thinking_budget_tokens, 300);
  assert.equal(buildSamplingParams({ profile: "quality", maxTokens: 10, env: {} }).params.thinking_budget_tokens, 512);
});

test("think harder fits prompt + max_tokens into the context: thinking shrinks first, then goes off", async () => {
  const env = { LLAMA_CONTEXT: "4096" };
  const roomy = makeRuntime({ ...env }, () => ({ content: "ok" }), { promptTokens: 3000 });
  await roomy.runtime.runLocalAssistantReply("q", 256, "default", null, null, null, true);
  // room = 4096 - 3000 - 64 = 1032 < 256 + 1024
  assert.equal(roomy.bodies[0].max_tokens, 1032);
  assert.equal(roomy.bodies[0].thinking_budget_tokens, 1024 - (256 + 1024 - 1032));
  assert.deepEqual(roomy.bodies[0].chat_template_kwargs, { enable_thinking: true });
  assert.match(roomy.bodies[0].reasoning_budget_message, /answer the user directly/);

  const full = makeRuntime({ ...env }, () => ({ content: "ok" }), { promptTokens: 3900 });
  await full.runtime.runLocalAssistantReply("q", 256, "default", null, null, null, true);
  assert.equal(full.bodies[0].max_tokens, 4096 - 3900 - 64);
  assert.equal(full.bodies[0].thinking_budget_tokens, undefined);
  assert.equal(full.bodies[0].reasoning_budget_message, undefined);
  assert.deepEqual(full.bodies[0].chat_template_kwargs, { enable_thinking: false });
});

test("think harder on the tool loop: every round thinks, repair doesn't, reasoning never leaks or parses as a call", async () => {
  const { runtime, bodies } = makeRuntime({}, (body) => {
    if (body.response_format) return { content: '{"tool_calls":[]}' };
    const round = bodies.filter((b) => !b.response_format).length;
    if (round === 1) {
      return {
        content: '<think>maybe {"name": "x", "arguments": {}}</think>',
        reasoning_content: "I should call x",
        tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
      };
    }
    if (round === 2) return { content: '<think>now {"name": "x", "arguments": {}}</think>Final answer', reasoning_content: "done" };
    return { content: "should not be reached" };
  });
  const toolPolicy = {
    tools: [{ type: "function", function: { name: "x", parameters: { type: "object" } } }],
    executeTool: () => "tool result",
  };
  const result = await runtime.runToolAwareReply("q", toolPolicy, { maxTokens: 64, thinking: true });

  assert.equal(result.content, "Final answer");
  assert.equal(bodies.length, 2, "the <think> text is not mistaken for a leaked tool call (no repair)");
  for (const body of bodies) {
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(body.thinking_budget_tokens, 512);
    assert.match(body.reasoning_budget_message, /answer the user directly/);
    assert.equal(body.max_tokens, 64 + 512);
    assert.equal(body.tool_choice, "auto");
  }
  const echoed = bodies[1].messages.find((m) => m.role === "assistant");
  assert.equal(echoed.content, null);
  assert.equal("reasoning_content" in echoed, false);

  // The repair request stays schema-only: no thinking even on a think-harder turn.
  // (Malformed on purpose: a well-formed text call is parsed directly, #787.)
  const leaky = makeRuntime({}, (body) =>
    body.response_format ? { content: '{"tool_calls":[]}' } : { content: '{{"name": "x", "arguments": {}}' },
  );
  await leaky.runtime.runToolAwareReply("q", toolPolicy, { maxTokens: 64, thinking: true });
  const repair = leaky.bodies.find((b) => b.response_format);
  assert.deepEqual(repair.chat_template_kwargs, { enable_thinking: false });
});

test("a 'think harder' turn (words or the client's flag) thinks on every reply path, tools kept; other turns don't", async () => {
  assert.equal(wantsThinkHarder("Can you think it through?"), true);
  assert.equal(wantsThinkHarder("I think hard work pays off"), false);

  const { createApp } = require("../server");
  const toolThinking = [];
  const streamThinking = [];
  const plainThinking = [];
  const app = createApp({
    llamaServerRuntime: {
      isEnabled: () => true,
      streamLocalAssistantReply: async (prompt, opts) => {
        streamThinking.push(opts.thinking);
        return "streamed reply";
      },
    },
    runToolAwareReply: async (prompt, policy, opts) => {
      toolThinking.push(opts.thinking());
      return { content: "", toolCalls: [], rounds: 0 };
    },
    runLocalAssistantReply: async (...args) => {
      plainThinking.push(args[6]);
      return "plain reply";
    },
  });
  const reply = (text, onSentence, replyMeta = {}) =>
    app.locals.buildAssistantReply(text, "", "", "default", null, null, null, replyMeta, onSentence);

  await reply("why is the sky blue", () => {});
  assert.deepEqual([toolThinking, streamThinking], [[undefined], [undefined]]);
  await reply("Think harder: why is the sky blue", () => {});
  assert.deepEqual([toolThinking, streamThinking], [[undefined, true], [undefined, true]]);
  await reply("why is the sky blue", null, { thinkHarder: true });
  assert.deepEqual([toolThinking, plainThinking], [[undefined, true, true], [true]]);
});

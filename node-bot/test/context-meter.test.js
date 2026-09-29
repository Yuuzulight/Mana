// Issue #642: the context-window meter -- real per-category token counts
// (incl. tool schemas), the context size, and llama-server's own prompt
// size, on the existing #400 record/route.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  recordPromptComposition,
  finalizePromptComposition,
  contextFullNote,
  getPromptComposition,
  resetPromptCompositionReport,
} = require("../prompt-composition-report");
const { createLlamaServerRuntime } = require("../ai/llama-server-runtime");

// One token per word -- stands in for the model's tokenizer.
const words = async (text) => text.split(/\s+/).filter(Boolean).length;

test("finalize counts every block with the tokenizer, adds late blocks, and reports usage against the context", async () => {
  resetPromptCompositionReport();
  const record = recordPromptComposition("s1", [
    { name: "system-prompt", chars: 11 },
    { name: "prompt-memory", chars: 0 },
  ]);
  await finalizePromptComposition(record, {
    texts: {
      "system-prompt": "you are mana",
      "prompt-memory": "",
      "tool-schemas": "a b c d",
      "user-turn": "hello there",
    },
    promptUsage: { promptTokens: 20, promptN: 5, cacheN: 15 },
    contextSize: 16384,
    countTokens: words,
  });
  const got = getPromptComposition("s1");
  assert.deepEqual(
    got.blocks.map((b) => [b.name, b.tokens]),
    [["system-prompt", 3], ["prompt-memory", 0], ["tool-schemas", 4], ["user-turn", 2]],
  );
  assert.equal(got.countedWith, "tokenizer");
  assert.equal(got.totalTokens, 9);
  assert.equal(got.promptTokens, 20);
  assert.equal(got.promptN, 5);
  assert.equal(got.cacheN, 15);
  assert.equal(got.unattributedTokens, 11, "template markup etc.");
  assert.equal(got.contextSize, 16384);
  assert.equal(got.percentUsed, 0.1);
});

test("finalize falls back to estimates when the tokenizer can't answer, and uses them for the percentage", async () => {
  resetPromptCompositionReport();
  const record = recordPromptComposition("s2", [{ name: "system-prompt", chars: 400 }]);
  await finalizePromptComposition(record, {
    texts: { "system-prompt": "x".repeat(400) },
    contextSize: 1000,
    countTokens: async () => null,
  });
  assert.equal(record.countedWith, "estimate");
  assert.equal(record.blocks[0].tokens, undefined);
  assert.equal(record.totalTokens, 100);
  assert.equal(record.promptTokens, undefined);
  assert.equal(record.unattributedTokens, undefined);
  assert.equal(record.percentUsed, 10);
});

test("a slow finalize never overwrites a newer turn's record", async () => {
  resetPromptCompositionReport();
  const older = recordPromptComposition("s3", [{ name: "system-prompt", chars: 1 }]);
  recordPromptComposition("s3", [{ name: "system-prompt", chars: 2 }]);
  await finalizePromptComposition(older, { texts: { "system-prompt": "a" }, contextSize: 10, countTokens: words });
  assert.equal(getPromptComposition("s3").totalChars, 2);
  assert.equal(getPromptComposition("s3").contextSize, undefined);
});

function runtimeWith(fetchImpl, env = {}, onSpawn = () => {}) {
  return createLlamaServerRuntime({
    env: { LLAMA_SERVER_BIN: "C:\llama\llama-server.exe", LLAMA_MODEL: "C:\models\mana.gguf", LLAMA_SERVER_PORT: "8099", ...env },
    fs: { existsSync: (p) => p === "C:\llama\llama-server.exe" || p === "C:\models\mana.gguf" },
    fetch: fetchImpl,
    spawn: () => (onSpawn(), { exitCode: null, stderr: { on: () => {} }, on: () => {}, once: () => {}, kill() {} }),
    sleep: async () => {},
    registerExitHandlers: false,
  });
}

test("runtime: no server yet -- countTokens is null, context size is the configured -c, and nothing is fetched", async () => {
  let fetched = 0;
  const runtime = runtimeWith(async () => {
    fetched += 1;
    return { ok: false };
  }, { LLAMA_CONTEXT: "16384" });
  assert.equal(await runtime.countTokens("hello"), null);
  assert.equal(await runtime.getContextSize(), 16384);
  assert.equal(runtime.getLastPromptUsage(), null);
  assert.equal(fetched, 0);
});

test("runtime: keeps the last completion's prompt size, and asks the running server for tokens and n_ctx", async () => {
  let up = false;
  const runtime = runtimeWith(async (url, init) => {
    if (url.endsWith("/health")) return { ok: up };
    if (url.endsWith("/props")) return { ok: true, json: async () => ({ model_path: "C:\models\mana.gguf", default_generation_settings: { n_ctx: 8192 } }) };
    if (url.endsWith("/tokenize")) {
      return { ok: true, json: async () => ({ tokens: JSON.parse(init.body).content.split(" ").map((_, i) => i) }) };
    }
    if (url.endsWith("/v1/chat/completions")) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }], timings: { prompt_n: 40, cache_n: 3165 } }) };
    }
    return { ok: false, status: 404, text: async () => "" };
  }, {}, () => {
    up = true;
  });
  const orig = console.log;
  console.log = () => {};
  try {
    await runtime.runLocalAssistantReply("hello", 16, "default");
  } finally {
    console.log = orig;
  }
  const usage = runtime.getLastPromptUsage();
  assert.deepEqual(usage, { promptTokens: 3205, promptN: 40, cacheN: 3165 });
  assert.equal(await runtime.countTokens("a b c"), 3);
  assert.equal(await runtime.getContextSize(), 8192);
  runtime.stop(); // clears the idle-shutdown timer
});

test("server: a tool-aware reply's meter counts tool schemas (local vs MCP), the user turn, and llama-server's prompt size", async () => {
  const original = process.env.MANA_ACP_MEMORY_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-acp-memory-"));
  process.env.MANA_ACP_MEMORY_DIR = tempDir;
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const { createApp } = require("../server");
    let usage = null;
    const mcpTool = { type: "function", function: { name: "mcp__srv__lookup", parameters: {} } };
    const app = createApp({
      llamaServerRuntime: {
        isEnabled: () => true,
        getLastPromptUsage: () => usage,
        countTokens: words,
        getContextSize: async () => 16384,
      },
      runToolAwareReply: async (prompt, toolPolicy) => {
        toolPolicy.tools.push(mcpTool);
        usage = { promptTokens: 3205, promptN: 3205, cacheN: 0 };
        return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
      },
    });
    app.locals.acpMemoryStore.ensureSession({ sessionId: "sess-meter" });
    const reply = await app.locals.buildAssistantReply("hi", "", "", "default", "sess-meter", null, null, {});
    assert.equal(reply, "tool-aware reply");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const record = getPromptComposition("sess-meter");
    const byName = Object.fromEntries(record.blocks.map((b) => [b.name, b]));
    assert.ok(byName["tool-schemas"].tokens > 0, "local tool schemas counted");
    assert.equal(byName["mcp-tool-schemas"].tokens, 1, "MCP schemas counted separately");
    assert.ok(byName["user-turn"].tokens > 0);
    assert.ok("skills-index" in byName);
    assert.equal(record.countedWith, "tokenizer");
    assert.equal(record.promptTokens, 3205);
    assert.equal(record.contextSize, 16384);
    assert.equal(record.percentUsed, 19.6);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
    if (original === undefined) delete process.env.MANA_ACP_MEMORY_DIR;
    else process.env.MANA_ACP_MEMORY_DIR = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("contextFullNote: only at 90% or more, once per session", () => {
  resetPromptCompositionReport();
  assert.equal(contextFullNote("a", 14000, 16384), "", "85% says nothing");
  assert.equal(contextFullNote("a", 100, null), "", "unknown context says nothing");
  assert.match(contextFullNote("a", 14746, 16384), /getting pretty full/);
  assert.equal(contextFullNote("a", 16000, 16384), "", "already said in this session");
  assert.match(contextFullNote("b", 16000, 16384), /fresh one/, "another session still hears it");
  resetPromptCompositionReport("a");
  assert.match(contextFullNote("a", 16000, 16384), /fresh one/);
});

test("server: at 90% of the context Mana ends one reply with the full-chat note", async () => {
  // After the test above: server.js (and its memory dir) is already loaded.
  resetPromptCompositionReport();
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const { createApp } = require("../server");
    let usage = null;
    const app = createApp({
      llamaServerRuntime: {
        isEnabled: () => true,
        getLastPromptUsage: () => usage,
        countTokens: words,
        getContextSize: async () => 16384,
      },
      runToolAwareReply: async () => {
        usage = { promptTokens: 15000, promptN: 15000, cacheN: 0 };
        return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
      },
    });
    const first = await app.locals.buildAssistantReply("hi", "", "", "default", "sess-full", null, null, {});
    assert.match(first, /^tool-aware reply By the way, this chat is getting pretty full/);
    const second = await app.locals.buildAssistantReply("hi", "", "", "default", "sess-full", null, null, {});
    assert.equal(second, "tool-aware reply");
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});

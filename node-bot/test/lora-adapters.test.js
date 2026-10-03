const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLlamaServerRuntime } = require("../ai/llama-server-runtime");

function makeFakeChild() {
  const listeners = {};
  return {
    exitCode: null,
    stderr: {
      on: () => {},
    },
    on: (event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    },
    once: (event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    },
    kill() {
      this.exitCode = 0;
      (listeners.exit || []).forEach((cb) => cb(0));
    },
  };
}

test("findLoraAdapters detects companion and assistant adapters from tools directory or env vars", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-lora-test-"));
  const loraDir = path.join(tempDir, "tools", "llama", "gguf-models", "loras");
  fs.mkdirSync(loraDir, { recursive: true });

  const companionGguf = path.join(loraDir, "mana-companion.gguf");
  const assistantGguf = path.join(loraDir, "mana-assistant.gguf");
  fs.writeFileSync(companionGguf, "fake-companion-lora");
  fs.writeFileSync(assistantGguf, "fake-assistant-lora");

  try {
    const runtime = createLlamaServerRuntime({
      env: {
        LLAMA_SERVER_BIN: path.join(tempDir, "llama-server.exe"),
        LLAMA_MODEL: path.join(tempDir, "base.gguf"),
      },
      baseDir: tempDir,
      toolsDir: path.join(tempDir, "tools"),
      registerExitHandlers: false,
    });

    const adapters = runtime.findLoraAdapters();
    assert.ok(adapters);
    assert.equal(adapters.companionPath, companionGguf);
    assert.equal(adapters.assistantPath, assistantGguf);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildServerArgs appends --lora-init-without-apply and --lora-scaled when adapters exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-lora-args-test-"));
  const loraDir = path.join(tempDir, "tools", "llama", "gguf-models", "loras");
  fs.mkdirSync(loraDir, { recursive: true });

  const bin = path.join(tempDir, "llama-server.exe");
  const model = path.join(tempDir, "base.gguf");
  const companionGguf = path.join(loraDir, "mana-companion.gguf");
  const assistantGguf = path.join(loraDir, "mana-assistant.gguf");
  fs.writeFileSync(bin, "fake");
  fs.writeFileSync(model, "fake");
  fs.writeFileSync(companionGguf, "fake-companion-lora");
  fs.writeFileSync(assistantGguf, "fake-assistant-lora");

  try {
    const runtime = createLlamaServerRuntime({
      env: {
        LLAMA_SERVER_BIN: bin,
        LLAMA_MODEL: model,
      },
      baseDir: tempDir,
      toolsDir: path.join(tempDir, "tools"),
      probeHelp: () => "--lora-init-without-apply\n--lora-scaled\n--load-mode\n",
      registerExitHandlers: false,
    });

    const args = runtime.buildServerArgs(model, 8099, null, "default", bin);
    assert.ok(args.includes("--lora-init-without-apply"));
    const scaledIdx = args.indexOf("--lora-scaled");
    assert.ok(scaledIdx !== -1);
    const spec = args[scaledIdx + 1];
    assert.ok(spec.includes("mana-companion.gguf:0.0"));
    assert.ok(spec.includes("mana-assistant.gguf:0.0"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("applyLoraAdapter updates scales via POST /lora-adapters", async () => {
  const postedBodies = [];
  let liveChild = null;
  const fakeFetch = async (url, options) => {
    if (String(url).endsWith("/health")) {
      return { ok: Boolean(liveChild && liveChild.exitCode === null) };
    }
    if (String(url).endsWith("/lora-adapters")) {
      if (options?.method === "POST") {
        postedBodies.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => [
          { id: 0, path: "C:\\models\\loras\\mana-companion.gguf", scale: 0.0 },
          { id: 1, path: "C:\\models\\loras\\mana-assistant.gguf", scale: 0.0 },
        ],
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-lora-post-test-"));
  const bin = path.join(tempDir, "llama-server.exe");
  const model = path.join(tempDir, "base.gguf");
  fs.writeFileSync(bin, "fake");
  fs.writeFileSync(model, "fake");

  try {
    const runtime = createLlamaServerRuntime({
      env: {
        LLAMA_SERVER_BIN: bin,
        LLAMA_MODEL: model,
        LLAMA_SERVER_PORT: "8099",
      },
      fetch: fakeFetch,
      spawn: () => {
        liveChild = makeFakeChild();
        return liveChild;
      },
      registerExitHandlers: false,
    });

    // Manually trigger server readiness state with mock adapters
    await runtime.waitForServer("default");

    // Switch to companion
    const resCompanion = await runtime.applyLoraAdapter("companion");
    assert.ok(resCompanion);
    assert.equal(runtime.getActiveLoraAdapter(), "companion");

    // Switch to assistant
    const resAssistant = await runtime.applyLoraAdapter("assistant");
    assert.ok(resAssistant);
    assert.equal(runtime.getActiveLoraAdapter(), "assistant");

    // Verify posted bodies
    assert.ok(postedBodies.length >= 2);
    const lastPost = postedBodies[postedBodies.length - 1];
    assert.deepEqual(lastPost, [
      { id: 0, scale: 0.0 },
      { id: 1, scale: 1.0 },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runLocalAssistantReply and runToolAwareReply dynamically route companion and assistant adapters", async () => {
  const postedBodies = [];
  let liveChild = null;
  const fakeFetch = async (url, options) => {
    if (String(url).endsWith("/health")) {
      return { ok: Boolean(liveChild && liveChild.exitCode === null) };
    }
    if (String(url).endsWith("/lora-adapters")) {
      if (options?.method === "POST") {
        postedBodies.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => [
          { id: 0, path: "C:\\models\\loras\\mana-companion.gguf", scale: 0.0 },
          { id: 1, path: "C:\\models\\loras\\mana-assistant.gguf", scale: 0.0 },
        ],
      };
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "hello" } }],
          timings: { prompt_n: 10, prompt_ms: 15 },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-lora-turn-test-"));
  const bin = path.join(tempDir, "llama-server.exe");
  const model = path.join(tempDir, "base.gguf");
  fs.writeFileSync(bin, "fake");
  fs.writeFileSync(model, "fake");

  try {
    const runtime = createLlamaServerRuntime({
      env: {
        LLAMA_SERVER_BIN: bin,
        LLAMA_MODEL: model,
        LLAMA_SERVER_PORT: "8099",
      },
      fetch: fakeFetch,
      spawn: () => {
        liveChild = makeFakeChild();
        return liveChild;
      },
      registerExitHandlers: false,
    });

    // 1. Casual chat turn -> companion adapter
    await runtime.runLocalAssistantReply("How's it going?");
    assert.equal(runtime.getActiveLoraAdapter(), "companion");

    // 2. Tools turn -> assistant adapter
    await runtime.runLocalAssistantReply("Open file", 256, "default", null, null, "tools");
    assert.equal(runtime.getActiveLoraAdapter(), "assistant");

    // 3. Casual chat turn again -> switches back to companion
    await runtime.runLocalAssistantReply("Just saying hi");
    assert.equal(runtime.getActiveLoraAdapter(), "companion");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

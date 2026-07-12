const assert = require("node:assert/strict");
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

function makeFakeEnv() {
  return {
    LLAMA_SERVER_BIN: "C:\\llama\\llama-server.exe",
    LLAMA_MODEL: "C:\\models\\mana.gguf",
    LLAMA_SERVER_PORT: "8099",
  };
}

function makeFakeFs() {
  return {
    existsSync: (target) =>
      target === "C:\\llama\\llama-server.exe" ||
      target === "C:\\models\\mana.gguf",
  };
}

test("llama-server runtime is disabled by MANA_LLAMA_SERVER=0", () => {
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), MANA_LLAMA_SERVER: "0" },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  assert.equal(runtime.isEnabled(), false);
});

test("llama-server runtime is disabled when no server binary exists", () => {
  const runtime = createLlamaServerRuntime({
    env: {},
    fs: { existsSync: () => false },
    registerExitHandlers: false,
  });
  assert.equal(runtime.isEnabled(), false);
});

test("finds llama-server next to LLAMA_BIN when LLAMA_SERVER_BIN is unset", () => {
  const runtime = createLlamaServerRuntime({
    env: { LLAMA_BIN: "C:\\llama\\llama-cli.exe" },
    fs: {
      existsSync: (target) => target === "C:\\llama\\llama-server.exe",
    },
    registerExitHandlers: false,
  });
  assert.equal(runtime.findLlamaServerBin(), "C:\\llama\\llama-server.exe");
  assert.equal(runtime.isEnabled(), true);
});

test("spawns llama-server once and reuses it for subsequent replies", async () => {
  const spawnCalls = [];
  let serverUp = false;

  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) {
      return { ok: serverUp };
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      assert.equal(body.messages[1].role, "user");
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: `<think>pondering</think>Mana says: ${body.messages[1].content}`,
              },
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: fakeFetch,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const first = await runtime.runLocalAssistantReply("hello", 64, "default");
  const second = await runtime.runLocalAssistantReply("again", 64, "default");

  assert.equal(first, "Mana says: hello");
  assert.equal(second, "Mana says: again");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "C:\\llama\\llama-server.exe");
  assert.deepEqual(spawnCalls[0].args.slice(0, 2), [
    "-m",
    "C:\\models\\mana.gguf",
  ]);
  assert.equal(spawnCalls[0].args.includes("--no-webui"), true);
  assert.equal(runtime.getStatus().running, true);
});

test("throws when the port is held by a llama-server with a different model", async () => {
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) {
      return { ok: true };
    }
    if (String(url).endsWith("/props")) {
      return {
        ok: true,
        json: async () => ({ model_path: "C:\\models\\other.gguf" }),
      };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: fakeFetch,
    spawn: () => {
      throw new Error("should not spawn");
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  await assert.rejects(
    () => runtime.runLocalAssistantReply("hello", 64, "default"),
    /already in use by another llama-server/,
  );
});

test("applies a retry cooldown after a failed start instead of retrying every reply", async () => {
  let spawnAttempts = 0;
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: async () => ({ ok: false }),
    spawn: () => {
      spawnAttempts += 1;
      throw new Error("bind failed");
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  await assert.rejects(
    () => runtime.runLocalAssistantReply("hello", 64, "default"),
    /bind failed/,
  );
  await assert.rejects(
    () => runtime.runLocalAssistantReply("hello again", 64, "default"),
    /retry cooldown active/,
  );
  assert.equal(spawnAttempts, 1);
});

test("vision reply starts llama-server with --mmproj and sends image content", async () => {
  const spawnCalls = [];
  let serverUp = false;
  let capturedBody = null;

  const visionEnv = {
    ...makeFakeEnv(),
    LLAMA_VISION_MODEL: "C:\\models\\qwen2.5-vl-3b.gguf",
    LLAMA_VISION_MMPROJ: "C:\\models\\mmproj-qwen2.5-vl-3b.gguf",
  };
  const visionFs = {
    existsSync: (target) =>
      target === "C:\\llama\\llama-server.exe" ||
      target === "C:\\models\\mana.gguf" ||
      target === "C:\\models\\qwen2.5-vl-3b.gguf" ||
      target === "C:\\models\\mmproj-qwen2.5-vl-3b.gguf",
  };

  const runtime = createLlamaServerRuntime({
    env: visionEnv,
    fs: visionFs,
    fetch: async (url, init) => {
      if (String(url).endsWith("/health")) {
        return { ok: serverUp };
      }
      if (String(url).endsWith("/v1/chat/completions")) {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "I can see a chocobo!" } }],
          }),
        };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    },
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const reply = await runtime.runVisionReply(
    "What is on my screen?",
    ["iVBORw0KGgoAAAANSUhEUg=="],
    128,
  );

  assert.equal(reply, "I can see a chocobo!");
  assert.equal(spawnCalls.length, 1);
  const args = spawnCalls[0].args;
  assert.equal(args[args.indexOf("--mmproj") + 1], "C:\\models\\mmproj-qwen2.5-vl-3b.gguf");
  assert.equal(args[args.indexOf("-m") + 1], "C:\\models\\qwen2.5-vl-3b.gguf");

  const userContent = capturedBody.messages[1].content;
  assert.equal(userContent[0].type, "text");
  assert.equal(userContent[0].text, "What is on my screen?");
  assert.equal(userContent[1].type, "image_url");
  assert.equal(
    userContent[1].image_url.url,
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  );
});

test("vision status reports unavailable when no vision model exists", () => {
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    // Pin auto-detection to an empty directory so the test does not depend
    // on which models are installed on the machine running it.
    toolsDir: "C:\\mana-test-no-models",
    registerExitHandlers: false,
  });
  const status = runtime.getVisionStatus();
  assert.equal(status.available, false);
  assert.match(status.reason, /No local vision model found/i);
});

test("vision reply rejects when no image is provided", async () => {
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: async () => ({ ok: false }),
    registerExitHandlers: false,
  });
  await assert.rejects(
    () => runtime.runVisionReply("hello", []),
    /requires at least one image/,
  );
});

test("adopts an existing llama-server that already serves the same model", async () => {
  let completions = 0;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) {
      return { ok: true };
    }
    if (String(url).endsWith("/props")) {
      return {
        ok: true,
        json: async () => ({ model_path: "C:\\models\\mana.gguf" }),
      };
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      completions += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "adopted reply" } }],
        }),
      };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: fakeFetch,
    spawn: () => {
      throw new Error("should not spawn");
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const reply = await runtime.runLocalAssistantReply("hello", 64, "default");
  assert.equal(reply, "adopted reply");
  assert.equal(completions, 1);
  assert.equal(runtime.getStatus().external, true);
});

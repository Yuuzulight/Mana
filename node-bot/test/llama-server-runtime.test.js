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

// runToolAwareReply (issue #51): a policy-gated, single-round tool loop.
// Verified against real hardware separately (Qwen3-4B reliably emits proper
// tool_calls via llama-server's --jinja template); these tests exercise the
// loop's own logic -- request tool schema, execute via the injected policy,
// feed results back, return the final content -- without needing a real GPU.
function makeFakePolicy(overrides = {}) {
  return {
    tools: [
      {
        type: "function",
        function: { name: "read_file", description: "read a file", parameters: {} },
      },
    ],
    executeTool: overrides.executeTool || (() => "default fake result"),
  };
}

test("runToolAwareReply executes a requested tool call and returns the follow-up reply", async () => {
  const calls = [];
  const executedArgs = [];
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        assert.deepEqual(body.tools[0].function.name, "read_file");
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      // Second call: the tool result should now be in the conversation.
      const toolMessage = body.messages.find((m) => m.role === "tool");
      assert.equal(toolMessage.content, "file contents here");
      assert.equal(toolMessage.tool_call_id, "call_1");
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "The file says: file contents here" } }],
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
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const policy = makeFakePolicy({
    executeTool: (name, args) => {
      executedArgs.push({ name, args });
      return "file contents here";
    },
  });

  const result = await runtime.runToolAwareReply("what does notes.txt say?", policy);

  assert.equal(result.content, "The file says: file contents here");
  assert.equal(calls.length, 2);
  assert.deepEqual(executedArgs, [{ name: "read_file", args: { path: "notes.txt" } }]);
  assert.deepEqual(result.toolCalls, [
    { name: "read_file", args: { path: "notes.txt" }, ok: true },
  ]);
});

test("runToolAwareReply reports a policy error back to the model instead of throwing", async () => {
  let secondCallToolMessage = null;
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      const isFirstCall = !body.messages.some((m) => m.role === "tool");
      if (isFirstCall) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "../secret.txt" }) },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      secondCallToolMessage = body.messages.find((m) => m.role === "tool");
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "I can't read that file." } }] }),
      };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: fakeFetch,
    spawn: () => {
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const policy = makeFakePolicy({
    executeTool: () => {
      throw new Error("path escapes the allowed project directory: ../secret.txt");
    },
  });

  const result = await runtime.runToolAwareReply("read ../secret.txt", policy);

  assert.equal(result.content, "I can't read that file.");
  assert.match(secondCallToolMessage.content, /path escapes the allowed project directory/);
  assert.deepEqual(result.toolCalls, [
    {
      name: "read_file",
      args: { path: "../secret.txt" },
      ok: false,
      error: "path escapes the allowed project directory: ../secret.txt",
    },
  ]);
});

test("runToolAwareReply skips the tool round entirely when the model doesn't request one", async () => {
  let callCount = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "2 + 2 is 4." } }] }),
      };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: fakeFetch,
    spawn: () => {
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const result = await runtime.runToolAwareReply("what is 2+2?", makeFakePolicy());

  assert.equal(result.content, "2 + 2 is 4.");
  assert.equal(callCount, 1, "no follow-up round when there's nothing to execute");
  assert.deepEqual(result.toolCalls, []);
});

test("runToolAwareReply rejects an unknown tool call name via the policy rather than guessing", async () => {
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      const isFirstCall = !body.messages.some((m) => m.role === "tool");
      if (isFirstCall) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "exec_shell_command", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "I can't do that." } }] }),
      };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: fakeFetch,
    spawn: () => {
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  // The real tool-policy module (not a fake) never registers write/exec
  // tools at all, so this exercises the actual "unknown tool" rejection.
  const { createToolPolicy } = require("../ai/tool-policy");
  const realPolicy = createToolPolicy({ allowedRoot: "C:\\project" });

  const result = await runtime.runToolAwareReply("run a command", realPolicy);

  assert.equal(result.toolCalls[0].ok, false);
  assert.match(result.toolCalls[0].error, /unknown tool: exec_shell_command/);
});

// Two independently controllable "models": runLocalAssistantReply resolves
// via env.LLAMA_MODEL (chat "default" profile short-circuits to it directly,
// see local-ai.js), runVisionReply resolves via env.LLAMA_VISION_MODEL. Both
// funnel into the same ensureServerConfig/debounce state machine, so this is
// a clean way to force a real cross-model swap without depending on the
// real tools/llama directory contents.
function makeTwoModelEnv() {
  return {
    ...makeFakeEnv(),
    LLAMA_VISION_MODEL: "C:\\models\\vision.gguf",
    LLAMA_VISION_MMPROJ: "C:\\models\\vision-mmproj.gguf",
  };
}

function makeTwoModelFs() {
  return {
    existsSync: (target) =>
      [
        "C:\\llama\\llama-server.exe",
        "C:\\models\\mana.gguf",
        "C:\\models\\vision.gguf",
        "C:\\models\\vision-mmproj.gguf",
      ].includes(target),
  };
}

function makeSwappingHarness(extraEnv = {}) {
  const spawnCalls = [];
  // Tracks liveness of whichever child is "current" -- reset on every spawn,
  // flipped off when that specific child is killed, so a stopAndWait()
  // between two swaps is correctly reflected in isHealthy() the way a real
  // llama-server process exiting would be.
  let liveChild = null;
  let clock = 0;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) {
      return { ok: Boolean(liveChild && liveChild.exitCode === null) };
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const runtime = createLlamaServerRuntime({
    env: { ...makeTwoModelEnv(), ...extraEnv },
    fs: makeTwoModelFs(),
    fetch: fakeFetch,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      liveChild = makeFakeChild();
      clock += 5; // simulate the spawn+healthcheck loop taking real time
      return liveChild;
    },
    sleep: async () => {},
    nowMs: () => clock,
    registerExitHandlers: false,
  });

  return {
    runtime,
    spawnCalls,
    advanceClock: (ms) => {
      clock += ms;
    },
  };
}

test("a real swap is timed and exposed via getStatus().lastSwapMs", async () => {
  const { runtime, advanceClock } = makeSwappingHarness();

  await runtime.runLocalAssistantReply("hello", 64, "default");
  assert.equal(runtime.getStatus().lastSwapMs, null, "cold start is not a swap");

  advanceClock(10000); // well past the default debounce window
  const before = runtime.getStatus();
  assert.equal(before.model, "C:\\models\\mana.gguf");

  await runtime.runVisionReply("what is this?", ["abc"]);
  const after = runtime.getStatus();
  assert.equal(after.model, "C:\\models\\vision.gguf");
  assert.equal(after.lastSwapMs, 5, "swap duration reflects the injected clock");
});

test("a second swap within the debounce window is skipped, serving the loaded model", async () => {
  const { runtime, spawnCalls, advanceClock } = makeSwappingHarness({
    LLAMA_SERVER_SWAP_DEBOUNCE_MS: "5000",
  });

  await runtime.runLocalAssistantReply("hello", 64, "default");
  assert.equal(spawnCalls.length, 1);

  // Immediately request the vision model, well inside the 5s debounce window.
  advanceClock(500);
  await runtime.runVisionReply("what is this?", ["abc"]);
  assert.equal(spawnCalls.length, 1, "debounced: no second spawn");
  assert.equal(
    runtime.getStatus().model,
    "C:\\models\\mana.gguf",
    "still serving the original model",
  );

  // Past the debounce window, the same request now actually swaps.
  advanceClock(5000);
  await runtime.runVisionReply("what is this?", ["abc"]);
  assert.equal(spawnCalls.length, 2, "debounce window elapsed: real swap happens");
  assert.equal(runtime.getStatus().model, "C:\\models\\vision.gguf");
});

test("LLAMA_SERVER_SWAP_DEBOUNCE_MS=0 disables debouncing entirely", async () => {
  const { runtime, spawnCalls } = makeSwappingHarness({
    LLAMA_SERVER_SWAP_DEBOUNCE_MS: "0",
  });

  await runtime.runLocalAssistantReply("hello", 64, "default");
  await runtime.runVisionReply("what is this?", ["abc"]);
  assert.equal(spawnCalls.length, 2, "every swap happens immediately");
});

test("GGML_CUDA_ENABLE_UNIFIED_MEMORY is set by default (measurably faster on real hardware)", async () => {
  const { runtime, spawnCalls } = makeSwappingHarness();

  await runtime.runLocalAssistantReply("hello", 64, "default");
  assert.equal(spawnCalls[0].options.env.GGML_CUDA_ENABLE_UNIFIED_MEMORY, "1");
});

test("MANA_LLAMA_UNIFIED_MEMORY=0 opts out of GGML_CUDA_ENABLE_UNIFIED_MEMORY", async () => {
  const { runtime, spawnCalls } = makeSwappingHarness({
    MANA_LLAMA_UNIFIED_MEMORY: "0",
  });

  await runtime.runLocalAssistantReply("hello", 64, "default");
  assert.equal(
    spawnCalls[0].options.env.GGML_CUDA_ENABLE_UNIFIED_MEMORY,
    undefined,
  );
});

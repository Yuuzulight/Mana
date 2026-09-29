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

test("findLlamaModel prefers a modelSettingsStore path over env.LLAMA_MODEL", () => {
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    registerExitHandlers: false,
    modelSettingsStore: { getModelPath: () => "C:\\models\\mana.gguf" },
  });
  // "default" profile is the only one where an explicit model short-circuits
  // the filename search (see pickPreferredLlamaModel in ai/local-ai.js).
  assert.equal(runtime.findLlamaModel("default"), "C:\\models\\mana.gguf");
});

test("findLlamaModel falls back to env.LLAMA_MODEL when the store has no override", () => {
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    registerExitHandlers: false,
    modelSettingsStore: { getModelPath: () => null },
  });
  assert.equal(runtime.findLlamaModel("default"), makeFakeEnv().LLAMA_MODEL);
});

test("findVisionModel/findVisionMmproj prefer a modelSettingsStore override over env vars", () => {
  const env = {
    ...makeFakeEnv(),
    LLAMA_VISION_MODEL: "C:\\models\\env-vision.gguf",
    LLAMA_VISION_MMPROJ: "C:\\models\\env-vision-mmproj.gguf",
  };
  const fs = {
    existsSync: (target) =>
      [
        "C:\\llama\\llama-server.exe",
        "C:\\models\\mana.gguf",
        "C:\\models\\env-vision.gguf",
        "C:\\models\\env-vision-mmproj.gguf",
        "C:\\models\\store-vision.gguf",
        "C:\\models\\store-vision-mmproj.gguf",
      ].includes(target),
  };
  const runtime = createLlamaServerRuntime({
    env,
    fs,
    registerExitHandlers: false,
    modelSettingsStore: {
      getModelPath: () => null,
      getVisionSettings: () => ({
        modelPath: "C:\\models\\store-vision.gguf",
        mmprojPath: "C:\\models\\store-vision-mmproj.gguf",
      }),
    },
  });
  assert.equal(runtime.findVisionModel(), "C:\\models\\store-vision.gguf");
  assert.equal(
    runtime.findVisionMmproj(),
    "C:\\models\\store-vision-mmproj.gguf",
  );
});

test("findVisionModel falls back to env.LLAMA_VISION_MODEL when the store has no override", () => {
  const env = {
    ...makeFakeEnv(),
    LLAMA_VISION_MODEL: "C:\\models\\env-vision.gguf",
  };
  const fs = {
    existsSync: (target) =>
      target === "C:\\llama\\llama-server.exe" ||
      target === "C:\\models\\mana.gguf" ||
      target === "C:\\models\\env-vision.gguf",
  };
  const runtime = createLlamaServerRuntime({
    env,
    fs,
    registerExitHandlers: false,
    modelSettingsStore: {
      getModelPath: () => null,
      getVisionSettings: () => ({ modelPath: "", mmprojPath: "" }),
    },
  });
  assert.equal(runtime.findVisionModel(), "C:\\models\\env-vision.gguf");
});

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

// Issue #431: runLocalReplyIfSafelyLoaded must never trigger a load or a
// swap -- it's used for a background classification call (memory conflict
// judging), not a user-facing reply, and a swap there would repeat the
// exact RAM-crash failure mode this session's own #360 testing hit.
test("runLocalReplyIfSafelyLoaded returns null and makes no HTTP call when nothing is loaded yet", async () => {
  let fetchCalled = false;
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    fetch: async () => {
      fetchCalled = true;
      return { ok: false, status: 404, text: async () => "not found" };
    },
    spawn: () => makeFakeChild(),
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const result = await runtime.runLocalReplyIfSafelyLoaded("judge this", 16);
  assert.equal(result, null);
  assert.equal(fetchCalled, false);
  assert.equal(runtime.getStatus().running, false);
});

test("runLocalReplyIfSafelyLoaded reuses an already-loaded model without spawning again", async () => {
  const spawnCalls = [];
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) {
      return { ok: serverUp };
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: `verdict for: ${body.messages[1].content}` } }] }) };
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

  // Ordinary conversational reply starts the server on the "default" profile.
  await runtime.runLocalAssistantReply("hello", 64, "default");
  assert.equal(spawnCalls.length, 1);
  assert.equal(runtime.isProfileAlreadyLoaded("default"), true);

  // The judge call reuses it -- no second spawn, i.e. no swap.
  const verdict = await runtime.runLocalReplyIfSafelyLoaded("judge this", 16);
  assert.equal(verdict, "verdict for: judge this");
  assert.equal(spawnCalls.length, 1, "must not spawn/swap for a background judge call");
});

// Issue #282: extraMessages splices memory entries into the messages array
// at either end -- "early" right after the persona system message, "late"
// right before the live user message.
test("runLocalAssistantReply splices extraMessages.early/late around the system/user pair", async () => {
  let capturedMessages = null;
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      capturedMessages = JSON.parse(init.body).messages;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
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

  await runtime.runLocalAssistantReply("hello", 64, "default", null, {
    early: [{ role: "system", content: "early note" }],
    late: [{ role: "system", content: "late note" }],
  });

  // Only the first message may be system-role (Qwen3.5's template rejects
  // later ones): early notes join it, late notes lead the user message.
  assert.equal(capturedMessages.length, 2);
  assert.equal(capturedMessages[0].role, "system");
  assert.ok(capturedMessages[0].content.endsWith("\n\nearly note"));
  assert.deepEqual(capturedMessages[1], { role: "user", content: "late note\n\nhello" });
  assert.equal(capturedMessages.filter((m) => m.role === "system").length, 1);
});

test("runLocalAssistantReply keeps the plain 2-message shape when extraMessages is omitted", async () => {
  let capturedMessages = null;
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      capturedMessages = JSON.parse(init.body).messages;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
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

  await runtime.runLocalAssistantReply("hello", 64, "default");

  assert.equal(capturedMessages.length, 2);
  assert.equal(capturedMessages[0].role, "system");
  assert.equal(capturedMessages[1], capturedMessages[capturedMessages.length - 1]);
  assert.equal(capturedMessages[1].content, "hello");
});

test("proxyChatCompletion forwards the request body untouched and returns the raw response", async () => {
  const spawnCalls = [];
  let serverUp = false;
  let capturedBody = null;

  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) {
      return { ok: serverUp };
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        body: "raw-upstream-body",
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

  // Unlike runLocalAssistantReply, no persona system prompt is injected --
  // external OpenAI-compatible clients (Obsidian Copilot, etc.) bring their
  // own messages, so the body must reach llama-server exactly as given.
  const requestBody = {
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    temperature: 0.2,
  };
  const resp = await runtime.proxyChatCompletion(requestBody);

  assert.equal(resp.ok, true);
  assert.equal(resp.body, "raw-upstream-body");
  assert.deepEqual(capturedBody, requestBody);
  assert.equal(spawnCalls.length, 1);
});

// Regression for the streaming idle-shutdown bug: proxyChatCompletion
// schedules the idle timer at dispatch time, but fetch() resolves once
// headers arrive -- a slow `stream: true` response can still be mid-flight
// when that timer fires, and stop() hard-kills the child process out from
// under the client. server.js now calls scheduleIdleShutdown() again once
// the piped response actually finishes; this confirms that a fresh call
// pushes the shutdown out past the original deadline instead of the process
// dying on schedule regardless.
test("scheduleIdleShutdown can be refreshed after dispatch to push shutdown past a still-streaming response", async () => {
  let serverUp = false;
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), LLAMA_SERVER_IDLE_MS: "30" },
    fs: makeFakeFs(),
    fetch: async (url) => {
      if (String(url).endsWith("/health")) return { ok: serverUp };
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: "raw-upstream-body",
      };
    },
    spawn: () => {
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  await runtime.proxyChatCompletion({ messages: [], stream: true });
  assert.equal(runtime.getStatus().running, true);

  // Simulate the response still streaming past the original 30ms deadline:
  // refresh the timer partway through, before it would have fired.
  await new Promise((resolve) => setTimeout(resolve, 15));
  runtime.scheduleIdleShutdown();

  // Past the original (unrefreshed) deadline -- still running because the
  // refresh pushed shutdown out further.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.getStatus().running, true);

  // Past the refreshed deadline -- now shut down.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.getStatus().running, false);
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

test("runToolAwareReply awaits an async executeTool (issue #169's MCP-tool prerequisite)", async () => {
  // Before issue #169, this loop called toolPolicy.executeTool(name, args)
  // without awaiting it, then did String(result) immediately -- fine for
  // tool-policy.js's synchronous read_file, but String(aPromise) would have
  // produced the literal text "[object Promise]" for anything async
  // (an MCP tool call is inherently network/child-process I/O). This test
  // fails on the old bare-call code the same way a real MCP tool would.
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    const body = JSON.parse(init.body);
    if (!body.messages.some((m) => m.role === "tool")) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "async_tool", arguments: "{}" } },
                ],
              },
            },
          ],
        }),
      };
    }
    const toolMessage = body.messages.find((m) => m.role === "tool");
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: `got: ${toolMessage.content}` } }],
      }),
    };
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
    executeTool: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return "resolved async result";
    },
  });

  const result = await runtime.runToolAwareReply("use the async tool", policy);
  assert.equal(result.content, "got: resolved async result");
  assert.doesNotMatch(result.content, /object Promise/);
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

// Confirmed directly against a real llama-server build (qwen2.5-coder-7b):
// some model/template combos never populate `tool_calls` at all -- they
// leak the call they meant to make into `content` instead, sometimes
// malformed (a real observed example: content was the literal string
// '{{"name": "get_weather", "arguments": {"location": "Tokyo"}}', a
// double-opening-brace, non-JSON-parseable string). These tests exercise
// the repair path that re-asks with response_format's json_schema
// constraint -- confirmed separately (manual testing against that same
// model) to reliably produce clean, schema-conforming JSON.
test("runToolAwareReply repairs a model that leaks a (possibly malformed) tool call into content instead of populating tool_calls", async () => {
  const calls = [];
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        // Native tool-calling path: model leaks a malformed attempt into
        // content instead of populating tool_calls.
        return {
          ok: true,
          json: async () => ({
            choices: [
              { message: { content: '{{"name": "read_file", "arguments": {"path": "notes.txt"}}' } },
            ],
          }),
        };
      }
      if (calls.length === 2) {
        // Repair round: must be schema-constrained, not the native tools param.
        assert.equal(body.response_format.type, "json_schema");
        assert.equal(body.response_format.json_schema.schema.required[0], "tool_calls");
        assert.equal(body.tools, undefined, "repair request replaces tools/tool_choice, doesn't add to them");
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tool_calls: [{ name: "read_file", arguments: { path: "notes.txt" } }],
                  }),
                },
              },
            ],
          }),
        };
      }
      // Third call: the tool result should now be in the conversation.
      const toolMessage = body.messages.find((m) => m.role === "tool");
      assert.equal(toolMessage.content, "file contents here");
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
    executeTool: () => "file contents here",
  });

  const result = await runtime.runToolAwareReply("what does notes.txt say?", policy);

  assert.equal(calls.length, 3, "native attempt + repair + follow-up after executing the repaired call");
  assert.equal(result.content, "The file says: file contents here");
  assert.deepEqual(result.toolCalls, [
    { name: "read_file", args: { path: "notes.txt" }, ok: true },
  ]);
});

test("runToolAwareReply does NOT attempt repair when content is a normal reply, not leaked JSON", async () => {
  let callCount = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Sure, notes.txt says hello." } }] }),
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

  const result = await runtime.runToolAwareReply("what does notes.txt say?", makeFakePolicy());

  assert.equal(callCount, 1, "a normal prose reply must never trigger the repair round-trip");
  assert.equal(result.content, "Sure, notes.txt says hello.");
});

// #623: every emotion-tagged reply starts with "[". Live, that sent each
// reply to the repair round, which invented a skill__view call every turn.
test("runToolAwareReply does NOT attempt repair on a plain reply that starts with an emotion tag", async () => {
  let callCount = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "[happy] Welcome home! [questioning] How was work?" } }] }),
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

  const result = await runtime.runToolAwareReply("I'm home", makeFakePolicy());

  assert.equal(callCount, 1, "a tagged prose reply must never trigger the repair round-trip");
  assert.equal(result.content, "[happy] Welcome home! [questioning] How was work?");
});

test("runToolAwareReply's repair path gives up cleanly (no throw) when the repair response itself doesn't parse", async () => {
  let callCount = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      callCount += 1;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: "{not valid json" } }] }) };
      }
      // Repair attempt also comes back unparseable -- must not throw.
      return { ok: true, json: async () => ({ choices: [{ message: { content: "still not json" } }] }) };
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

  const result = await runtime.runToolAwareReply("what does notes.txt say?", makeFakePolicy());

  assert.equal(callCount, 2, "native attempt + one repair attempt, then gives up");
  assert.deepEqual(result.toolCalls, []);
});

// Second, distinct leak shape confirmed live against qwen2.5-coder-7b's
// real deployed build with Mana's actual coding__propose_edit schema (9
// live samples against the real model): instead of leaking *only* JSON,
// it writes ordinary explanatory prose and embeds the intended call mid-
// response inside a ```json fence, e.g. "...let's propose this edit:\n\n
// ```json\n{\"name\": \"coding__propose_edit\", \"arguments\": {...}}\n
// ```". The original prefix-only check (`content` must start with `{`/`[`)
// never saw this -- confirmed 0/9 real samples triggered repair, including
// this one. This test locks in the fix: detection must also fire on a
// "name"+"arguments" pair embedded anywhere in the content, not just at
// the very start.
test("runToolAwareReply repairs a tool call embedded mid-response inside explanatory prose, not just a leaked-JSON prefix", async () => {
  const calls = [];
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        // Real captured shape: prose first, JSON tool call embedded later.
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content:
                    "Sure, let's fix that. Here's the corrected code:\n\n" +
                    "```python\ndef clamp(x, lo, hi):\n    return max(lo, min(x, hi))\n```\n\n" +
                    "Now, let's propose this edit using the `coding__propose_edit` function:\n\n" +
                    '```json\n{"name": "coding__propose_edit", "arguments": {"path": "utils/math.py"}}\n```',
                },
              },
            ],
          }),
        };
      }
      if (calls.length === 2) {
        assert.equal(body.response_format.type, "json_schema");
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tool_calls: [{ name: "coding__propose_edit", arguments: { path: "utils/math.py" } }],
                  }),
                },
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Done." } }] }) };
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

  const policy = makeFakePolicy({ executeTool: () => "ok" });
  const result = await runtime.runToolAwareReply("fix the clamp() bug", policy);

  assert.equal(calls.length, 3, "native attempt + repair + follow-up after executing the repaired call");
  assert.deepEqual(result.toolCalls, [
    { name: "coding__propose_edit", args: { path: "utils/math.py" }, ok: true },
  ]);
});

// The far more common real shape (8 of 9 live samples): the model never
// attempts a tool call at all -- pure prose describing or half-performing
// the action (often with a plain, non-JSON diff block), no "name"+
// "arguments" pair anywhere. Detection must stay silent here; this is a
// different, unaddressed problem (the model choosing not to call the tool),
// not something a smarter JSON scan can fix.
test("runToolAwareReply does NOT attempt repair on a real captured no-tool-call sample (prose + plain diff, no embedded JSON)", async () => {
  let callCount = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "Got it! Let's fix that off-by-one bug in the `clamp()` function. I'll propose the edit for you.\n\n" +
                  "```diff\ndiff --git a/utils/math.py b/utils/math.py\n--- a/utils/math.py\n+++ b/utils/math.py\n" +
                  "@@ -10,7 +10,7 @@ def clamp(x, lo, hi):\n     if x < lo:\n         return lo\n     elif x > hi:\n" +
                  "-        return hi\n+        return hi - 1\n     else:\n         return x\n```\n\n" +
                  "This should fix the off-by-one issue. Let me know if you need anything else!",
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
    spawn: () => {
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const result = await runtime.runToolAwareReply("fix the clamp() bug", makeFakePolicy());

  assert.equal(callCount, 1, "a plain-diff reply with no embedded tool-call JSON must never trigger repair");
  assert.deepEqual(result.toolCalls, []);
});

// Issue #282: same early/late splicing as runLocalAssistantReply, applies
// to the initial messages array before any tool-calling rounds run.
test("runToolAwareReply splices options.extraMessages.early/late into the initial messages array", async () => {
  let serverUp = false;
  let capturedMessages = null;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      capturedMessages = JSON.parse(init.body).messages;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "answer" } }] }),
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

  await runtime.runToolAwareReply("what is 2+2?", makeFakePolicy(), {
    extraMessages: {
      early: [{ role: "system", content: "early note" }],
      late: [{ role: "system", content: "late note" }],
    },
  });

  assert.equal(capturedMessages[0].role, "system");
  assert.ok(capturedMessages[0].content.endsWith("\n\nearly note"));
  assert.equal(capturedMessages[1].role, "user");
  assert.ok(capturedMessages[1].content.startsWith("late note\n\n"));
  assert.equal(capturedMessages.filter((m) => m.role === "system").length, 1);
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

// Multi-round tool calling (issue #183): runToolAwareReply used to be a
// fixed two-call sequence (one tool round, then a forced final answer). It
// now loops -- these tests exercise the loop itself and its safety caps
// (round limit, per-round call limit, consecutive-error limit, wall-clock
// budget), each verified via a fake fetch rather than a real GPU.
function makeToolCallResponse(toolNames) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: "",
            tool_calls: toolNames.map((name, i) => ({
              id: `call_${name}_${i}`,
              type: "function",
              function: { name, arguments: "{}" },
            })),
          },
        },
      ],
    }),
  };
}

function makeAnswerResponse(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}

test("runToolAwareReply loops across multiple rounds when the model keeps requesting tools", async () => {
  let callCount = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      callCount += 1;
      if (callCount <= 2) return makeToolCallResponse(["read_file"]);
      return makeAnswerResponse("Done after two rounds of tool calls.");
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

  const policy = makeFakePolicy({ executeTool: () => "ok" });
  const result = await runtime.runToolAwareReply("do a multi-step task", policy);

  assert.equal(result.content, "Done after two rounds of tool calls.");
  assert.equal(callCount, 3, "two tool rounds plus the final real answer");
  assert.equal(result.rounds, 3);
  assert.equal(result.toolCalls.length, 2, "one executed call per tool round");
});

test("runToolAwareReply hits the round cap and forces a tools-disabled final answer", async () => {
  const bodies = [];
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      // Always wants another tool -- this response never actually stops.
      return makeToolCallResponse(["read_file"]);
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

  const policy = makeFakePolicy({ executeTool: () => "ok" });
  const result = await runtime.runToolAwareReply("loop forever", policy, { maxRounds: 2 });

  // 2 rounds (both requesting tools) + 1 forced tools-disabled final call.
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].tool_choice, "auto");
  assert.equal(bodies[1].tool_choice, "auto");
  assert.equal(bodies[2].tool_choice, "none");
  assert.equal(bodies[2].tools, undefined, "tools omitted entirely on the forced final call");
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls.length, 2, "tools still executed for both allowed rounds");
});

test("runToolAwareReply caps how many tool calls execute in a single round", async () => {
  let round = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      round += 1;
      if (round === 1) return makeToolCallResponse(["read_file", "read_file", "read_file"]);
      return makeAnswerResponse("done");
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

  const executed = [];
  const policy = makeFakePolicy({
    executeTool: (name) => {
      executed.push(name);
      return "ok";
    },
  });
  const result = await runtime.runToolAwareReply("call three tools", policy, {
    maxToolCallsPerRound: 1,
  });

  assert.equal(executed.length, 1, "only the first tool call in the round actually executed");
  assert.equal(result.content, "done");
});

test("runToolAwareReply stops after consecutive tool errors and forces a final answer", async () => {
  const bodies = [];
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tool_choice === "none") return makeAnswerResponse("giving up gracefully");
      return makeToolCallResponse(["read_file"]);
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
      throw new Error("always broken");
    },
  });
  // Round cap set high so the error cap (3 consecutive) is what actually
  // ends the loop, not running out of rounds.
  const result = await runtime.runToolAwareReply("keep trying a broken tool", policy, {
    maxRounds: 10,
  });

  assert.equal(result.content, "giving up gracefully");
  assert.equal(bodies.length, 4, "3 failing tool rounds + 1 forced final call");
  assert.equal(result.toolCalls.filter((c) => !c.ok).length, 3);
});

// Issue #401: session_goal__finish lets the model genuinely stop the loop
// early, once it believes the session's user-stated goal is done -- not
// just when it naturally runs out of tools to call, or hits the round/
// time/error caps.
test("runToolAwareReply stops immediately when the model calls session_goal__finish, without looping further", async () => {
  const bodies = [];
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tool_choice === "none") return makeAnswerResponse("Goal achieved, all done.");
      // If the loop looped again instead of stopping, this would keep
      // requesting more tool calls forever -- the round cap below is set
      // high specifically so only the finish signal (not running out of
      // rounds) could plausibly account for the loop stopping here.
      return makeToolCallResponse(["session_goal__finish"]);
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
    executeTool: (name) => {
      assert.equal(name, "session_goal__finish");
      return JSON.stringify({ status: "ok", finished: true, reason: "Login bug is fixed and tests pass." });
    },
  });

  const result = await runtime.runToolAwareReply("fix the login bug", policy, {
    maxRounds: 10,
  });

  assert.equal(result.content, "Goal achieved, all done.");
  assert.equal(bodies.length, 2, "1 round requesting the finish tool + 1 forced final call");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "session_goal__finish");
  assert.equal(result.toolCalls[0].ok, true);
});

test("runToolAwareReply respects a wall-clock time budget across rounds", async () => {
  let clock = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      clock += 40000; // each round "takes" 40s
      return makeToolCallResponse(["read_file"]);
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
    nowMs: () => clock,
    registerExitHandlers: false,
  });

  const policy = makeFakePolicy({ executeTool: () => "ok" });
  // maxMs=60000: the budget check happens after each round's own call
  // resolves, using the clock at that point -- round 1 ends at 40s (still
  // under budget, loop continues), round 2 ends at 80s (over budget), so
  // the loop stops after 2 rounds rather than running the full maxRounds.
  const result = await runtime.runToolAwareReply("slow task", policy, {
    maxRounds: 10,
    maxMs: 60000,
  });

  assert.equal(result.rounds, 2, "time budget exhausted partway through, not the full maxRounds");
});

// Issue #676: goal mode. `turns` scripts the tool-loop replies in order
// (the last one repeats); `reviews` scripts the completion-review replies.
function runGoalScript({ turns, reviews = [{ complete: true, missing: [] }], options = {}, toolResult = "ok", promptN = 0, tools }) {
  const loopBodies = [];
  const reviewBodies = [];
  const repairBodies = [];
  let serverUp = false;
  let turnIndex = 0;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      if (body.response_format?.json_schema?.name === "goal_review") {
        reviewBodies.push(body);
        const review = reviews[Math.min(reviewBodies.length, reviews.length) - 1];
        return makeAnswerResponse(JSON.stringify(review));
      }
      if (body.response_format?.json_schema?.name === "tool_calls_repair") {
        repairBodies.push(body);
        return makeAnswerResponse(JSON.stringify({ tool_calls: [] }));
      }
      loopBodies.push(body);
      if (body.tool_choice === "none") return makeAnswerResponse("final answer");
      const turn = turns[Math.min(turnIndex++, turns.length - 1)];
      const reply = Array.isArray(turn) ? makeToolCallResponse(turn) : makeAnswerResponse(turn);
      if (!promptN) return reply;
      const json = await reply.json();
      return { ok: true, json: async () => ({ ...json, timings: { prompt_n: promptN, cache_n: 0 } }) };
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
  const executed = [];
  const policy = makeFakePolicy({
    executeTool: (name) => {
      executed.push(name);
      return typeof toolResult === "function" ? toolResult(name) : toolResult;
    },
  });
  if (tools) policy.tools = tools.map((name) => ({ type: "function", function: { name, parameters: {} } }));
  return runtime
    .runToolAwareReply("change A and change B", policy, { goal: "Change A and B", ...options })
    .then((result) => ({ result, loopBodies, reviewBodies, repairBodies, executed }));
}

const lastUserText = (body) => body.messages.filter((m) => m.role === "user").pop().content;

test("#676 goal mode: a plain reply gets a re-check and the loop continues until finish", async () => {
  const { result, loopBodies, reviewBodies, executed } = await runGoalScript({
    turns: [["read_file"], "I think that's it.", ["session_goal__finish"]],
  });

  assert.deepEqual(executed, ["read_file", "session_goal__finish"]);
  assert.match(lastUserText(loopBodies[2]), /^Goal: Change A and B\nIf it's done, call session_goal__finish/);
  assert.equal(loopBodies.length, 4, "tool round, plain reply, finish round, forced final");
  assert.equal(loopBodies[3].tool_choice, "none");
  assert.equal(reviewBodies.length, 1);
  assert.equal(result.content, "final answer");
});

test("#676 goal mode: stops at the round cap", async () => {
  const { result, loopBodies } = await runGoalScript({ turns: [["read_file"]], options: { maxRounds: 3 } });

  assert.equal(result.rounds, 3);
  assert.equal(loopBodies.length, 4, "3 tool rounds + forced final");
  assert.equal(result.content, "final answer");
});

test("#676 goal mode: stops after two unanswered re-checks and says what is missing", async () => {
  const { result, loopBodies, reviewBodies } = await runGoalScript({
    turns: ["Done!"],
    reviews: [{ complete: false, missing: ["change B"] }],
  });

  assert.equal(loopBodies.length, 3, "plain reply + 2 re-checks, then stop instead of spinning");
  assert.equal(reviewBodies.length, 1, "stalled: no further review cycle");
  assert.equal(result.content, "Not done yet: change B\n\nDone!");
});

test("#676 goal mode: stops before the prompt outgrows 80% of the context", async () => {
  // No /props in the fake, so the context is the configured 4096 default.
  const { result, loopBodies } = await runGoalScript({ turns: [["read_file"]], promptN: 3300 });

  assert.equal(result.rounds, 1);
  assert.equal(loopBodies.length, 2, "1 round + forced final");
});

test("#676 goal mode: a call left waiting on approval stops the loop instead of queueing more", async () => {
  const { result, loopBodies, executed } = await runGoalScript({
    turns: [["read_file"]],
    reviews: [{ complete: false, missing: ["the edit"] }],
    toolResult: JSON.stringify({ status: "pending", requestId: "r1", summary: "write a file" }),
  });

  assert.equal(executed.length, 1);
  assert.equal(loopBodies.length, 2, "1 round + forced final");
  assert.equal(result.content, "Not done yet: the edit\n\nfinal answer");
});

test("#676 completion review: a skipped change triggers one more cycle naming it", async () => {
  const { result, loopBodies, reviewBodies } = await runGoalScript({
    turns: [["session_goal__finish"], ["read_file"], ["session_goal__finish"]],
    reviews: [{ complete: false, missing: ["change B"] }, { complete: true, missing: [] }],
  });

  assert.equal(reviewBodies.length, 2);
  assert.match(reviewBodies[0].messages[1].content, /session_goal__finish\(\{\}\) ok/);
  assert.match(lastUserText(loopBodies[2]), /Still missing: change B/);
  assert.equal(result.content, "final answer", "second review passed, no note");
});

test("#676 completion review: out of budget, the answer says what is missing", async () => {
  const { result, reviewBodies } = await runGoalScript({
    turns: [["read_file"]],
    reviews: [{ complete: false, missing: ["change B"] }],
    options: { maxRounds: 2 },
  });

  assert.equal(reviewBodies.length, 1);
  assert.equal(result.content, "Not done yet: change B\n\nfinal answer");
});

// #787: the live comparison's false "done"s. T1: finish without any edit;
// T4/T5: an edit, then a failing test run, then finish. The model review
// said "complete" to all three.
const CODING_TOOLS = ["read_file", "coding__propose_edit", "coding__run_tests", "session_goal__finish"];
const codingResult = ({ passed }) => (name) =>
  name === "coding__run_tests" ? JSON.stringify({ status: "ok", passed, output: passed ? "# fail 0" : "# fail 1" })
  : name === "coding__propose_edit" ? JSON.stringify({ status: "ok", diff: "-a\n+b" })
  : "ok";

test("#787 review: finishing an edit goal without any edit is not done, whatever the model review says", async () => {
  const { result, loopBodies, reviewBodies } = await runGoalScript({
    tools: CODING_TOOLS,
    turns: [["read_file"], ["session_goal__finish"]],
    reviews: [{ complete: true, missing: [] }],
    toolResult: codingResult({ passed: true }),
  });

  assert.equal(reviewBodies.length, 0, "decided from the evidence, no model review");
  assert.ok(loopBodies.some((b) => /Still missing: no edit was made yet/.test(lastUserText(b))));
  assert.match(result.content, /^Not done yet: no edit was made yet/);
});

test("#787 review: a failing test run after the last edit is not done", async () => {
  const { result, reviewBodies } = await runGoalScript({
    tools: CODING_TOOLS,
    turns: [["coding__propose_edit"], ["coding__run_tests"], ["session_goal__finish"]],
    reviews: [{ complete: true, missing: [] }],
    toolResult: codingResult({ passed: false }),
    options: { maxRounds: 3 },
  });

  assert.equal(reviewBodies.length, 0);
  assert.match(result.content, /^Not done yet: the last test run failed/);
});

test("#787 review: with an edit and passing tests the model review decides, and sees the results", async () => {
  const { result, reviewBodies } = await runGoalScript({
    tools: CODING_TOOLS,
    turns: [["coding__propose_edit"], ["coding__run_tests"], ["session_goal__finish"]],
    toolResult: codingResult({ passed: true }),
  });

  assert.equal(reviewBodies.length, 1);
  assert.ok(reviewBodies[0].messages[1].content.includes('coding__run_tests({}) ok\n  result: {"status":"ok","passed":true'));
  assert.equal(result.content, "final answer");
});

// #787: qwen2.5-coder writes its calls as text instead of <tool_call> tags.
test("#787 a well-formed text-form call to an offered tool runs without a repair request", async () => {
  const fenced = 'Let me look.\n```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```';
  const { executed, repairBodies } = await runGoalScript({ turns: [fenced, "Done."], options: { goal: null } });

  assert.deepEqual(executed, ["read_file"]);
  assert.equal(repairBodies.length, 0);
});

test("#787 a text-form call to a tool that isn't offered still goes to repair", async () => {
  const bare = '{"name": "shell__run", "arguments": {"command": "rm -rf /"}}';
  const { executed, repairBodies } = await runGoalScript({ turns: [bare], options: { goal: null } });

  assert.deepEqual(executed, []);
  assert.equal(repairBodies.length, 1);
});

test("#676 goal mode off: unchanged -- 4 rounds by default, a plain reply ends it, no review", async () => {
  const capped = await runGoalScript({ turns: [["read_file"]], options: { goal: null } });
  assert.equal(capped.result.rounds, 4);
  assert.equal(capped.reviewBodies.length, 0);

  const plain = await runGoalScript({ turns: ["Hello!"], options: { goal: "" } });
  assert.equal(plain.loopBodies.length, 1);
  assert.equal(plain.reviewBodies.length, 0);
  assert.equal(plain.result.content, "Hello!");
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

// Issue #320: VRAM guard. mana.gguf and vision.gguf get controllable sizes
// via statSync so estimateModelFootprintMb has something real to compute
// from -- makeTwoModelFs()'s existsSync-only fake can't drive this, since a
// missing statSync makes the guard gracefully no-op (already covered by
// every pre-#320 test above still passing unchanged).
function makeTwoModelFsWithSizes({ manaSizeMb, visionSizeMb, mmprojSizeMb = 0 }) {
  const sizes = {
    "C:\\models\\mana.gguf": manaSizeMb * 1024 * 1024,
    "C:\\models\\vision.gguf": visionSizeMb * 1024 * 1024,
    "C:\\models\\vision-mmproj.gguf": mmprojSizeMb * 1024 * 1024,
  };
  return {
    existsSync: (target) =>
      [
        "C:\\llama\\llama-server.exe",
        "C:\\models\\mana.gguf",
        "C:\\models\\vision.gguf",
        "C:\\models\\vision-mmproj.gguf",
      ].includes(target),
    statSync: (target) => ({ size: sizes[target] }),
  };
}

function makeVramGuardHarness({ manaSizeMb, visionSizeMb, mmprojSizeMb, freeMbSequence, extraEnv = {}, detectGpuVramUsage }) {
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

  // freeMbSequence: one value per assertVramForSwap call, in order (cold
  // start first, then each subsequent swap) -- a real GPU's free memory
  // genuinely differs between "nothing loaded yet" and "mana is already
  // resident," so a single constant free value can't represent both
  // moments in the same test.
  let callIndex = 0;
  const resolvedDetectUsage =
    detectGpuVramUsage ||
    (() => {
      const freeMb = freeMbSequence[Math.min(callIndex, freeMbSequence.length - 1)];
      callIndex += 1;
      return { usedMb: 0, freeMb };
    });

  const runtime = createLlamaServerRuntime({
    env: { ...makeTwoModelEnv(), ...extraEnv },
    fs: makeTwoModelFsWithSizes({ manaSizeMb, visionSizeMb, mmprojSizeMb }),
    fetch: fakeFetch,
    spawn: () => {
      liveChild = makeFakeChild();
      clock += 5;
      return liveChild;
    },
    sleep: async () => {},
    nowMs: () => clock,
    registerExitHandlers: false,
    detectGpuVramUsage: resolvedDetectUsage,
  });

  return { runtime, advanceClock: (ms) => { clock += ms; } };
}

test("assertVramForSwap includes the mmproj file's footprint, not just the base model", async () => {
  const { runtime, advanceClock } = makeVramGuardHarness({
    manaSizeMb: 4000, // cold start: needs ~4800MB, 10000MB free easily covers it
    visionSizeMb: 4000, // vision model alone would need ~4800MB -- looks fine on its own
    mmprojSizeMb: 4000, // + mmproj: real requirement is ~9600MB (8000 * 1.2)
    // swap-time free (2000MB) + 4000MB outgoing mana = 6000MB projected --
    // enough for the vision model alone, NOT enough once mmproj is counted.
    freeMbSequence: [10000, 2000],
  });

  await runtime.runLocalAssistantReply("hello", 64, "default");
  advanceClock(10000);

  await assert.rejects(
    () => runtime.runVisionReply("what is this?", ["abc"]),
    /refusing to load/,
    "mmproj's footprint should push this over the projected free VRAM",
  );
  assert.equal(runtime.getStatus().model, "C:\\models\\mana.gguf", "blocked swap left the working model in place");
});

test("assertVramForSwap blocks a swap that would not fit even accounting for the outgoing model", async () => {
  const { runtime, advanceClock } = makeVramGuardHarness({
    manaSizeMb: 4000, // cold start: needs ~4800MB, 10000MB free easily covers it
    visionSizeMb: 20000, // swap: requires ~24000MB
    freeMbSequence: [10000, 2000], // swap-time free + 4000MB outgoing = 6000MB, still short
  });

  await runtime.runLocalAssistantReply("hello", 64, "default");
  assert.equal(runtime.getStatus().model, "C:\\models\\mana.gguf", "cold start succeeded");
  advanceClock(10000);

  await assert.rejects(
    () => runtime.runVisionReply("what is this?", ["abc"]),
    /refusing to load/,
  );
  assert.equal(runtime.getStatus().model, "C:\\models\\mana.gguf", "outgoing model was never torn down");
});

test("assertVramForSwap accounts for the outgoing model's own footprint, not just current free VRAM", async () => {
  const { runtime, advanceClock } = makeVramGuardHarness({
    manaSizeMb: 4000, // cold start: needs ~4800MB, 10000MB free easily covers it
    visionSizeMb: 4500, // swap: requires ~5400MB
    // swap-time free (2000MB) alone is short of 5400MB, but + 4000MB
    // outgoing = 6000MB, enough -- proves the outgoing-footprint addition
    // is what makes this pass, not just a generously free GPU.
    freeMbSequence: [10000, 2000],
  });

  await runtime.runLocalAssistantReply("hello", 64, "default");
  advanceClock(10000);

  await runtime.runVisionReply("what is this?", ["abc"]);
  assert.equal(runtime.getStatus().model, "C:\\models\\vision.gguf", "swap succeeded");
});

test("LLAMA_SERVER_VRAM_GUARD=0 disables the guard even when it would otherwise block", async () => {
  const { runtime, advanceClock } = makeVramGuardHarness({
    manaSizeMb: 4000,
    visionSizeMb: 20000,
    freeMbSequence: [10000, 2000],
    extraEnv: { LLAMA_SERVER_VRAM_GUARD: "0" },
  });

  await runtime.runLocalAssistantReply("hello", 64, "default");
  advanceClock(10000);

  await runtime.runVisionReply("what is this?", ["abc"]);
  assert.equal(runtime.getStatus().model, "C:\\models\\vision.gguf", "guard disabled: swap proceeded");
});

test("assertVramForSwap proceeds gracefully when live VRAM usage is unavailable", async () => {
  const { runtime, advanceClock } = makeVramGuardHarness({
    manaSizeMb: 4000,
    visionSizeMb: 20000,
    freeMbSequence: [10000, 2000],
    detectGpuVramUsage: () => null, // e.g. nvidia-smi missing/failed
  });

  await runtime.runLocalAssistantReply("hello", 64, "default");
  advanceClock(10000);

  await runtime.runVisionReply("what is this?", ["abc"]);
  assert.equal(runtime.getStatus().model, "C:\\models\\vision.gguf", "no data: guard does not block");
});

// Issue #417 whole-branch review, Finding 1: a tool executed mid-loop
// (vision__look) can swap the server to a different model out from under
// runToolAwareReply's loop, because ensureServer() used to run only once,
// before round 1 -- every later round (including the one that composes the
// final answer) was then silently served by whatever model the tool call
// last loaded. This proves the fix: complete() re-ensures the configured
// profile's model before every round, so a mid-loop swap gets reversed
// before the next request goes out.
test("runToolAwareReply re-ensures the configured model before every round, reversing a mid-loop swap", async () => {
  const spawnCalls = [];
  let liveChild = null;
  let currentModel = null;
  let clock = 0;
  const modelAtCompletion = [];

  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) {
      return { ok: Boolean(liveChild && liveChild.exitCode === null) };
    }
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      const lastMessage = body.messages[body.messages.length - 1];
      // runVisionReply sends image content as an array; runToolAwareReply's
      // own completions always send a plain string -- use that to tell a
      // tool's own internal vision request apart from the tool loop's own
      // round-by-round completions without needing separate fetch stubs.
      if (Array.isArray(lastMessage?.content)) {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "a browser window" } }] }),
        };
      }
      modelAtCompletion.push(currentModel);
      if (modelAtCompletion.length === 1) {
        return makeToolCallResponse(["vision__look"]);
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "final answer" } }] }),
      };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const runtime = createLlamaServerRuntime({
    // Debounce disabled: isolates the re-ensure fix itself from the
    // separate (and, per the review, narrower/lower-priority) question of
    // whether a mid-loop swap should also bypass the debounce window.
    env: { ...makeTwoModelEnv(), LLAMA_SERVER_SWAP_DEBOUNCE_MS: "0" },
    fs: makeTwoModelFs(),
    fetch: fakeFetch,
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      liveChild = makeFakeChild();
      currentModel = args[args.indexOf("-m") + 1];
      clock += 5;
      return liveChild;
    },
    sleep: async () => {},
    nowMs: () => clock,
    registerExitHandlers: false,
  });

  const policy = {
    tools: [{ type: "function", function: { name: "vision__look", description: "look", parameters: {} } }],
    executeTool: async () => {
      // Mirrors vision-tool-source.js's executeTool: a tool call mid-loop
      // triggers a real runVisionReply(), which swaps the server.
      await runtime.runVisionReply("what's on screen?", ["fake-image-data"]);
      return JSON.stringify({ status: "ok", description: "a browser window" });
    },
  };

  const result = await runtime.runToolAwareReply("what's on my screen?", policy, {
    maxRounds: 4,
  });

  assert.equal(result.content, "final answer");
  assert.equal(modelAtCompletion.length, 2);
  assert.equal(modelAtCompletion[0], "C:\\models\\mana.gguf", "round 1 runs on the text model");
  assert.equal(
    modelAtCompletion[1],
    "C:\\models\\mana.gguf",
    "round 2 (after the tool swapped to vision mid-loop) must be re-ensured back to the text model, not silently served by vision",
  );
  assert.equal(runtime.getStatus().model, "C:\\models\\mana.gguf");
  assert.equal(spawnCalls.length, 3, "text model, swap to vision for the tool call, swap back for round 2");
});

// runBestOfNReply (issue #70): N candidates at varied temperature, then a
// temp-0 judge call picks the best one. Sequential, not parallel -- matches
// how the actual llama-server instance is spawned here (default single
// parallel slot). These tests exercise the loop/judge-parsing logic without
// needing a real GPU; real latency is measured separately (see
// docs/roadmap/issue-70-best-of-n.md).
test("runBestOfNReply generates N candidates and returns the judge's pick", async () => {
  const candidateTemps = [];
  let judgeCall = null;
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      const isJudge = body.messages.some((m) =>
        String(m.content).includes("Best candidate number"),
      );
      if (isJudge) {
        judgeCall = body;
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "2" } }] }),
        };
      }
      candidateTemps.push(body.temperature);
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: `candidate at temp ${body.temperature}` } },
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
    spawn: () => {
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });

  const result = await runtime.runBestOfNReply("write a fibonacci function", {
    n: 3,
    profile: "default",
  });

  assert.equal(candidateTemps.length, 3);
  assert.deepEqual(candidateTemps, [0.2, 0.6, 1]);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.judgeIndex, 1);
  assert.equal(result.content, "candidate at temp 0.6");
  assert.ok(judgeCall, "judge call happened");
});

test("runBestOfNReply falls back to the first candidate when the judge reply is unparseable", async () => {
  let serverUp = false;
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init.body);
      const isJudge = body.messages.some((m) =>
        String(m.content).includes("Best candidate number"),
      );
      if (isJudge) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "I'm not sure, honestly." } }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "safe candidate" } }] }),
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

  const result = await runtime.runBestOfNReply("hello", { n: 2, profile: "default" });

  assert.equal(result.judgeIndex, 0);
  assert.equal(result.content, "safe candidate");
});

test("runBestOfNReply skips the judge call entirely when n is 1", async () => {
  let callCount = 0;
  let serverUp = false;
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/health")) return { ok: serverUp };
    if (String(url).endsWith("/v1/chat/completions")) {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "only answer" } }] }),
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

  const result = await runtime.runBestOfNReply("hello", { n: 1, profile: "default" });

  assert.equal(callCount, 1, "no judge round when there's only one candidate");
  assert.equal(result.content, "only answer");
  assert.equal(result.judgeIndex, 0);
});

// Issue #332: speculative decoding wiring in buildServerArgs.
test("buildServerArgs omits --spec-type by default (no speculative decoding env vars set)", () => {
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
  assert.equal(args.includes("--spec-type"), false);
  assert.equal(args.includes("--spec-draft-model"), false);
  assert.equal(args.includes("--spec-draft-ngl"), false);
});

test("buildServerArgs leaves n-gram speculative decoding off for any LLAMA_ENABLE_SPEC_NGRAM value other than the literal string \"1\"", () => {
  for (const value of ["0", "true", "yes", "on"]) {
    const runtime = createLlamaServerRuntime({
      env: { ...makeFakeEnv(), LLAMA_ENABLE_SPEC_NGRAM: value },
      fs: makeFakeFs(),
      registerExitHandlers: false,
    });
    const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
    assert.equal(args.includes("--spec-type"), false, `value ${value} should not enable the gate`);
  }
});

test("buildServerArgs enables n-gram speculative decoding, defaulting to ngram-simple", () => {
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), LLAMA_ENABLE_SPEC_NGRAM: "1" },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
  const idx = args.indexOf("--spec-type");
  assert.ok(idx !== -1);
  assert.equal(args[idx + 1], "ngram-simple");
});

// Issue #370: per-profile tuning defaults (n-gram spec-decode for "coding").
test("buildServerArgs enables n-gram speculative decoding by default for the coding profile, no env var needed", () => {
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090, null, "coding");
  const idx = args.indexOf("--spec-type");
  assert.ok(idx !== -1);
  assert.equal(args[idx + 1], "ngram-simple");
});

test("buildServerArgs leaves n-gram speculative decoding off by default for non-coding profiles", () => {
  for (const profile of ["default", "fast", "quality", null, undefined]) {
    const runtime = createLlamaServerRuntime({
      env: makeFakeEnv(),
      fs: makeFakeFs(),
      registerExitHandlers: false,
    });
    const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090, null, profile);
    assert.equal(args.includes("--spec-type"), false, `profile ${profile} should not enable the gate`);
  }
});

test("buildServerArgs: LLAMA_ENABLE_SPEC_NGRAM=0 overrides the coding profile's default-on", () => {
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), LLAMA_ENABLE_SPEC_NGRAM: "0" },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090, null, "coding");
  assert.equal(args.includes("--spec-type"), false);
});

test("buildServerArgs: LLAMA_ENABLE_SPEC_NGRAM=1 turns n-gram spec-decode on for non-coding profiles too", () => {
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), LLAMA_ENABLE_SPEC_NGRAM: "1" },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090, null, "default");
  assert.ok(args.includes("--spec-type"));
});

// Issue #360: --mlock pins the model in RAM so a mode-switch back doesn't
// pay a cold disk read if the OS evicted the page cache under pressure.
test("buildServerArgs omits --mlock by default", () => {
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
  assert.equal(args.includes("--mlock"), false);
});

test("buildServerArgs falls back to --no-mmap for llama.cpp builds without --load-mode, probing each binary once", () => {
  const probes = [];
  const helpFor = {
    "C:\\llama\\new\\llama-server.exe": "  --load-mode MODE   how to load the model\n  --mmap, --no-mmap  DEPRECATED",
    "C:\\llama\\old\\llama-server.exe": "  --mmap, --no-mmap  whether to memory-map model",
  };
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makeFakeFs(),
    registerExitHandlers: false,
    probeHelp: (bin) => {
      probes.push(bin);
      if (!(bin in helpFor)) throw new Error("spawn failed");
      return helpFor[bin];
    },
  });
  const args = (bin) => runtime.buildServerArgs("C:\\models\\mana.gguf", 8090, null, null, bin);

  const fresh = args("C:\\llama\\new\\llama-server.exe");
  assert.equal(fresh[fresh.indexOf("--load-mode") + 1], "none");
  assert.equal(fresh.includes("--no-mmap"), false);

  const old = args("C:\\llama\\old\\llama-server.exe");
  assert.ok(old.includes("--no-mmap"));
  assert.equal(old.includes("--load-mode"), false);

  // A probe that fails counts as "not supported": --no-mmap still works on
  // new builds (deprecated), while --load-mode would stop an old one.
  assert.ok(args("C:\\llama\\broken\\llama-server.exe").includes("--no-mmap"));

  args("C:\\llama\\new\\llama-server.exe");
  assert.deepEqual(probes, [
    "C:\\llama\\new\\llama-server.exe",
    "C:\\llama\\old\\llama-server.exe",
    "C:\\llama\\broken\\llama-server.exe",
  ]);
});

// #660: uncapped, llama-server's host-RAM prompt cache (8 GiB default) grew
// its working set 0.9 -> 4.6 GB in one session.
test("buildServerArgs caps the host-RAM prompt cache at 1024 MiB, LLAMA_CACHE_RAM overrides, older builds skip it", () => {
  const helpFor = {
    "new-llama-server.exe": "  -cram, --cache-ram N   set the maximum cache size in MiB",
    "old-llama-server.exe": "  --mmap, --no-mmap  whether to memory-map model",
  };
  const cacheRam = (env, bin = "new-llama-server.exe") => {
    const runtime = createLlamaServerRuntime({
      env: { ...makeFakeEnv(), ...env },
      fs: makeFakeFs(),
      registerExitHandlers: false,
      probeHelp: (b) => helpFor[b],
    });
    const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090, null, null, bin);
    return args.includes("--cache-ram") ? args[args.indexOf("--cache-ram") + 1] : null;
  };

  assert.equal(cacheRam({}), "1024");
  assert.equal(cacheRam({ LLAMA_CACHE_RAM: "4096" }), "4096");
  assert.equal(cacheRam({ LLAMA_CACHE_RAM: "-1" }), "-1", "no limit");
  assert.equal(cacheRam({ LLAMA_CACHE_RAM: "0" }), "0", "off");
  assert.equal(cacheRam({ LLAMA_CACHE_RAM: "lots" }), "1024");
  assert.equal(cacheRam({}, "old-llama-server.exe"), null, "a build without the flag would refuse to start");
});

test("buildServerArgs loads straight into VRAM (--load-mode none) by default; MANA_LLAMA_MMAP=1, a saved false or LLAMA_MLOCK=1 turn it off", () => {
  const argsFor = (env, modelSettingsStore) =>
    createLlamaServerRuntime({
      env: { ...makeFakeEnv(), ...env },
      fs: makeFakeFs(),
      registerExitHandlers: false,
      modelSettingsStore,
    }).buildServerArgs("C:\\models\\mana.gguf", 8090);
  const store = (saved) => ({
    isLoadIntoVram: (env) => (saved === null ? env.MANA_LLAMA_MMAP !== "1" : saved),
  });

  const loadMode = (args) => (args.includes("--load-mode") ? args[args.indexOf("--load-mode") + 1] : null);
  assert.equal(loadMode(argsFor({})), "none");
  assert.equal(argsFor({}).includes("--no-mmap"), false, "deprecated flag");
  assert.equal(loadMode(argsFor({ MANA_LLAMA_MMAP: "1" })), null);
  assert.equal(loadMode(argsFor({}, store(null))), "none");
  assert.equal(loadMode(argsFor({}, store(false))), null);
  assert.equal(loadMode(argsFor({ MANA_LLAMA_MMAP: "1" }, store(true))), "none");
  // #360's opt-in mlock keeps mmap + mlock rather than mixing load modes
  const mlocked = argsFor({ LLAMA_MLOCK: "1" });
  assert.ok(mlocked.includes("--mlock"));
  assert.equal(loadMode(mlocked), null);
});

test("buildServerArgs adds --mlock only when LLAMA_MLOCK=1", () => {
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), LLAMA_MLOCK: "1" },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
  assert.ok(args.includes("--mlock"));
});

test("buildServerArgs leaves --mlock off for any LLAMA_MLOCK value other than the literal string \"1\"", () => {
  for (const value of ["0", "true", "yes", "on"]) {
    const runtime = createLlamaServerRuntime({
      env: { ...makeFakeEnv(), LLAMA_MLOCK: value },
      fs: makeFakeFs(),
      registerExitHandlers: false,
    });
    const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
    assert.equal(args.includes("--mlock"), false, `value ${value} should not enable mlock`);
  }
});

test("buildServerArgs lets LLAMA_SPEC_NGRAM_TYPE override which n-gram variant is used", () => {
  const runtime = createLlamaServerRuntime({
    env: {
      ...makeFakeEnv(),
      LLAMA_ENABLE_SPEC_NGRAM: "1",
      LLAMA_SPEC_NGRAM_TYPE: "ngram-mod",
    },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
  assert.equal(args[args.indexOf("--spec-type") + 1], "ngram-mod");
});

test("buildServerArgs wires draft-model speculative decoding from LLAMA_SPEC_DRAFT_MODEL", () => {
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), LLAMA_SPEC_DRAFT_MODEL: "C:\\models\\draft-1.7b.gguf" },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
  assert.equal(args[args.indexOf("--spec-type") + 1], "draft-simple");
  assert.equal(args[args.indexOf("--spec-draft-model") + 1], "C:\\models\\draft-1.7b.gguf");
});

// Issue #332: measured directly that -ngld's own 'auto' default leaves the
// draft model mostly off-GPU (14.6 tok/s vs. 78.7 tok/s forced to match
// -ngl, on a real coder-7B + 1.5B-draft pairing) -- buildServerArgs must
// always pin --spec-draft-ngl to the same value as -ngl.
test("buildServerArgs sets --spec-draft-ngl to match -ngl, not the draft model's own 'auto' default", () => {
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), LLAMA_SPEC_DRAFT_MODEL: "C:\\models\\draft-1.7b.gguf", LLAMA_NGL: "42" },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
  assert.equal(args[args.indexOf("--spec-draft-ngl") + 1], "42");
  assert.equal(args[args.indexOf("-ngl") + 1], "42");
});

test("buildServerArgs combines n-gram and draft-model speculative decoding when both are set", () => {
  const runtime = createLlamaServerRuntime({
    env: {
      ...makeFakeEnv(),
      LLAMA_ENABLE_SPEC_NGRAM: "1",
      LLAMA_SPEC_DRAFT_MODEL: "C:\\models\\draft-1.7b.gguf",
    },
    fs: makeFakeFs(),
    registerExitHandlers: false,
  });
  const args = runtime.buildServerArgs("C:\\models\\mana.gguf", 8090);
  assert.equal(args[args.indexOf("--spec-type") + 1], "ngram-simple,draft-simple");
});

// #693: in-memory fs covering what the tools/llama/active.json pointer
// code touches, on top of the existsSync the runtime already uses.
const path = require("node:path");
const POINTER_TOOLS_DIR = "C:\\tools\\llama";
const POINTER_FILE = path.join(POINTER_TOOLS_DIR, "active.json");

function makePointerFs(files) {
  return {
    existsSync: (target) => target in files,
    readFileSync: (target) => {
      if (!(target in files)) throw new Error(`ENOENT: ${target}`);
      return files[target];
    },
    writeFileSync: (target, data) => {
      files[target] = String(data);
    },
    renameSync: (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
  };
}

function pointerFiles(pointer) {
  return {
    "C:\\llama\\llama-server.exe": "",
    "C:\\llama-new\\llama-server.exe": "",
    "C:\\models\\mana.gguf": "",
    ...(pointer === undefined ? {} : { [POINTER_FILE]: typeof pointer === "string" ? pointer : JSON.stringify(pointer) }),
  };
}

test("findLlamaServerBin prefers the update pointer, and is unchanged with a missing or corrupt one", () => {
  const make = (files) =>
    createLlamaServerRuntime({
      env: makeFakeEnv(),
      fs: makePointerFs(files),
      toolsDir: POINTER_TOOLS_DIR,
      registerExitHandlers: false,
    });

  assert.equal(make(pointerFiles({ active: "C:\\llama-new" })).findLlamaServerBin(), "C:\\llama-new\\llama-server.exe");
  assert.equal(make(pointerFiles()).findLlamaServerBin(), "C:\\llama\\llama-server.exe");
  assert.equal(make(pointerFiles("{not json")).findLlamaServerBin(), "C:\\llama\\llama-server.exe");
  // A pointer at a folder that no longer has llama-server.exe falls through too.
  assert.equal(make(pointerFiles({ active: "C:\\gone" })).findLlamaServerBin(), "C:\\llama\\llama-server.exe");
});

function makePointerRuntime(files, failingBin) {
  const spawnCalls = [];
  let serverUp = false;
  const runtime = createLlamaServerRuntime({
    env: makeFakeEnv(),
    fs: makePointerFs(files),
    toolsDir: POINTER_TOOLS_DIR,
    fetch: async (url) => {
      if (String(url).endsWith("/health")) return { ok: serverUp };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    },
    spawn: (command) => {
      spawnCalls.push(command);
      if (command === failingBin) throw new Error("new build crashed");
      serverUp = true;
      return makeFakeChild();
    },
    sleep: async () => {},
    registerExitHandlers: false,
  });
  return { runtime, spawnCalls };
}

test("an update-installed build that fails to start is rolled back and the previous build starts on the next reply", async () => {
  const files = pointerFiles({
    active: "C:\\llama-new",
    previous: "C:\\llama",
    pendingVerification: true,
    installed: ["C:\\llama-new"],
  });
  const { runtime, spawnCalls } = makePointerRuntime(files, "C:\\llama-new\\llama-server.exe");

  await assert.rejects(() => runtime.runLocalAssistantReply("hello", 64, "default"), /new build crashed/);
  const pointer = JSON.parse(files[POINTER_FILE]);
  assert.equal(pointer.active, "C:\\llama");
  assert.equal(pointer.previous, "C:\\llama-new");
  assert.equal(pointer.pendingVerification, false);
  assert.equal(pointer.lastRollback.from, "C:\\llama-new");
  assert.match(pointer.lastRollback.reason, /new build crashed/);

  // No retry cooldown after a rollback: the next reply starts the old build.
  assert.equal(await runtime.runLocalAssistantReply("again", 64, "default"), "ok");
  assert.deepEqual(spawnCalls, ["C:\\llama-new\\llama-server.exe", "C:\\llama\\llama-server.exe"]);
});

test("a clean start on an update-installed build confirms it; a failure on a confirmed build rolls nothing back", async () => {
  const files = pointerFiles({ active: "C:\\llama-new", previous: "C:\\llama", pendingVerification: true, installed: [] });
  const { runtime } = makePointerRuntime(files, null);
  await runtime.runLocalAssistantReply("hello", 64, "default");
  assert.equal(JSON.parse(files[POINTER_FILE]).pendingVerification, false);

  const confirmed = pointerFiles({ active: "C:\\llama-new", previous: "C:\\llama", installed: [] });
  const before = confirmed[POINTER_FILE];
  const failing = makePointerRuntime(confirmed, "C:\\llama-new\\llama-server.exe");
  await assert.rejects(() => failing.runtime.runLocalAssistantReply("hello", 64, "default"), /new build crashed/);
  assert.equal(confirmed[POINTER_FILE], before);
});

// #666: fake clock (sleep advances it) + a spawn that fails the first
// failing.get(model) starts of that model, so retry/cooldown timing is
// checked without real waits.
function makeRetryRuntime(failing = new Map(), env = {}) {
  let clock = 0;
  let serverUp = false;
  const sleeps = [];
  const spawned = [];
  const runtime = createLlamaServerRuntime({
    env: { ...makeFakeEnv(), ...env },
    fs: makeFakeFs(),
    nowMs: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetch: async () => ({ ok: serverUp }),
    spawn: (bin, args) => {
      const model = args[args.indexOf(args.includes("-m") ? "-m" : "-hf") + 1];
      spawned.push(model);
      if (failing.get(model) > 0) {
        failing.set(model, failing.get(model) - 1);
        throw new Error(`out of memory loading ${model}`);
      }
      serverUp = true;
      return makeFakeChild();
    },
    registerExitHandlers: false,
  });
  return { runtime, sleeps, spawned, setClock: (ms) => (clock = ms) };
}

const MANA_MODEL = makeFakeEnv().LLAMA_MODEL;
const modelFor = (profile) => makeRetryRuntime().runtime.findLlamaModel(profile);

test("#666: the start cooldown is per model and backs off from 5s, capped by LLAMA_SERVER_RETRY_COOLDOWN_MS", async () => {
  const { runtime, spawned, setClock } = makeRetryRuntime(new Map([[MANA_MODEL, Infinity]]), {
    LLAMA_SERVER_RETRY_COOLDOWN_MS: "20000",
  });
  const start = () => runtime.ensureServerConfig(MANA_MODEL);

  await assert.rejects(start, /out of memory/);
  setClock(4999);
  await assert.rejects(start, (e) => /cooldown active/.test(e.message) && e.retryAfterMs === 1);
  setClock(5000);
  await assert.rejects(start, /out of memory/);
  setClock(5000 + 14999);
  await assert.rejects(start, /cooldown active/);
  setClock(20000);
  await assert.rejects(start, /out of memory/);
  // Third failure: 45s by the backoff, capped at 20s.
  setClock(39999);
  await assert.rejects(start, /cooldown active/);
  setClock(40000);
  await assert.rejects(start, /out of memory/);
  assert.equal(spawned.length, 4);

  // Another model is not held back by this one's cooldown.
  await runtime.ensureServerConfig("C:\\models\\other.gguf");
  assert.equal(spawned.at(-1), "C:\\models\\other.gguf");
});

test("#666: waitForServer tells the turn once, retries after the cooldown, and returns when the server is back", async () => {
  const { runtime, sleeps, spawned } = makeRetryRuntime(new Map([[MANA_MODEL, 1]]));
  let notices = 0;
  const onWait = () => (notices += 1);

  assert.equal(await runtime.waitForServer("default", onWait), "default");
  assert.equal(notices, 1);
  assert.deepEqual(sleeps, [5000]);
  assert.equal(spawned.length, 2);

  // Already up: no notice, no wait.
  assert.equal(await runtime.waitForServer("default", onWait), "default");
  assert.equal(notices, 1);
  assert.equal(spawned.length, 2);
});

test("#666: waitForServer gives up within its budget, then answers with the profile's fallbackProfile", async () => {
  const qualityModel = modelFor("quality");
  const { runtime, sleeps, spawned } = makeRetryRuntime(new Map([[qualityModel, Infinity]]));
  let notices = 0;

  assert.equal(await runtime.waitForServer("quality", () => (notices += 1)), "default");
  assert.equal(notices, 1);
  // Starts at 0s, 5s, 20s; the next cooldown (45s) doesn't fit in 20s.
  assert.deepEqual(sleeps, [5000, 15000]);
  assert.deepEqual(spawned, [qualityModel, qualityModel, qualityModel, MANA_MODEL]);
});

test("#666: waitForServer rejects when nothing comes up, and a long cooldown fails the next turn fast and silently", async () => {
  // "fast" has no fallbackProfile.
  const { runtime, sleeps } = makeRetryRuntime(new Map([[modelFor("fast"), Infinity]]));

  await assert.rejects(() => runtime.waitForServer("fast"), /out of memory/);
  const sleepsAfterFirstTurn = sleeps.length;

  let notices = 0;
  await assert.rejects(() => runtime.waitForServer("fast", () => (notices += 1)), /cooldown active/);
  assert.equal(notices, 0);
  assert.equal(sleeps.length, sleepsAfterFirstTurn);
});

test("#666: a rolled-back build is retried by waitForServer straight away, not after a cooldown", async () => {
  const files = pointerFiles({
    active: "C:\\llama-new",
    previous: "C:\\llama",
    pendingVerification: true,
    installed: ["C:\\llama-new"],
  });
  const { runtime, spawnCalls } = makePointerRuntime(files, "C:\\llama-new\\llama-server.exe");

  assert.equal(await runtime.waitForServer("default"), "default");
  assert.deepEqual(spawnCalls, ["C:\\llama-new\\llama-server.exe", "C:\\llama\\llama-server.exe"]);
  assert.equal(JSON.parse(files[POINTER_FILE]).active, "C:\\llama");
});

test("#666: backupProfileFor names the profile's fallbackProfile, or null when it has none", () => {
  const { runtime } = makeRetryRuntime();
  assert.equal(runtime.backupProfileFor("quality"), "default");
  assert.equal(runtime.backupProfileFor("fast"), null);
});

// Live run (2026-09-29): idle shutdown logged "shutting it down" but the
// llama-server it had spawned kept its port and ~6GB VRAM. Fakes only: one
// port a single child can bind, children that exit a tick after being
// killed (a real CUDA teardown takes seconds), taskkill as a fake execFile.
function makeStopHarness({ exitOnKill = true, releasePortOnKill = false, taskkillFails = false } = {}) {
  const models = ["C:\\models\\mana.gguf", "C:\\models\\other.gguf"];
  const children = [];
  const taskkills = [];
  let holder = null;
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  function terminate(child) {
    child.killed = true;
    if (releasePortOnKill && holder === child) holder = null;
    if (exitOnKill) setImmediate(() => child.exit(1));
  }

  const runtime = createLlamaServerRuntime({
    env: {
      ...makeFakeEnv(),
      LLAMA_SERVER_VRAM_GUARD: "0",
      LLAMA_SERVER_SWAP_DEBOUNCE_MS: "0",
      LLAMA_SERVER_IDLE_MS: "1000",
    },
    fs: { existsSync: (target) => target === "C:\\llama\\llama-server.exe" || models.includes(target) },
    platform: "win32",
    execFile: (cmd, args, options, callback) => {
      taskkills.push([cmd, ...args]);
      const child = !taskkillFails && children.find((c) => c.pid === Number(args[1]));
      if (child) terminate(child);
      setImmediate(() => callback(child ? null : new Error("not found")));
    },
    fetch: async (url) => {
      // Answers once its model is "loaded": from the third request on.
      const ready = Boolean(holder && !holder.killed && holder.polls++ >= 2);
      if (String(url).endsWith("/health")) return { ok: ready };
      if (String(url).endsWith("/props")) {
        return { ok: ready, json: async () => ({ model_path: holder.model }) };
      }
      return { ok: false, status: 404, text: async () => "" };
    },
    spawn: (bin, args) => {
      const listeners = {};
      const child = {
        pid: 4000 + children.length,
        model: args[args.indexOf("-m") + 1],
        exitCode: null,
        signalCode: null,
        polls: 0,
        stderr: { on: () => {} },
        on: (event, cb) => (listeners[event] = listeners[event] || []).push(cb),
        once: (event, cb) => (listeners[event] = listeners[event] || []).push(cb),
        exit(code) {
          if (child.exitCode !== null) return;
          child.exitCode = code;
          if (holder === child) holder = null;
          (listeners.exit || []).forEach((cb) => cb(code));
        },
        kill: () => {
          child.killedDirectly = true;
          terminate(child);
        },
      };
      children.push(child);
      if (holder) setImmediate(() => child.exit(1)); // port already bound
      else holder = child;
      return child;
    },
    sleep: tick,
    registerExitHandlers: false,
  });
  return { runtime, models, children, taskkills, tick, live: () => children.filter((c) => c.exitCode === null) };
}

test("live run: idle shutdown tree-kills llama-server on win32 and logs only once it has exited", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  const { runtime, models, children, taskkills, tick, live } = makeStopHarness();

  await runtime.ensureServerConfig(models[0]);
  runtime.scheduleIdleShutdown();
  t.mock.timers.tick(1000);

  assert.deepEqual(taskkills, [["C:\\Windows\\System32\\taskkill.exe", "/PID", "4000", "/T", "/F"]]);
  assert.equal(children[0].killedDirectly, undefined, "taskkill, not child.kill()");
  assert.equal(runtime.getStatus().running, false);
  assert.ok(logs.some((l) => /idle for 1000ms, shutting it down \(pid 4000\)/.test(l)));
  assert.ok(!logs.some((l) => /stopped/.test(l)), "not claimed stopped before it exited");

  await tick();
  await tick();
  assert.deepEqual(live(), []);
  assert.ok(logs.some((l) => /pid 4000\) stopped/.test(l)));
});

test("live run: when taskkill fails, stop() falls back to child.kill()", async () => {
  const { runtime, models, children, tick, live } = makeStopHarness({ taskkillFails: true });

  await runtime.ensureServerConfig(models[0]);
  runtime.stop();
  await tick();
  await tick();

  assert.equal(children[0].killedDirectly, true);
  assert.deepEqual(live(), []);
});

test("live run: a llama-server that doesn't exit after being stopped is reported", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const { runtime, models } = makeStopHarness({ exitOnKill: false });

  await runtime.ensureServerConfig(models[0]);
  runtime.stop();
  t.mock.timers.tick(15000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(warnings.some((w) => /pid 4000\) is still running 15000ms after being stopped/.test(w)));
});

test("live run: a start right after idle shutdown waits for the old server to exit instead of failing to bind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runtime, models, children, live } = makeStopHarness();

  await runtime.ensureServerConfig(models[0]);
  runtime.scheduleIdleShutdown();
  t.mock.timers.tick(1000);
  // Old process still tearing down (and holding the port) at this point.
  await runtime.ensureServerConfig(models[0]);

  assert.equal(children.length, 2);
  assert.equal(children[0].exitCode, 1);
  assert.deepEqual(live(), [children[1]]);
  assert.equal(runtime.getStatus().running, true);
  assert.equal(runtime.getStatus().external, false);
});

test("live run: overlapping restarts never leave a spawned llama-server that stop() can't reach", async () => {
  const { runtime, models, tick, live } = makeStopHarness({ releasePortOnKill: true });

  await runtime.ensureServerConfig(models[0]);
  // A swap and a turn for the first model arrive together.
  await Promise.allSettled([
    runtime.ensureServerConfig(models[1]),
    runtime.ensureServerConfig(models[0]),
  ]);
  runtime.stop();
  for (let i = 0; i < 5; i += 1) await tick();

  assert.deepEqual(live().map((c) => c.pid), []);
});

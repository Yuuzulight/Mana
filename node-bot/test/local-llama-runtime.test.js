const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLocalLlamaRuntime,
  isLocalModelSpec,
} = require("../ai/local-llama-runtime");

test("isLocalModelSpec detects local GGUF paths and rejects HF repo shorthands", () => {
  assert.equal(isLocalModelSpec("C:\\models\\mana.gguf"), true);
  assert.equal(isLocalModelSpec("models/mana.gguf"), true);
  assert.equal(isLocalModelSpec("Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"), false);
  assert.equal(isLocalModelSpec(""), false);
});

test("local llama runtime builds llama.cpp args for local GGUF replies", () => {
  const calls = [];
  const runtime = createLocalLlamaRuntime({
    env: {
      LLAMA_BIN: "C:\\llama\\llama-cli.exe",
      LLAMA_MODEL: "C:\\models\\mana.gguf",
    },
    fs: {
      existsSync: (target) =>
        target === "C:\\llama\\llama-cli.exe" || target === "C:\\models\\mana.gguf",
    },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "Prompt echo\nMana reply", stderr: "" };
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  const reply = runtime.runLocalAssistantReply("Hello", 64, "default");

  assert.equal(reply, "Prompt echo\nMana reply");
  assert.equal(calls[0].command, "C:\\llama\\llama-cli.exe");
  assert.deepEqual(calls[0].args.slice(0, 4), [
    "-m",
    "C:\\models\\mana.gguf",
    "-sys",
    runtime.systemPrompt,
  ]);
  assert.equal(calls[0].args.includes("--single-turn"), true);
  assert.equal(calls[0].options.cwd, "C:\\llama");
});

test("local llama runtime builds HF repo args when model is not a local spec", () => {
  const calls = [];
  const runtime = createLocalLlamaRuntime({
    env: {
      LLAMA_BIN: "C:\\llama\\llama-cli.exe",
      LLAMA_MODEL: "Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M",
    },
    fs: {
      existsSync: (target) => target === "C:\\llama\\llama-cli.exe",
    },
    spawnSync: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "Mana reply", stderr: "" };
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  const reply = runtime.runLocalAssistantReply("Hello", 64, "default");

  assert.equal(reply, "Mana reply");
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "-hf",
    "Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M",
    "-sys",
    runtime.systemPrompt,
    "-p",
  ]);
});

test("local llama runtime strips echoed prompt, boot banner, and bracketed thinking blocks", () => {
  const calls = [];
  const noisyStdout =
    "Loading model... > system prompt here > the actual prompt here " +
    "__ __ _ __ _ _ _ _ _\nbuild: b9436-d6588daa8\nmodel: qwen2.5-coder-7b\n" +
    "[Start thinking] let me figure out how to respond [End thinking] " +
    "Here is the real reply.\nExiting...";
  const runtime = createLocalLlamaRuntime({
    env: {
      LLAMA_BIN: "C:\\llama\\llama-cli.exe",
      LLAMA_MODEL: "C:\\models\\mana.gguf",
    },
    fs: {
      existsSync: (target) =>
        target === "C:\\llama\\llama-cli.exe" || target === "C:\\models\\mana.gguf",
    },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: noisyStdout, stderr: "" };
    },
    nowMs: () => 1,
    logPerf: () => {},
    systemPrompt: "system prompt here",
  });

  const reply = runtime.runLocalAssistantReply(
    "the actual prompt here",
    64,
    "default",
  );

  assert.equal(reply, "Here is the real reply.");
});

test("local llama runtime reports status and placeholder when binary is missing", () => {
  const runtime = createLocalLlamaRuntime({
    env: {},
    fs: {
      existsSync: () => false,
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  const status = runtime.getLlamaStatus();
  const reply = runtime.runLocalAssistantReply("hello world", 64, "default");

  assert.equal(status.ok, false);
  assert.equal(status.bin, null);
  assert.match(status.message, /Llama executable not found/i);
  assert.equal(reply, "(no local llama binary found) I heard: hello world");
});

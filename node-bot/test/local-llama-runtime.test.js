const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLocalLlamaRuntime,
  isLocalModelSpec,
  cleanLlamaOutput,
} = require("../ai/local-llama-runtime");

test("isLocalModelSpec detects local GGUF paths and rejects HF repo shorthands", () => {
  assert.equal(isLocalModelSpec("C:\\models\\mana.gguf"), true);
  assert.equal(isLocalModelSpec("models/mana.gguf"), true);
  assert.equal(isLocalModelSpec("Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"), false);
  assert.equal(isLocalModelSpec(""), false);
});

// The exported cleanLlamaOutput is the one acp-memory-store.js and server.js
// actually import (see issue #91: "the shared cleaner both the per-session
// summarizer and the background compactor route through"). It must get the
// same prompt/sysPrompt-echo stripping as the runtime's internal cleaner,
// not just the banner/reasoning stripping -- these tests exercise it
// directly, independent of runLocalAssistantReply, so a future caller that
// feeds raw CLI stdout straight to the export (bypassing the runtime) still
// gets the full cleanup.
test("exported cleanLlamaOutput strips echoed prompt/sysPrompt when given context", () => {
  const noisy = "Loading model... system prompt here the actual prompt here Here is the real reply.";
  const cleaned = cleanLlamaOutput(noisy, {
    sysPrompt: "system prompt here",
    prompt: "the actual prompt here",
  });
  assert.equal(cleaned, "Here is the real reply.");
});

test("exported cleanLlamaOutput skips the strip step when no prompt context is given", () => {
  const text = "Hello! How can I help you today?";
  assert.equal(cleanLlamaOutput(text), text);
});

test("exported cleanLlamaOutput still strips banner/reasoning noise with no prompt context", () => {
  const noisy = "[Start thinking] pondering [End thinking] The actual reply. Exiting...";
  assert.equal(cleanLlamaOutput(noisy), "The actual reply.");
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

test("local llama runtime preserves prompt text that legitimately repeats in the reply", () => {
  const runtime = createLocalLlamaRuntime({
    env: {
      LLAMA_BIN: "C:\\llama\\llama-cli.exe",
      LLAMA_MODEL: "C:\\models\\mana.gguf",
    },
    fs: {
      existsSync: (target) =>
        target === "C:\\llama\\llama-cli.exe" || target === "C:\\models\\mana.gguf",
    },
    spawnSync: () => ({
      status: 0,
      // Echo happens once, up front, exactly like real llama-cli output --
      // the real reply after it happens to repeat "Hello" again.
      stdout: "Hello Hello! How can I help you today?",
      stderr: "",
    }),
    nowMs: () => 1,
    logPerf: () => {},
    systemPrompt: "",
  });

  const reply = runtime.runLocalAssistantReply("Hello", 64, "default");

  assert.equal(reply, "Hello! How can I help you today?");
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

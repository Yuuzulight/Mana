// Issue #401: a session's user-stated goal should only be surfaced (as
// system-prompt text, and as the session_goal__finish tool) under the
// exact same condition that lets the model actually call any tool at all
// -- mirrors test/skills-index-tool-calling-gate.test.js's own reasoning
// and setup for the [AVAILABLE SKILLS] index.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApp } = require("../server");

function withTempAcpMemoryDir(fn) {
  const original = process.env.MANA_ACP_MEMORY_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-acp-memory-"));
  process.env.MANA_ACP_MEMORY_DIR = tempDir;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.MANA_ACP_MEMORY_DIR;
    else process.env.MANA_ACP_MEMORY_DIR = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("a session's goal is NOT surfaced when tool-calling is disabled (default state)", async () => {
  await withTempAcpMemoryDir(async () => {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
    let capturedSystemPrompt = null;
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
        capturedSystemPrompt = overrideSystemPrompt;
        return "plain reply";
      },
    });

    const store = app.locals.acpMemoryStore;
    store.ensureSession({ sessionId: "sess-goal-disabled" });
    store.setSessionGoal("sess-goal-disabled", "Fix the login bug");

    const reply = await app.locals.buildAssistantReply(
      "hi", "", "", "default", "sess-goal-disabled", null, null, {},
    );

    assert.equal(reply, "plain reply");
    assert.ok(capturedSystemPrompt !== null, "runLocalAssistantReply should have been called");
    assert.ok(!capturedSystemPrompt.includes("Session goal:"));
  });
});

test("a session's goal IS surfaced (in the prompt and as session_goal__finish) when tool-calling is enabled and the profile is \"default\"", async () => {
  await withTempAcpMemoryDir(async () => {
    process.env.MANA_TOOL_CALLING_ENABLED = "1";
    let capturedSystemPrompt = null;
    let capturedTools = null;
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy, options) => {
        capturedSystemPrompt = options.overrideSystemPrompt;
        capturedTools = toolPolicy.tools;
        return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
      },
    });

    const store = app.locals.acpMemoryStore;
    store.ensureSession({ sessionId: "sess-goal-enabled" });
    store.setSessionGoal("sess-goal-enabled", "Fix the login bug");

    const reply = await app.locals.buildAssistantReply(
      "hi", "", "", "default", "sess-goal-enabled", null, null, {},
    );

    delete process.env.MANA_TOOL_CALLING_ENABLED;

    assert.equal(reply, "tool-aware reply");
    assert.ok(capturedSystemPrompt !== null, "runToolAwareReply should have been called");
    assert.ok(capturedSystemPrompt.includes("Session goal: Fix the login bug"));
    assert.ok(
      capturedTools.some((t) => t.function?.name === "session_goal__finish"),
      "session_goal__finish should be offered when the session has a goal",
    );
  });
});

test("session_goal__finish is NOT offered when the session has no goal set, even with tool-calling enabled", async () => {
  await withTempAcpMemoryDir(async () => {
    process.env.MANA_TOOL_CALLING_ENABLED = "1";
    let capturedTools = null;
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy) => {
        capturedTools = toolPolicy.tools;
        return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
      },
    });

    const store = app.locals.acpMemoryStore;
    store.ensureSession({ sessionId: "sess-no-goal" });

    await app.locals.buildAssistantReply(
      "hi", "", "", "default", "sess-no-goal", null, null, {},
    );

    delete process.env.MANA_TOOL_CALLING_ENABLED;

    assert.ok(
      !capturedTools.some((t) => t.function?.name === "session_goal__finish"),
      "session_goal__finish must not be offered without a stored goal",
    );
  });
});

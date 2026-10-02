const test = require("node:test");
const assert = require("node:assert");
const {
  createCodingSessionManager,
  isExitCommand,
  isEnterCommand,
  getMaskingPhrase,
} = require("../ai/coding-session");

test("Coding Session Manager Suite (#1343 Phase 3)", async (t) => {
  await t.test("recognizes enter and exit phrases accurately", () => {
    assert.strictEqual(isEnterCommand("let's code"), true);
    assert.strictEqual(isEnterCommand("please open dev workspace now"), true);
    assert.strictEqual(isEnterCommand("start coding"), true);
    assert.strictEqual(isEnterCommand("how's the weather today?"), false);

    assert.strictEqual(isExitCommand("done"), true);
    assert.strictEqual(isExitCommand("exit code mode"), true);
    assert.strictEqual(isExitCommand("we're done"), true);
    assert.strictEqual(isExitCommand("back to chat"), true);
    assert.strictEqual(isExitCommand("thanks, that's all"), true);
    assert.strictEqual(isExitCommand("can you explain this function?"), false);
  });

  await t.test("starts sticky session and returns audio masking phrase", () => {
    const manager = createCodingSessionManager();
    assert.strictEqual(manager.isActive("sess-1"), false);

    const result = manager.start("sess-1");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.maskingPhrase, "Opening the dev workspace...");
    assert.strictEqual(manager.isActive("sess-1"), true);

    manager.stop("sess-1");
    assert.strictEqual(manager.isActive("sess-1"), false);
  });

  await t.test("session auto-exits after idle timeout", async () => {
    let timedOut = false;
    let clock = 1000;
    const manager = createCodingSessionManager({
      idleTimeoutMs: 50,
      nowMs: () => clock,
      onSessionTimeout: () => {
        timedOut = true;
      },
    });

    manager.start("sess-timeout");
    assert.strictEqual(manager.isActive("sess-timeout"), true);

    // Wait past 50ms timeout
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(timedOut, true);
    assert.strictEqual(manager.isActive("sess-timeout"), false);
  });

  await t.test("touch resets idle timeout", async () => {
    let timedOut = false;
    const manager = createCodingSessionManager({
      idleTimeoutMs: 60,
      onSessionTimeout: () => {
        timedOut = true;
      },
    });

    manager.start("sess-touch");
    await new Promise((resolve) => setTimeout(resolve, 40));
    manager.touch("sess-touch");

    // After 40ms more (80ms total from start), touch should have kept it alive
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(manager.isActive("sess-touch"), true);
    assert.strictEqual(timedOut, false);

    manager.stop("sess-touch");
  });

  await t.test("gaming guard strictly blocks coding mode and terminates active sessions", () => {
    let gaming = false;
    const manager = createCodingSessionManager({
      isGaming: () => gaming,
    });

    manager.start("sess-game");
    assert.strictEqual(manager.isActive("sess-game"), true);

    // Game starts
    gaming = true;
    assert.strictEqual(manager.isActive("sess-game"), false);

    // Attempting to start while gaming is rejected
    const startResult = manager.start("sess-game-2");
    assert.strictEqual(startResult.ok, false);
    assert.strictEqual(startResult.reason, "gaming_active");
  });
});

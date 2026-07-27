const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { MAX_TEXT_CHARS, createTelegramBridge, pollOnce } = require("../telegram-bridge");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-telegram-"));
}

test("an unapproved chat's message gets back a pairing code, not a real reply", async () => {
  const bridge = createTelegramBridge({ dataDir: createTempDir() });
  const reply = await bridge.handleIncomingMessage({ chatId: 111, text: "hi", senderName: "aurora" });

  assert.match(reply, /^This chat isn't paired with Mana yet\..*: [A-Z0-9]{6}$/);
  assert.equal(bridge.isApproved(111), false);
  assert.equal(bridge.listPending().length, 1);
  assert.equal(bridge.listPending()[0].name, "aurora");
});

test("the same unapproved chat reuses its existing pairing code across messages", async () => {
  const bridge = createTelegramBridge({ dataDir: createTempDir() });
  const first = await bridge.handleIncomingMessage({ chatId: 222, text: "one" });
  const second = await bridge.handleIncomingMessage({ chatId: 222, text: "two" });
  assert.equal(first, second);
});

test("approvePairing moves a chat from pending to approved and returns its chatId", async () => {
  const bridge = createTelegramBridge({ dataDir: createTempDir() });
  const reply = await bridge.handleIncomingMessage({ chatId: 333, text: "hi" });
  const code = reply.match(/: (\w{6})$/)[1];

  const chatId = bridge.approvePairing(code);
  assert.equal(chatId, "333");
  assert.equal(bridge.isApproved(333), true);
  assert.equal(bridge.listPending().length, 0);
  assert.equal(bridge.listApproved().length, 1);
});

test("approvePairing returns null for an unknown code", () => {
  const bridge = createTelegramBridge({ dataDir: createTempDir() });
  assert.equal(bridge.approvePairing("NOPE12"), null);
});

test("an approved chat's message routes through replyFn with a per-chat sessionId", async () => {
  let received = null;
  const bridge = createTelegramBridge({
    dataDir: createTempDir(),
    replyFn: async (text, options) => {
      received = { text, options };
      return "a real reply";
    },
  });
  const code = (await bridge.handleIncomingMessage({ chatId: 444, text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const reply = await bridge.handleIncomingMessage({ chatId: 444, text: "what's the weather" });
  assert.equal(reply, "a real reply");
  assert.equal(received.text, "what's the weather");
  assert.equal(received.options.sessionId, "telegram-444");
});

test("handleIncomingMessage truncates to MAX_TEXT_CHARS and requires a chatId", async () => {
  const bridge = createTelegramBridge({
    dataDir: createTempDir(),
    replyFn: async (text) => text,
  });
  const code = (await bridge.handleIncomingMessage({ chatId: 555, text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const longText = "x".repeat(MAX_TEXT_CHARS + 500);
  const reply = await bridge.handleIncomingMessage({ chatId: 555, text: longText });
  assert.equal(reply.length, MAX_TEXT_CHARS);

  await assert.rejects(() => bridge.handleIncomingMessage({ text: "hi" }), /chatId is required/);
});

test("pollOnce only routes private chats and advances the offset past the highest update_id seen", async () => {
  const sentTo = [];
  const client = {
    async getUpdates() {
      return [
        { update_id: 10, message: { chat: { id: 1, type: "private" }, text: "hi", from: {} } },
        { update_id: 11, message: { chat: { id: 2, type: "group" }, text: "ignored", from: {} } },
      ];
    },
    async sendMessage(chatId, text) {
      sentTo.push({ chatId, text });
    },
  };
  const bridge = createTelegramBridge({
    dataDir: createTempDir(),
    replyFn: async () => "pong",
  });
  // Pre-approve chat 1 so pollOnce exercises the real reply path.
  const code = (await bridge.handleIncomingMessage({ chatId: 1, text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const nextOffset = await pollOnce({ client, bridge, lastOffset: 0 });
  assert.equal(nextOffset, 12);
  assert.deepEqual(sentTo, [{ chatId: 1, text: "pong" }]);
});

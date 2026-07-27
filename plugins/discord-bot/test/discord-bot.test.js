const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_TEXT_CHARS,
  DISCORD_DM_CHANNEL_TYPE,
  createDiscordBridge,
  handleDiscordMessage,
} = require("../discord-bot");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-discord-"));
}

test("an unapproved channel's message gets back a pairing code, not a real reply", async () => {
  const bridge = createDiscordBridge({ dataDir: createTempDir() });
  const reply = await bridge.handleIncomingMessage({ channelId: "111", text: "hi", senderName: "aurora" });

  assert.match(reply, /^This chat isn't paired with Mana yet\..*: [A-Z0-9]{6}$/);
  assert.equal(bridge.isApproved("111"), false);
  assert.equal(bridge.listPending().length, 1);
  assert.equal(bridge.listPending()[0].name, "aurora");
});

test("the same unapproved channel reuses its existing pairing code across messages", async () => {
  const bridge = createDiscordBridge({ dataDir: createTempDir() });
  const first = await bridge.handleIncomingMessage({ channelId: "222", text: "one" });
  const second = await bridge.handleIncomingMessage({ channelId: "222", text: "two" });
  assert.equal(first, second);
});

test("approvePairing moves a channel from pending to approved and returns its channelId", async () => {
  const bridge = createDiscordBridge({ dataDir: createTempDir() });
  const reply = await bridge.handleIncomingMessage({ channelId: "333", text: "hi" });
  const code = reply.match(/: (\w{6})$/)[1];

  const channelId = bridge.approvePairing(code);
  assert.equal(channelId, "333");
  assert.equal(bridge.isApproved("333"), true);
  assert.equal(bridge.listPending().length, 0);
  assert.equal(bridge.listApproved().length, 1);
});

test("approvePairing returns null for an unknown code", () => {
  const bridge = createDiscordBridge({ dataDir: createTempDir() });
  assert.equal(bridge.approvePairing("NOPE12"), null);
});

test("an approved channel's message routes through replyFn with a per-channel sessionId", async () => {
  let received = null;
  const bridge = createDiscordBridge({
    dataDir: createTempDir(),
    replyFn: async (text, options) => {
      received = { text, options };
      return "a real reply";
    },
  });
  const code = (await bridge.handleIncomingMessage({ channelId: "444", text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const reply = await bridge.handleIncomingMessage({ channelId: "444", text: "what's the weather" });
  assert.equal(reply, "a real reply");
  assert.equal(received.text, "what's the weather");
  assert.equal(received.options.sessionId, "discord-444");
});

test("handleIncomingMessage truncates to MAX_TEXT_CHARS and requires a channelId", async () => {
  const bridge = createDiscordBridge({
    dataDir: createTempDir(),
    replyFn: async (text) => text,
  });
  const code = (await bridge.handleIncomingMessage({ channelId: "555", text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const longText = "x".repeat(MAX_TEXT_CHARS + 500);
  const reply = await bridge.handleIncomingMessage({ channelId: "555", text: longText });
  assert.equal(reply.length, MAX_TEXT_CHARS);

  await assert.rejects(() => bridge.handleIncomingMessage({ text: "hi" }), /channelId is required/);
});

function fakeMessage({ authorBot = false, channelType = DISCORD_DM_CHANNEL_TYPE, content = "hi", username = "aurora" } = {}) {
  const sent = [];
  return {
    message: {
      author: { bot: authorBot, username },
      channel: { type: channelType, id: "chan-1", send: async (text) => sent.push(text) },
      content,
    },
    sent,
  };
}

test("handleDiscordMessage ignores messages from bots", async () => {
  const bridge = createDiscordBridge({ dataDir: createTempDir(), replyFn: async () => "pong" });
  const { message, sent } = fakeMessage({ authorBot: true });
  await handleDiscordMessage({ message, bridge });
  assert.deepEqual(sent, []);
  assert.equal(bridge.listPending().length, 0);
});

test("handleDiscordMessage ignores non-DM channels", async () => {
  const bridge = createDiscordBridge({ dataDir: createTempDir(), replyFn: async () => "pong" });
  const { message, sent } = fakeMessage({ channelType: 0 });
  await handleDiscordMessage({ message, bridge });
  assert.deepEqual(sent, []);
  assert.equal(bridge.listPending().length, 0);
});

test("handleDiscordMessage pairs a new DM and sends back the pairing code", async () => {
  const bridge = createDiscordBridge({ dataDir: createTempDir() });
  const { message, sent } = fakeMessage({ content: "hello" });
  await handleDiscordMessage({ message, bridge });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /This chat isn't paired/);
});

test("handleDiscordMessage routes an approved DM through the real reply pipeline", async () => {
  const dataDir = createTempDir();
  const bridge = createDiscordBridge({ dataDir, replyFn: async () => "pong" });
  const code = (await bridge.handleIncomingMessage({ channelId: "chan-1", text: "hi" })).match(/: (\w{6})$/)[1];
  bridge.approvePairing(code);

  const { message, sent } = fakeMessage({ content: "what's up" });
  await handleDiscordMessage({ message, bridge });
  assert.deepEqual(sent, ["pong"]);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createChannelPairingBridge } = require("../channel-pairing-bridge");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-channel-pairing-"));
}

function makeBridge(overrides = {}) {
  return createChannelPairingBridge({
    dataDir: createTempDir(),
    idField: "chatId",
    maxTextChars: 100,
    sessionPrefix: "test",
    ...overrides,
  });
}

test("createChannelPairingBridge requires dataDir/idField/maxTextChars/sessionPrefix", () => {
  assert.throws(() => createChannelPairingBridge({}), /dataDir is required/);
  assert.throws(() => createChannelPairingBridge({ dataDir: "x" }), /idField is required/);
  assert.throws(
    () => createChannelPairingBridge({ dataDir: "x", idField: "chatId" }),
    /maxTextChars is required/,
  );
  assert.throws(
    () => createChannelPairingBridge({ dataDir: "x", idField: "chatId", maxTextChars: 10 }),
    /sessionPrefix is required/,
  );
});

test("an unapproved id gets a pairing code back instead of a real reply", async () => {
  const bridge = makeBridge();
  const reply = await bridge.handleIncomingMessage({ id: "111", text: "hello" });
  assert.match(reply, /isn't paired with Mana yet/);
  assert.match(reply, /[A-Z0-9]{6}/);
  assert.equal(bridge.isApproved("111"), false);
});

test("the same id re-requesting gets the same pairing code, not a new one", async () => {
  const bridge = makeBridge();
  const first = await bridge.handleIncomingMessage({ id: "111", text: "hi" });
  const second = await bridge.handleIncomingMessage({ id: "111", text: "hi again" });
  const codeOf = (reply) => reply.match(/[A-Z0-9]{6}$/)[0];
  assert.equal(codeOf(first), codeOf(second));
});

test("approvePairing approves the matching id and clears it from pending", async () => {
  const bridge = makeBridge();
  const reply = await bridge.handleIncomingMessage({ id: "111", text: "hi", senderName: "Alex" });
  const code = reply.match(/[A-Z0-9]{6}$/)[0];

  const approvedId = bridge.approvePairing(code);
  assert.equal(approvedId, "111");
  assert.equal(bridge.isApproved("111"), true);
  assert.deepEqual(bridge.listPending(), []);
  assert.equal(bridge.listApproved().length, 1);
  assert.equal(bridge.listApproved()[0].chatId, "111");
});

test("approvePairing returns null for a code that doesn't match anything pending", () => {
  const bridge = makeBridge();
  assert.equal(bridge.approvePairing("NOPE00"), null);
});

test("listPending/listApproved use the configured idField name", async () => {
  const bridge = makeBridge({ idField: "channelId" });
  await bridge.handleIncomingMessage({ id: "222", text: "hi" });
  assert.equal(bridge.listPending()[0].channelId, "222");
  assert.equal(bridge.listPending()[0].chatId, undefined);
});

test("an approved id's message routes through replyFn with the configured sessionPrefix", async () => {
  const calls = [];
  const bridge = makeBridge({
    sessionPrefix: "telegram",
    replyFn: async (text, opts) => {
      calls.push({ text, opts });
      return `echo: ${text}`;
    },
  });
  const code = (await bridge.handleIncomingMessage({ id: "111", text: "hi" })).match(/[A-Z0-9]{6}$/)[0];
  bridge.approvePairing(code);

  const reply = await bridge.handleIncomingMessage({ id: "111", text: "hello there" });
  assert.equal(reply, "echo: hello there");
  assert.deepEqual(calls, [{ text: "hello there", opts: { sessionId: "telegram-111" } }]);
});

test("handleIncomingMessage truncates to maxTextChars and requires an id (named per idField in the error)", async () => {
  const bridge = makeBridge({
    idField: "channelId",
    maxTextChars: 5,
    replyFn: async (text) => text,
  });
  const code = (await bridge.handleIncomingMessage({ id: "111", text: "hi" })).match(/[A-Z0-9]{6}$/)[0];
  bridge.approvePairing(code);

  const reply = await bridge.handleIncomingMessage({ id: "111", text: "hello world" });
  assert.equal(reply, "hello");

  await assert.rejects(() => bridge.handleIncomingMessage({ text: "hi" }), /channelId is required/);
});

test("an approved id sending an empty message gets no reply, without calling replyFn", async () => {
  let called = false;
  const bridge = makeBridge({ replyFn: async () => { called = true; return "x"; } });
  const code = (await bridge.handleIncomingMessage({ id: "111", text: "hi" })).match(/[A-Z0-9]{6}$/)[0];
  bridge.approvePairing(code);

  const reply = await bridge.handleIncomingMessage({ id: "111", text: "   " });
  assert.equal(reply, null);
  assert.equal(called, false);
});

test("an approved id's message throws a clear error when no replyFn is configured", async () => {
  const bridge = makeBridge();
  const code = (await bridge.handleIncomingMessage({ id: "111", text: "hi" })).match(/[A-Z0-9]{6}$/)[0];
  bridge.approvePairing(code);
  await assert.rejects(
    () => bridge.handleIncomingMessage({ id: "111", text: "hello" }),
    /no reply function configured/,
  );
});

test("state persists across bridge instances pointed at the same dataDir", async () => {
  const dataDir = createTempDir();
  const bridgeA = makeBridge({ dataDir });
  const reply = await bridgeA.handleIncomingMessage({ id: "111", text: "hi" });
  const code = reply.match(/[A-Z0-9]{6}$/)[0];
  bridgeA.approvePairing(code);

  const bridgeB = makeBridge({ dataDir });
  assert.equal(bridgeB.isApproved("111"), true);
});

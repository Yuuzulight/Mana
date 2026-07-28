const assert = require("node:assert/strict");
const test = require("node:test");

const { parseVoiceCommand, createVoiceCommandHandler } = require("../discord-voice-commands");

function createFakeMessage(content, channelId = "dm-channel-1") {
  const sent = [];
  return {
    content,
    channel: { id: channelId, send: async (text) => sent.push(text) },
    sent,
  };
}

function createFakeVoiceChannel(id = "voice-channel-1", isVoiceBased = true) {
  return {
    id,
    isVoiceBased: () => isVoiceBased,
    guild: { id: "guild-1", voiceAdapterCreator: "fake-adapter-creator" },
  };
}

function createFakeVoice(overrides = {}) {
  return {
    joinVoiceChannel: overrides.joinVoiceChannel || (() => ({ destroy: () => {} })),
    entersState: overrides.entersState || (async () => {}),
    VoiceConnectionStatus: { Ready: "ready" },
  };
}

function createFakeClient(fetchResult) {
  return { channels: { fetch: async () => fetchResult } };
}

test("parseVoiceCommand recognizes !join <channelId>, !leave, and rejects everything else", () => {
  assert.deepEqual(parseVoiceCommand("!join 123456789012345"), { command: "join", channelId: "123456789012345" });
  assert.deepEqual(parseVoiceCommand("!JOIN 123456789012345"), { command: "join", channelId: "123456789012345" });
  assert.deepEqual(parseVoiceCommand("!leave"), { command: "leave" });
  assert.deepEqual(parseVoiceCommand("!LEAVE"), { command: "leave" });
  assert.equal(parseVoiceCommand("hello mana"), null);
  assert.equal(parseVoiceCommand("!join"), null);
  assert.equal(parseVoiceCommand("!join abc"), null);
  assert.equal(parseVoiceCommand(""), null);
});

test("!join with a valid voice channel creates a session and confirms", async () => {
  const targetChannel = createFakeVoiceChannel();
  const client = createFakeClient(targetChannel);
  const voice = createFakeVoice();
  const createSessionCalls = [];
  const fakeSession = { destroy: () => {} };
  const sessions = new Map();

  const handler = createVoiceCommandHandler({
    client,
    voice,
    opus: {},
    whisperQueue: {},
    replyFn: async () => {},
    synthesizeReply: async () => {},
    sessions,
    createSession: (opts) => {
      createSessionCalls.push(opts);
      return fakeSession;
    },
  });

  const message = createFakeMessage("!join 123456789012345");
  const handled = await handler.tryHandle(message);

  assert.equal(handled, true);
  assert.equal(createSessionCalls.length, 1);
  assert.equal(createSessionCalls[0].channelId, targetChannel.id);
  assert.deepEqual(sessions.get("dm-channel-1"), { session: fakeSession, voiceChannelId: targetChannel.id });
  assert.deepEqual(message.sent, ["Joined <#voice-channel-1>."]);
});

test("!join with a non-voice channel sends an error and never joins", async () => {
  const client = createFakeClient(createFakeVoiceChannel("text-channel-1", false));
  let joinCalled = false;
  const voice = createFakeVoice({ joinVoiceChannel: () => { joinCalled = true; return {}; } });

  const handler = createVoiceCommandHandler({ client, voice, opus: {}, whisperQueue: {}, replyFn: async () => {}, synthesizeReply: async () => {} });
  const message = createFakeMessage("!join 123456789012345");
  await handler.tryHandle(message);

  assert.equal(joinCalled, false);
  assert.deepEqual(message.sent, ["That doesn't look like a voice channel I can join."]);
});

test("!join when the channel can't be fetched sends an error and never joins", async () => {
  const client = { channels: { fetch: async () => { throw new Error("unknown channel"); } } };
  let joinCalled = false;
  const voice = createFakeVoice({ joinVoiceChannel: () => { joinCalled = true; return {}; } });

  const handler = createVoiceCommandHandler({ client, voice, opus: {}, whisperQueue: {}, replyFn: async () => {}, synthesizeReply: async () => {} });
  await handler.tryHandle(createFakeMessage("!join 123456789012345"));

  assert.equal(joinCalled, false);
});

test("!join when entersState rejects destroys the connection and reports the error", async () => {
  const client = createFakeClient(createFakeVoiceChannel());
  const destroyCalls = [];
  const connection = { destroy: () => destroyCalls.push(true) };
  const voice = createFakeVoice({
    joinVoiceChannel: () => connection,
    entersState: async () => { throw new Error("timed out"); },
  });

  const handler = createVoiceCommandHandler({ client, voice, opus: {}, whisperQueue: {}, replyFn: async () => {}, synthesizeReply: async () => {} });
  const message = createFakeMessage("!join 123456789012345");
  await handler.tryHandle(message);

  assert.deepEqual(destroyCalls, [true]);
  assert.deepEqual(message.sent, ["Couldn't join that channel: timed out"]);
});

test("!leave with an active session destroys it, removes it, and confirms", async () => {
  const destroyCalls = [];
  const sessions = new Map([["dm-channel-1", { session: { destroy: () => destroyCalls.push(true) }, voiceChannelId: "voice-channel-1" }]]);
  const handler = createVoiceCommandHandler({
    client: createFakeClient(null),
    voice: createFakeVoice(),
    opus: {},
    whisperQueue: {},
    replyFn: async () => {},
    synthesizeReply: async () => {},
    sessions,
  });

  const message = createFakeMessage("!leave");
  const handled = await handler.tryHandle(message);

  assert.equal(handled, true);
  assert.deepEqual(destroyCalls, [true]);
  assert.equal(sessions.has("dm-channel-1"), false);
  assert.deepEqual(message.sent, ["Left the voice channel."]);
});

test("!leave with no active session reports that instead of erroring", async () => {
  const handler = createVoiceCommandHandler({
    client: createFakeClient(null),
    voice: createFakeVoice(),
    opus: {},
    whisperQueue: {},
    replyFn: async () => {},
    synthesizeReply: async () => {},
  });

  const message = createFakeMessage("!leave");
  await handler.tryHandle(message);

  assert.deepEqual(message.sent, ["I'm not in a voice channel right now."]);
});

test("!join replaces an existing session for that DM, destroying the old one first", async () => {
  const oldDestroyCalls = [];
  const sessions = new Map([["dm-channel-1", { session: { destroy: () => oldDestroyCalls.push(true) }, voiceChannelId: "old-voice-channel" }]]);
  const client = createFakeClient(createFakeVoiceChannel("new-voice-channel"));
  const voice = createFakeVoice();
  const newSession = { destroy: () => {} };

  const handler = createVoiceCommandHandler({
    client,
    voice,
    opus: {},
    whisperQueue: {},
    replyFn: async () => {},
    synthesizeReply: async () => {},
    sessions,
    createSession: () => newSession,
  });

  await handler.tryHandle(createFakeMessage("!join 123456789012345"));

  assert.deepEqual(oldDestroyCalls, [true]);
  assert.deepEqual(sessions.get("dm-channel-1"), { session: newSession, voiceChannelId: "new-voice-channel" });
});

test("a non-command message returns false and has no side effects", async () => {
  const client = createFakeClient(null);
  const voice = createFakeVoice();
  const handler = createVoiceCommandHandler({ client, voice, opus: {}, whisperQueue: {}, replyFn: async () => {}, synthesizeReply: async () => {} });

  const message = createFakeMessage("just chatting, not a command");
  const handled = await handler.tryHandle(message);

  assert.equal(handled, false);
  assert.deepEqual(message.sent, []);
});

test("createVoiceCommandHandler requires client and voice", () => {
  assert.throws(() => createVoiceCommandHandler({}), /client is required/);
  assert.throws(() => createVoiceCommandHandler({ client: {} }), /voice is required/);
});

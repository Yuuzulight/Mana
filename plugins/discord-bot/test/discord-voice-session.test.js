const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createDiscordVoiceSession } = require("../discord-voice-session");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-discord-voice-session-"));
}

// Fakes matching @discordjs/voice's real shapes closely enough to drive
// discord-voice-session.js's actual logic -- a fake opus stream (just a
// PassThrough the test writes raw "PCM" bytes into and ends), a fake
// receiver with a real EventEmitter for `speaking`, and a fake AudioPlayer
// that's a real EventEmitter (so player.on(AudioPlayerStatus.Idle, ...)
// behaves exactly like the real one).
function createFakeConnection() {
  const speaking = new EventEmitter();
  const subscribeCalls = [];
  const opusStreams = new Map();

  function opusStreamFor(userId) {
    if (!opusStreams.has(userId)) opusStreams.set(userId, new PassThrough());
    return opusStreams.get(userId);
  }

  const receiver = {
    speaking,
    subscribe(userId, options) {
      subscribeCalls.push({ userId, options });
      return opusStreamFor(userId);
    },
  };

  return {
    receiver,
    subscribeCalls,
    opusStreamFor,
    subscribe: () => {}, // connection.subscribe(player) -- no-op fake
    destroy: function () {
      this.destroyed = true;
    },
  };
}

function createFakeOpusModule() {
  // A fake opus.Decoder: a passthrough Transform that just forwards
  // whatever bytes come in as "decoded PCM" -- the actual decode math
  // isn't this module's concern, only that data/end are wired correctly.
  class FakeDecoder extends PassThrough {
    constructor(opts) {
      super();
      this.opts = opts;
    }
  }
  return { Decoder: FakeDecoder };
}

const AudioPlayerStatus = { Idle: "idle", Playing: "playing" };
const EndBehaviorType = { AfterSilence: 1, Manual: 0 };

function createFakeVoiceModule() {
  const players = [];
  function createAudioPlayer() {
    const player = new EventEmitter();
    player.playCalls = [];
    player.stopCalls = [];
    player.play = (resource) => player.playCalls.push(resource);
    player.stop = (force) => {
      player.stopCalls.push(force);
      player.emit(AudioPlayerStatus.Idle);
    };
    players.push(player);
    return player;
  }
  return {
    createAudioPlayer,
    createAudioResource: (stream) => ({ stream }),
    entersState: async () => {},
    AudioPlayerStatus,
    EndBehaviorType,
    players,
  };
}

function createSession(overrides = {}) {
  const connection = overrides.connection || createFakeConnection();
  const opus = overrides.opus || createFakeOpusModule();
  const voice = overrides.voice || createFakeVoiceModule();
  const whisperQueue = overrides.whisperQueue || { transcribe: async () => "hello mana" };
  const replyFn = overrides.replyFn || (async () => "hi there");
  const synthesizeReply = overrides.synthesizeReply || (async () => Buffer.from("fake wav bytes"));

  const session = createDiscordVoiceSession({
    connection,
    opus,
    voice,
    whisperQueue,
    replyFn,
    synthesizeReply,
    tmpDir: createTempDir(),
    channelId: "voice-channel-1",
    silenceMs: 500,
  });
  return { session, connection, opus, voice, whisperQueue, replyFn, synthesizeReply };
}

// Drives one full "user talks, stream ends" cycle through the fake opus
// stream and waits for the async handleUtterance chain to settle.
async function simulateUtterance(connection, userId, pcmChunk) {
  connection.receiver.speaking.emit("start", userId);
  const opusStream = connection.opusStreamFor(userId);
  opusStream.write(pcmChunk);
  opusStream.end();
  // Let the pipe()/data/end microtask chain and the subsequent async
  // handleUtterance() actually run before the test asserts on it.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("a speaking-start event subscribes to that user with EndBehaviorType.AfterSilence", () => {
  const { connection } = createSession();
  connection.receiver.speaking.emit("start", "user-1");
  assert.equal(connection.subscribeCalls.length, 1);
  assert.equal(connection.subscribeCalls[0].userId, "user-1");
  assert.deepEqual(connection.subscribeCalls[0].options, { end: { behavior: EndBehaviorType.AfterSilence, duration: 500 } });
});

test("a full utterance is transcribed, replied to, and spoken back", async () => {
  const transcribeCalls = [];
  const replyCalls = [];
  const synthesizeCalls = [];
  const { connection, voice } = createSession({
    whisperQueue: {
      transcribe: async (wavPath) => {
        transcribeCalls.push(wavPath);
        return "what's the weather";
      },
    },
    replyFn: async (text, opts) => {
      replyCalls.push({ text, opts });
      return "it's sunny";
    },
    synthesizeReply: async (text) => {
      synthesizeCalls.push(text);
      return Buffer.from("wav-bytes");
    },
  });

  await simulateUtterance(connection, "user-1", Buffer.from([1, 2, 3, 4]));

  assert.equal(transcribeCalls.length, 1);
  assert.match(transcribeCalls[0], /\.wav$/);
  assert.deepEqual(replyCalls, [{ text: "what's the weather", opts: { sessionId: "discord-voice-voice-channel-1" } }]);
  assert.deepEqual(synthesizeCalls, ["it's sunny"]);
  assert.equal(voice.players[0].playCalls.length, 1);
});

test("an empty transcript produces no reply and no playback", async () => {
  const replyCalls = [];
  const { connection, voice } = createSession({
    whisperQueue: { transcribe: async () => "   " },
    replyFn: async (text) => {
      replyCalls.push(text);
      return "should not be called";
    },
  });

  await simulateUtterance(connection, "user-1", Buffer.from([1, 2]));
  assert.equal(replyCalls.length, 0);
  assert.equal(voice.players[0].playCalls.length, 0);
});

test("an empty reply (nothing to say) produces no playback", async () => {
  const { connection, voice } = createSession({ replyFn: async () => null });
  await simulateUtterance(connection, "user-1", Buffer.from([1, 2]));
  assert.equal(voice.players[0].playCalls.length, 0);
});

test("barge-in: a new speaking-start event stops in-progress playback", async () => {
  // synthesizeReply is deliberately deferred (resolved manually below) so
  // the test can observe the moment between "playback started" (playing =
  // true, waiting on the fake player's Idle event) and "playback
  // finished" -- a second speaking-start event during that window should
  // call player.stop(true) via the barge-in path, not wait its turn.
  let resolveSynth;
  const { connection, voice } = createSession({
    synthesizeReply: () => new Promise((resolve) => { resolveSynth = resolve; }),
  });
  const player = voice.players[0];

  connection.receiver.speaking.emit("start", "user-1");
  const opusStream = connection.opusStreamFor("user-1");
  opusStream.write(Buffer.from([1, 2]));
  opusStream.end();
  await new Promise((resolve) => setTimeout(resolve, 20));

  resolveSynth(Buffer.from("wav"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(player.playCalls.length, 1); // now actually playing

  connection.receiver.speaking.emit("start", "user-2");
  assert.deepEqual(player.stopCalls, [true]);
});

test("destroy stops the player and destroys the connection", () => {
  const { session, connection, voice } = createSession();
  session.destroy();
  assert.deepEqual(voice.players[0].stopCalls, [true]);
  assert.equal(connection.destroyed, true);
});

test("createDiscordVoiceSession requires its core dependencies", () => {
  assert.throws(() => createDiscordVoiceSession({}), /connection is required/);
  assert.throws(() => createDiscordVoiceSession({ connection: {} }), /opus is required/);
});

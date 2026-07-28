// Issue #187: joins a Discord voice channel, transcribes each speaker's
// utterance (Discord's own client-side VAD already signals turn
// boundaries -- see "Endpointing" below, no custom silence detector
// needed), routes the transcript through Mana's real reply pipeline, and
// speaks the reply back.
const path = require("path");
const { Readable } = require("stream");
const { pcmToWav } = require("./pcm-to-wav");

const DEFAULT_SILENCE_MS = 1000;
const DISCORD_OPUS_RATE = 48000;
const DISCORD_OPUS_CHANNELS = 2;
const DISCORD_OPUS_FRAME_SIZE = 960;

// Endpointing: Discord's own client sends a speaking-start/speaking-stop
// signal over the Gateway for each user (@discordjs/voice surfaces this as
// connection.receiver.speaking's "start" event), and
// receiver.subscribe(userId, {end: {behavior: AfterSilence, duration}})
// auto-ends that user's audio stream after a given period of silence.
// Both are already part of @discordjs/voice -- issue #187's own text
// assumed "no reusable server-side endpointing... needs its own simple
// energy-based or timeout-based silence detection" before this was built;
// reading the actual library's API (not assuming from the issue text)
// found that assumption was wrong, so no custom VAD was written.
//
// options.connection: a real (or fake) VoiceConnection, already
// joined -- see index.js for the real joinVoiceChannel() call.
// options.opus: prism-media's opus module (injectable for tests).
// options.whisperQueue: {transcribe(wavPath) => Promise<string>} (see
// whisper-queue.js).
// options.replyFn: (text, {sessionId}) => Promise<string> -- same shape
// discord-bot.js's bridge already uses for DM text.
// options.synthesizeReply: (text) => Promise<Buffer> (WAV bytes) -- same
// function server.js's /synthesize route already calls.
// options.voice: injectable {createAudioPlayer, createAudioResource,
// entersState, AudioPlayerStatus, EndBehaviorType} from @discordjs/voice.
function createDiscordVoiceSession(options = {}) {
  const {
    connection,
    opus,
    whisperQueue,
    replyFn,
    synthesizeReply,
    voice,
    tmpDir = require("os").tmpdir(),
    silenceMs = DEFAULT_SILENCE_MS,
    channelId,
    fs = require("fs"),
    onError = (e) => console.warn("discord-voice-session:", e && e.message ? e.message : e),
  } = options;

  if (!connection) throw new Error("connection is required");
  if (!opus) throw new Error("opus is required");
  if (!whisperQueue) throw new Error("whisperQueue is required");
  if (!replyFn) throw new Error("replyFn is required");
  if (!synthesizeReply) throw new Error("synthesizeReply is required");
  if (!voice) throw new Error("voice is required");

  const player = voice.createAudioPlayer();
  connection.subscribe(player);
  const subscribedUsers = new Set();
  let playing = false;

  // Barge-in: if someone starts talking while Mana is mid-reply, stop her
  // audio immediately rather than talking over them -- the same
  // interrupt_response behavior speech-to-speech's realtime protocol
  // documents (see issue #187's own "Prior art found" section), achieved
  // here for free from Discord's own speaking-start signal rather than a
  // separate barge-in detector.
  function stopIfPlaying() {
    if (playing) {
      player.stop(true);
    }
  }

  async function playReplyAudio(wavBuffer) {
    const resource = voice.createAudioResource(Readable.from(wavBuffer));
    playing = true;
    player.play(resource);
    try {
      await voice.entersState(player, voice.AudioPlayerStatus.Playing, 5000).catch(() => {});
      await new Promise((resolve) => {
        const onIdle = () => {
          player.off(voice.AudioPlayerStatus.Idle, onIdle);
          resolve();
        };
        player.on(voice.AudioPlayerStatus.Idle, onIdle);
      });
    } finally {
      playing = false;
    }
  }

  async function handleUtterance(userId, pcmBuffer) {
    if (!pcmBuffer.length) return;
    const wavPath = path.join(tmpDir, `mana-discord-voice-${userId}-${Date.now()}.wav`);
    fs.writeFileSync(wavPath, pcmToWav(pcmBuffer));
    try {
      const transcript = (await whisperQueue.transcribe(wavPath)).trim();
      if (!transcript) return;
      const reply = await replyFn(transcript, { sessionId: `discord-voice-${channelId}` });
      if (!reply) return;
      const audio = await synthesizeReply(reply);
      await playReplyAudio(audio);
    } finally {
      try {
        fs.unlinkSync(wavPath);
      } catch (e) {}
    }
  }

  function subscribeToUser(userId) {
    if (subscribedUsers.has(userId)) return;
    subscribedUsers.add(userId);

    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: voice.EndBehaviorType.AfterSilence, duration: silenceMs },
    });
    const decoder = new opus.Decoder({
      rate: DISCORD_OPUS_RATE,
      channels: DISCORD_OPUS_CHANNELS,
      frameSize: DISCORD_OPUS_FRAME_SIZE,
    });
    const chunks = [];
    opusStream.pipe(decoder);
    decoder.on("data", (chunk) => chunks.push(chunk));
    decoder.once("end", () => {
      subscribedUsers.delete(userId);
      handleUtterance(userId, Buffer.concat(chunks)).catch(onError);
    });
    decoder.once("error", (e) => {
      subscribedUsers.delete(userId);
      onError(e);
    });
  }

  connection.receiver.speaking.on("start", (userId) => {
    stopIfPlaying();
    subscribeToUser(userId);
  });

  function destroy() {
    player.stop(true);
    connection.destroy();
  }

  return { destroy, _subscribeToUser: subscribeToUser, _handleUtterance: handleUtterance };
}

module.exports = { createDiscordVoiceSession, DEFAULT_SILENCE_MS };

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const whisperDiscovery = require("../../node-bot/whisper-discovery");
const videoWatch = require("./video-watch");

function resolveBin(envVar, fallback, env) {
  return env[envVar] || fallback;
}

async function registerVideoWatchRoutes(app, deps = {}) {
  const env = deps.env || process.env;
  const runVisionReply = deps.runVisionReply;

  app.post("/video/watch", async (req, res) => {
    const source = req.body?.source;
    const question = req.body?.question;
    if (!source || typeof source !== "string") {
      return res.status(400).json({ error: "source is required" });
    }
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "question is required" });
    }

    const workDir = path.join(os.tmpdir(), `mana-video-watch-${crypto.randomBytes(6).toString("hex")}`);
    try {
      const whisperBin = whisperDiscovery.findWhisperBin({ env });
      const whisperModel = whisperDiscovery.findWhisperModel({ env });

      const watchResult = await videoWatch.watchVideo(source, {
        workDir,
        ytDlpBin: resolveBin("MANA_YTDLP_PATH", "yt-dlp", env),
        ffmpegBin: resolveBin("MANA_FFMPEG_PATH", "ffmpeg", env),
        ffprobeBin: resolveBin("MANA_FFPROBE_PATH", "ffprobe", env),
        whisperBin,
        whisperModel,
        spawnFn: deps.spawnFn,
      });
      const answer = await videoWatch.answerAboutVideo(question, watchResult, {
        runVisionReply,
      });

      return res.json({
        durationSeconds: watchResult.durationSeconds,
        frameCount: watchResult.frameCount,
        transcriptSource: watchResult.transcriptSource,
        transcript: watchResult.transcript,
        answer,
      });
    } catch (e) {
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (e) {
        console.warn("video-watch: failed to clean up temp dir:", e?.message || e);
      }
    }
  });
}

module.exports = {
  ...videoWatch,
  key: "videoWatch",
  name: "Video Watch",
  category: "Vision",
  defaultEnabled: false,
  description:
    "Download (yt-dlp) or accept a local video file, pull captions or fall back to local Whisper transcription, extract a duration-scaled set of frames, and answer a question grounded in what's actually shown/said -- no external API key required.",
  registerRoutes: registerVideoWatchRoutes,
  getHealth: (deps = {}) => {
    const env = deps.env || process.env;
    const whisperModel = whisperDiscovery.findWhisperModel({ env });
    return {
      status: whisperModel ? "configured" : "unavailable",
      configured: Boolean(whisperModel),
      message: whisperModel
        ? "Video watching is available (Whisper fallback ready; yt-dlp/ffmpeg assumed on PATH)."
        : "No local Whisper model found -- caption-only videos will still work, but transcription fallback won't.",
    };
  },
};

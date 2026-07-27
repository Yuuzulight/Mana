// Issue #154: give Mana a video-watching path -- download (yt-dlp) or
// accept a local file, pull captions first (free) and only fall back to
// local Whisper transcription when the source has none (still free, no
// external API key either way), extract a duration-scaled set of frames,
// and hand transcript + frames to the existing local vision pipeline
// (llama-server-runtime.js's runVisionReply) for a grounded answer.
//
// Every external process (yt-dlp/ffmpeg/ffprobe/whisper-cli) is injected
// as a spawnFn so tests never invoke a real binary -- same DI pattern as
// acp-memory-store.js/cron-scheduler.js, just for child processes instead
// of storage.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MIN_FRAMES = 8;
const MAX_FRAMES = 20;
const HARD_FPS_CEILING = 2;
// Downscale extracted frames to this max width before handing them to the
// vision model (see extractFrames) -- a local small-context vision model
// pays real context-window cost per frame, unlike a cloud model with a
// huge context window. Measured directly against this codebase's own
// default local vision setup (Qwen2.5-VL-3B, llama-server's default -c
// 4096): a full 1280x720 frame costs ~1210 prompt tokens (so even
// MIN_FRAMES would blow the entire context on images alone), while a
// frame downscaled to 336px wide costs ~88 tokens. The original
// MIN_FRAMES=12/MAX_FRAMES=100 budget (matching the reference
// implementation's cloud-model-oriented numbers) was never checked
// against a real local model's context window before this was first
// built -- confirmed broken in manual verification (both a 39s and a
// ~20-minute test video failed with "exceeds context size" at full
// resolution and the original frame counts) and fixed here.
const DEFAULT_FRAME_MAX_DIMENSION = 336;

// Duration-scaled frame budget: roughly 1 frame per 5 seconds up to
// MAX_FRAMES worth of duration, then flat at MAX_FRAMES for anything
// longer -- deliberately conservative (not the reference implementation's
// "~12-30 short, up to 100 long" cloud-model numbers) so that, combined
// with the downscaling above, a typical video's frames + transcript +
// question comfortably fit inside a local model's default context window.
// The hard 2fps ceiling still wins over the floor for very short clips (a
// 2-second video can't produce 8 distinct frames).
function computeFrameBudget(durationSeconds) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  if (duration <= 0) return MIN_FRAMES;

  const raw = duration / 5;
  const scaled = Math.max(MIN_FRAMES, Math.min(Math.round(raw), MAX_FRAMES));
  const ceiling = Math.max(1, Math.floor(duration * HARD_FPS_CEILING));
  return Math.min(scaled, ceiling);
}

// Parses WEBVTT/SRT-ish caption files into {start, end, text} segments.
// Deliberately simple -- real-world caption files vary a lot, but this
// covers the standard "HH:MM:SS.mmm --> HH:MM:SS.mmm" cue format both
// yt-dlp's --convert-subs vtt output and most manual caption tracks use.
const CUE_TIME_RE =
  /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/;

function timeToSeconds(value) {
  const [h, m, s] = value.replace(",", ".").split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// A single-pass character scan rather than a regex -- caption text is
// downloaded from wherever yt-dlp/the source pulled it from, so it's
// effectively untrusted input. A regex-based tag stripper (`<[^>]+>`)
// flagged as both an incomplete sanitizer (a malformed/nested `<<script>`
// can survive one pass) and a polynomial-regex risk on CodeQL; this scan
// has neither problem since it just tracks in/out of a tag byte-by-byte.
function stripInlineTags(text) {
  let result = "";
  let insideTag = false;
  for (const ch of String(text || "")) {
    if (ch === "<") {
      insideTag = true;
      continue;
    }
    if (ch === ">") {
      insideTag = false;
      continue;
    }
    if (!insideTag) result += ch;
  }
  return result;
}

function parseCaptions(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const segments = [];
  let current = null;

  for (const line of lines) {
    const match = CUE_TIME_RE.exec(line);
    if (match) {
      if (current && current.text.trim()) segments.push(current);
      current = { start: timeToSeconds(match[1]), end: timeToSeconds(match[2]), text: "" };
      continue;
    }
    if (!current) continue;
    const clean = stripInlineTags(line).trim();
    if (clean && clean.toUpperCase() !== "WEBVTT") {
      current.text = current.text ? `${current.text} ${clean}` : clean;
    }
  }
  if (current && current.text.trim()) segments.push(current);
  return segments;
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatTimestampedTranscript(segments) {
  return (segments || [])
    .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
    .join("\n");
}

// Downloads a video (and captions, if the source has any) via yt-dlp.
// Returns the local video file path and, if found, a captions file path.
function downloadVideo(url, options = {}) {
  const outputDir = options.outputDir;
  const ytDlpBin = options.ytDlpBin || "yt-dlp";
  const run = options.spawnFn || spawnSync;
  fs.mkdirSync(outputDir, { recursive: true });

  const result = run(
    ytDlpBin,
    [
      "-o",
      path.join(outputDir, "video.%(ext)s"),
      "--write-subs",
      "--write-auto-sub",
      "--sub-lang",
      "en",
      "--convert-subs",
      "vtt",
      url,
    ],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`yt-dlp failed: ${result.stderr || result.error || "unknown error"}`);
  }

  const files = fs.readdirSync(outputDir);
  const videoFile = files.find((f) => f.startsWith("video.") && !f.endsWith(".vtt"));
  const captionsFile = files.find((f) => f.endsWith(".vtt"));
  if (!videoFile) {
    throw new Error("yt-dlp did not produce a video file");
  }
  return {
    videoPath: path.join(outputDir, videoFile),
    captionsPath: captionsFile ? path.join(outputDir, captionsFile) : null,
  };
}

function getVideoDurationSeconds(videoPath, options = {}) {
  const ffprobeBin = options.ffprobeBin || "ffprobe";
  const run = options.spawnFn || spawnSync;
  const result = run(
    ffprobeBin,
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", videoPath],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr || result.error || "unknown error"}`);
  }
  const parsed = JSON.parse(result.stdout || "{}");
  return Number(parsed?.format?.duration) || 0;
}

// Extracts up to frameBudget frames. Default "keyframe" mode uses
// -skip_frame nokey (a fast/cheap pass -- ffmpeg never fully decodes
// non-keyframes); optional "scene" mode trades speed for picking
// visually-distinct frames instead of whatever the encoder happened to
// keyframe on.
function extractFrames(videoPath, options = {}) {
  const outputDir = options.outputDir;
  const frameBudget = Math.max(1, Number(options.frameBudget) || MIN_FRAMES);
  const mode = options.mode === "scene" ? "scene" : "keyframe";
  const ffmpegBin = options.ffmpegBin || "ffmpeg";
  const maxDimension = Math.max(64, Number(options.frameMaxDimension) || DEFAULT_FRAME_MAX_DIMENSION);
  const run = options.spawnFn || spawnSync;
  fs.mkdirSync(outputDir, { recursive: true });

  const selectFilter =
    mode === "scene" ? "select='gt(scene,0.3)'" : "select='eq(pict_type,I)'";
  // scale=min(maxDimension,iw):-2 never upscales a frame already smaller
  // than maxDimension, and -2 keeps the height even (required by many
  // encoders) while preserving aspect ratio.
  const args = [
    ...(mode === "keyframe" ? ["-skip_frame", "nokey"] : []),
    "-i",
    videoPath,
    "-vf",
    `${selectFilter},scale='min(${maxDimension},iw)':-2`,
    "-vsync",
    "vfr",
    "-frames:v",
    String(frameBudget),
    "-q:v",
    "4",
    path.join(outputDir, "frame_%04d.jpg"),
  ];
  const result = run(ffmpegBin, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg frame extraction failed: ${result.stderr || result.error || "unknown error"}`);
  }

  const frameFiles = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
    .sort()
    .slice(0, frameBudget);
  return frameFiles.map((f) => fs.readFileSync(path.join(outputDir, f)).toString("base64"));
}

// Falls back to local Whisper when the source has no captions. Extracts
// audio to WAV first (mirrors server.js's normalizeUploadedAudio ffmpeg
// call) and parses whisper-cli's --output-json segments directly here
// (rather than reusing server.js's runWhisper) so the per-segment
// timestamps survive -- runWhisper collapses them into one joined string
// for the voice pipeline, which doesn't need timestamps but this does.
function transcribeVideoAudio(videoPath, options = {}) {
  const ffmpegBin = options.ffmpegBin || "ffmpeg";
  const whisperBin = options.whisperBin;
  const whisperModel = options.whisperModel;
  const run = options.spawnFn || spawnSync;
  const workDir = options.workDir;
  if (!whisperBin || !whisperModel) {
    throw new Error("whisperBin and whisperModel are required");
  }

  const wavPath = path.join(workDir, "audio.wav");
  const audioResult = run(ffmpegBin, ["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", wavPath], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (audioResult.status !== 0) {
    throw new Error(`ffmpeg audio extraction failed: ${audioResult.stderr || audioResult.error || "unknown error"}`);
  }

  const outBase = path.join(workDir, "transcript");
  const whisperResult = run(
    whisperBin,
    ["-m", whisperModel, "-f", wavPath, "--output-json", "-of", outBase],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  if (whisperResult.status !== 0) {
    throw new Error(`whisper-cli failed: ${whisperResult.stderr || whisperResult.error || "unknown error"}`);
  }

  const parsed = JSON.parse(fs.readFileSync(`${outBase}.json`, "utf8"));
  return (parsed?.transcription || []).map((seg) => ({
    start: (seg?.offsets?.from ?? 0) / 1000,
    end: (seg?.offsets?.to ?? 0) / 1000,
    text: String(seg?.text || "").trim(),
  }));
}

function isLikelyUrl(source) {
  return /^https?:\/\//i.test(String(source || ""));
}

// Orchestrates the whole pass: download-if-url, probe duration, pull
// captions or fall back to Whisper, extract frames. Returns everything a
// caller needs to actually answer a question, without asking one yet --
// answerAboutVideo below is the piece that calls the vision model.
async function watchVideo(source, options = {}) {
  const workDir = options.workDir;
  fs.mkdirSync(workDir, { recursive: true });

  let videoPath;
  let captionsPath = null;
  if (isLikelyUrl(source)) {
    const downloaded = downloadVideo(source, { ...options, outputDir: workDir });
    videoPath = downloaded.videoPath;
    captionsPath = downloaded.captionsPath;
  } else {
    videoPath = source;
  }

  const durationSeconds = getVideoDurationSeconds(videoPath, options);
  const frameBudget = computeFrameBudget(durationSeconds);

  let segments;
  let transcriptSource;
  if (captionsPath) {
    segments = parseCaptions(fs.readFileSync(captionsPath, "utf8"));
    transcriptSource = "captions";
  } else {
    segments = transcribeVideoAudio(videoPath, { ...options, workDir });
    transcriptSource = "whisper";
  }

  const frames = extractFrames(videoPath, {
    ...options,
    outputDir: path.join(workDir, "frames"),
    frameBudget,
  });

  return {
    videoPath,
    durationSeconds,
    frameBudget,
    frameCount: frames.length,
    frames,
    transcriptSource,
    transcript: formatTimestampedTranscript(segments),
  };
}

// Confirmed broken in manual verification: a long video's transcript (auto
// captions especially -- YouTube's overlapping caption windows repeat
// most of each line 2-3 times, as seen directly in this plugin's own test
// output) was embedded in the vision prompt with no length cap at all, so
// a ~20-minute video blew the context budget on transcript text alone even
// after the frame-count/resolution fix above. Truncated here, not at the
// source (formatTimestampedTranscript) -- the full transcript is still
// returned to the caller in the route response; only the copy actually
// sent to the model is capped.
const MAX_TRANSCRIPT_CHARS_FOR_PROMPT = 4000;

// Hands the watch result to the existing local vision pipeline for a
// grounded answer -- no new model-calling code, this just builds the
// prompt runVisionReply already expects.
async function answerAboutVideo(question, watchResult, options = {}) {
  const runVisionReply = options.runVisionReply;
  if (typeof runVisionReply !== "function") {
    throw new Error("runVisionReply is required");
  }
  const transcript = watchResult.transcript || "";
  const promptTranscript =
    transcript.length > MAX_TRANSCRIPT_CHARS_FOR_PROMPT
      ? `${transcript.slice(0, MAX_TRANSCRIPT_CHARS_FOR_PROMPT)}\n[transcript truncated]`
      : transcript;
  const prompt = [
    `Question about this video: ${question}`,
    "",
    "Timestamped transcript:",
    promptTranscript || "(no transcript available)",
  ].join("\n");
  return runVisionReply(prompt, watchResult.frames, options.maxTokens || 400);
}

module.exports = {
  MIN_FRAMES,
  MAX_FRAMES,
  HARD_FPS_CEILING,
  DEFAULT_FRAME_MAX_DIMENSION,
  MAX_TRANSCRIPT_CHARS_FOR_PROMPT,
  computeFrameBudget,
  parseCaptions,
  formatTimestamp,
  formatTimestampedTranscript,
  downloadVideo,
  getVideoDurationSeconds,
  extractFrames,
  transcribeVideoAudio,
  isLikelyUrl,
  watchVideo,
  answerAboutVideo,
};

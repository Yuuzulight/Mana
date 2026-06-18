/*
Node backend server (server.js)
- POST /transcribe : accepts multipart 'file' audio, runs whisper.cpp to transcribe, then llama.cpp to generate a reply.
- POST /synthesize : accepts JSON { text } and returns WAV audio from the configured TTS tool.
- GET /health : basic health check

Environment variables (set before running):
- WHISPER_BIN : full path to whisper.cpp main executable (e.g. C:\whisper.cpp\main.exe)
- WHISPER_MODEL : full path to whisper model file (e.g. models/ggml-base.en.bin)
- LLAMA_BIN : full path to llama.cpp/main executable (e.g. C:\llama.cpp\main.exe)
- LLAMA_MODEL : full path to GGUF model file (e.g. models/7B.gguf)
- TTS_BIN : full path to your TTS executable
- TTS_MODEL : model path or model id for your TTS executable
- TTS_ARGS_JSON : optional JSON array of CLI args with placeholders like {text}, {output}, {model}, {voice}, {speaker}
- TTS_VOICE : optional voice value used by your TTS args
- TTS_SPEAKER : optional speaker value used by your TTS args

This server aims to avoid Python. You must download and place the whisper.cpp and llama.cpp binaries and model files yourself.
*/

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
const upload = multer({ dest: path.join(__dirname, "tmp") });

const WHISPER_BIN = process.env.WHISPER_BIN || null;
const WHISPER_MODEL = process.env.WHISPER_MODEL || null;
const LLAMA_BIN = process.env.LLAMA_BIN || null;
const LLAMA_MODEL = process.env.LLAMA_MODEL || null;
const TTS_BIN = process.env.TTS_BIN || null;
const TTS_MODEL = process.env.TTS_MODEL || null;
const TTS_ARGS_JSON = process.env.TTS_ARGS_JSON || null;
const TTS_VOICE = process.env.TTS_VOICE || null;
const TTS_SPEAKER = process.env.TTS_SPEAKER || null;

if (!fs.existsSync(path.join(__dirname, "tmp"))) {
  fs.mkdirSync(path.join(__dirname, "tmp"));
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ttsConfigured: Boolean(TTS_BIN),
  });
});

function makeTmpPath(prefix, ext) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(__dirname, "tmp", `${prefix}-${unique}.${ext}`);
}

function parseTtsArgsTemplate() {
  if (!TTS_ARGS_JSON) {
    return ["-m", "{model}", "-p", "{text}", "-o", "{output}"];
  }

  let parsed;
  try {
    parsed = JSON.parse(TTS_ARGS_JSON);
  } catch (error) {
    throw new Error("TTS_ARGS_JSON must be valid JSON");
  }

  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) {
    throw new Error("TTS_ARGS_JSON must be a JSON array of strings");
  }

  return parsed;
}

function buildTtsArgs(text, outputPath) {
  if (!TTS_BIN) {
    throw new Error("TTS_BIN not configured");
  }

  const template = parseTtsArgsTemplate();
  const values = {
    "{text}": text,
    "{output}": outputPath,
    "{model}": TTS_MODEL || "",
    "{voice}": TTS_VOICE || "",
    "{speaker}": TTS_SPEAKER || "",
  };

  for (const placeholder of ["{model}", "{voice}", "{speaker}"]) {
    const needsValue = template.includes(placeholder);
    if (needsValue && !values[placeholder]) {
      throw new Error(`${placeholder.slice(1, -1).toUpperCase()} not configured`);
    }
  }

  return template.map((part) => values[part] ?? part);
}

function runTts(text) {
  if (!text) {
    throw new Error("No text provided for synthesis");
  }

  const outputPath = makeTmpPath("tts", "wav");
  const args = buildTtsArgs(text, outputPath);
  console.log("Running TTS:", TTS_BIN, args.join(" "));

  const result = spawnSync(TTS_BIN, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error("tts stderr:", result.stderr);
    throw new Error("tts failed: " + result.stderr);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error("tts did not produce an output file");
  }

  const audio = fs.readFileSync(outputPath);
  try {
    fs.unlinkSync(outputPath);
  } catch (error) {}

  return audio;
}

function findWhisperBin() {
  const candidates = [];
  if (WHISPER_BIN) {
    candidates.push(WHISPER_BIN);
  }

  const localToolDir = path.join(__dirname, "..", "tools", "whisper");
  candidates.push(
    path.join(localToolDir, "Release", "whisper-cli.exe"),
    path.join(localToolDir, "whisper-cli.exe"),
    path.join(localToolDir, "main.exe"),
  );

  const validPath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (validPath) {
    return validPath;
  }

  const checked = candidates.filter(Boolean).join(", ");
  throw new Error(
    `Whisper executable not found. Checked: ${checked}. Set WHISPER_BIN to a valid whisper-cli.exe path.`,
  );
}

function runWhisper(filePath) {
  if (!WHISPER_MODEL) {
    throw new Error("WHISPER_MODEL not configured");
  }
  const whisperBin = findWhisperBin();
  // I ask whisper-cli for JSON output so transcription parsing does not depend on stdout formatting.
  const outBase = filePath + ".out";
  const outJson = outBase + ".json";
  const args = [
    "-m",
    WHISPER_MODEL,
    "-f",
    filePath,
    "--output-json",
    "-of",
    outBase,
  ];
  console.log("Running whisper:", whisperBin, args.join(" "));
  const r = spawnSync(whisperBin, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  console.log(
    "whisper exit code",
    r.status,
    "stdout_len",
    r.stdout ? r.stdout.length : 0,
    "stderr_len",
    r.stderr ? r.stderr.length : 0,
  );
  if (r.status !== 0) {
    console.error("whisper stderr:", r.stderr);
    throw new Error("whisper failed: " + r.stderr);
  }
  // Wait briefly for the JSON file to appear
  let attempts = 0;
  while (!fs.existsSync(outJson) && attempts < 5) {
    attempts += 1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (!fs.existsSync(outJson)) {
    // fallback: try to return stdout
    const textOut = r.stdout ? r.stdout.trim() : "";
    return textOut;
  }
  try {
    const j = JSON.parse(fs.readFileSync(outJson, "utf8"));
    if (j && j.transcription && j.transcription.length > 0) {
      const t = j.transcription
        .map((s) => s.text)
        .join(" ")
        .trim();
      // cleanup json
      try {
        fs.unlinkSync(outJson);
      } catch (e) {}
      try {
        fs.unlinkSync(outBase + ".txt");
      } catch (e) {}
      return t;
    }
  } catch (e) {
    console.warn("failed to parse whisper json", e);
  }
  // fallback to stdout
  return r.stdout ? r.stdout.trim() : "";
}

function runLlama(prompt, maxTokens = 256) {
  if (!LLAMA_BIN || !LLAMA_MODEL) {
    console.warn(
      "LLAMA_BIN or LLAMA_MODEL not configured — returning placeholder reply",
    );
    // This keeps the voice round-trip testable even before the local model is wired up.
    return "(no model configured) I heard: " + prompt.slice(0, 200);
  }

  // Support either a local GGUF path or an HF repo-style identifier without branching elsewhere.
  let args = [];
  const looksLikeHfRepo =
    LLAMA_MODEL.indexOf("/") !== -1 && !fs.existsSync(LLAMA_MODEL);
  if (looksLikeHfRepo) {
    args = [
      "completion",
      "--hf-repo",
      LLAMA_MODEL,
      "-p",
      prompt,
      "-n",
      String(maxTokens),
    ];
  } else {
    args = [
      "completion",
      "-m",
      LLAMA_MODEL,
      "-p",
      prompt,
      "-n",
      String(maxTokens),
    ];
  }

  console.log("Running llama:", LLAMA_BIN, args.join(" "));
  const r = spawnSync(LLAMA_BIN, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  console.log(
    "llama exit",
    r.status,
    "stdout_len",
    r.stdout ? r.stdout.length : 0,
    "stderr_len",
    r.stderr ? r.stderr.length : 0,
  );
  if (r.status !== 0) {
    console.error("llama stderr:", r.stderr);
    throw new Error("llama failed: " + r.stderr);
  }
  // The binary usually prints the generated text to stdout after the prompt
  const out = r.stdout || "";
  // Attempt to strip the prompt echo if present
  let reply = out;
  try {
    const idx = out.indexOf("\n");
    if (idx !== -1) reply = out.slice(idx + 1);
  } catch (e) {}
  reply = reply.trim();
  return reply;
}

app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    console.log("Got file upload:", req.file);
    const tmpPath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    // I always try to normalize the upload to WAV first.
    // If ffmpeg is unavailable, I preserve the original extension so whisper still has format hints.
    let audioPath = tmpPath;
    const wavPath = tmpPath + ".wav";
    try {
      // Try ffmpeg conversion to WAV for any input file
      const conv = spawnSync("ffmpeg", ["-y", "-i", tmpPath, wavPath], {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      if (conv.status === 0) {
        audioPath = wavPath;
        console.log("Converted upload to WAV via ffmpeg:", wavPath);
      } else {
        // ffmpeg failed (maybe not installed or format issue). Try copying with extension
        if (ext) {
          const copyPath = tmpPath + ext;
          try {
            fs.copyFileSync(tmpPath, copyPath);
            audioPath = copyPath;
            console.log("Copied upload to preserve extension:", copyPath);
          } catch (e) {
            console.warn("could not copy file to preserve extension", e);
            audioPath = tmpPath; // fall back to original
          }
        } else {
          // no extension and ffmpeg failed -> use original tmpPath
          audioPath = tmpPath;
        }
      }
    } catch (e) {
      console.warn(
        "ffmpeg conversion attempt failed with error, falling back",
        e,
      );
      if (ext) {
        const copyPath = tmpPath + ext;
        try {
          fs.copyFileSync(tmpPath, copyPath);
          audioPath = copyPath;
        } catch (err) {
          audioPath = tmpPath;
        }
      } else {
        audioPath = tmpPath;
      }
    }

    console.log(
      "audioPath ->",
      audioPath,
      "exists=",
      fs.existsSync(audioPath),
      "size=",
      fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0,
    );
    const transcript = runWhisper(audioPath);

    // Keep replies short and practical because this is part of a voice interaction loop.
    const prompt = `You are a helpful local AI assistant. The user said: "${transcript}"\nRespond concisely and helpfully.`;
    const reply = runLlama(prompt, 256);

    // Delay cleanup slightly so I do not race any slower external process still holding the file.
    setTimeout(() => {
      try {
        fs.unlinkSync(tmpPath);
      } catch (e) {}
      try {
        if (audioPath !== tmpPath) fs.unlinkSync(audioPath);
      } catch (e) {}
    }, 10000);

    return res.json({
      transcript,
      reply,
      ttsConfigured: Boolean(TTS_BIN),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/synthesize", async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "no text" });
    }
    if (!TTS_BIN) {
      return res.status(400).json({ error: "TTS not configured" });
    }

    const audio = runTts(text);
    res.setHeader("Content-Type", "audio/wav");
    return res.send(audio);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 5005;
app.listen(port, () => console.log("Node local bot listening on", port));

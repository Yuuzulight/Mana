/*
Node backend server (server.js)
- POST /transcribe : accepts multipart 'file' audio, runs whisper.cpp to transcribe, then llama.cpp to generate a reply.
- GET /health : basic health check

Environment variables (set before running):
- WHISPER_BIN : full path to whisper.cpp main executable (e.g. C:\whisper.cpp\main.exe)
- WHISPER_MODEL : full path to whisper model file (e.g. models/ggml-base.en.bin)
- LLAMA_BIN : full path to llama.cpp/main executable (e.g. C:\llama.cpp\main.exe)
- LLAMA_MODEL : full path to GGUF model file (e.g. models/7B.gguf)

This server aims to avoid Python. You must download and place the whisper.cpp and llama.cpp binaries and model files yourself.
*/

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
const upload = multer({ dest: path.join(__dirname, "tmp") });

const WHISPER_BIN = process.env.WHISPER_BIN || null;
const WHISPER_MODEL = process.env.WHISPER_MODEL || null;
const LLAMA_BIN = process.env.LLAMA_BIN || null;
const LLAMA_MODEL = process.env.LLAMA_MODEL || null;

if (!fs.existsSync(path.join(__dirname, "tmp"))) {
  fs.mkdirSync(path.join(__dirname, "tmp"));
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

function runWhisper(filePath) {
  if (!WHISPER_BIN || !WHISPER_MODEL) {
    throw new Error("WHISPER_BIN or WHISPER_MODEL not configured");
  }
  // Use whisper-cli to write JSON output to a known file, then read it.
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
  console.log("Running whisper:", WHISPER_BIN, args.join(" "));
  const r = spawnSync(WHISPER_BIN, args, {
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
    // Return a helpful placeholder reply so the pipeline can be tested without a model.
    return "(no model configured) I heard: " + prompt.slice(0, 200);
  }
  // Example llama.cpp CLI: main.exe -m model.gguf -p \"prompt\" -n 128
  // Use a simple non-interactive generation
  const args = ["-m", LLAMA_MODEL, "-p", prompt, "-n", String(maxTokens)];
  console.log("Running llama:", LLAMA_BIN, args.join(" "));
  const r = spawnSync(LLAMA_BIN, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error("llama stderr:", r.stderr);
    throw new Error("llama failed: " + r.stderr);
  }
  // The binary usually prints the generated text to stdout after the prompt
  const out = r.stdout;
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
    // If webm, try to convert to wav using ffmpeg if available. Otherwise, attempt sending directly.
    // Robust handling: always try to convert uploaded file to WAV using ffmpeg if available.
    // Fallback: copy to a path that retains the original extension so whisper can detect the format.
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

    // simple prompt: include the transcript and ask for a helpful coding buddy reply
    const prompt = `You are a helpful coding buddy. The user said: "${transcript}"\nRespond concisely and helpfully.`;
    const reply = runLlama(prompt, 256);

    // cleanup files (async)
    setTimeout(() => {
      try {
        fs.unlinkSync(tmpPath);
      } catch (e) {}
      try {
        if (audioPath !== tmpPath) fs.unlinkSync(audioPath);
      } catch (e) {}
    }, 10000);

    return res.json({ transcript, reply });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 5005;
app.listen(port, () => console.log("Node local bot listening on", port));

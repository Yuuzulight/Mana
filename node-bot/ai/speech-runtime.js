function createSpeechRuntime(context) {
async function synthesizeReply(text, opts = {}) {
    // S1-mini needs the GPU largely to itself -- under real VRAM contention
    // from a running game it doesn't fail, it just gets slow enough (10-50x)
    // to be unusable for real-time chat. Switch to Kokoro automatically
    // whenever a watched game is running, and back once it closes. Kokoro
    // is started on demand by that switch (kokoro-runtime.js) and stops
    // again after MANA_KOKORO_IDLE_MS without use. Qwen3-TTS has no such
    // switch: it stays loaded and keeps speaking while a game runs.
    if (context.ttsRuntime.ttsProvider === "fish") {
      try {
        const gaming = context.getGamingStatus();
        context.ttsRuntime.setProviderOverride(gaming.gamingAppRunning ? "kokoro" : null);
        // Fire-and-forget: also park S1-mini's weights in system RAM while
        // the game holds the GPU, and pull them back once it closes. Swaps
        // take 30-100s+ under contention, so this must never block the
        // reply that's about to go out over Kokoro.
        context.ttsRuntime
          .swapFishDevice(gaming.gamingAppRunning ? "cpu" : "cuda")
          .catch((err) =>
            console.warn("Fish device swap failed:", err.message),
          );
      } catch (e) {
        // Best-effort; fall through with whatever provider is configured.
      }
    }

    // Acquire a voice turn (priority 0 = highest for direct voice turns)
    const release = await context.turnArbiter.acquireTurn(0, {
      timeoutMs: 2 * 60 * 1000,
    });

    let captionServer = null;
    let resourceLease;
    try {
      resourceLease = await context.resourceCoordinator?.acquire({ owner: 'Voice synthesis', priority: 0, signal: opts.signal,
        estimate: { cpu: 2 }, onWait: event => console.log(`[resources] ${event.reason}`) });
      try {
        captionServer = require("../caption-server");
      } catch (e) {
        captionServer = null;
      }

      // prefer a provider method that returns timings
      if (typeof context.ttsRuntime.synthesizeWithTimings === "function") {
        const res = await context.ttsRuntime.synthesizeWithTimings(text);
        const audio = res && res.audio ? res.audio : res;
        const timings = res && res.timings ? res.timings : null;
        // broadcast captions if we have timings and a caption server
        if (
          timings &&
          captionServer &&
          typeof captionServer.broadcastCaption === "function"
        ) {
          try {
            captionServer.broadcastCaption({
              text,
              words: timings,
              source: "tts",
            });
          } catch (e) {}
        }
        return audio;
      }

      // fallback: synthesize audio and estimate timings locally
      const audio = await context.ttsRuntime.synthesizeReply(text, opts.emotion);
      if (
        captionServer &&
        typeof captionServer.broadcastCaption === "function"
      ) {
        try {
          // estimate timings using TTS runtime helper if available
          const timings =
            typeof context.ttsRuntime.estimateWordTimings === "function"
              ? context.ttsRuntime.estimateWordTimings(text)
              : String(text)
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((w, i) => ({
                    word: w,
                    startMs: i * 120,
                    endMs: (i + 1) * 120,
                  }));
          captionServer.broadcastCaption({
            text,
            words: timings,
            source: "tts",
          });
        } catch (e) {}
      }

      return audio;
    } finally {
      resourceLease?.release();
      try {
        release();
      } catch (e) {}
    }
  }

function findWhisperBin() {
    const found = context.whisperDiscovery.findWhisperBin({ env: process.env });
    if (found) {
      return found;
    }
    throw new Error(
      "Whisper executable not found under tools/whisper. Set WHISPER_BIN to a valid whisper-cli.exe path.",
    );
  }

function findLlamaBin() {
    return context.localLlamaRuntime.findLlamaBin();
  }

function findLlamaModel(profile = "default") {
    return context.localLlamaRuntime.findLlamaModel(profile);
  }

function getLlamaStatus() {
    return context.localLlamaRuntime.getLlamaStatus();
  }

async function runWhisperHeard(filePath) {
    const parakeet = context.STT_PROVIDER === "parakeet";
    const heard = parakeet
      ? await withCliMemory(true, () => runParakeet(filePath))
      : ((await context.transcribeWithWhisperServer(filePath)) ?? await withCliMemory(false, () => runWhisperCli(filePath)));
    const model = parakeet
      ? context.whisperDiscovery.findParakeetModel({ env: process.env })
      : context.whisperDiscovery.findWhisperModel({ env: process.env });
    return {
      heard,
      transcript: context.speechVocabulary.correct(heard),
      model: model ? context.path.basename(model) : null,
      language: context.whisperLanguage(),
    };
  }

async function runWhisper(filePath) {
    return (await runWhisperHeard(filePath)).transcript;
  }

async function runWhisperPartial(filePath) {
    return context.speechVocabulary.correct(
      (await context.transcribeWithWhisperServer(filePath)) ?? (await withCliMemory(false, memoryLease => runWhisperCliPartial(filePath, memoryLease))),
    );
  }

async function withCliMemory(parakeet, fn) {
    if (!context.resourceCoordinator) return fn();
    const model = parakeet ? context.whisperDiscovery.findParakeetModel({ env: process.env })
      : context.whisperDiscovery.findWhisperModel({ env: process.env, language: context.whisperLanguage() });
    const bin = parakeet ? findParakeetBin() : findWhisperBin();
    const memory = Math.ceil(context.fs.statSync(model).size / 1048576 * 2);
    const cuda = context.fs.existsSync(context.path.join(context.path.dirname(bin), 'ggml-cuda.dll'));
    const lease = await context.resourceCoordinator.acquire({ owner: 'One-shot voice model', priority: 0,
      estimate: { ramMb: memory, vramMb: cuda ? memory : 0, cpu: Math.max(1, Number(context.whisperThreads()) || 1) } });
    try { return await fn(lease); } finally { lease.release(); }
  }

function findParakeetBin() {
    const found = context.whisperDiscovery.findParakeetBin({ env: process.env });
    if (found) {
      return found;
    }
    throw new Error(
      "Parakeet executable not found under tools/whisper. Set PARAKEET_BIN to a valid parakeet-cli.exe path.",
    );
  }

function runParakeet(filePath) {
    const parakeetModel = context.whisperDiscovery.findParakeetModel({ env: process.env });
    if (!parakeetModel) {
      throw new Error(
        "Parakeet model not found under tools/whisper. Set PARAKEET_MODEL to a valid ggml-parakeet-*.bin path.",
      );
    }
    const parakeetBin = findParakeetBin();
    const startedAt = context.nowMs();
    const outBase = filePath + ".out";
    const outTxt = outBase + ".txt";
    const args = [
      "-m",
      parakeetModel,
      "-f",
      filePath,
      "-t",
      String(context.whisperThreads()),
      "-otxt",
      "-of",
      outBase,
      "-np",
    ];
    console.log("Running parakeet:", parakeetBin, args.join(" "));
    const r = context.spawnSync(parakeetBin, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      console.error("parakeet stderr:", r.stderr);
      throw new Error("parakeet failed: " + r.stderr);
    }
    context.logPerf("parakeet", startedAt);
    let attempts = 0;
    while (!context.fs.existsSync(outTxt) && attempts < 5) {
      attempts += 1;
      context.Atomics.wait(new context.Int32Array(new context.SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (!context.fs.existsSync(outTxt)) {
      return r.stdout ? r.stdout.trim() : "";
    }
    const text = context.fs.readFileSync(outTxt, "utf8").trim();
    try {
      context.fs.unlinkSync(outTxt);
    } catch (e) {}
    return text;
  }

function runWhisperCli(filePath) {
    const whisperModel = context.whisperDiscovery.findWhisperModel({ env: process.env, language: context.whisperLanguage() });
    if (!whisperModel) {
      throw new Error(
        "Whisper model not found under tools/whisper. Set WHISPER_MODEL to a valid ggml *.bin path.",
      );
    }
    const whisperBin = findWhisperBin();
    const startedAt = context.nowMs();
    // I ask whisper-cli for JSON output so transcription parsing does not depend on stdout formatting.
    const outBase = filePath + ".out";
    const outJson = outBase + ".json";
    const args = [
      "-m",
      whisperModel,
      "-f",
      filePath,
      "-t",
      String(context.whisperThreads()),
      "-l",
      context.whisperLanguage(),
      "-bs",
      context.WHISPER_BEAM_SIZE,
      "-nth",
      context.WHISPER_NO_SPEECH_THRESHOLD,
      "-tp",
      context.WHISPER_TEMPERATURE,
      "--output-json",
      "-of",
      outBase,
    ];
    args.push("--prompt", context.getWhisperPrompt(), "--carry-initial-prompt");
    console.log("Running whisper:", whisperBin, args.join(" "));
    const r = context.spawnSync(whisperBin, args, {
      encoding: "utf8",
      // Issue #388: runs on every spoken utterance -- a console flash here
      // would be constant.
      windowsHide: true,
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
    context.logPerf("whisper", startedAt);
    // Wait briefly for the JSON file to appear
    let attempts = 0;
    while (!context.fs.existsSync(outJson) && attempts < 5) {
      attempts += 1;
      context.Atomics.wait(new context.Int32Array(new context.SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (!context.fs.existsSync(outJson)) {
      // fallback: try to return stdout
      const textOut = r.stdout ? r.stdout.trim() : "";
      return textOut;
    }
    try {
      const j = JSON.parse(context.fs.readFileSync(outJson, "utf8"));
      if (j && j.transcription && j.transcription.length > 0) {
        const t = j.transcription
          .map((s) => s.text)
          .join(" ")
          .trim();
        // cleanup json
        try {
          context.fs.unlinkSync(outJson);
        } catch (e) {}
        try {
          context.fs.unlinkSync(outBase + ".txt");
        } catch (e) {}
        return t;
      }
    } catch (e) {
      console.warn("failed to parse whisper json", e);
    }
    // fallback to stdout
    return r.stdout ? r.stdout.trim() : "";
  }

function spawnWhisperCliAsync(whisperBin, args, lease) {
    return new Promise((resolve, reject) => {
      const child = context.belowNormal(context.spawn(whisperBin, args, { windowsHide: true }));
      lease?.attachProcess(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ status: code, stdout, stderr });
      });
    });
  }

async function runWhisperCliPartial(filePath, lease) {
    const whisperModel = context.whisperDiscovery.findWhisperModel({ env: process.env, language: context.whisperLanguage() });
    if (!whisperModel) {
      throw new Error(
        "Whisper model not found under tools/whisper. Set WHISPER_MODEL to a valid ggml *.bin path.",
      );
    }
    const whisperBin = findWhisperBin();
    const startedAt = context.nowMs();
    // A distinct suffix from runWhisperCli's ".out" -- self-documents this
    // as the partial-transcription artifact, even though a filename
    // collision isn't actually possible (each upload gets its own tmp path).
    const outBase = filePath + ".partial-out";
    const outJson = outBase + ".json";
    const args = [
      "-m",
      whisperModel,
      "-f",
      filePath,
      "-t",
      String(context.whisperThreads()),
      "-l",
      context.whisperLanguage(),
      "-bs",
      context.WHISPER_BEAM_SIZE,
      "-nth",
      context.WHISPER_NO_SPEECH_THRESHOLD,
      "-tp",
      context.WHISPER_TEMPERATURE,
      "--output-json",
      "-of",
      outBase,
    ];
    args.push("--prompt", context.getWhisperPrompt(), "--carry-initial-prompt");
    const r = await spawnWhisperCliAsync(whisperBin, args, lease);
    if (r.status !== 0) {
      console.error("whisper (partial) stderr:", r.stderr);
      throw new Error("whisper (partial) failed: " + r.stderr);
    }
    context.logPerf("whisper-partial", startedAt);
    // Wait briefly for the JSON file to appear -- async setTimeout, not
    // runWhisperCli's blocking Atomics.wait, since blocking here would
    // defeat the entire point of using spawn over spawnSync.
    let attempts = 0;
    while (!context.fs.existsSync(outJson) && attempts < 5) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!context.fs.existsSync(outJson)) {
      return r.stdout ? r.stdout.trim() : "";
    }
    try {
      const j = JSON.parse(context.fs.readFileSync(outJson, "utf8"));
      if (j && j.transcription && j.transcription.length > 0) {
        return j.transcription
          .map((s) => s.text)
          .join(" ")
          .trim();
      }
      return r.stdout ? r.stdout.trim() : "";
    } catch (e) {
      console.warn("failed to parse whisper (partial) json", e);
      return r.stdout ? r.stdout.trim() : "";
    } finally {
      // Runs on every path once outJson exists -- an empty transcription
      // (routine on early, mostly-silent polls) or a parse failure must not
      // leak the temp file; this endpoint is polled ~every 1.2s per
      // recording, so a leak here compounds much faster than
      // runWhisperCli's one-shot equivalent.
      try {
        context.fs.unlinkSync(outJson);
      } catch (e) {}
      try {
        context.fs.unlinkSync(outBase + ".txt");
      } catch (e) {}
    }
  }

function normalizeUploadedAudioAsync(file) {
    return new Promise((resolve) => {
      if (!file) {
        throw new Error("no file");
      }
      const tmpPath = file.path;
      const ext = context.path.extname(file.originalname).toLowerCase();
      const wavPath = tmpPath + ".wav";

      const child = context.spawn("ffmpeg", ["-y", "-i", tmpPath, wavPath], {
        windowsHide: true,
      });
      child.on("error", () => resolve(fallbackToCopy()));
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ tmpPath, audioPath: wavPath });
        } else {
          resolve(fallbackToCopy());
        }
      });

      function fallbackToCopy() {
        let audioPath = tmpPath;
        if (ext) {
          const copyPath = tmpPath + ext;
          try {
            context.fs.copyFileSync(tmpPath, copyPath);
            audioPath = copyPath;
          } catch (error) {
            console.warn("could not copy file to preserve extension", error);
          }
        }
        return { tmpPath, audioPath };
      }
    });
  }

function normalizeUploadedAudio(file) {
    if (!file) {
      throw new Error("no file");
    }

    const tmpPath = file.path;
    const ext = context.path.extname(file.originalname).toLowerCase();
    let audioPath = tmpPath;
    const wavPath = tmpPath + ".wav";

    try {
      const conv = context.spawnSync("ffmpeg", ["-y", "-i", tmpPath, wavPath], {
        encoding: "utf8",
        // Issue #388: no console flash on audio conversion.
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      });
      if (conv.status === 0) {
        audioPath = wavPath;
        return { tmpPath, audioPath };
      }
    } catch (error) {
      console.warn(
        "ffmpeg conversion attempt failed with error, falling back",
        error,
      );
    }

    if (ext) {
      const copyPath = tmpPath + ext;
      try {
        context.fs.copyFileSync(tmpPath, copyPath);
        audioPath = copyPath;
      } catch (error) {
        console.warn("could not copy file to preserve extension", error);
      }
    }

    return { tmpPath, audioPath };
  }

function cleanupUploadedAudio(tmpPath, audioPath) {
    setTimeout(() => {
      try {
        context.fs.unlinkSync(tmpPath);
      } catch (error) {}
      try {
        if (audioPath !== tmpPath) context.fs.unlinkSync(audioPath);
      } catch (error) {}
    }, 10000);
  }

function getScreenOcrWorker() {
    if (!context.screenOcrWorkerPromise) {
      // Quick rundown: keep one OCR worker warm so screen reading is not restarted every reply.
      context.screenOcrWorkerPromise = context.createWorker("eng", 1, {
        cachePath: context.SCREEN_OCR_CACHE_PATH,
        errorHandler: (error) => {
          console.warn("Screen OCR worker error:", error);
        },
      }).catch((error) => {
        context.screenOcrWorkerPromise = null;
        throw error;
      });
    }

    return context.screenOcrWorkerPromise;
  }

function dataUrlToBuffer(dataUrl) {
    const match = String(dataUrl || "").match(
      /^data:image\/(?:png|jpeg|jpg);base64,(.+)$/i,
    );
    if (!match) {
      throw new Error("screen image must be a PNG or JPEG data URL");
    }

    return Buffer.from(match[1], "base64");
  }

async function readScreenText(imageDataUrl) {
    if (!context.SCREEN_CONTEXT_ENABLED) {
      return "";
    }

    const startedAt = context.nowMs();
    const imageBuffer = dataUrlToBuffer(imageDataUrl);
    try {
      const worker = await getScreenOcrWorker();
      const result = await worker.recognize(imageBuffer);
      context.logPerf("screen ocr", startedAt);
      return context.clampText(result?.data?.text || "", context.SCREEN_CONTEXT_MAX_CHARS);
    } catch (error) {
      // Quick rundown: if OCR chokes on one capture, reset it and keep Mana alive.
      context.screenOcrWorkerPromise = null;
      throw error;
    }
  }

  return { synthesizeReply, findWhisperBin, findLlamaBin, findLlamaModel, getLlamaStatus, runWhisperHeard, runWhisper, runWhisperPartial, findParakeetBin, runParakeet, runWhisperCli, spawnWhisperCliAsync, runWhisperCliPartial, normalizeUploadedAudioAsync, normalizeUploadedAudio, cleanupUploadedAudio, getScreenOcrWorker, dataUrlToBuffer, readScreenText };
}

module.exports = { createSpeechRuntime };

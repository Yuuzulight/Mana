const listenBtn = document.getElementById("listenToggle");
const statusEl = document.getElementById("statustxt");
const transcriptEl = document.getElementById("transcript");
const replyEl = document.getElementById("modelReply");
const openWebUIButton = document.getElementById("openWebUI");
const gamingModeCheckbox = document.getElementById("gamingMode");
const gamingStatusEl = document.getElementById("gamingStatus");
const { ipcRenderer } = require("electron");

const WAKE_WORDS = [
  "mana",
  "manah",
  "manna",
  "mannah",
  "myna",
  "ma na",
  "mah na",
  "my na",
  "wake up",
  "wake-up",
];
const LISTEN_CHUNK_MS = 3500;
const LISTEN_PAUSE_MS = 250;
const GAMING_IDLE_PAUSE_MS = 1800;
const GAMING_STATUS_POLL_MS = 5000;
const AUTO_LISTEN_RETRY_MS = 1500;
const AUTO_LISTEN_MAX_ATTEMPTS = 20;
const MAX_TTS_CHUNK_CHARS = 180;
const MIN_SPEECH_RMS = 0.012;
const MIN_SPEECH_PEAK = 0.04;
const MAX_CLICKY_ZERO_CROSSING_RATE = 0.28;
const SPEECH_DEBUG_ENABLED =
  new URLSearchParams(window.location.search).get("speechDebug") === "1" ||
  localStorage.getItem("manaSpeechDebug") === "1";
const NOISE_ONLY_TRANSCRIPTS = [
  "blank audio",
  "silence",
  "silent",
  "keyboard clicking",
  "keyboard clicks",
  "typing",
  "clicking",
  "click",
  "mouse clicking",
  "background noise",
  "noise",
  "sound effect",
  "sound effects",
  "music",
  "laughter",
  "laughing",
  "applause",
  "clapping",
];

let mediaStream = null;
let currentReplyAudio = null;
let currentReplyUrl = null;
let replyPlaybackToken = 0;
let listening = false;
let processing = false;
let awake = false;
let gamingAppRunning = false;
let lastGamingStatusCheck = 0;
let gamingStatusCheckPromise = null;

function setAvatarState(state) {
  ipcRenderer.send("avatar:set-state", state);
}

openWebUIButton.addEventListener("click", () => {
  const { shell } = require("electron");
  shell.openExternal("http://localhost:7860");
});

async function checkServices() {
  if (listening) {
    return;
  }

  try {
    const response = await fetch("http://localhost:5005/health", {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Health check returned ${response.status}`);
    }
    const health = await response.json();
    statusEl.textContent = health.ttsConfigured
      ? "Local backend running"
      : "Local backend running (TTS not configured)";
  } catch (e) {
    statusEl.textContent = "Local backend not reachable";
  }
}

setAvatarState("idle");
setInterval(checkServices, 5000);

async function waitForBackend() {
  for (let attempt = 0; attempt < AUTO_LISTEN_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch("http://localhost:5005/health", {
        method: "GET",
      });
      if (response.ok) {
        return true;
      }
    } catch (error) {}

    statusEl.textContent = "Waiting for local backend...";
    await wait(AUTO_LISTEN_RETRY_MS);
  }

  return false;
}

function stopReplyAudio() {
  replyPlaybackToken += 1;
  if (currentReplyAudio) {
    currentReplyAudio.pause();
    currentReplyAudio = null;
  }
  if (currentReplyUrl) {
    URL.revokeObjectURL(currentReplyUrl);
    currentReplyUrl = null;
  }
  setAvatarState("idle");
}

function splitReplyForSpeech(text) {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g);

  if (!sentences) {
    return [];
  }

  const chunks = [];
  let currentChunk = "";
  for (const sentence of sentences.map((part) => part.trim()).filter(Boolean)) {
    const nextChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
    if (nextChunk.length <= MAX_TTS_CHUNK_CHARS) {
      currentChunk = nextChunk;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }
    currentChunk = sentence;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function synthesizeSpeechChunk(index, chunks, playbackToken) {
  if (playbackToken !== replyPlaybackToken) {
    return null;
  }

  const text = chunks[index];
  const total = chunks.length;
  statusEl.textContent =
    total > 1
      ? `Synthesizing reply ${index + 1}/${total}...`
      : "Synthesizing reply...";

  const response = await fetch("http://localhost:5005/synthesize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  if (playbackToken !== replyPlaybackToken) {
    return null;
  }

  return await response.blob();
}

function playAudioBlob(audioBlob, playbackToken) {
  return new Promise((resolve, reject) => {
    if (playbackToken !== replyPlaybackToken) {
      resolve();
      return;
    }

    if (currentReplyAudio) {
      currentReplyAudio.pause();
      currentReplyAudio = null;
    }
    if (currentReplyUrl) {
      URL.revokeObjectURL(currentReplyUrl);
      currentReplyUrl = null;
    }

    setAvatarState("talking");
    currentReplyUrl = URL.createObjectURL(audioBlob);
    currentReplyAudio = new Audio(currentReplyUrl);

    currentReplyAudio.addEventListener(
      "ended",
      () => {
        if (currentReplyUrl) {
          URL.revokeObjectURL(currentReplyUrl);
          currentReplyUrl = null;
        }
        currentReplyAudio = null;
        resolve();
      },
      { once: true },
    );

    currentReplyAudio.addEventListener(
      "error",
      () => {
        if (currentReplyUrl) {
          URL.revokeObjectURL(currentReplyUrl);
          currentReplyUrl = null;
        }
        currentReplyAudio = null;
        reject(new Error("Reply audio playback failed"));
      },
      { once: true },
    );

    currentReplyAudio.play().catch(reject);
  });
}

async function playReplyAudio(text) {
  const chunks = splitReplyForSpeech(text);
  if (chunks.length === 0) {
    return;
  }

  stopReplyAudio();
  const playbackToken = replyPlaybackToken;
  let nextAudioBlobPromise = synthesizeSpeechChunk(0, chunks, playbackToken);

  // Quick rundown: play one chunk while the next chunk renders in the background.
  for (let index = 0; index < chunks.length; index += 1) {
    if (playbackToken !== replyPlaybackToken) {
      break;
    }

    const audioBlob = await nextAudioBlobPromise;
    nextAudioBlobPromise =
      index + 1 < chunks.length
        ? synthesizeSpeechChunk(index + 1, chunks, playbackToken)
        : null;

    if (audioBlob) {
      await playAudioBlob(audioBlob, playbackToken);
    }
  }

  if (playbackToken === replyPlaybackToken) {
    setAvatarState("idle");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logSpeechDebug(eventName, details = {}) {
  if (!SPEECH_DEBUG_ENABLED) {
    return;
  }

  console.info("Mana speech debug:", {
    event: eventName,
    ...details,
  });
}

function isGamingModeEnabled() {
  return Boolean(gamingModeCheckbox?.checked);
}

function updateGamingStatusText(matchedProcesses = []) {
  if (!gamingStatusEl) {
    return;
  }

  if (!isGamingModeEnabled()) {
    gamingStatusEl.textContent = "Off";
    return;
  }

  gamingStatusEl.textContent = gamingAppRunning
    ? `Active: ${matchedProcesses.join(", ")}`
    : "No watched game running";
}

async function refreshGamingStatus(force = false) {
  if (!isGamingModeEnabled()) {
    gamingAppRunning = false;
    updateGamingStatusText();
    return false;
  }

  const now = Date.now();
  if (!force && now - lastGamingStatusCheck < GAMING_STATUS_POLL_MS) {
    return gamingAppRunning;
  }
  if (gamingStatusCheckPromise) {
    return gamingStatusCheckPromise;
  }

  gamingStatusCheckPromise = fetch("http://localhost:5005/gaming/status", {
    method: "GET",
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Gaming status returned ${response.status}`);
      }
      const status = await response.json();
      gamingAppRunning = Boolean(status.gamingAppRunning);
      lastGamingStatusCheck = Date.now();
      updateGamingStatusText(status.matchedProcesses || []);
      return gamingAppRunning;
    })
    .catch((error) => {
      console.warn("Gaming status check failed:", error.message);
      gamingAppRunning = false;
      lastGamingStatusCheck = Date.now();
      if (gamingStatusEl) {
        gamingStatusEl.textContent = "Game check unavailable";
      }
      return false;
    })
    .finally(() => {
      gamingStatusCheckPromise = null;
    });

  return gamingStatusCheckPromise;
}

async function ensureMediaStream() {
  if (!mediaStream) {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  return mediaStream;
}

async function recordAudioChunk(durationMs) {
  await ensureMediaStream();

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const recorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event) => reject(event.error);
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: "audio/webm" }));
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }, durationMs);
  });
}

function getAudioStats(audioBuffer) {
  const channel = audioBuffer.getChannelData(0);
  let sumSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let previous = channel[0] || 0;

  for (let index = 0; index < channel.length; index += 1) {
    const sample = channel[index];
    const absSample = Math.abs(sample);
    sumSquares += sample * sample;
    if (absSample > peak) {
      peak = absSample;
    }
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) {
      zeroCrossings += 1;
    }
    previous = sample;
  }

  const rms = Math.sqrt(sumSquares / Math.max(channel.length, 1));
  return {
    rms,
    peak,
    zeroCrossingRate: zeroCrossings / Math.max(channel.length, 1),
  };
}

function getSpeechRejectReason(stats) {
  if (stats.rms < MIN_SPEECH_RMS || stats.peak < MIN_SPEECH_PEAK) {
    return "quiet";
  }

  if (stats.zeroCrossingRate > MAX_CLICKY_ZERO_CROSSING_RATE) {
    return "clicky";
  }

  return null;
}

async function prepareSpeechWavBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const stats = getAudioStats(audioBuffer);
    const rejectReason = getSpeechRejectReason(stats);
    logSpeechDebug("audio-stats", {
      durationSeconds: Number(audioBuffer.duration.toFixed(2)),
      rms: Number(stats.rms.toFixed(5)),
      peak: Number(stats.peak.toFixed(5)),
      zeroCrossingRate: Number(stats.zeroCrossingRate.toFixed(5)),
      rejectReason,
    });
    // Quick rundown: skip quiet chunks and sharp clicky noise before Whisper sees them.
    if (rejectReason) {
      return { wavBlob: null, stats, skipReason: rejectReason };
    }

    const wavBytes = audioBufferToWav(audioBuffer);
    return {
      wavBlob: new Blob([wavBytes], { type: "audio/wav" }),
      stats,
      skipReason: null,
    };
  } finally {
    await audioCtx.close().catch(() => {});
  }
}

async function transcribeBlob(blob) {
  const startedAt = performance.now();
  const preparedAudio = await prepareSpeechWavBlob(blob);
  const wavBlob = preparedAudio.wavBlob;
  if (!wavBlob) {
    logSpeechDebug("transcribe-skipped", {
      reason: preparedAudio.skipReason,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return {
      transcript: "",
      debug: {
        skipped: true,
        skipReason: preparedAudio.skipReason,
        stats: preparedAudio.stats,
      },
    };
  }

  const formData = new FormData();
  formData.append("file", wavBlob, "listening.wav");
  if (SPEECH_DEBUG_ENABLED) {
    formData.append("debug", "1");
  }

  const response = await fetch("http://localhost:5005/transcribe-only", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  const result = await response.json();
  logSpeechDebug("transcribe-result", {
    transcript: result.transcript || "",
    elapsedMs: Math.round(performance.now() - startedAt),
    backendDebug: result.debug || null,
  });
  console.info(
    `Mana perf: transcribe ${Math.round(performance.now() - startedAt)}ms`,
  );
  return result;
}

function extractWakeCommand(transcript) {
  const normalized = transcript
    .trim()
    .replace(/\bminor\b/gi, "mana")
    .replace(/\bman a\b/gi, "mana");
  const wakeWordsPattern = WAKE_WORDS.map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
  ).join("|");
  const wakePattern = new RegExp(
    `\\b(?:${wakeWordsPattern})\\b[\\s,.:;!?-]*`,
    "i",
  );
  const wakeMatch = normalized.match(wakePattern);
  if (!wakeMatch) {
    return null;
  }

  const command = normalized.slice(wakeMatch.index + wakeMatch[0].length).trim();
  return command || normalized;
}

function cleanTranscriptText(transcript) {
  return transcript
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]+\)/g, " ")
    .replace(/[.。,…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoiseOnlyTranscript(transcript) {
  const normalized = cleanTranscriptText(transcript).toLowerCase();
  if (!normalized) {
    logSpeechDebug("transcript-noise", { reason: "empty", transcript });
    return true;
  }

  const isNoise = NOISE_ONLY_TRANSCRIPTS.some(
    (noiseText) => normalized === noiseText,
  );
  if (isNoise) {
    logSpeechDebug("transcript-noise", { reason: "noise-only", transcript });
  }
  return isNoise;
}

async function requestReply(text) {
  const startedAt = performance.now();
  const response = await fetch("http://localhost:5005/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  const result = await response.json();
  console.info(`Mana perf: reply ${Math.round(performance.now() - startedAt)}ms`);
  return result;
}

async function handleTranscript(transcript) {
  if (isNoiseOnlyTranscript(transcript)) {
    return false;
  }

  const cleanTranscript = cleanTranscriptText(transcript);

  // Quick rundown: the first wake word turns Mana on for the rest of this app session.
  const wakeCommand = extractWakeCommand(cleanTranscript);
  if (!awake && !wakeCommand) {
    statusEl.textContent = "Waiting for Mana...";
    transcriptEl.textContent = `Heard: ${cleanTranscript}`;
    return false;
  }

  if (wakeCommand) {
    awake = true;
  }

  const command = wakeCommand || cleanTranscript;
  if (!command) {
    statusEl.textContent = awake ? "Mana is awake..." : "Waiting for Mana...";
    return false;
  }

  processing = true;
  statusEl.textContent = awake ? "Mana is thinking..." : "Mana heard her name...";
  transcriptEl.textContent = `You: ${cleanTranscript}`;

  try {
    const replyResult = await requestReply(command);
    const reply = replyResult.reply || "";
    replyEl.textContent = `Mana: ${reply}`;

    if (replyResult.ttsConfigured) {
      await playReplyAudio(reply);
    }

    statusEl.textContent = listening
      ? awake
        ? "Mana is awake..."
        : "Waiting for Mana..."
      : "Stopped";
    return true;
  } finally {
    processing = false;
  }
}

async function listenLoop() {
  // Quick rundown: game mode only slows idle loops when a watched game process is running.
  while (listening) {
    if (processing || currentReplyAudio) {
      await wait(LISTEN_PAUSE_MS);
      continue;
    }

    try {
      const gamingModeActive = await refreshGamingStatus();
      statusEl.textContent = awake ? "Mana is awake..." : "Waiting for Mana...";

      const chunk = await recordAudioChunk(LISTEN_CHUNK_MS);
      if (!listening) {
        break;
      }

      const result = await transcribeBlob(chunk);
      const handledTranscript = await handleTranscript(result.transcript || "");
      if (!handledTranscript && gamingModeActive) {
        await wait(GAMING_IDLE_PAUSE_MS);
      }
    } catch (error) {
      console.error(error);
      statusEl.textContent = `Listening error: ${error.message}`;
      await wait(1500);
    }
  }
}

async function startListening() {
  if (listening) {
    return;
  }

  transcriptEl.textContent = "";
  replyEl.textContent = "";
  listening = true;
  listenBtn.textContent = "Stop listening";
  listenBtn.classList.add("active");
  statusEl.textContent = awake ? "Mana is awake..." : "Waiting for Mana...";
  await listenLoop();
}

function stopListening() {
  listening = false;
  awake = false;
  listenBtn.textContent = "Start listening";
  listenBtn.classList.remove("active");
  statusEl.textContent = "Stopped";
  stopReplyAudio();

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

gamingModeCheckbox?.addEventListener("change", () => {
  lastGamingStatusCheck = 0;
  refreshGamingStatus(true);
});

listenBtn.addEventListener("click", async () => {
  if (listening) {
    stopListening();
    return;
  }

  try {
    await startListening();
  } catch (error) {
    console.error(error);
    stopListening();
    statusEl.textContent = `Microphone access failed: ${error.message}`;
  }
});

async function startListeningOnLaunch() {
  // Quick rundown: show Mana right away, then start listening as soon as the backend is ready.
  const backendReady = await waitForBackend();
  if (!backendReady) {
    statusEl.textContent = "Local backend not reachable";
    return;
  }

  try {
    await startListening();
  } catch (error) {
    console.error(error);
    stopListening();
    statusEl.textContent = `Microphone access failed: ${error.message}`;
  }
}

startListeningOnLaunch();
refreshGamingStatus(true);

// helper: convert AudioBuffer to WAV bytes (16-bit PCM)
function audioBufferToWav(buffer, opt) {
  opt = opt || {};
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = opt.float32 ? 3 : 1; // 3 = IEEE float, 1 = PCM
  const bitDepth = format === 3 ? 32 : 16;

  let result;
  if (numChannels === 2) {
    result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
  } else {
    result = buffer.getChannelData(0);
  }

  return encodeWAV(result, numChannels, sampleRate, bitDepth, format);
}

function interleave(inputL, inputR) {
  const length = inputL.length + inputR.length;
  const result = new Float32Array(length);
  let index = 0,
    inputIndex = 0;
  while (index < length) {
    result[index++] = inputL[inputIndex];
    result[index++] = inputR[inputIndex];
    inputIndex++;
  }
  return result;
}

function encodeWAV(samples, numChannels, sampleRate, bitDepth, format) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  if (bitDepth === 16) {
    floatTo16BitPCM(view, 44, samples);
  } else {
    writeFloat32(view, 44, samples);
  }

  return buffer;
}

function floatTo16BitPCM(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeFloat32(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 4) {
    output.setFloat32(offset, input[i], true);
  }
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

const listenBtn = document.getElementById("listenToggle");
const statusEl = document.getElementById("statustxt");
const transcriptEl = document.getElementById("transcript");
const replyEl = document.getElementById("modelReply");
const openWebUIButton = document.getElementById("openWebUI");
const gamingModeCheckbox = document.getElementById("gamingMode");
const gamingStatusEl = document.getElementById("gamingStatus");
const perfStatusEl = document.getElementById("perfStatus");
const runDoctorButton = document.getElementById("runDoctor");
const doctorTitleEl = document.getElementById("doctorTitle");
const doctorSummaryEl = document.getElementById("doctorSummary");
const doctorChecksEl = document.getElementById("doctorChecks");
const { ipcRenderer } = require("electron");
const { formatDoctorPanel } = require("./doctor-panel");

const WAKE_WORDS = ["mana", "manah", "manna", "mannah", "wake up"];
const LISTEN_CHUNK_MS = 3500;
const LISTEN_PAUSE_MS = 250;
const GAMING_IDLE_PAUSE_MS = 1800;
const GAMING_LISTEN_CHUNK_MS = 5000;
const GAMING_DEEP_IDLE_PAUSE_MS = 3200;
const GAMING_STATUS_POLL_MS = 5000;
const PERF_STATUS_POLL_MS = 3000;
const AUTO_LISTEN_RETRY_MS = 1500;
const AUTO_LISTEN_MAX_ATTEMPTS = 20;
const MAX_TTS_CHUNK_CHARS = 180;
const SCREEN_CONTEXT_ENABLED = true;
const SCREEN_CONTEXT_MIN_INTERVAL_MS = 8000;
const SCREEN_CONTEXT_GAMING_MIN_INTERVAL_MS = 30000;
const SCREEN_CONTEXT_KEYWORDS = [
  "screen",
  "see",
  "seeing",
  "look",
  "looking",
  "read",
  "icon",
  "image",
  "picture",
  "menu",
  "chat",
  "game",
  "ffxiv",
  "map",
  "quest",
  "window",
];
const MIN_SPEECH_RMS = 0.012;
const MIN_SPEECH_PEAK = 0.04;
const MAX_CLICKY_ZERO_CROSSING_RATE = 0.28;
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
let lastScreenContextAt = 0;
let lastScreenText = "";

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
setInterval(refreshPerfStatus, PERF_STATUS_POLL_MS);

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

function detectReplyEmotion(text) {
  const normalized = text.toLowerCase();
  const excitedPattern =
    /!{2,}|\b(yay|yes|nice|great|awesome|amazing|let'?s go|finally|hehe|haha)\b/;
  const angryPattern =
    /\b(angry|mad|annoyed|ugh|hmph|stupid|idiot|seriously|how dare|stop that)\b/;

  if (angryPattern.test(normalized)) {
    return "angry";
  }
  if (excitedPattern.test(normalized)) {
    return "excited";
  }
  return "talking";
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

function playAudioBlob(audioBlob, playbackToken, avatarState) {
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

    setAvatarState(avatarState);
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
  const avatarState = detectReplyEmotion(text);
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
      await playAudioBlob(audioBlob, playbackToken, avatarState);
    }
  }

  if (playbackToken === replyPlaybackToken) {
    setAvatarState("idle");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function looksLikeSpeech(stats) {
  if (stats.rms < MIN_SPEECH_RMS || stats.peak < MIN_SPEECH_PEAK) {
    return false;
  }

  return stats.zeroCrossingRate <= MAX_CLICKY_ZERO_CROSSING_RATE;
}

async function prepareSpeechWavBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const stats = getAudioStats(audioBuffer);
    // Quick rundown: skip quiet chunks and sharp clicky noise before Whisper sees them.
    if (!looksLikeSpeech(stats)) {
      return null;
    }

    const wavBytes = audioBufferToWav(audioBuffer);
    return new Blob([wavBytes], { type: "audio/wav" });
  } finally {
    await audioCtx.close().catch(() => {});
  }
}

async function transcribeBlob(blob) {
  const startedAt = performance.now();
  const wavBlob = await prepareSpeechWavBlob(blob);
  if (!wavBlob) {
    return { transcript: "" };
  }

  const formData = new FormData();
  formData.append("file", wavBlob, "listening.wav");

  const response = await fetch("http://localhost:5005/transcribe-only", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  const result = await response.json();
  console.info(
    `Mana perf: transcribe ${Math.round(performance.now() - startedAt)}ms`,
  );
  return result;
}

function extractWakeCommand(transcript) {
  const normalized = transcript.trim();
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
    return true;
  }

  return NOISE_ONLY_TRANSCRIPTS.some((noiseText) => normalized === noiseText);
}

function formatOperationMetric(label, metric) {
  if (!metric) {
    return `${label}: no samples`;
  }

  return `${label}: last ${metric.lastMs}ms, avg ${metric.avgMs}ms, max ${metric.maxMs}ms, count ${metric.count}`;
}

function formatPerfStatus(status) {
  const operations = status.operations || {};
  const config = status.config || {};
  const processInfo = status.process || {};
  const gaming = status.gaming || {};
  const gameLine = gaming.gamingAppRunning
    ? `Game: active (${(gaming.matchedProcesses || []).join(", ")})`
    : "Game: not detected";

  return [
    gameLine,
    `Memory: ${processInfo.totalMemoryMb || 0} MB across ${(processInfo.processes || []).length} Mana processes`,
    `Caps: Whisper ${config.whisperThreads} threads, Llama ${config.llamaThreads} threads, ${config.llamaMaxTokens} tokens`,
    formatOperationMetric("Whisper", operations.whisper),
    formatOperationMetric("OCR", operations["screen ocr"]),
    formatOperationMetric("Llama", operations.llama),
    formatOperationMetric("TTS Kokoro", operations["tts kokoro"]),
    formatOperationMetric("TTS Chatterbox", operations["tts chatterbox"]),
  ].join("\n");
}

async function refreshPerfStatus() {
  if (!perfStatusEl) {
    return;
  }

  try {
    const response = await fetch("http://localhost:5005/perf/status", {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Performance status returned ${response.status}`);
    }

    const status = await response.json();
    perfStatusEl.textContent = formatPerfStatus(status);
  } catch (error) {
    perfStatusEl.textContent = `Performance metrics unavailable: ${error.message}`;
  }
}

function renderDoctorPanel(result) {
  if (!doctorTitleEl || !doctorSummaryEl || !doctorChecksEl) {
    return;
  }

  const panel = formatDoctorPanel(result);
  doctorTitleEl.textContent = panel.heading;
  doctorSummaryEl.textContent = panel.summary;
  doctorChecksEl.innerHTML = "";

  for (const row of panel.rows) {
    const item = document.createElement("div");
    item.className = row.className;

    const title = document.createElement("div");
    title.className = "doctor-check-title";
    title.textContent = `${row.label} (${row.status})`;

    const message = document.createElement("div");
    message.textContent = row.message;

    item.append(title, message);
    doctorChecksEl.appendChild(item);
  }
}

async function runDoctorChecksFromLauncher() {
  if (!doctorSummaryEl || !doctorChecksEl) {
    return;
  }

  doctorSummaryEl.textContent = "Running checks...";
  doctorChecksEl.innerHTML = "";
  if (runDoctorButton) {
    runDoctorButton.disabled = true;
  }

  try {
    const response = await fetch("http://localhost:5005/doctor", {
      method: "GET",
    });
    const result = await response.json();
    renderDoctorPanel(result);
  } catch (error) {
    doctorTitleEl.textContent = "Doctor: unavailable";
    doctorSummaryEl.textContent = `Could not run checks: ${error.message}`;
  } finally {
    if (runDoctorButton) {
      runDoctorButton.disabled = false;
    }
  }
}

function shouldReadScreenForCommand(text, gamingModeActive) {
  if (!gamingModeActive) {
    return true;
  }

  const normalized = cleanTranscriptText(text).toLowerCase();
  return SCREEN_CONTEXT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

async function readScreenContext(text, gamingModeActive) {
  if (!SCREEN_CONTEXT_ENABLED) {
    return "";
  }

  const now = Date.now();
  const minInterval = gamingModeActive
    ? SCREEN_CONTEXT_GAMING_MIN_INTERVAL_MS
    : SCREEN_CONTEXT_MIN_INTERVAL_MS;
  if (lastScreenText && now - lastScreenContextAt < minInterval) {
    return lastScreenText;
  }
  if (!shouldReadScreenForCommand(text, gamingModeActive)) {
    return lastScreenText;
  }

  try {
    statusEl.textContent = "Mana is reading the screen...";
    const image = await ipcRenderer.invoke("screen:capture-primary");
    const response = await fetch("http://localhost:5005/screen/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const result = await response.json();
    lastScreenText = result.text || "";
    lastScreenContextAt = now;
    return lastScreenText;
  } catch (error) {
    console.warn("Mana screen read failed:", error);
    return "";
  }
}

async function requestScreenAwareReply(text, gamingModeActive) {
  const screenText = await readScreenContext(text, gamingModeActive);
  const startedAt = performance.now();
  const response = await fetch("http://localhost:5005/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, screenText }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  const result = await response.json();
  console.info(`Mana perf: reply ${Math.round(performance.now() - startedAt)}ms`);
  return result;
}

async function handleTranscript(transcript, gamingModeActive = false) {
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
    const replyResult = await requestScreenAwareReply(command, gamingModeActive);
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

      const chunkDuration = gamingModeActive ? GAMING_LISTEN_CHUNK_MS : LISTEN_CHUNK_MS;
      const chunk = await recordAudioChunk(chunkDuration);
      if (!listening) {
        break;
      }

      const result = await transcribeBlob(chunk);
      const handledTranscript = await handleTranscript(
        result.transcript || "",
        gamingModeActive,
      );
      if (!handledTranscript && gamingModeActive) {
        await wait(awake ? GAMING_IDLE_PAUSE_MS : GAMING_DEEP_IDLE_PAUSE_MS);
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

runDoctorButton?.addEventListener("click", () => {
  runDoctorChecksFromLauncher();
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
refreshPerfStatus();
runDoctorChecksFromLauncher();

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

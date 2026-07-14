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
const modelModeControlsEl = document.getElementById("modelModeControls");
const modelStatusEl = document.getElementById("modelStatus");
const { ipcRenderer } = require("electron");
const { formatDoctorPanel } = require("./doctor-panel");
const {
  DEFAULT_VISION_HOTKEY_PROMPT,
  describeVisionHotkeyError,
  extractReplyErrorDetail,
} = require("./vision-hotkey");
const { createLive2dAvatar } = require("../avatar/live2d-avatar");
const {
  DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
  shouldStopRecording,
} = require("./voice-endpointing");
const { detectReplyEmotion } = require("./reply-emotion");

const chatLogEl = document.getElementById("chatLog");
const chatInputEl = document.getElementById("chatInput");
const chatSendEl = document.getElementById("chatSend");
const deepResearchBtnEl = document.getElementById("deepResearchBtn");
const researchProgressEl = document.getElementById("researchProgress");
const researchProgressLabelEl = document.getElementById("researchProgressLabel");
const researchCancelBtnEl = document.getElementById("researchCancelBtn");
const manaCanvasEl = document.getElementById("manaCanvas");
const avatarZoomBtnEl = document.getElementById("avatarZoomBtn");

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
const LISTEN_PAUSE_MS = 250;
const GAMING_IDLE_PAUSE_MS = 1800;
const GAMING_DEEP_IDLE_PAUSE_MS = 3200;
// Voice endpointing: how long Mana waits after you stop talking before
// treating the sentence as finished, rather than cutting speech off at a
// fixed duration. Override via MANA_SILENCE_BUFFER_MS if 2.2s feels too
// short/long for how you talk.
const SILENCE_BUFFER_MS = Number(
  process.env.MANA_SILENCE_BUFFER_MS || DEFAULT_SILENCE_BUFFER_MS,
);
const MAX_WAIT_FOR_SPEECH_MS = DEFAULT_MAX_WAIT_FOR_SPEECH_MS;
const GAMING_MAX_WAIT_FOR_SPEECH_MS = DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS;
const MAX_UTTERANCE_MS = DEFAULT_MAX_UTTERANCE_MS;
// How often the live silence-detection meter samples audio energy.
const SILENCE_METER_INTERVAL_MS = 150;
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
// Per-session transcription debug logging (docs/speech_recognition_improvement_plan.md):
// enable with ?speechDebug=1 or localStorage.manaSpeechDebug = "1".
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
let lastScreenContextAt = 0;
let lastScreenText = "";

// In-window avatar: the "maximized" Mana rendered inside the chat window.
// The overlay window keeps its own instance for minimized mode.
let windowAvatar = null;

const ZOOM_BUTTON_TITLES = {
  full: "Whole body — click to zoom to waist-up",
  waist: "Waist-up — click to zoom to bust-up",
  bust: "Bust-up — click to zoom to whole body",
};

function updateZoomButtonLabel(level) {
  if (!avatarZoomBtnEl) {
    return;
  }
  avatarZoomBtnEl.title = ZOOM_BUTTON_TITLES[level] || ZOOM_BUTTON_TITLES.full;
}

function initWindowAvatar() {
  if (!manaCanvasEl) {
    return;
  }
  createLive2dAvatar({
    canvas: manaCanvasEl,
    width: manaCanvasEl.clientWidth || 320,
    height: manaCanvasEl.clientHeight || 480,
  })
    .then((instance) => {
      windowAvatar = instance;
      if (windowAvatar) {
        updateZoomButtonLabel(windowAvatar.getZoom());
      }
    })
    .catch((error) => {
      console.warn("In-window avatar failed to load:", error);
    });
}

if (avatarZoomBtnEl) {
  avatarZoomBtnEl.addEventListener("click", () => {
    if (!windowAvatar) {
      return;
    }
    const level = windowAvatar.cycleZoom();
    updateZoomButtonLabel(level);
  });
}

function appendChatMessage(role, text) {
  if (!chatLogEl || !text) {
    return;
  }
  const bubble = document.createElement("div");
  bubble.className = `chat-message ${role === "user" ? "chat-user" : "chat-mana"}`;
  bubble.textContent = text;
  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function setAvatarState(state) {
  ipcRenderer.send("avatar:set-state", state);
  if (windowAvatar) {
    windowAvatar.setState(state);
  }
}

// Lip sync: sample the playing reply audio's RMS amplitude and forward it to
// the avatar window, where it drives the Live2D mouth parameter.
let lipSyncAudioContext = null;
let lipSyncRafId = null;

function stopLipSync() {
  if (lipSyncRafId !== null) {
    cancelAnimationFrame(lipSyncRafId);
    lipSyncRafId = null;
  }
  ipcRenderer.send("avatar:set-mouth", 0);
  if (windowAvatar) {
    windowAvatar.setMouthTarget(0);
  }
}

function startLipSync(audioElement) {
  try {
    if (!lipSyncAudioContext) {
      lipSyncAudioContext = new AudioContext();
    }
    // createMediaElementSource reroutes ALL of this element's audio through
    // the Web Audio graph below. Chromium starts/leaves AudioContexts
    // suspended without a direct user-gesture resume, and can re-suspend
    // them on window blur — which happens constantly here since the overlay
    // deploys whenever the chat window isn't focused. A suspended context
    // silently drops every sample with no error, so playback goes fully
    // silent. Resume on every call, not just first creation.
    if (lipSyncAudioContext.state === "suspended") {
      lipSyncAudioContext.resume().catch((error) => {
        console.warn("Failed to resume audio context:", error);
      });
    }
    const source = lipSyncAudioContext.createMediaElementSource(audioElement);
    const analyser = lipSyncAudioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(lipSyncAudioContext.destination);

    const samples = new Float32Array(analyser.fftSize);
    let lastSentAt = 0;
    const tick = (timestamp) => {
      if (audioElement.ended || audioElement.paused) {
        stopLipSync();
        return;
      }
      // ~30Hz is plenty for mouth movement and keeps IPC traffic light.
      if (timestamp - lastSentAt >= 33) {
        lastSentAt = timestamp;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          sum += samples[i] * samples[i];
        }
        const rms = Math.sqrt(sum / samples.length);
        ipcRenderer.send("avatar:set-mouth", rms);
        if (windowAvatar) {
          windowAvatar.setMouthTarget(rms);
        }
      }
      lipSyncRafId = requestAnimationFrame(tick);
    };
    lipSyncRafId = requestAnimationFrame(tick);
  } catch (error) {
    // Lip sync is a nicety; never let it break audio playback.
    console.warn("Lip sync unavailable:", error);
  }
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

// Model mode: lets you switch which local llama.cpp profile Mana replies
// with (default/fast/quality/coding, see node-bot/ai/local-ai.js), backed
// by the existing GET /models/status + POST /models/active-profile routes.
let selectedModelProfile = "default";
const MODEL_STATUS_POLL_MS = 15000;

function renderModelModeButtons(profiles, activeProfile) {
  if (!modelModeControlsEl) {
    return;
  }
  modelModeControlsEl.innerHTML = "";
  for (const [key, profile] of Object.entries(profiles || {})) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "modelModeButton" + (key === activeProfile ? " active" : "");
    button.dataset.modelProfile = key;
    button.textContent = profile.label || key;
    button.addEventListener("click", () => setActiveModelProfile(key));
    modelModeControlsEl.appendChild(button);
  }
}

function describeModelStatus(status) {
  const active = status.profiles?.[status.activeProfile];
  if (!active) {
    return `Active: ${status.activeProfile}`;
  }
  return active.available
    ? `Active: ${active.label} (${active.selectedModel || "model found"})`
    : `Active: ${active.label} — no matching GGUF found in tools\\llama`;
}

function applyModelStatus(status) {
  selectedModelProfile = status.activeProfile || selectedModelProfile;
  renderModelModeButtons(status.profiles, status.activeProfile);
  if (modelStatusEl) {
    modelStatusEl.textContent = describeModelStatus(status);
  }
}

async function refreshModelStatus() {
  try {
    const response = await fetch("http://localhost:5005/models/status");
    if (!response.ok) {
      throw new Error(`Model status returned ${response.status}`);
    }
    applyModelStatus(await response.json());
  } catch (error) {
    if (modelStatusEl) {
      modelStatusEl.textContent = "Model status unavailable";
    }
    console.warn("Mana model status failed:", error);
  }
}

async function setActiveModelProfile(profile) {
  try {
    const response = await fetch("http://localhost:5005/models/active-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    });
    if (!response.ok) {
      throw new Error(`Set active profile returned ${response.status}`);
    }
    applyModelStatus(await response.json());
  } catch (error) {
    console.warn("Mana set model profile failed:", error);
  }
}

setAvatarState("idle");
setInterval(checkServices, 5000);
setInterval(refreshPerfStatus, PERF_STATUS_POLL_MS);
refreshModelStatus();
setInterval(refreshModelStatus, MODEL_STATUS_POLL_MS);

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
        stopLipSync();
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
        stopLipSync();
        if (currentReplyUrl) {
          URL.revokeObjectURL(currentReplyUrl);
          currentReplyUrl = null;
        }
        currentReplyAudio = null;
        reject(new Error("Reply audio playback failed"));
      },
      { once: true },
    );

    const playback = currentReplyAudio.play();
    startLipSync(currentReplyAudio);
    playback.catch(reject);
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

// Records continuously and stops once the user has been silent for
// `silenceBufferMs` after speaking — so a long sentence is captured whole
// instead of being cut off at a fixed duration. Uses the same MIN_SPEECH_RMS
// threshold as the post-hoc noise filter below, so "is this speech" stays
// consistent whether it's judged live or after the fact.
async function recordUntilSilence({
  maxWaitForSpeechMs = MAX_WAIT_FOR_SPEECH_MS,
  silenceBufferMs = SILENCE_BUFFER_MS,
  maxDurationMs = MAX_UTTERANCE_MS,
} = {}) {
  await ensureMediaStream();

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  function currentRms() {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const recorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });
    let hasHeardSpeech = false;
    let lastSpeechAt = 0;
    let meterInterval = null;
    const startedAt = performance.now();

    function cleanup() {
      if (meterInterval !== null) {
        clearInterval(meterInterval);
        meterInterval = null;
      }
      try {
        source.disconnect();
      } catch (e) {}
      audioCtx.close().catch(() => {});
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      cleanup();
      reject(event.error);
    };
    recorder.onstop = () => {
      cleanup();
      resolve(new Blob(chunks, { type: "audio/webm" }));
    };

    // A short timeslice keeps dataavailable events flowing so audio isn't
    // lost if recording stops earlier than a browser's default flush cadence.
    recorder.start(SILENCE_METER_INTERVAL_MS);

    meterInterval = setInterval(() => {
      const now = performance.now();
      if (currentRms() >= MIN_SPEECH_RMS) {
        if (!hasHeardSpeech) {
          statusEl.textContent = "Mana is listening...";
        }
        hasHeardSpeech = true;
        lastSpeechAt = now;
      }

      const stopReason = shouldStopRecording({
        hasHeardSpeech,
        elapsedMs: now - startedAt,
        msSinceLastSpeech: hasHeardSpeech ? now - lastSpeechAt : 0,
        maxWaitForSpeechMs,
        silenceBufferMs,
        maxDurationMs,
      });
      if (stopReason && recorder.state !== "inactive") {
        recorder.stop();
      }
    }, SILENCE_METER_INTERVAL_MS);
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
    return { wavBlob: new Blob([wavBytes], { type: "audio/wav" }), stats, skipReason: null };
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
    body: JSON.stringify({
      text,
      screenText,
      modelProfile: selectedModelProfile,
      sessionId: typeof ensureSessionId === "function" ? ensureSessionId() : undefined,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  const result = await response.json();
  console.info(`Mana perf: reply ${Math.round(performance.now() - startedAt)}ms`);
  return result;
}

let visionHotkeyBusy = false;

async function handleVisionHotkey() {
  if (visionHotkeyBusy) {
    return;
  }
  visionHotkeyBusy = true;
  processing = true;
  // Pressing the hotkey is an explicit request, so it also wakes Mana.
  awake = true;

  try {
    statusEl.textContent = "Mana is looking at your screen...";
    transcriptEl.textContent = "You: (vision hotkey)";
    appendChatMessage("user", "(asked Mana to look at the screen)");

    const image = await ipcRenderer.invoke("screen:capture-primary");
    const response = await fetch("http://localhost:5005/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: DEFAULT_VISION_HOTKEY_PROMPT,
        image,
        modelProfile: selectedModelProfile,
        sessionId: typeof ensureSessionId === "function" ? ensureSessionId() : undefined,
      }),
    });

    if (!response.ok) {
      const detail = await extractReplyErrorDetail(response);
      statusEl.textContent = describeVisionHotkeyError(response.status, detail);
      return;
    }

    const result = await response.json();
    const reply = result.reply || "";
    replyEl.textContent = `Mana: ${reply}`;
    appendChatMessage("mana", reply);
    if (typeof refreshSessionList === "function") {
      refreshSessionList();
    }

    if (result.ttsConfigured) {
      await playReplyAudio(reply);
    }

    statusEl.textContent = listening
      ? awake
        ? "Mana is awake..."
        : "Waiting for Mana..."
      : "Stopped";
  } catch (error) {
    console.warn("Vision hotkey failed:", error);
    statusEl.textContent = describeVisionHotkeyError(0, error.message);
  } finally {
    processing = false;
    visionHotkeyBusy = false;
  }
}

// Typed chat: the composer bypasses the wake word (typing at Mana is an
// explicit request) and otherwise uses the exact same reply pipeline.
async function sendTypedMessage() {
  if (!chatInputEl) {
    return;
  }
  const text = chatInputEl.value.trim();
  if (!text || processing) {
    return;
  }
  chatInputEl.value = "";
  awake = true;
  try {
    const gaming = isGamingModeEnabled() && (await refreshGamingStatus());
    await handleTranscript(text, Boolean(gaming));
  } catch (error) {
    console.warn("Typed message failed:", error);
    statusEl.textContent = `Reply failed: ${error.message}`;
  }
}

chatSendEl?.addEventListener("click", () => {
  sendTypedMessage();
});

chatInputEl?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTypedMessage();
  }
});

let deepResearchRunning = false;
let currentResearchJobId = null;

function setResearchProgress(label) {
  if (!researchProgressEl || !researchProgressLabelEl) {
    return;
  }
  if (!label) {
    researchProgressEl.hidden = true;
    return;
  }
  researchProgressEl.hidden = false;
  researchProgressLabelEl.textContent = label;
}

function formatResearchReply(result) {
  const lines = [result.report, ""];
  if (result.sources.length) {
    lines.push("Sources:");
    for (const source of result.sources) {
      const suffix = source.readFailed ? " (couldn't be read; used search snippet)" : "";
      lines.push(`[${source.index}] ${source.title || source.url} - ${source.url}${suffix}`);
    }
  }
  if (result.subQueries?.length) {
    lines.push("");
    lines.push(`Searched: ${result.subQueries.join(" | ")}`);
  }
  if (result.bounds.hitTimeLimit || result.bounds.hitSourceLimit) {
    lines.push("");
    lines.push(
      `(Stopped early: ${result.bounds.sourcesUsed} of up to ${result.bounds.maxSources} sources read${
        result.bounds.hitTimeLimit ? `, ${Math.round(result.bounds.elapsedMs / 1000)}s time budget reached` : ""
      }.)`,
    );
  }
  return lines.join("\n");
}

async function pollResearchJob(jobId) {
  for (;;) {
    const response = await fetch(`http://localhost:5005/research/${jobId}`);
    if (!response.ok) {
      throw new Error(`Research status check failed (${response.status})`);
    }
    const job = await response.json();
    if (job.status === "done") {
      return job.result;
    }
    if (job.status === "cancelled") {
      const cancelled = new Error("Research cancelled.");
      cancelled.cancelled = true;
      throw cancelled;
    }
    if (job.status === "error") {
      throw new Error(job.error || "Deep research failed");
    }
    setResearchProgress(job.progress?.label || "Researching...");
    await wait(600);
  }
}

async function startDeepResearch() {
  if (deepResearchRunning || !chatInputEl) {
    return;
  }
  const question = chatInputEl.value.trim();
  if (!question) {
    return;
  }
  chatInputEl.value = "";
  deepResearchRunning = true;
  deepResearchBtnEl?.classList.add("active");
  appendChatMessage("user", question);
  setResearchProgress("Starting research...");

  try {
    const startResponse = await fetch("http://localhost:5005/research/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!startResponse.ok) {
      const detail = await startResponse.text();
      throw new Error(detail || `Failed to start research (${startResponse.status})`);
    }
    const { jobId } = await startResponse.json();
    currentResearchJobId = jobId;
    const result = await pollResearchJob(jobId);
    appendChatMessage("mana", formatResearchReply(result));
  } catch (error) {
    if (error.cancelled) {
      appendChatMessage("mana", "Research cancelled.");
    } else {
      console.warn("Deep research failed:", error);
      appendChatMessage("mana", `Research failed: ${error.message}`);
    }
  } finally {
    deepResearchRunning = false;
    currentResearchJobId = null;
    deepResearchBtnEl?.classList.remove("active");
    setResearchProgress(null);
  }
}

deepResearchBtnEl?.addEventListener("click", () => {
  startDeepResearch();
});

researchCancelBtnEl?.addEventListener("click", async () => {
  if (!currentResearchJobId) {
    return;
  }
  setResearchProgress("Cancelling...");
  try {
    await fetch(`http://localhost:5005/research/${currentResearchJobId}/cancel`, {
      method: "POST",
    });
  } catch (error) {
    console.warn("Research cancel request failed:", error);
  }
});

ipcRenderer.on("vision:hotkey", () => {
  handleVisionHotkey();
});

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
  appendChatMessage("user", cleanTranscript);

  try {
    const replyResult = await requestScreenAwareReply(command, gamingModeActive);
    const reply = replyResult.reply || "";
    replyEl.textContent = `Mana: ${reply}`;
    appendChatMessage("mana", reply);
    if (typeof refreshSessionList === "function") {
      refreshSessionList();
    }

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

      const chunk = await recordUntilSilence({
        maxWaitForSpeechMs: gamingModeActive
          ? GAMING_MAX_WAIT_FOR_SPEECH_MS
          : MAX_WAIT_FOR_SPEECH_MS,
      });
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
initWindowAvatar();
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

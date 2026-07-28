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
const doctorAttentionLabelEl = document.getElementById("doctorAttentionLabel");
const doctorPassLabelEl = document.getElementById("doctorPassLabel");
const doctorPassChecksEl = document.getElementById("doctorPassChecks");
const doctorBubbleEl = document.getElementById("doctorBubble");
const doctorBubbleTitleEl = doctorBubbleEl?.querySelector(".doctor-bubble-title");
const doctorBubbleMessageEl = doctorBubbleEl?.querySelector(".doctor-bubble-message");
const modelModeControlsEl = document.getElementById("modelModeControls");
const modelStatusEl = document.getElementById("modelStatus");
const useRemoteAiToggleEl = document.getElementById("useRemoteAiToggle");
const brainProviderFieldsEl = document.getElementById("brainProviderFields");
const brainProviderSelectEl = document.getElementById("brainProviderSelect");
const brainBaseUrlEl = document.getElementById("brainBaseUrl");
const brainModelEl = document.getElementById("brainModel");
const brainApiKeyEl = document.getElementById("brainApiKey");
const brainProviderConnectBtnEl = document.getElementById("brainProviderConnectBtn");
const brainProviderSaveBtnEl = document.getElementById("brainProviderSaveBtn");
const brainProviderStatusEl = document.getElementById("brainProviderStatus");
const visionModelPathEl = document.getElementById("visionModelPath");
const visionMmprojPathEl = document.getElementById("visionMmprojPath");
const visionModelBrowseBtnEl = document.getElementById("visionModelBrowseBtn");
const visionMmprojBrowseBtnEl = document.getElementById("visionMmprojBrowseBtn");
const visionModelClearBtnEl = document.getElementById("visionModelClearBtn");
const visionModelStatusEl = document.getElementById("visionModelStatus");
const presetSelectEl = document.getElementById("presetSelect");
const presetNewBtnEl = document.getElementById("presetNewBtn");
const presetEditBtnEl = document.getElementById("presetEditBtn");
const presetDeleteBtnEl = document.getElementById("presetDeleteBtn");
const presetEditorEl = document.getElementById("presetEditor");
const presetNameInputEl = document.getElementById("presetNameInput");
const presetInstructionsInputEl = document.getElementById("presetInstructionsInput");
const presetSaveBtnEl = document.getElementById("presetSaveBtn");
const presetCancelBtnEl = document.getElementById("presetCancelBtn");
const { ipcRenderer } = require("electron");
const { formatDoctorPanel } = require("./doctor-panel");
const {
  DEFAULT_VISION_HOTKEY_PROMPT,
  describeVisionHotkeyError,
  extractReplyErrorDetail,
} = require("./vision-hotkey");
const { createLive2dAvatar } = require("../avatar/live2d-avatar");
const { createVrmAvatar } = require("../avatar/vrm-avatar");
const {
  DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
  nextBargeInState,
  shouldStopRecording,
} = require("./voice-endpointing");
const { detectReplyEmotion } = require("./reply-emotion");
const {
  isLikelyWhisperHallucination,
  fuzzyMatchesWakeWord,
  computeGainFactor,
  getSpeechRejectReason: getSpeechRejectReasonPure,
} = require("./speech-filters");
const { extractArtifact } = require("./artifact-detector");
const { createMarkdownRenderer } = require("./markdown-render");
const renderMarkdownToSafeHtml = createMarkdownRenderer();
const {
  formatCompareProfileLabel,
  pickDefaultCompareProfiles,
} = require("./compare-mode");
const {
  createSileroVad,
  FRAME_SAMPLES: VAD_FRAME_SAMPLES,
  SAMPLE_RATE: VAD_SAMPLE_RATE,
} = require("./silero-vad");

const chatLogEl = document.getElementById("chatLog");
const chatInputEl = document.getElementById("chatInput");
const chatSendEl = document.getElementById("chatSend");
const deepResearchBtnEl = document.getElementById("deepResearchBtn");
const researchProgressEl = document.getElementById("researchProgress");
const researchProgressLabelEl = document.getElementById("researchProgressLabel");
const researchCancelBtnEl = document.getElementById("researchCancelBtn");
const compareModeBtnEl = document.getElementById("compareModeBtn");
const comparePanelEl = document.getElementById("comparePanel");
const compareProfileAEl = document.getElementById("compareProfileA");
const compareProfileBEl = document.getElementById("compareProfileB");
const compareResultAEl = document.getElementById("compareResultA");
const compareResultBEl = document.getElementById("compareResultB");
const compareLabelAEl = document.getElementById("compareLabelA");
const compareLabelBEl = document.getElementById("compareLabelB");
const comparePreferAEl = document.getElementById("comparePreferA");
const comparePreferBEl = document.getElementById("comparePreferB");
const compareColumnAEl = document.getElementById("compareColumnA");
const compareColumnBEl = document.getElementById("compareColumnB");
const compareCancelBtnEl = document.getElementById("compareCancelBtn");
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
// Issue #4: quiet real speech (soft-spoken, further from the mic) can sit
// right at these thresholds -- override via env if the defaults are
// skipping speech you know was real, or letting through more noise than
// you'd like. Same override pattern as SILENCE_BUFFER_MS above.
const MIN_SPEECH_RMS = Number(process.env.MANA_MIN_SPEECH_RMS || 0.012);
const MIN_SPEECH_PEAK = Number(process.env.MANA_MIN_SPEECH_PEAK || 0.04);
const MAX_CLICKY_ZERO_CROSSING_RATE = Number(
  process.env.MANA_MAX_CLICKY_ZCR || 0.28,
);
// Gain applied to a recorded clip before computing reject stats and
// sending to Whisper, when its peak amplitude is below this target --
// rescues quiet-but-real speech without loosening MIN_SPEECH_RMS/PEAK
// themselves (which would also let more noise through). 0 disables.
const SPEECH_GAIN_TARGET_PEAK = Number(
  process.env.MANA_SPEECH_GAIN_TARGET_PEAK || 0.2,
);
const SPEECH_GAIN_MAX_BOOST = Number(process.env.MANA_SPEECH_GAIN_MAX_BOOST || 6);
// Live speech/silence detection in recordUntilSilence() prefers Silero VAD
// (issue #135) over the plain RMS threshold above -- a neural model tells
// speech apart from a loud fan or game audio far better than an energy
// threshold can. MANA_VAD_THRESHOLD overrides Silero's own speech-probability
// cutoff; MANA_DISABLE_VAD=1 forces the RMS fallback even if the model is
// available (useful for A/B comparing the two, or if VAD misbehaves).
const VAD_THRESHOLD = Number(process.env.MANA_VAD_THRESHOLD || 0.5);
const VAD_DISABLED = process.env.MANA_DISABLE_VAD === "1";
const VAD_MODEL_URL = "../assets/vad/silero_vad.onnx";
// Issue #219 phase 2, experimental and OFF by default: interrupt Mana by just
// talking over her, instead of only via the hotkey. getUserMedia's default
// echoCancellation constraint (on since ensureMediaStream() only ever
// requests `audio: true`) already tries to cancel Mana's own TTS voice out
// of the mic before this ever sees it, but real speaker/mic acoustic paths
// vary a lot by hardware -- unlike the hotkey, this can misfire on residual
// echo, so it needs the user's own speakers/mic to validate before trusting
// it. MANA_BARGE_IN_HOLD_MS requires that many ms of continuous VAD-positive
// speech before triggering, to reject brief echo pops/clicks.
const BARGE_IN_VOICE_ENABLED = process.env.MANA_BARGE_IN_VOICE === "1";
const BARGE_IN_HOLD_MS = Number(process.env.MANA_BARGE_IN_HOLD_MS || 350);
const BARGE_IN_POLL_MS = 50;
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
// Lazily created on first use (not at load time) so a missing/broken ONNX
// runtime never blocks the app from starting -- just falls back to RMS.
let sileroVad = null;
let sileroVadLoadFailed = false;

function getSileroVad() {
  if (VAD_DISABLED || sileroVadLoadFailed || typeof window.ort === "undefined") {
    return null;
  }
  if (!sileroVad) {
    sileroVad = createSileroVad({
      ort: window.ort,
      modelUrl: VAD_MODEL_URL,
      threshold: VAD_THRESHOLD,
    });
  }
  return sileroVad;
}
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

// VRM is preferred when a model is configured (issue #161); Live2D is the
// fallback -- both bind to the same canvas element since only one is ever
// active at a time, so no second canvas/HTML change was needed here
// (unlike the overlay window, which keeps two canvases for a simpler
// initial-load hide/show).
async function initWindowAvatar() {
  if (!manaCanvasEl) {
    return;
  }
  const dimensions = {
    canvas: manaCanvasEl,
    width: manaCanvasEl.clientWidth || 320,
    height: manaCanvasEl.clientHeight || 480,
  };

  try {
    const vrmInstance = await createVrmAvatar(dimensions);
    if (vrmInstance) {
      windowAvatar = vrmInstance;
      updateZoomButtonLabel(windowAvatar.getZoom());
      return;
    }
  } catch (error) {
    console.warn("In-window VRM avatar failed to load, falling back to Live2D:", error);
  }

  try {
    const live2dInstance = await createLive2dAvatar(dimensions);
    windowAvatar = live2dInstance;
    if (windowAvatar) {
      updateZoomButtonLabel(windowAvatar.getZoom());
    }
  } catch (error) {
    console.warn("In-window avatar failed to load:", error);
  }
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

  // A big or ```html fenced block gets pulled out of the bubble into its
  // own window (issue #148) instead of dominating the chat log.
  const artifact = extractArtifact(text);
  const displayText = artifact ? text.replace(artifact.matchedText, "").trim() : text;
  bubble.innerHTML = renderMarkdownToSafeHtml(displayText);

  if (artifact) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-artifact-open";
    button.textContent = `Open ${artifact.language} content in new window`;
    button.addEventListener("click", () => {
      ipcRenderer.send("open-artifact", artifact);
    });
    bubble.appendChild(button);
  }

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
    const response = await fetch(`${BACKEND_BASE_URL}/health`, {
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

// Provider id -> preset (baseUrl, needsKey, label), loaded once from
// GET /models/brain-providers so windows-launcher and desktop-client can't
// drift from what server.js actually knows how to reach.
let brainProviderPresets = [];

async function loadBrainProviderPresets() {
  if (!brainProviderSelectEl) return;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/models/brain-providers`);
    brainProviderPresets = await response.json();
    brainProviderSelectEl.innerHTML = "";
    for (const preset of brainProviderPresets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      brainProviderSelectEl.appendChild(option);
    }
  } catch (error) {
    console.warn("Mana brain provider presets failed:", error);
  }
}

// Only overwrite the brain/vision fields with what the backend has stored
// when the user isn't actively mid-edit -- refreshModelStatus polls every
// MODEL_STATUS_POLL_MS, and re-populating on every poll would stomp
// whatever they're currently typing.
function applyBrainAndVisionStatus(status) {
  const brain = status.brain || { type: "local", baseUrl: "", model: "" };
  const isEditing = [brainBaseUrlEl, brainModelEl, brainApiKeyEl].includes(document.activeElement);
  if (!isEditing) {
    if (useRemoteAiToggleEl) useRemoteAiToggleEl.checked = brain.type === "openai_compatible";
    if (brainProviderFieldsEl) brainProviderFieldsEl.hidden = brain.type !== "openai_compatible";
    if (brainProviderSelectEl) {
      const matched = brainProviderPresets.find((p) => p.baseUrl === brain.baseUrl);
      brainProviderSelectEl.value = matched ? matched.id : "custom";
    }
    if (brainBaseUrlEl) brainBaseUrlEl.value = brain.baseUrl || "";
    if (brainModelEl) brainModelEl.value = brain.model || "";
    if (brainApiKeyEl) brainApiKeyEl.placeholder = brain.hasApiKey ? "(key saved -- leave blank to keep it)" : "leave blank for local servers";
  }

  const vision = status.vision || { modelPath: "", mmprojPath: "" };
  if (visionModelPathEl) visionModelPathEl.value = vision.modelPath || "";
  if (visionMmprojPathEl) visionMmprojPathEl.value = vision.mmprojPath || "";
}

function applyModelStatus(status) {
  selectedModelProfile = status.activeProfile || selectedModelProfile;
  renderModelModeButtons(status.profiles, status.activeProfile);
  populateCompareSelects(status.profiles);
  applyBrainAndVisionStatus(status);
  if (modelStatusEl) {
    modelStatusEl.textContent = describeModelStatus(status);
  }

  const active = status.profiles?.[status.activeProfile];
  const shortLabel = active?.label || status.activeProfile || "Model";
  const composerModelNameEl = document.getElementById("composerModelName");
  const sidebarModelLabelEl = document.getElementById("sidebarModelLabel");
  if (composerModelNameEl) {
    composerModelNameEl.textContent = shortLabel;
  }
  if (sidebarModelLabelEl) {
    sidebarModelLabelEl.textContent = shortLabel;
  }
}

async function refreshModelStatus() {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/models/status`);
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
    const response = await fetch(`${BACKEND_BASE_URL}/models/active-profile`, {
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

// Brain provider: local llama-server (default, profile buttons above) vs.
// any OpenAI-compatible endpoint -- self-hosted (Ollama, LM Studio, vLLM,
// text-generation-webui, ...) or a real API. See node-bot's
// shouldUseRemoteAi (ai/local-ai.js) for why a local endpoint here doesn't
// need MANA_ALLOW_REMOTE_AI.
function toggleBrainProviderFields() {
  if (brainProviderFieldsEl) {
    brainProviderFieldsEl.hidden = !useRemoteAiToggleEl?.checked;
  }
}
useRemoteAiToggleEl?.addEventListener("change", toggleBrainProviderFields);

// Picking a preset auto-fills its baseUrl; "Custom" clears it for manual entry.
brainProviderSelectEl?.addEventListener("change", () => {
  const preset = brainProviderPresets.find((p) => p.id === brainProviderSelectEl.value);
  if (brainBaseUrlEl) brainBaseUrlEl.value = preset?.baseUrl || "";
});

function currentBrainProviderBody() {
  const type = useRemoteAiToggleEl?.checked ? "openai_compatible" : "local";
  const body = { type };
  if (type === "openai_compatible") {
    body.baseUrl = brainBaseUrlEl?.value || "";
    body.model = brainModelEl?.value || "";
    // Blank means "keep whatever's already saved" -- an empty apiKey field
    // is the common case (re-saving baseUrl/model shouldn't wipe a key
    // the user isn't looking at right now).
    if (brainApiKeyEl?.value) {
      body.apiKey = brainApiKeyEl.value;
    }
  }
  return body;
}

brainProviderConnectBtnEl?.addEventListener("click", async () => {
  if (brainProviderStatusEl) brainProviderStatusEl.textContent = "Connecting...";
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/models/brain-provider/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: brainBaseUrlEl?.value || "", apiKey: brainApiKeyEl?.value || "" }),
    });
    const result = await response.json();
    if (brainProviderStatusEl) {
      brainProviderStatusEl.textContent = result.ok
        ? `Connected${typeof result.modelCount === "number" ? ` -- ${result.modelCount} model(s) available` : ""}.`
        : `Connection failed: ${result.error || `HTTP ${result.status}`}`;
    }
  } catch (error) {
    if (brainProviderStatusEl) brainProviderStatusEl.textContent = `Connection failed: ${error.message}`;
  }
});

brainProviderSaveBtnEl?.addEventListener("click", async () => {
  const body = currentBrainProviderBody();
  if (brainProviderStatusEl) brainProviderStatusEl.textContent = "Saving...";
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/models/brain-provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || `Save failed (${response.status})`);
    }
    if (brainApiKeyEl) brainApiKeyEl.value = "";
    applyModelStatus(payload);
    if (brainProviderStatusEl) brainProviderStatusEl.textContent = "Saved.";
  } catch (error) {
    if (brainProviderStatusEl) brainProviderStatusEl.textContent = `Failed to save: ${error.message}`;
  }
});

loadBrainProviderPresets();

// Vision model override (see findVisionModel/findVisionMmproj in
// ai/llama-server-runtime.js) -- blank fields mean "keep auto-detecting".
async function browseAndSetVisionField(targetEl, fieldName) {
  try {
    const picked = await ipcRenderer.invoke("browse-model-file");
    if (picked.canceled) return;
    const body = { [fieldName]: picked.filePath };
    const response = await fetch(`${BACKEND_BASE_URL}/models/vision-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || `Save failed (${response.status})`);
    }
    applyModelStatus(payload);
  } catch (error) {
    if (visionModelStatusEl) visionModelStatusEl.textContent = `Failed: ${error.message}`;
  }
}
visionModelBrowseBtnEl?.addEventListener("click", () => browseAndSetVisionField(visionModelPathEl, "modelPath"));
visionMmprojBrowseBtnEl?.addEventListener("click", () => browseAndSetVisionField(visionMmprojPathEl, "mmprojPath"));

visionModelClearBtnEl?.addEventListener("click", async () => {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/models/vision-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelPath: "", mmprojPath: "" }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || `Clear failed (${response.status})`);
    }
    applyModelStatus(payload);
    if (visionModelStatusEl) visionModelStatusEl.textContent = "Cleared -- back to auto-detect.";
  } catch (error) {
    if (visionModelStatusEl) visionModelStatusEl.textContent = `Failed: ${error.message}`;
  }
});

// Presets: saved persona/behavior instructions the user can select to be
// appended to the base system prompt (see buildAssistantReply in
// node-bot/server.js). Backed by GET/POST/PATCH/DELETE /presets, editing
// happens in-place in an inline form rather than a modal since there's only
// ever one preset being edited at a time.
const PRESET_STORAGE_KEY = "manaSelectedPresetId";
let selectedPresetId = localStorage.getItem(PRESET_STORAGE_KEY) || "";
let editingPresetId = null;
let latestPresets = [];

function setSelectedPresetId(presetId) {
  selectedPresetId = presetId || "";
  if (selectedPresetId) {
    localStorage.setItem(PRESET_STORAGE_KEY, selectedPresetId);
  } else {
    localStorage.removeItem(PRESET_STORAGE_KEY);
  }
  presetEditBtnEl.hidden = !selectedPresetId;
  presetDeleteBtnEl.hidden = !selectedPresetId;
}

function renderPresetSelect(presets) {
  presetSelectEl.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "None";
  presetSelectEl.appendChild(noneOption);
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    presetSelectEl.appendChild(option);
  }
  const stillExists = presets.some((preset) => preset.id === selectedPresetId);
  presetSelectEl.value = stillExists ? selectedPresetId : "";
  setSelectedPresetId(presetSelectEl.value);
}

async function refreshPresetList() {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/presets`);
    if (!response.ok) {
      throw new Error(`Preset list returned ${response.status}`);
    }
    const result = await response.json();
    latestPresets = result.presets || [];
    renderPresetSelect(latestPresets);
  } catch (error) {
    console.warn("Mana preset list failed:", error);
  }
}

function closePresetEditor() {
  editingPresetId = null;
  presetEditorEl.hidden = true;
  presetNameInputEl.value = "";
  presetInstructionsInputEl.value = "";
}

function openPresetEditor(preset) {
  editingPresetId = preset ? preset.id : null;
  presetNameInputEl.value = preset ? preset.name : "";
  presetInstructionsInputEl.value = preset ? preset.instructions : "";
  presetEditorEl.hidden = false;
  presetNameInputEl.focus();
}

presetSelectEl.addEventListener("change", () => {
  setSelectedPresetId(presetSelectEl.value);
});

presetNewBtnEl.addEventListener("click", () => openPresetEditor(null));

presetEditBtnEl.addEventListener("click", () => {
  const preset = latestPresets.find((item) => item.id === selectedPresetId);
  if (preset) {
    openPresetEditor(preset);
  }
});

presetCancelBtnEl.addEventListener("click", closePresetEditor);

presetSaveBtnEl.addEventListener("click", async () => {
  const name = presetNameInputEl.value.trim();
  const instructions = presetInstructionsInputEl.value.trim();
  if (!name || !instructions) {
    return;
  }
  try {
    const url = editingPresetId
      ? `${BACKEND_BASE_URL}/presets/${editingPresetId}`
      : `${BACKEND_BASE_URL}/presets`;
    const response = await fetch(url, {
      method: editingPresetId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, instructions }),
    });
    if (!response.ok) {
      throw new Error(`Save preset returned ${response.status}`);
    }
    const saved = await response.json();
    closePresetEditor();
    await refreshPresetList();
    presetSelectEl.value = saved.id;
    setSelectedPresetId(saved.id);
  } catch (error) {
    console.warn("Mana save preset failed:", error);
  }
});

presetDeleteBtnEl.addEventListener("click", async () => {
  const preset = latestPresets.find((item) => item.id === selectedPresetId);
  if (!preset) {
    return;
  }
  const confirmed =
    typeof showConfirmModal === "function"
      ? await showConfirmModal(`Delete preset "${preset.name}"? This cannot be undone.`)
      : window.confirm(`Delete preset "${preset.name}"?`);
  if (!confirmed) {
    return;
  }
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/presets/${preset.id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`Delete preset returned ${response.status}`);
    }
    setSelectedPresetId("");
    await refreshPresetList();
  } catch (error) {
    console.warn("Mana delete preset failed:", error);
  }
});

// Compare mode: an opt-in side-by-side view (not part of the normal chat
// flow) that sends one prompt to two model profiles via the existing
// /reply endpoint -- no new backend inference path, no sessionId (so these
// exploratory replies don't get saved to chat/session memory).
let compareModeActive = false;
let compareRunning = false;
let compareAbortController = null;
let latestCompareProfiles = {};

function updateCompareLabels() {
  if (compareLabelAEl) {
    compareLabelAEl.textContent = formatCompareProfileLabel(
      compareProfileAEl?.value,
      latestCompareProfiles,
    );
  }
  if (compareLabelBEl) {
    compareLabelBEl.textContent = formatCompareProfileLabel(
      compareProfileBEl?.value,
      latestCompareProfiles,
    );
  }
}

function populateCompareSelects(profiles) {
  if (!compareProfileAEl || !compareProfileBEl) {
    return;
  }
  latestCompareProfiles = profiles || {};
  const keys = Object.keys(latestCompareProfiles);
  const availableKeys = keys.filter((key) => latestCompareProfiles[key]?.available);
  const previousA = compareProfileAEl.value;
  const previousB = compareProfileBEl.value;

  for (const selectEl of [compareProfileAEl, compareProfileBEl]) {
    selectEl.innerHTML = "";
    for (const key of keys) {
      const profile = latestCompareProfiles[key];
      const option = document.createElement("option");
      option.value = key;
      option.textContent = profile?.available
        ? profile.label || key
        : `${profile?.label || key} (unavailable)`;
      option.disabled = !profile?.available;
      selectEl.appendChild(option);
    }
  }

  // Prefer a profile that's actually usable; only fall back to an
  // unavailable one if nothing on this machine is usable at all.
  const pickFrom = availableKeys.length ? availableKeys : keys;
  const [defaultA, defaultB] = pickDefaultCompareProfiles(pickFrom);
  compareProfileAEl.value = availableKeys.includes(previousA) ? previousA : defaultA;
  compareProfileBEl.value = availableKeys.includes(previousB) ? previousB : defaultB;

  updateCompareLabels();
}

compareProfileAEl?.addEventListener("change", updateCompareLabels);
compareProfileBEl?.addEventListener("change", updateCompareLabels);

function setCompareModeActive(active) {
  compareModeActive = active;
  compareModeBtnEl?.classList.toggle("active", active);
  if (comparePanelEl) {
    comparePanelEl.hidden = !active;
  }
}

compareModeBtnEl?.addEventListener("click", () => {
  setCompareModeActive(!compareModeActive);
});

function setComparePreferred(column) {
  compareColumnAEl?.classList.toggle("preferred", column === "a");
  compareColumnBEl?.classList.toggle("preferred", column === "b");
}

comparePreferAEl?.addEventListener("click", () => setComparePreferred("a"));
comparePreferBEl?.addEventListener("click", () => setComparePreferred("b"));

async function fetchCompareReply(text, profile, signal) {
  const response = await fetch(`${BACKEND_BASE_URL}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, modelProfile: profile }),
    signal,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Reply failed (${response.status})`);
  }
  const result = await response.json();
  return result.reply || "";
}

function describeCompareOutcome(settledResult) {
  if (settledResult.status === "fulfilled") {
    return settledResult.value;
  }
  if (settledResult.reason?.name === "AbortError") {
    return "Cancelled.";
  }
  return `Failed: ${settledResult.reason.message}`;
}

async function runCompare() {
  if (!chatInputEl || compareRunning) {
    return;
  }
  const text = chatInputEl.value.trim();
  if (!text) {
    return;
  }
  chatInputEl.value = "";
  compareRunning = true;
  setComparePreferred(null);
  if (compareCancelBtnEl) {
    compareCancelBtnEl.hidden = false;
  }

  const profileA = compareProfileAEl?.value || "default";
  const profileB = compareProfileBEl?.value || "default";
  updateCompareLabels();
  if (compareResultAEl) compareResultAEl.textContent = "Thinking...";
  if (compareResultBEl) compareResultBEl.textContent = "Thinking...";

  compareAbortController = new AbortController();
  const { signal } = compareAbortController;

  const [resultA, resultB] = await Promise.allSettled([
    fetchCompareReply(text, profileA, signal),
    fetchCompareReply(text, profileB, signal),
  ]);

  if (compareResultAEl) {
    compareResultAEl.textContent = describeCompareOutcome(resultA);
  }
  if (compareResultBEl) {
    compareResultBEl.textContent = describeCompareOutcome(resultB);
  }
  compareAbortController = null;
  compareRunning = false;
  if (compareCancelBtnEl) {
    compareCancelBtnEl.hidden = true;
  }
}

compareCancelBtnEl?.addEventListener("click", () => {
  compareAbortController?.abort();
});

setAvatarState("idle");
setInterval(checkServices, 5000);
setInterval(refreshPerfStatus, PERF_STATUS_POLL_MS);
refreshModelStatus();
setInterval(refreshModelStatus, MODEL_STATUS_POLL_MS);
refreshPresetList();
setSelectedPresetId(selectedPresetId);

async function waitForBackend() {
  for (let attempt = 0; attempt < AUTO_LISTEN_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/health`, {
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

  const response = await fetch(`${BACKEND_BASE_URL}/synthesize`, {
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

let bargeInMonitor = null;

// Issue #219 phase 2: runs only while Mana is speaking and BARGE_IN_VOICE_ENABLED
// is on. Reuses the same mic stream + Silero VAD as normal listening (so
// whatever echo cancellation getUserMedia is already doing applies here too)
// instead of opening a second audio pipeline. Requires BARGE_IN_HOLD_MS of
// continuous VAD-positive speech -- not just one positive frame -- before
// calling stopReplyAudio(), so a single echo/pop blip can't trigger it.
async function watchForBargeIn() {
  if (bargeInMonitor) {
    return;
  }
  const self = { stopped: false };
  bargeInMonitor = self;

  try {
    await ensureMediaStream();
    const vad = getSileroVad();
    if (!vad) {
      return;
    }
    vad.reset();

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: VAD_SAMPLE_RATE,
    });
    const source = audioCtx.createMediaStreamSource(mediaStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    let speechStartedAt = null;
    try {
      while (!self.stopped && currentReplyAudio) {
        await wait(BARGE_IN_POLL_MS);
        if (self.stopped || !currentReplyAudio) {
          break;
        }

        let isSpeech = false;
        try {
          analyser.getFloatTimeDomainData(samples);
          const frame = samples.subarray(samples.length - VAD_FRAME_SAMPLES);
          const probability = await vad.processFrame(frame);
          isSpeech = vad.isSpeech(probability);
        } catch (e) {
          isSpeech = false;
        }

        const state = nextBargeInState({
          isSpeech,
          speechStartedAt,
          now: performance.now(),
          holdMs: BARGE_IN_HOLD_MS,
        });
        speechStartedAt = state.speechStartedAt;
        if (state.triggered) {
          stopReplyAudio();
          break;
        }
      }
    } finally {
      try {
        source.disconnect();
      } catch (e) {}
      audioCtx.close().catch(() => {});
    }
  } finally {
    bargeInMonitor = null;
  }
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
    if (BARGE_IN_VOICE_ENABLED) {
      watchForBargeIn().catch((e) =>
        console.warn("Voice barge-in monitor failed:", e.message),
      );
    }
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
  // Issue #4: persist to disk too, not just the devtools console -- so a
  // missed-speech report can be debugged after the fact instead of only
  // during a live session with devtools open.
  ipcRenderer.send("log-speech-debug", { event: eventName, ...details });
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
    ? `Active: ${matchedProcesses.join(", ")} (using Kokoro voice)`
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

  gamingStatusCheckPromise = fetch(`${BACKEND_BASE_URL}/gaming/status`, {
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
// instead of being cut off at a fixed duration. Prefers Silero VAD's speech
// probability (issue #135) over the plain MIN_SPEECH_RMS threshold for the
// live "is this speech" decision -- a neural VAD tells speech apart from a
// loud fan or game audio far better than an energy threshold can -- and
// falls back to RMS if the model isn't available or inference fails. The
// post-hoc noise filter below (getSpeechRejectReason) still uses RMS/ZCR
// either way; it's a separate second-layer check on the finished recording.
async function recordUntilSilence({
  maxWaitForSpeechMs = MAX_WAIT_FOR_SPEECH_MS,
  silenceBufferMs = SILENCE_BUFFER_MS,
  maxDurationMs = MAX_UTTERANCE_MS,
} = {}) {
  await ensureMediaStream();

  const vad = getSileroVad();
  if (vad) {
    vad.reset();
  }

  // 16kHz is what Silero VAD expects; the browser resamples for us, so
  // there's no hand-written resampling code either way -- the RMS fallback
  // doesn't care what sample rate it runs at.
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: VAD_SAMPLE_RATE,
  });
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

  async function isSpeechNow() {
    if (vad) {
      try {
        analyser.getFloatTimeDomainData(samples);
        // Silero wants exactly VAD_FRAME_SAMPLES; take the most recent ones
        // from the analyser's larger ring buffer.
        const frame = samples.subarray(samples.length - VAD_FRAME_SAMPLES);
        const probability = await vad.processFrame(frame);
        return vad.isSpeech(probability);
      } catch (e) {
        console.warn("Silero VAD inference failed, falling back to RMS for this session:", e);
        sileroVadLoadFailed = true;
      }
    }
    return currentRms() >= MIN_SPEECH_RMS;
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const recorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });
    let hasHeardSpeech = false;
    let lastSpeechAt = 0;
    let meterTimer = null;
    let stopped = false;
    const startedAt = performance.now();

    function cleanup() {
      stopped = true;
      if (meterTimer !== null) {
        clearTimeout(meterTimer);
        meterTimer = null;
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

    // Self-scheduling instead of setInterval: VAD inference is async, and
    // this guarantees one tick's inference finishes before the next tick
    // starts rather than risking overlapping calls.
    async function tick() {
      if (stopped) return;
      if (await isSpeechNow()) {
        if (!hasHeardSpeech) {
          statusEl.textContent = "Mana is listening...";
        }
        hasHeardSpeech = true;
        lastSpeechAt = performance.now();
      }
      if (stopped) return;

      const stopReason = shouldStopRecording({
        hasHeardSpeech,
        elapsedMs: performance.now() - startedAt,
        msSinceLastSpeech: hasHeardSpeech ? performance.now() - lastSpeechAt : 0,
        maxWaitForSpeechMs,
        silenceBufferMs,
        maxDurationMs,
      });
      if (stopReason) {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
        return;
      }
      meterTimer = setTimeout(tick, SILENCE_METER_INTERVAL_MS);
    }
    meterTimer = setTimeout(tick, SILENCE_METER_INTERVAL_MS);
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
  return getSpeechRejectReasonPure(stats, {
    minRms: MIN_SPEECH_RMS,
    minPeak: MIN_SPEECH_PEAK,
    maxClickyZcr: MAX_CLICKY_ZERO_CROSSING_RATE,
  });
}

// Issue #4: boosts a quiet clip's gain in place (clamped to avoid clipping)
// before stats/reject-checks run, so soft-spoken real speech both clears
// MIN_SPEECH_RMS/PEAK and reaches Whisper with a stronger signal. No-op
// (gain factor 1) for anything already loud enough.
function applySpeechGain(audioBuffer) {
  const rawPeak = getAudioStats(audioBuffer).peak;
  const gain = computeGainFactor(rawPeak, SPEECH_GAIN_TARGET_PEAK, SPEECH_GAIN_MAX_BOOST);
  if (gain === 1) return { gain };

  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const channel = audioBuffer.getChannelData(c);
    for (let i = 0; i < channel.length; i++) {
      channel[i] = Math.max(-1, Math.min(1, channel[i] * gain));
    }
  }
  return { gain };
}

async function prepareSpeechWavBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const { gain } = applySpeechGain(audioBuffer);
    const stats = getAudioStats(audioBuffer);
    stats.durationSeconds = audioBuffer.duration;
    const rejectReason = getSpeechRejectReason(stats);
    logSpeechDebug("audio-stats", {
      durationSeconds: Number(audioBuffer.duration.toFixed(2)),
      rms: Number(stats.rms.toFixed(5)),
      peak: Number(stats.peak.toFixed(5)),
      zeroCrossingRate: Number(stats.zeroCrossingRate.toFixed(5)),
      gain: Number(gain.toFixed(2)),
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

  const response = await fetch(`${BACKEND_BASE_URL}/transcribe-only`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  const result = await response.json();
  if (
    result.transcript &&
    isLikelyWhisperHallucination(
      cleanTranscriptText(result.transcript).toLowerCase(),
      preparedAudio.stats.durationSeconds,
    )
  ) {
    logSpeechDebug("transcript-hallucination-filtered", {
      transcript: result.transcript,
      durationSeconds: preparedAudio.stats.durationSeconds,
    });
    result.transcript = "";
  }
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
  if (wakeMatch) {
    const command = normalized.slice(wakeMatch.index + wakeMatch[0].length).trim();
    return command || normalized;
  }

  // Issue #4: the exact WAKE_WORDS list can't enumerate every way Whisper
  // mis-transcribes "Mana" -- check the first couple words for a close
  // (edit-distance-1) match before giving up on this utterance entirely.
  const words = normalized.split(/\s+/).filter(Boolean);
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    const stripped = words[i].replace(/[.,!?;:]+$/, "");
    if (fuzzyMatchesWakeWord(stripped, WAKE_WORDS)) {
      const command = words.slice(i + 1).join(" ").trim();
      return command || normalized;
    }
  }

  return null;
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
  ].join("\n");
}

async function refreshPerfStatus() {
  if (!perfStatusEl) {
    return;
  }

  try {
    const response = await fetch(`${BACKEND_BASE_URL}/perf/status`, {
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

// Startup loading screen (issue #138): driven by main.js's
// runStartupSequence() over IPC. get-startup-status catches up on any
// row events that fired before this listener attached (page load timing),
// but "done" is derived from row state client-side rather than trusted to
// the one-shot startup-complete event alone -- if every row already
// finished before this script ran (e.g. services still warm from a
// previous launch), that event fired and was missed with nothing left to
// replay it, and the overlay would otherwise never hide.
const startupOverlayEl = document.getElementById("startupOverlay");
const STARTUP_ROW_IDS = ["backend", "voice", "websearch", "localai"];
const startupRowState = {};
let startupCompleteHandled = false;

// The window opens small (sized to the loading card) and only grows to its
// real chat-UI dimensions once startup finishes (see main.js's
// runStartupSequence). initWindowAvatar() measures manaCanvasEl's box to
// size PixiJS's renderer -- calling it while the window is still small
// bakes in a near-zero render size that never recovers even after the
// window grows, since live2d-avatar.js has no resize() to call later. So
// it's deferred to here instead of running unconditionally at script load.
// Polls an element's client box until two consecutive reads agree (or
// maxWaitMs runs out), then calls back. A single rAF pair wasn't enough --
// verified live that the avatar canvas's measured height was still
// mid-reflow one full frame after the OS-level window resize
// (mainWindow.setSize() in main.js), landing PixiJS's autoDensity-set
// inline canvas size at a wrong, permanently-stuck value (no resize() to
// fix it later). Real setTimeout ticks (not rAF) so each check is its own
// full event-loop turn, giving style/layout/paint an actual chance to
// finish rather than possibly landing inside the same reflow batch.
function waitForStableSize(el, callback, maxWaitMs = 1000, checkIntervalMs = 50) {
  let lastWidth = -1;
  let lastHeight = -1;
  const deadline = Date.now() + maxWaitMs;
  function check() {
    const { clientWidth, clientHeight } = el;
    if (clientWidth > 0 && clientWidth === lastWidth && clientHeight === lastHeight) {
      callback();
      return;
    }
    lastWidth = clientWidth;
    lastHeight = clientHeight;
    if (Date.now() >= deadline) {
      callback();
      return;
    }
    setTimeout(check, checkIntervalMs);
  }
  check();
}

function handleStartupComplete() {
  if (startupCompleteHandled) return;
  startupCompleteHandled = true;
  if (startupOverlayEl) startupOverlayEl.hidden = true;
  if (manaCanvasEl) {
    waitForStableSize(manaCanvasEl, initWindowAvatar);
  } else {
    initWindowAvatar();
  }
}

function applyStartupProgress(update) {
  if (!update || !update.id) return;
  const row = document.querySelector(`.startup-row[data-startup-row="${update.id}"]`);
  if (row) {
    row.dataset.status = update.status;
    const statusEl = row.querySelector(".startup-row-status");
    if (statusEl) {
      statusEl.textContent =
        update.status === "ready" ? "Ready" : update.status === "timeout" ? "Taking a while" : "Starting...";
    }
  }
  startupRowState[update.id] = update.status;
  const allTerminal = STARTUP_ROW_IDS.every(
    (id) => startupRowState[id] === "ready" || startupRowState[id] === "timeout",
  );
  if (allTerminal) handleStartupComplete();
}

ipcRenderer.on("startup-progress", (event, update) => applyStartupProgress(update));
ipcRenderer.on("startup-complete", handleStartupComplete);
ipcRenderer
  .invoke("get-startup-status")
  .then((state) => {
    Object.values(state || {}).forEach(applyStartupProgress);
  })
  .catch(() => {});

// Doctor issue detail popover: chips show just the name, click one to see
// its full message in a small bubble anchored to it. position:fixed (see
// index.html) so it's placed relative to the viewport, not clipped by
// navInfoBody's own overflow-y:auto scroll area.
function showDoctorBubble(chipEl) {
  if (!doctorBubbleEl) return;
  doctorBubbleTitleEl.textContent = chipEl.querySelector("strong")?.textContent || "";
  doctorBubbleMessageEl.textContent = chipEl.dataset.doctorMessage || "";
  doctorBubbleEl.hidden = false;
  const rect = chipEl.getBoundingClientRect();
  const bubbleRect = doctorBubbleEl.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - bubbleRect.width - 12);
  const fitsBelow = rect.bottom + 8 + bubbleRect.height <= window.innerHeight - 12;
  const top = fitsBelow ? rect.bottom + 8 : Math.max(12, rect.top - bubbleRect.height - 8);
  doctorBubbleEl.style.left = `${Math.max(12, left)}px`;
  doctorBubbleEl.style.top = `${top}px`;
}
function hideDoctorBubble() {
  if (doctorBubbleEl) doctorBubbleEl.hidden = true;
}
document.addEventListener("click", (event) => {
  if (!doctorBubbleEl || doctorBubbleEl.hidden) return;
  if (!doctorBubbleEl.contains(event.target) && !event.target.closest(".doctor-chip")) {
    hideDoctorBubble();
  }
});

function doctorChip(row) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = `doctor-chip doctor-chip-${row.status}`;
  chip.dataset.doctorMessage = row.message || "No further detail.";

  const dot = document.createElement("span");
  dot.className = "doctor-chip-dot";

  const label = document.createElement("strong");
  label.textContent = row.label;

  chip.append(dot, label);
  chip.addEventListener("click", () => showDoctorBubble(chip));
  return chip;
}

function renderDoctorPanel(result) {
  if (!doctorTitleEl || !doctorSummaryEl || !doctorChecksEl) {
    return;
  }
  hideDoctorBubble();

  const panel = formatDoctorPanel(result);
  doctorTitleEl.textContent = panel.heading;

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const row of panel.rows) {
    counts[row.status] = (counts[row.status] || 0) + 1;
  }
  doctorSummaryEl.innerHTML = "";
  for (const status of ["pass", "warn", "fail"]) {
    const pill = document.createElement("span");
    pill.className = `doctor-pill doctor-pill-${status}`;
    const noun = status === "pass" ? "passing" : status === "warn" ? "need attention" : "failing";
    pill.textContent = `${counts[status]} ${noun}`;
    doctorSummaryEl.appendChild(pill);
  }

  const needsAttention = panel.rows.filter((row) => row.status !== "pass");
  const passing = panel.rows.filter((row) => row.status === "pass");

  doctorChecksEl.innerHTML = "";
  needsAttention.forEach((row) => doctorChecksEl.appendChild(doctorChip(row)));
  if (doctorAttentionLabelEl) doctorAttentionLabelEl.hidden = needsAttention.length === 0;

  doctorPassChecksEl.innerHTML = "";
  passing.forEach((row) => doctorPassChecksEl.appendChild(doctorChip(row)));
  if (doctorPassLabelEl) {
    doctorPassLabelEl.hidden = passing.length === 0;
    doctorPassLabelEl.textContent = `All good (${passing.length})`;
  }

  let worstStatus = "pass";
  for (const row of panel.rows) {
    if (row.status === "fail") {
      worstStatus = "fail";
    } else if (row.status === "warn" && worstStatus !== "fail") {
      worstStatus = "warn";
    }

    if (row.id === "searxng") {
      const webAccessDotEl = document.getElementById("webAccessDot");
      const webAccessStatusEl = document.getElementById("webAccessStatus");
      const dotClass = row.status === "pass" ? "ok" : row.status === "warn" ? "warn" : "fail";
      if (webAccessDotEl) {
        webAccessDotEl.className = `nav-dot ${dotClass}`;
      }
      if (webAccessStatusEl) {
        webAccessStatusEl.textContent = row.message;
      }
    }
  }

  const doctorNavDotEl = document.getElementById("doctorNavDot");
  if (doctorNavDotEl) {
    const dotClass = worstStatus === "pass" ? "ok" : worstStatus === "warn" ? "warn" : "fail";
    doctorNavDotEl.className = `nav-dot ${dotClass}`;
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
    const response = await fetch(`${BACKEND_BASE_URL}/doctor`, {
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
    const response = await fetch(`${BACKEND_BASE_URL}/screen/read`, {
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
  const response = await fetch(`${BACKEND_BASE_URL}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      screenText,
      modelProfile: selectedModelProfile,
      sessionId: typeof ensureSessionId === "function" ? ensureSessionId() : undefined,
      presetId: selectedPresetId || undefined,
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
    const response = await fetch(`${BACKEND_BASE_URL}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: DEFAULT_VISION_HOTKEY_PROMPT,
        image,
        modelProfile: selectedModelProfile,
        sessionId: typeof ensureSessionId === "function" ? ensureSessionId() : undefined,
        presetId: selectedPresetId || undefined,
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
  if (compareModeActive) {
    runCompare();
  } else {
    sendTypedMessage();
  }
});

chatInputEl?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (compareModeActive) {
      runCompare();
    } else {
      sendTypedMessage();
    }
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
    const response = await fetch(`${BACKEND_BASE_URL}/research/${jobId}`);
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
    const startResponse = await fetch(`${BACKEND_BASE_URL}/research/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        sessionId: typeof ensureSessionId === "function" ? ensureSessionId() : undefined,
      }),
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
    await fetch(`${BACKEND_BASE_URL}/research/${currentResearchJobId}/cancel`, {
      method: "POST",
    });
  } catch (error) {
    console.warn("Research cancel request failed:", error);
  }
});

ipcRenderer.on("vision:hotkey", () => {
  handleVisionHotkey();
});

// Issue #219: lets the user cut Mana off mid-speech (MANA_INTERRUPT_HOTKEY,
// "Control+Alt+I" by default) -- stopReplyAudio() already does everything
// needed (bumps replyPlaybackToken, pauses the audio, resets avatar state);
// this just exposes it as a user action instead of only firing internally
// when a new reply supersedes an old one.
ipcRenderer.on("interrupt-speech", () => {
  stopReplyAudio();
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
      ipcRenderer
        .invoke("log-voice-crash", {
          error: error.message,
          stack: error.stack || null,
          audioBackend: VAD_DISABLED
            ? "vad-disabled"
            : sileroVadLoadFailed
              ? "rms-fallback (silero failed mid-session)"
              : getSileroVad()
                ? "silero-vad"
                : "rms-only (silero unavailable)",
          inputDeviceLabel: mediaStream?.getAudioTracks?.()[0]?.label || null,
          awake,
          listening,
        })
        .catch(() => {});
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
// initWindowAvatar() is deferred to handleStartupComplete() (see above) --
// the window opens small and grows once startup finishes, and Live2D's
// canvas-size measurement has to happen after that resize, not before it.
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

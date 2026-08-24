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
const refreshSnapshotsBtn = document.getElementById("refreshSnapshotsBtn");
const snapshotsListEl = document.getElementById("snapshotsList");
const snapshotsEmptyEl = document.getElementById("snapshotsEmpty");
const refreshProposalsBtn = document.getElementById("refreshProposalsBtn");
const proposalsListEl = document.getElementById("proposalsList");
const proposalsEmptyEl = document.getElementById("proposalsEmpty");
const proposalReviewEl = document.getElementById("proposalReview");
const proposalReviewPathEl = document.getElementById("proposalReviewPath");
const proposalReviewSummaryEl = document.getElementById("proposalReviewSummary");
const proposalReviewHunksEl = document.getElementById("proposalReviewHunks");
const proposalReviewBackBtn = document.getElementById("proposalReviewBackBtn");
const proposalReviewApproveBtn = document.getElementById("proposalReviewApproveBtn");
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
// ipcRenderer comes from backend-config.js's top-level `const { ipcRenderer }`
// -- index.html loads these as sibling classic <script> tags (not modules),
// which share one lexical scope, and backend-config.js loads first. A second
// `const` of the same name here throws "Identifier has already been
// declared" and silently kills this entire script before any of it runs
// (including the loading-screen listeners below) -- a real, pre-existing bug
// found while live-testing issue #219, unrelated to barge-in itself.
const { formatDoctorPanel } = require("./doctor-panel");
const {
  DEFAULT_VISION_HOTKEY_PROMPT,
  buildClipHotkeyPrompt,
  describeVisionHotkeyError,
} = require("./vision-hotkey");
const {
  createClipBuffer,
  pushFrame: pushClipFrame,
  getSpanSeconds: getClipSpanSeconds,
  getImages: getClipImages,
} = require("./clip-buffer");
const { createLive2dAvatar } = require("../avatar/live2d-avatar");
const { createVrmAvatar } = require("../avatar/vrm-avatar");
const { spectralCentroidHz, computeMfcc, classifyViseme } = require("../avatar/lip-sync");
const {
  DEFAULT_BARGE_IN_MIN_DBFS,
  DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
  dbfsFromSamples,
  nextBargeInState,
  shouldStopRecording,
  silenceBufferMsForTranscript,
} = require("./voice-endpointing");
const { detectReplyEmotion } = require("./reply-emotion");
const { isAccessibilityTreeTextUsable } = require("../accessibility-tree");
const { shouldReadScreenForCommand: shouldReadScreenForCommandPure } = require("./screen-context-trigger");
const { waitForPlayback } = require("./reply-audio-playback");
const {
  isLikelyWhisperHallucination,
  fuzzyMatchesWakeWord,
  computeGainFactor,
  getSpeechRejectReason: getSpeechRejectReasonPure,
} = require("./speech-filters");
const { extractArtifact, assignArtifactVersion } = require("./artifact-detector");
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
const { createStreamingChunkQueue } = require("./streaming-chunk-queue");

const chatLogEl = document.getElementById("chatLog");
const chatInputEl = document.getElementById("chatInput");
const chatSendEl = document.getElementById("chatSend");
const deepResearchBtnEl = document.getElementById("deepResearchBtn");
const researchProgressEl = document.getElementById("researchProgress");
const researchProgressLabelEl = document.getElementById("researchProgressLabel");
const researchCancelBtnEl = document.getElementById("researchCancelBtn");
const browserAutomationActivityEl = document.getElementById("browserAutomationActivity");
const browserAutomationActivityLogEl = document.getElementById("browserAutomationActivityLog");
const browserAutomationActivityScreenshotEl = document.getElementById("browserAutomationActivityScreenshot");
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
// #341 Sub-project A: how often to snapshot the audio recorded so far and
// poll for a partial transcript while the user is still speaking. Slower
// than SILENCE_METER_INTERVAL_MS (150ms, the VAD tick) on purpose --
// whisper-cli takes ~1-1.7s per call (benchmarked), so polling faster than
// that would just pile up in-flight requests.
const PARTIAL_TRANSCRIPT_POLL_MS = 1200;
const GAMING_STATUS_POLL_MS = 5000;
const PERF_STATUS_POLL_MS = 3000;
// Issue #418: unlike deep research (a job this app itself starts and
// stops), browser-automation tool calls happen ad-hoc inside the model's
// own tool-calling loop with no "task started/finished" signal this
// renderer can hook into -- so visibility is staleness-based instead: shown
// while the most recent action is still recent, hidden once it's gone
// quiet for a while.
const BROWSER_AUTOMATION_ACTIVITY_POLL_MS = 1000;
const BROWSER_AUTOMATION_ACTIVITY_STALE_MS = 5000;
const AUTO_LISTEN_RETRY_MS = 1500;
const AUTO_LISTEN_MAX_ATTEMPTS = 20;
const MAX_TTS_CHUNK_CHARS = 180;
const SCREEN_CONTEXT_ENABLED = true;
const SCREEN_CONTEXT_MIN_INTERVAL_MS = 8000;
const SCREEN_CONTEXT_GAMING_MIN_INTERVAL_MS = 30000;
// Issue #344: default on, applies the same keyword gate outside gaming
// mode too. Set MANA_SCREEN_CONTEXT_KEYWORD_GATE=0 to restore the old
// always-read-outside-gaming behavior.
const SCREEN_CONTEXT_KEYWORD_GATE_ENABLED =
  process.env.MANA_SCREEN_CONTEXT_KEYWORD_GATE !== "0";
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
// Issue #219 phase 2, on by default: interrupt Mana by just talking over
// her, instead of only via the hotkey. getUserMedia's default
// echoCancellation constraint (on since ensureMediaStream() only ever
// requests `audio: true`) already tries to cancel Mana's own TTS voice out
// of the mic before this ever sees it, but real speaker/mic acoustic paths
// vary a lot by hardware -- unlike the hotkey, this can misfire on residual
// echo. Set MANA_BARGE_IN_VOICE=0 to fall back to hotkey-only if it
// misfires; raising MANA_BARGE_IN_HOLD_MS (continuous VAD-positive speech
// required before triggering, rejects brief echo pops/clicks) is worth
// trying first.
const BARGE_IN_VOICE_ENABLED = process.env.MANA_BARGE_IN_VOICE !== "0";
const BARGE_IN_HOLD_MS = Number(process.env.MANA_BARGE_IN_HOLD_MS || 350);
const BARGE_IN_MIN_DBFS = Number(process.env.MANA_BARGE_IN_MIN_DBFS || DEFAULT_BARGE_IN_MIN_DBFS);
const BARGE_IN_POLL_MS = 50;
// Issue #272: ambient screen-sensing is off by default -- opt in with
// MANA_SCREEN_SENSING_ENABLED=1. The interval is deliberately coarse
// (default 2 minutes, not seconds) since this is a periodic glance, not
// continuous capture -- see plugins/screen-sensing for the backend side
// that summarizes-and-discards each captured frame.
const SCREEN_SENSING_ENABLED = process.env.MANA_SCREEN_SENSING_ENABLED === "1";
const SCREEN_SENSING_INTERVAL_MS = Number(process.env.MANA_SCREEN_SENSING_INTERVAL_MS || 120000);
// Issue #450: the clip-review hotkey's rolling frame buffer. Gated behind
// the same SCREEN_SENSING_ENABLED toggle as the glance above -- both are
// continuous background screen capture, the same privacy category, even
// though this runs far more often (a raw capture kept in memory, never sent
// anywhere until the hotkey fires, vs. the glance's periodic vision-model
// call). 5 frames @ 3s apart, settled via a 100-agent vote (47% plurality)
// over 30/50-agent runs that all converged on the same answer.
const CLIP_BUFFER_INTERVAL_MS = Number(process.env.MANA_CLIP_BUFFER_INTERVAL_MS || 3000);
// Issue #283: skip a glance entirely when nobody's been at the keyboard/
// mouse recently, so an empty room doesn't spend a vision-model call for
// nothing. Reuses powerMonitor's OS-level idle time (same signal Dream
// Mode's idle-report already polls, see main.js's "get-idle-seconds"
// handler) rather than a new camera/presence pipeline -- screen-sensing
// captures the desktop, not a webcam, so there's no camera feed to check
// presence against in the first place. Short threshold on purpose (default
// 90s): this just needs "did they step away a moment ago", not Dream
// Mode's "have they been gone for a while" bar.
const SCREEN_SENSING_PRESENCE_IDLE_MS = Number(
  process.env.MANA_SCREEN_SENSING_PRESENCE_IDLE_MS || 90000,
);
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

// Sub-project B: the streaming-chunk-queue currently backing playback, so a
// barge-in trigger can read its not-yet-played sentences. Set at the start
// of playStreamingReply, cleared once that call's queue has genuinely
// drained or been superseded -- see the `if (activeStreamingQueue === queue)`
// guard there, which stops a newer call's reference from being stomped by
// an older one's cleanup running late.
let activeStreamingQueue = null;

// { sentences: string[], stackDepth: 0|1 } while a reply is held mid-
// playback after a barge-in, else null. stackDepth 1 means this hold is
// "underneath" a currently-playing inserted new-question answer; a second
// interruption while stackDepth is 1 discards this hold instead of nesting
// (see handleBargeInTrigger).
let heldReply = null;

// Count of barge-in-triggered captures currently in flight (recording the
// interruption through classifying and acting on it) -- listenLoop must not
// start its own recording while this is > 0, since `processing` alone isn't
// reliably still true for that whole span (it flips false as soon as
// playStreamingReply's now-superseded queue finishes unwinding, which can
// happen well before the interruption has finished being captured). A
// counter rather than a boolean: a nested interruption (see
// handleBargeInTrigger's wasNested branch) starts a second capture while the
// first is still winding down its own `handleTranscript` await, so two
// captures' windows can overlap -- a boolean would get set back to false by
// whichever one finishes first, letting listenLoop start a third, racing
// recording while the other capture is still in flight.
let bargeInCaptureCount = 0;

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

// Issue #391: every artifact detected this session, in chronological order,
// each enriched with a threadId/versionIndex by assignArtifactVersion.
// windows-launcher loads a session's whole history in order (no scroll-back
// pagination the way desktop-client has), and appendChatMessage is the only
// path either live or replayed history goes through -- so a plain
// chronological array is correct here without the batch-ordering care
// desktop-client's paginated prependTurns needs.
let sessionArtifacts = [];

// Called by session-sidebar.js before replaying a (new or freshly switched)
// session's history, so version threads don't bleed across sessions.
function resetSessionArtifacts() {
  sessionArtifacts = [];
}

function appendChatMessage(role, text) {
  if (!chatLogEl || !text) {
    return;
  }
  const bubble = document.createElement("div");
  bubble.className = `chat-message ${role === "user" ? "chat-user" : "chat-mana"}`;

  // A big or ```html fenced block gets pulled out of the bubble into its
  // own window (issue #148) instead of dominating the chat log.
  const rawArtifact = extractArtifact(text);
  const displayText = rawArtifact ? text.replace(rawArtifact.matchedText, "").trim() : text;
  bubble.innerHTML = renderMarkdownToSafeHtml(displayText);

  if (rawArtifact) {
    const artifact = assignArtifactVersion(rawArtifact, sessionArtifacts);
    sessionArtifacts.push(artifact);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-artifact-open";
    button.textContent = `Open ${artifact.language} content in new window`;
    button.addEventListener("click", () => {
      const thread = sessionArtifacts.filter((a) => a.threadId === artifact.threadId);
      ipcRenderer.send("open-artifact", { thread, index: thread.indexOf(artifact) });
    });
    bubble.appendChild(button);
  }

  chatLogEl.appendChild(bubble);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function setAvatarState(state, preferredExpression) {
  ipcRenderer.send("avatar:set-state", state, preferredExpression);
  if (windowAvatar) {
    windowAvatar.setState(state, preferredExpression);
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
  ipcRenderer.send("avatar:set-mouth", 0, 0);
  if (windowAvatar) {
    windowAvatar.setMouthTarget(0, 0);
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
    // Frequency-domain read alongside the time-domain one above, used only
    // for a spectral-centroid estimate (mouth *shape*) -- no extra audio
    // graph, just a second read of the same analyser (see lip-sync.js's
    // spectralCentroidHz).
    const magnitudesDb = new Float32Array(analyser.frequencyBinCount);
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
        analyser.getFloatFrequencyData(magnitudesDb);
        const centroidHz = spectralCentroidHz(
          magnitudesDb,
          lipSyncAudioContext.sampleRate,
          analyser.fftSize,
        );
        // Issue #275: MFCC-based viseme classification, computed alongside
        // (not instead of) the older centroid -- see live2d-avatar.js's
        // setMouthTarget for why centroidHz still travels as a fallback.
        const viseme = classifyViseme(
          computeMfcc(magnitudesDb, lipSyncAudioContext.sampleRate, analyser.fftSize),
        );
        ipcRenderer.send("avatar:set-mouth", rms, centroidHz, viseme);
        if (windowAvatar) {
          windowAvatar.setMouthTarget(rms, centroidHz, viseme);
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
setInterval(refreshBrowserAutomationActivity, BROWSER_AUTOMATION_ACTIVITY_POLL_MS);
refreshModelStatus();
setInterval(refreshModelStatus, MODEL_STATUS_POLL_MS);
if (SCREEN_SENSING_ENABLED) {
  setInterval(runScreenSensingGlance, SCREEN_SENSING_INTERVAL_MS);
  setInterval(captureClipFrame, CLIP_BUFFER_INTERVAL_MS);
}
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

// Sub-project B: re-speaks a held reply's remaining sentences from the cut
// point, reusing the same one-ahead synthesize/play queue playStreamingReply
// uses -- not a new playback primitive, just a second entry point into it,
// sourced from the held array instead of an NDJSON stream. Held state is
// text only; this re-synthesizes rather than replaying cached audio.
async function resumeHeldReply() {
  const sentences = heldReply ? heldReply.sentences : null;
  heldReply = null;
  if (!sentences || sentences.length === 0) {
    return;
  }

  stopReplyAudio();
  const playbackToken = replyPlaybackToken;
  const queue = createStreamingChunkQueue({
    synthesize: (text) => synthesizeSpeechChunk(0, [text], playbackToken),
    play: (audioBlob, text) =>
      playAudioBlob(audioBlob, playbackToken, detectReplyEmotion(text), undefined),
    isCurrent: () => replyPlaybackToken === playbackToken,
    onIdle: () => setAvatarState("idle"),
  });
  activeStreamingQueue = queue;
  const runPromise = queue.run();
  for (const sentence of sentences) {
    queue.pushChunk(sentence);
  }
  queue.markDone();
  await runPromise;
  if (activeStreamingQueue === queue) {
    activeStreamingQueue = null;
  }
}

async function classifyBargeInText(text) {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/barge-in/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      return { category: "unclassified" };
    }
    const data = await response.json();
    return { category: data.category || "unclassified" };
  } catch (e) {
    console.warn("Barge-in classify request failed:", e.message);
    return { category: "unclassified" };
  }
}

// Acts on a classified interruption against the currently-held reply.
// `heldReply` must already be set (non-null) when this is called for the
// non-nested path -- see handleBargeInTrigger.
async function handleBargeInInterruption(category, transcript, gamingModeActive) {
  // Captured once up front: a nested interruption's own capture window can
  // overlap this one's `await handleTranscript` below (see
  // bargeInCaptureCount's doc comment) and replace the module-global
  // `heldReply` with a new hold before this call resumes -- comparing
  // identity against `hold` rather than re-reading the global lets this
  // dispatch stay correct regardless of that ordering.
  const hold = heldReply;

  if (category === "amend") {
    // Same shape as correction (discard, no resume -- the amended reply
    // replaces what was being said, it doesn't supplement it), except the
    // transcript is wrapped so the model steers using the original reply
    // it already has in session history (see the design doc's Key Finding:
    // buildAssistantReply appends the full reply to session history before
    // /reply/stream's final event, well before any barge-in can fire).
    heldReply = null;
    if (transcript) {
      // NOTE: no parentheses here -- cleanTranscriptText() (called inside
      // handleTranscript) strips ALL parenthesized text via
      // /\([^)]+\)/g, which would silently delete a "(...)"-wrapped prefix
      // before the model ever sees it. This bit Task 3 of #399's plan; if
      // you're changing this wrapper, keep it parenthesis-free.
      await handleTranscript(`Amending what you just said: ${transcript}`, gamingModeActive);
    }
    return;
  }

  if (category === "correction") {
    heldReply = null;
    if (transcript) {
      await handleTranscript(transcript, gamingModeActive);
    }
    return;
  }

  if (category === "new_question") {
    hold.stackDepth = 1;
    if (transcript) {
      // handleTranscript -> requestScreenAwareReply -> playStreamingReply
      // already awaits full playback of the inserted answer before
      // returning, so resuming right after is safe -- no separate "wait for
      // playback to finish" step needed.
      await handleTranscript(transcript, gamingModeActive);
    }
    // A nested interruption during the line above discards heldReply itself
    // (see handleBargeInTrigger's wasNested branch) -- only resume if it's
    // still the same hold.
    if (heldReply === hold) {
      await resumeHeldReply();
    }
    return;
  }

  // backchannel or unclassified: resume from the cut point, no new turn.
  await resumeHeldReply();
}

// Fired from watchForBargeIn once a trigger holds for BARGE_IN_HOLD_MS.
// Captures the current reply's not-yet-played sentences, records the
// interruption immediately (not waiting for listenLoop's next cycle),
// transcribes and classifies it, then dispatches to resume/discard/insert.
async function handleBargeInTrigger() {
  const wasNested = Boolean(heldReply && heldReply.stackDepth >= 1);
  const heldSentences = activeStreamingQueue ? activeStreamingQueue.peekPending() : [];
  stopReplyAudio();

  if (wasNested) {
    // A second interruption arrived while an inserted new-question answer
    // was playing -- per the depth-1 cap, the outer held reply is discarded
    // outright (not stacked); this interruption becomes a fresh top-level
    // turn, no classification needed since there's nothing left to
    // resume/discard against.
    heldReply = null;
    bargeInCaptureCount += 1;
    try {
      const chunk = await recordUntilSilence();
      const result = await transcribeBlob(chunk);
      if (result.transcript) {
        const gamingModeActive = await refreshGamingStatus();
        await handleTranscript(result.transcript, gamingModeActive);
      }
    } catch (e) {
      console.warn("Barge-in interruption capture failed:", e.message);
    } finally {
      bargeInCaptureCount -= 1;
    }
    return;
  }

  if (heldSentences.length === 0) {
    // Nothing left to hold -- equivalent to today's stop-and-discard; the
    // normal listen loop picks up whatever comes next.
    return;
  }

  heldReply = { sentences: heldSentences, stackDepth: 0 };
  bargeInCaptureCount += 1;
  try {
    const chunk = await recordUntilSilence();
    const result = await transcribeBlob(chunk);
    const { category } = await classifyBargeInText(cleanTranscriptText(result.transcript || ""));
    const gamingModeActive = await refreshGamingStatus();
    await handleBargeInInterruption(category, result.transcript, gamingModeActive);
  } catch (e) {
    console.warn("Barge-in interruption capture failed:", e.message);
    heldReply = null;
  } finally {
    bargeInCaptureCount -= 1;
  }
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

        // #340: reuses the same `samples` frame just read for VAD -- no
        // extra mic read.
        const isLoudEnough = dbfsFromSamples(samples) >= BARGE_IN_MIN_DBFS;

        const state = nextBargeInState({
          isSpeech,
          isLoudEnough,
          speechStartedAt,
          now: performance.now(),
          holdMs: BARGE_IN_HOLD_MS,
        });
        speechStartedAt = state.speechStartedAt;
        if (state.triggered) {
          handleBargeInTrigger().catch((e) =>
            console.warn("Barge-in interruption handling failed:", e.message),
          );
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

function playAudioBlob(audioBlob, playbackToken, avatarState, preferredExpression) {
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

    setAvatarState(avatarState, preferredExpression);
    currentReplyUrl = URL.createObjectURL(audioBlob);
    currentReplyAudio = new Audio(currentReplyUrl);

    // See reply-audio-playback.js: this resolves on 'pause' too (not just
    // 'ended'/'error'), so interrupting playback via stopReplyAudio() --
    // barge-in, the interrupt hotkey, a fresh reply superseding this one --
    // can't hang this promise (and whatever awaits it, e.g.
    // handleTranscript's `processing` gate) forever.
    waitForPlayback(currentReplyAudio, () => {
      stopLipSync();
      if (currentReplyUrl) {
        URL.revokeObjectURL(currentReplyUrl);
        currentReplyUrl = null;
      }
      currentReplyAudio = null;
    }).then(resolve, reject);

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

// Issue #253: preferredExpression is the model's own expression__set tool
// choice for this reply (from the /reply response's `expression` field, if
// any) -- passed alongside the automatically-detected avatarState, not
// instead of it, since the coarse state still drives motion/idle-reset
// behavior; only the specific expression face is overridden.
async function playReplyAudio(text, preferredExpression) {
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
      await playAudioBlob(audioBlob, playbackToken, avatarState, preferredExpression);
    }
  }

  if (playbackToken === replyPlaybackToken) {
    setAvatarState("idle");
  }
}

// Issue #331: POST /reply/stream sends newline-delimited JSON objects over
// a chunked response -- one "sentence" event per completed sentence, then
// exactly one "final" event. This mirrors node-bot/utils/sse-sentence-
// stream.js's readSseDeltas shape (buffer partial lines across network
// chunks) but for plain NDJSON instead of "data:"-prefixed SSE frames.
async function* readNdjsonEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch (e) {
        // A malformed line costs one event, not the whole stream.
      }
    }
  }
}

// Issue #331: replaces the fetch("/reply") -> res.json() -> playReplyAudio
// flow at this app's two reply call sites. Sentences arrive incrementally
// from POST /reply/stream and are queued for TTS/playback as they arrive;
// on the final event, if what was already streamed doesn't match the true
// final reply (changed:true -- covers both "nothing streamed" and "a
// regeneration pass rewrote it"), cancel the queue and fall back to today's
// synthesize-the-whole-thing-at-once path unchanged.
//
// onFinal(finalEvent), if given, fires the instant the final NDJSON event is
// read -- well before playback finishes, since that event arrives before
// queue.markDone()/runPromise below even start winding down. Issue #331
// review (Finding 1): callers use this to append the reply text to the chat
// log as soon as it's known, instead of waiting for this whole function
// (and therefore all queued audio) to finish playing first.
//
// synthesizeSpeechChunk(index, chunks, ...) reads chunks[index] -- every
// call below passes a fresh one-element array, so the index into *that*
// array is always 0, never the running sentence count. Each sentence gets
// its own avatar-mood read (rather than one mood for the whole reply, like
// playReplyAudio does) since moods aren't known upfront here -- the full
// reply text isn't available until the final event.
async function playStreamingReply(requestBody, preferredExpression, onFinal) {
  stopReplyAudio();
  const playbackToken = replyPlaybackToken;
  const queue = createStreamingChunkQueue({
    synthesize: (text) => synthesizeSpeechChunk(0, [text], playbackToken),
    play: (audioBlob, text) =>
      playAudioBlob(audioBlob, playbackToken, detectReplyEmotion(text), preferredExpression),
    isCurrent: () => replyPlaybackToken === playbackToken,
    onIdle: () => setAvatarState("idle"),
  });
  activeStreamingQueue = queue;
  const runPromise = queue.run();

  let finalEvent = null;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/reply/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    // Deliberately keeps reading every event -- including after this
    // playback has been superseded -- so the full reply text is always
    // available for the chat log even if a barge-in or a newer request cut
    // the *audio* short. The queue itself already stops synthesizing/
    // playing once replyPlaybackToken moves past playbackToken.
    for await (const event of readNdjsonEvents(response)) {
      if (event.type === "sentence") {
        queue.pushChunk(event.text);
      } else if (event.type === "final") {
        finalEvent = event;
        if (typeof onFinal === "function") {
          onFinal(finalEvent);
        }
        if (event.changed) {
          // Known now, as early as the final event itself arrives (which is
          // always after every sentence event, so this can't miss any
          // pending chunk) -- drop the rest of the backlog instead of
          // letting the whole stale draft play out before restarting.
          queue.cancelPending();
        }
      }
    }
  } finally {
    // Always run to completion so the queue's promise settles even if the
    // stream read fails or playback was superseded partway through. Thanks
    // to cancelPending() above, a changed:true run only finishes whatever
    // chunk it was already synthesizing/playing, not the full backlog.
    queue.markDone();
    await runPromise;
    if (activeStreamingQueue === queue) {
      activeStreamingQueue = null;
    }
  }

  const result = finalEvent || { reply: "", ttsConfigured: false };

  // Nothing was streamed (image replies, restart commands) or a
  // verification/retry pass rewrote the reply -- what (if anything) already
  // played doesn't match the true final text, so speak the corrected
  // version from scratch. This intentionally waits for the queue above to
  // fully drain first: calling stopReplyAudio() while a chunk from the
  // *same* queue is still mid-playback would pause its <audio> element
  // without ever firing "ended", leaving playAudioBlob()'s promise (and so
  // this whole function) hung forever.
  if (
    replyPlaybackToken === playbackToken &&
    result.changed &&
    result.reply &&
    result.ttsConfigured
  ) {
    stopReplyAudio();
    await playReplyAudio(result.reply, result.expression);
  }

  return result;
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
    let partialTimer = null;
    let partialPollInFlight = false;
    // Plumbing for #341 Sub-project B's classifier, not yet consumed by
    // anything -- kept in sync with the status text below.
    let partialTranscript = "";
    // Aborted in cleanup() so an in-flight poll doesn't keep running (and
    // competing for CPU with the real /transcribe-only call about to
    // start) after the recording it was polling for has already ended.
    const partialAbortController = new AbortController();
    let stopped = false;
    const startedAt = performance.now();

    function cleanup() {
      stopped = true;
      if (meterTimer !== null) {
        clearTimeout(meterTimer);
        meterTimer = null;
      }
      if (partialTimer !== null) {
        clearInterval(partialTimer);
        partialTimer = null;
      }
      partialAbortController.abort();
      try {
        source.disconnect();
      } catch (e) {}
      audioCtx.close().catch(() => {});
    }

    // #341 Sub-project A: snapshots whatever's been recorded so far and
    // polls for a partial transcript, updating the live status text. A
    // failed or slow poll is silently skipped -- this never blocks or
    // delays tick()'s actual stop-detection logic below. Both this and
    // tick() write statusEl.textContent independently; whichever fires
    // last wins, self-correcting each cycle -- an accepted simplification,
    // not a bug, since this is a live status indicator, not a source of
    // truth for anything.
    async function pollPartialTranscript() {
      if (stopped || partialPollInFlight || chunks.length === 0) {
        return;
      }
      partialPollInFlight = true;
      try {
        const snapshot = new Blob(chunks, { type: "audio/webm" });
        const form = new FormData();
        form.append("file", snapshot, "partial.webm");
        const response = await fetch(`${BACKEND_BASE_URL}/transcribe-partial`, {
          method: "POST",
          body: form,
          signal: partialAbortController.signal,
        });
        if (!response.ok || stopped) {
          return;
        }
        const data = await response.json();
        if (data.transcript && !stopped) {
          partialTranscript = data.transcript;
          statusEl.textContent = `Hearing: "${data.transcript}"`;
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          console.warn("Partial transcript poll failed:", e.message);
        }
      } finally {
        partialPollInFlight = false;
      }
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
    partialTimer = setInterval(pollPartialTranscript, PARTIAL_TRANSCRIPT_POLL_MS);

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
        // Issue #341: the live partial transcript already nudges this wider
        // or narrower than the plain default -- "and I think..." keeps
        // listening longer, "...that's all." wraps up sooner. Falls back to
        // the caller's own silenceBufferMs unchanged when the transcript is
        // empty or has no clear signal either way.
        silenceBufferMs: silenceBufferMsForTranscript(partialTranscript, silenceBufferMs),
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

// Issue #421: only present for a remote-AI session (the backend omits it
// entirely for a local-only one), so this returns null rather than a
// placeholder line -- formatPerfStatus filters null entries out, instead of
// showing a "no data" line for something that fundamentally doesn't apply.
function formatTokenUsage(tokenUsage) {
  if (!tokenUsage) {
    return null;
  }
  const flags = [];
  if (tokenUsage.stopExceeded) flags.push("STOPPED");
  else if (tokenUsage.warnExceeded) flags.push("WARN");
  const flagSuffix = flags.length ? ` [${flags.join(", ")}]` : "";
  return `Remote AI tokens: ${tokenUsage.totalTokens} (${tokenUsage.promptTokens} prompt / ${tokenUsage.completionTokens} completion) across ${tokenUsage.calls} call(s)${flagSuffix}`;
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
    formatTokenUsage(status.tokenUsage),
  ]
    .filter(Boolean)
    .join("\n");
}

async function refreshPerfStatus() {
  if (!perfStatusEl) {
    return;
  }

  try {
    // Issue #421: sessionId is only needed so the backend can look up this
    // session's remote-AI token usage -- when remote AI is off, the backend
    // omits tokenUsage from the response regardless, so passing it here is
    // harmless even for a local-only session.
    const sessionId = typeof ensureSessionId === "function" ? ensureSessionId() : undefined;
    const url = sessionId
      ? `${BACKEND_BASE_URL}/perf/status?sessionId=${encodeURIComponent(sessionId)}`
      : `${BACKEND_BASE_URL}/perf/status`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Performance status returned ${response.status}`);
    }

    const status = await response.json();
    perfStatusEl.textContent = formatPerfStatus(status);
  } catch (error) {
    perfStatusEl.textContent = `Performance metrics unavailable: ${error.message}`;
  }
}

// Tracked separately from "did this particular poll succeed" -- if the
// route starts failing (backend restart, a 500) while the panel is
// showing, staleness still has to keep being re-evaluated against the
// clock, or a failed poll would just leave a stale screenshot on screen
// forever instead of hiding it like a genuinely-quiet browser would.
let lastKnownBrowserActivityAt = 0;

function hideBrowserAutomationActivityIfStale() {
  if (!browserAutomationActivityEl) {
    return;
  }
  if (Date.now() - lastKnownBrowserActivityAt > BROWSER_AUTOMATION_ACTIVITY_STALE_MS) {
    browserAutomationActivityEl.hidden = true;
  }
}

async function refreshBrowserAutomationActivity() {
  if (!browserAutomationActivityEl || !browserAutomationActivityLogEl) {
    return;
  }
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/browser-automation/activity`);
    if (!response.ok) {
      hideBrowserAutomationActivityIfStale();
      return;
    }
    const activity = await response.json();
    const lastEntry = activity.log?.[activity.log.length - 1];
    if (lastEntry) {
      lastKnownBrowserActivityAt = new Date(lastEntry.at).getTime();
    }

    if (!lastEntry || Date.now() - lastKnownBrowserActivityAt > BROWSER_AUTOMATION_ACTIVITY_STALE_MS) {
      browserAutomationActivityEl.hidden = true;
      return;
    }

    browserAutomationActivityEl.hidden = false;
    browserAutomationActivityLogEl.innerHTML = "";
    for (const entry of activity.log.slice(-5)) {
      const line = document.createElement("div");
      line.textContent = entry.summary;
      browserAutomationActivityLogEl.appendChild(line);
    }

    if (browserAutomationActivityScreenshotEl) {
      if (activity.screenshot?.base64) {
        browserAutomationActivityScreenshotEl.src = `data:image/jpeg;base64,${activity.screenshot.base64}`;
        browserAutomationActivityScreenshotEl.hidden = false;
      } else {
        browserAutomationActivityScreenshotEl.hidden = true;
      }
    }
  } catch (error) {
    // Ambient, best-effort indicator -- no error surfaced (same as
    // researchProgress's own loop), but staleness still has to be
    // re-checked, same reasoning as the non-ok branch above.
    hideBrowserAutomationActivityIfStale();
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

// Closing screen (issue #228): reuses the exact same #startupOverlay/
// .startup-row markup and CSS as the boot screen above -- just swaps the
// title/subtitle text and re-shows it -- rather than a second parallel
// overlay. No catch-up handler needed the way startup has one: shutdown
// only ever starts once this renderer is already up and its IPC listeners
// are already attached (main.js's runGracefulShutdown() shows the window
// and sends shutdown-begin itself), unlike startup rows which can fire
// before the page finishes loading.
const startupTitleEl = document.getElementById("startupTitle");
const startupSubtitleEl = document.getElementById("startupSubtitle");

function applyShutdownProgress(update) {
  if (!update || !update.id) return;
  const row = document.querySelector(`.startup-row[data-startup-row="${update.id}"]`);
  if (!row) return;
  row.dataset.status = update.status;
  const statusEl = row.querySelector(".startup-row-status");
  if (statusEl) {
    statusEl.textContent =
      update.status === "ready" ? "Stopped" : update.status === "timeout" ? "Force-stopping" : "Stopping...";
  }
}

ipcRenderer.on("shutdown-begin", () => {
  if (startupTitleEl) startupTitleEl.textContent = "Closing Mana";
  if (startupSubtitleEl) startupSubtitleEl.textContent = "Shutting down...";
  STARTUP_ROW_IDS.forEach((id) => {
    const row = document.querySelector(`.startup-row[data-startup-row="${id}"]`);
    if (!row) return;
    row.dataset.status = "";
    const statusEl = row.querySelector(".startup-row-status");
    if (statusEl) statusEl.textContent = "Waiting...";
  });
  if (startupOverlayEl) startupOverlayEl.hidden = false;
});
ipcRenderer.on("shutdown-progress", (event, update) => applyShutdownProgress(update));

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

// Issue #428: restorable snapshots of applied editor-handoff edits, from
// whichever editor was connected -- generic, not Zed-specific.
function formatSnapshotTimestamp(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function renderEditSnapshotsPanel(snapshots) {
  if (snapshotsEmptyEl) {
    snapshotsEmptyEl.hidden = snapshots.length > 0;
  }
  if (!snapshotsListEl) {
    return;
  }
  snapshotsListEl.innerHTML = "";
  for (const snapshot of snapshots) {
    const row = document.createElement("div");
    row.className = "snapshot-item";

    const info = document.createElement("div");
    info.className = "snapshot-item-info";
    const pathEl = document.createElement("div");
    pathEl.className = "snapshot-item-path";
    pathEl.textContent = snapshot.relativePath || "(unknown file)";
    const metaEl = document.createElement("div");
    metaEl.className = "snapshot-item-meta";
    metaEl.textContent = `${snapshot.summary || "Edit"} · ${formatSnapshotTimestamp(snapshot.appliedAt)}`;
    info.appendChild(pathEl);
    info.appendChild(metaEl);

    const restoreBtn = document.createElement("button");
    restoreBtn.textContent = "Restore";
    restoreBtn.addEventListener("click", () =>
      restoreEditSnapshotWithConfirm(snapshot.id, snapshot.relativePath),
    );

    row.appendChild(info);
    row.appendChild(restoreBtn);
    snapshotsListEl.appendChild(row);
  }
}

async function refreshEditSnapshots() {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/editors/workspace/snapshots`);
    if (!response.ok) {
      throw new Error(`Snapshot list returned ${response.status}`);
    }
    const result = await response.json();
    renderEditSnapshotsPanel(result.snapshots || []);
  } catch (error) {
    console.warn("Mana edit snapshot list failed:", error);
  }
}

// Restore has no code-level conflict check against the file's current
// content -- unlike approving a proposal, a snapshot only knows the file's
// state before its own edit, not what may have changed since. This
// confirmation dialog is the safety net, matching how approval gates (not
// code-level conflict detection) are the safety net elsewhere in this app.
async function restoreEditSnapshotWithConfirm(id, relativePath) {
  const confirmed = await showConfirmModal(
    `Restore "${relativePath}" to its state before this edit? The current content will be overwritten.`,
    "Restore",
  );
  if (!confirmed) {
    return;
  }
  try {
    const response = await fetch(
      `${BACKEND_BASE_URL}/editors/workspace/snapshots/${id}/restore`,
      { method: "POST" },
    );
    const result = await response.json();
    if (!response.ok || !result.restored) {
      throw new Error(result.error || `Restore returned ${response.status}`);
    }
    await refreshEditSnapshots();
  } catch (error) {
    console.warn("Mana edit snapshot restore failed:", error);
  }
}

// Issue #427: hunk-level accept/reject for editor-handoff diff proposals,
// from whichever editor was connected -- generic, not Zed-specific.
let currentProposalReviewId = null;

function renderProposalsPanel(proposals) {
  const pending = proposals.filter((p) => p.status === "pending");
  if (proposalsEmptyEl) {
    proposalsEmptyEl.hidden = pending.length > 0;
  }
  if (!proposalsListEl) {
    return;
  }
  proposalsListEl.innerHTML = "";
  for (const proposal of pending) {
    const row = document.createElement("div");
    row.className = "snapshot-item";

    const info = document.createElement("div");
    info.className = "snapshot-item-info";
    const pathEl = document.createElement("div");
    pathEl.className = "snapshot-item-path";
    pathEl.textContent = proposal.relativePath || "(unknown file)";
    const metaEl = document.createElement("div");
    metaEl.className = "snapshot-item-meta";
    const hunkCount = proposal.hunkCount || 0;
    metaEl.textContent = `${proposal.summary || "Edit"} · ${hunkCount} hunk${hunkCount === 1 ? "" : "s"}`;
    info.appendChild(pathEl);
    info.appendChild(metaEl);

    const reviewBtn = document.createElement("button");
    reviewBtn.textContent = "Review";
    reviewBtn.addEventListener("click", () => openProposalReview(proposal.id));

    row.appendChild(info);
    row.appendChild(reviewBtn);
    proposalsListEl.appendChild(row);
  }
}

async function refreshProposalsPanel() {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/editors/workspace/proposals`);
    if (!response.ok) {
      throw new Error(`Proposal list returned ${response.status}`);
    }
    const result = await response.json();
    renderProposalsPanel(result.proposals || []);
  } catch (error) {
    console.warn("Mana proposal list failed:", error);
  }
}

function renderHunkDiff(hunk) {
  const pre = document.createElement("pre");
  pre.className = "hunk-diff";
  for (const line of hunk.lines) {
    const span = document.createElement("span");
    const prefix = line.charAt(0);
    span.className =
      prefix === "+" ? "hunk-line-add" : prefix === "-" ? "hunk-line-del" : "hunk-line-ctx";
    span.textContent = `${line}\n`;
    pre.appendChild(span);
  }
  return pre;
}

function renderProposalReviewHunks(proposal) {
  if (!proposalReviewHunksEl) return;
  proposalReviewHunksEl.innerHTML = "";
  for (const hunk of proposal.hunks || []) {
    const card = document.createElement("div");
    card.className = "hunk-card";

    const label = document.createElement("label");
    label.className = "hunk-card-header";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.hunkId = hunk.id;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` Accept this hunk (line ${hunk.newStart})`));
    card.appendChild(label);
    card.appendChild(renderHunkDiff(hunk));
    proposalReviewHunksEl.appendChild(card);
  }
}

async function openProposalReview(id) {
  try {
    const response = await fetch(
      `${BACKEND_BASE_URL}/editors/workspace/proposals/${encodeURIComponent(id)}`,
    );
    if (!response.ok) {
      throw new Error(`Proposal fetch returned ${response.status}`);
    }
    const result = await response.json();
    const proposal = result.proposal;
    currentProposalReviewId = proposal.id;
    if (proposalReviewPathEl) proposalReviewPathEl.textContent = proposal.relativePath || "";
    if (proposalReviewSummaryEl) proposalReviewSummaryEl.textContent = proposal.summary || "";
    renderProposalReviewHunks(proposal);
    if (proposalReviewEl) proposalReviewEl.hidden = false;
    if (proposalsListEl) proposalsListEl.hidden = true;
  } catch (error) {
    console.warn("Mana proposal review failed:", error);
  }
}

function closeProposalReview() {
  currentProposalReviewId = null;
  if (proposalReviewEl) proposalReviewEl.hidden = true;
  if (proposalsListEl) proposalsListEl.hidden = false;
}

async function approveSelectedProposalHunks() {
  if (!currentProposalReviewId || !proposalReviewHunksEl) return;
  const acceptedHunkIds = [...proposalReviewHunksEl.querySelectorAll("input[type=checkbox]")]
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.dataset.hunkId);

  try {
    const response = await fetch(
      `${BACKEND_BASE_URL}/editors/workspace/proposals/${encodeURIComponent(currentProposalReviewId)}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acceptedHunkIds }),
      },
    );
    const result = await response.json();
    if (!response.ok || !result.proposal) {
      throw new Error(result.error || `Approve returned ${response.status}`);
    }
    closeProposalReview();
    await refreshProposalsPanel();
  } catch (error) {
    console.warn("Mana proposal approve failed:", error);
  }
}

function shouldReadScreenForCommand(text, gamingModeActive) {
  const normalized = cleanTranscriptText(text).toLowerCase();
  return shouldReadScreenForCommandPure(normalized, {
    gamingModeActive,
    keywordGateEnabled: SCREEN_CONTEXT_KEYWORD_GATE_ENABLED,
  });
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

    // Issue #343: try the UI Automation tree first -- fast, precise, no
    // screenshot/OCR round trip -- and only fall back to the existing
    // screenshot+OCR path below when it's disabled, times out, errors, or
    // the tree it got back doesn't clear the empty-tree bar.
    const treeText = await ipcRenderer.invoke("screen:read-accessibility-tree");
    if (isAccessibilityTreeTextUsable(treeText)) {
      lastScreenText = treeText;
      lastScreenContextAt = now;
      return lastScreenText;
    }

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

async function requestScreenAwareReply(text, gamingModeActive, onFinal) {
  const screenText = await readScreenContext(text, gamingModeActive);
  const startedAt = performance.now();
  // playStreamingReply already speaks the reply as sentences stream in (and
  // handles the changed:true fallback/restart), so callers just get the
  // final {reply, ttsConfigured, expression, error?} the same shape /reply
  // used to return -- no separate playReplyAudio call needed at the call site.
  const result = await playStreamingReply(
    {
      text,
      screenText,
      modelProfile: selectedModelProfile,
      sessionId: typeof ensureSessionId === "function" ? ensureSessionId() : undefined,
      presetId: selectedPresetId || undefined,
    },
    undefined,
    onFinal,
  );

  // /reply/stream has no HTTP-level error status (always 200); errors
  // surface as an `error` field on the final event instead. Throwing here
  // preserves the old !response.ok behavior for handleTranscript's callers.
  if (result.error) {
    throw new Error(result.error);
  }

  console.info(`Mana perf: reply ${Math.round(performance.now() - startedAt)}ms`);
  return result;
}

// Issue #272: periodic ambient screen glance -- captures via the same
// screen:capture-primary IPC the vision hotkey uses, but the raw image
// never persists here either: it's a local const inside this one function
// call, sent straight to the backend, and goes out of scope the moment
// this function returns (the backend itself discards it after summarizing,
// see plugins/screen-sensing/index.js). Only ever runs while
// SCREEN_SENSING_ENABLED and skips entirely while Mana is mid-reply/
// mid-listen so it can't step on an actual conversation turn.
let screenSensingRunning = false;
async function runScreenSensingGlance() {
  if (!SCREEN_SENSING_ENABLED || screenSensingRunning || processing || currentReplyAudio) {
    return;
  }
  screenSensingRunning = true;
  try {
    const idleSeconds = await ipcRenderer.invoke("get-idle-seconds").catch(() => 0);
    if (idleSeconds * 1000 >= SCREEN_SENSING_PRESENCE_IDLE_MS) {
      return;
    }
    const gamingModeActive = await refreshGamingStatus();
    const image = await ipcRenderer.invoke("screen:capture-primary");
    const response = await fetch(`${BACKEND_BASE_URL}/screen-sensing/glance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, gamingModeActive }),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const result = await response.json();
    // Re-check: a real conversation turn (voice reply, playback) can start
    // during the awaits above (gaming-status check, screen capture, the
    // vision-model round-trip itself) -- without this, a glance that was
    // fine to run when it started could still land on top of it.
    if (result.shouldSurface && result.summary && !processing && !currentReplyAudio) {
      replyEl.textContent = `Mana: ${result.summary}`;
      appendChatMessage("mana", result.summary);
      if (typeof refreshSessionList === "function") {
        refreshSessionList();
      }
    }
  } catch (error) {
    console.warn("Screen sensing glance failed:", error.message);
  } finally {
    screenSensingRunning = false;
  }
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
    // Issue #331 review (Finding 1): append to the chat log as soon as the
    // final event names the reply, not after playStreamingReply resolves --
    // that await also waits for every queued chunk to finish *playing*.
    const result = await playStreamingReply(
      {
        text: DEFAULT_VISION_HOTKEY_PROMPT,
        image,
        modelProfile: selectedModelProfile,
        sessionId: typeof ensureSessionId === "function" ? ensureSessionId() : undefined,
        presetId: selectedPresetId || undefined,
      },
      undefined,
      (finalEvent) => {
        if (finalEvent.error) {
          return;
        }
        const reply = finalEvent.reply || "";
        replyEl.textContent = `Mana: ${reply}`;
        appendChatMessage("mana", reply);
        if (typeof refreshSessionList === "function") {
          refreshSessionList();
        }
      },
    );

    // /reply/stream has no HTTP-level error status (always 200) -- errors
    // surface as an `error` field on the final event instead. The vision-
    // model-missing case is the one describeVisionHotkeyError special-cases
    // by status code, so match its literal backend message here.
    if (result.error) {
      const status = result.error === "no local vision model available" ? 503 : 0;
      statusEl.textContent = describeVisionHotkeyError(status, result.detail || result.error);
      return;
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

let clipBuffer = createClipBuffer();

// Issue #450: silent background capture into the rolling clip buffer -- no
// reply pipeline, no status text, just accumulate a frame. Unlike
// runScreenSensingGlance, this doesn't skip during processing/reply/idle --
// it's a cheap local screenshot with no model call, and skipping would
// create gaps in the buffer at exactly the moments (mid-conversation about
// something on screen) it would be most useful to have covered.
async function captureClipFrame() {
  try {
    const image = await ipcRenderer.invoke("screen:capture-primary");
    clipBuffer = pushClipFrame(clipBuffer, image, Date.now());
  } catch (error) {
    console.warn("Clip buffer capture failed:", error);
  }
}

let clipHotkeyBusy = false;

async function handleClipHotkey() {
  if (clipHotkeyBusy) {
    return;
  }
  clipHotkeyBusy = true;
  processing = true;
  // Pressing the hotkey is an explicit request, so it also wakes Mana.
  awake = true;

  try {
    const images = getClipImages(clipBuffer);
    if (!images.length) {
      statusEl.textContent = "Mana hasn't captured anything yet -- try again in a few seconds.";
      return;
    }
    const prompt = buildClipHotkeyPrompt(getClipSpanSeconds(clipBuffer));

    statusEl.textContent = "Mana is reviewing what just happened...";
    transcriptEl.textContent = "You: (clip hotkey)";
    appendChatMessage("user", "(asked Mana what just happened)");

    const result = await playStreamingReply(
      {
        text: prompt,
        images,
        modelProfile: selectedModelProfile,
        sessionId: typeof ensureSessionId === "function" ? ensureSessionId() : undefined,
        presetId: selectedPresetId || undefined,
      },
      undefined,
      (finalEvent) => {
        if (finalEvent.error) {
          return;
        }
        const reply = finalEvent.reply || "";
        replyEl.textContent = `Mana: ${reply}`;
        appendChatMessage("mana", reply);
        if (typeof refreshSessionList === "function") {
          refreshSessionList();
        }
      },
    );

    // Same no-HTTP-level-error shape as the vision hotkey -- see its own
    // comment above for why status codes are inferred from the message.
    if (result.error) {
      const status = result.error === "no local vision model available" ? 503 : 0;
      statusEl.textContent = describeVisionHotkeyError(status, result.detail || result.error);
      return;
    }

    statusEl.textContent = listening
      ? awake
        ? "Mana is awake..."
        : "Waiting for Mana..."
      : "Stopped";
  } catch (error) {
    console.warn("Clip hotkey failed:", error);
    statusEl.textContent = describeVisionHotkeyError(0, error.message);
  } finally {
    processing = false;
    clipHotkeyBusy = false;
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

ipcRenderer.on("clip:hotkey", () => {
  handleClipHotkey();
});

// Issue #417: node-bot asks (over vision-capture-bridge.js's WebSocket,
// relayed here by main.js) for a fresh screenshot when the model decides
// mid-reply that seeing the screen would help. Captures the same way the
// hotkey/ambient-glance flows already do, then POSTs the result back so
// the server's pending requestCapture() promise resolves. A capture
// failure (e.g. the user denies a screen-capture permission prompt) is
// POSTed back as {requestId, error} so the server can reject the pending
// promise immediately instead of blocking the reply for the full
// DEFAULT_TIMEOUT_MS -- see vision-capture-bridge.js's rejectCapture().
ipcRenderer.on("vision:capture-request", async (event, requestId) => {
  let image;
  try {
    image = await ipcRenderer.invoke("screen:capture-primary");
  } catch (error) {
    console.warn("Mana vision capture-request failed:", error);
    try {
      await fetch(`${BACKEND_BASE_URL}/vision/capture-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, error: error.message || String(error) }),
      });
    } catch (postError) {
      console.warn("Mana vision capture-result error POST failed:", postError);
    }
    return;
  }
  try {
    await fetch(`${BACKEND_BASE_URL}/vision/capture-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, image }),
    });
  } catch (error) {
    console.warn("Mana vision capture-result POST failed:", error);
  }
});

// Issue #219: lets the user cut Mana off mid-speech (MANA_INTERRUPT_HOTKEY,
// "Control+Alt+I" by default) -- stopReplyAudio() already does everything
// needed (bumps replyPlaybackToken, pauses the audio, resets avatar state);
// this just exposes it as a user action instead of only firing internally
// when a new reply supersedes an old one.
ipcRenderer.on("interrupt-speech", () => {
  stopReplyAudio();
  heldReply = null;
});

// Issue #398: the quick-entry popup is just an alternate way to fill
// #chatInput and hit send -- reuses sendTypedMessage() as-is instead of a
// second reply pipeline, so this gets the same gaming-mode check,
// wake-bypass, and TTS playback any other typed message already gets.
ipcRenderer.on("quick-entry:submit", (event, text) => {
  if (!chatInputEl) return;
  chatInputEl.value = text;
  sendTypedMessage();
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
    // Issue #331 review (Finding 1): append the reply to the chat log the
    // instant the final event names it, not after requestScreenAwareReply
    // resolves -- that await also waits for every queued chunk to finish
    // *playing*, which used to make the text show up later than before
    // this feature existed instead of earlier.
    await requestScreenAwareReply(command, gamingModeActive, (finalEvent) => {
      if (finalEvent.error) {
        return;
      }
      const reply = finalEvent.reply || "";
      replyEl.textContent = `Mana: ${reply}`;
      appendChatMessage("mana", reply);
      if (typeof refreshSessionList === "function") {
        refreshSessionList();
      }
    });

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
    if (processing || currentReplyAudio || bargeInCaptureCount > 0) {
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
  heldReply = null;

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

refreshSnapshotsBtn?.addEventListener("click", () => {
  refreshEditSnapshots();
});

refreshProposalsBtn?.addEventListener("click", () => {
  refreshProposalsPanel();
});
proposalReviewBackBtn?.addEventListener("click", closeProposalReview);
proposalReviewApproveBtn?.addEventListener("click", () => {
  approveSelectedProposalHunks();
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
refreshEditSnapshots();
refreshProposalsPanel();

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

// Issue #362: consume the caption feed node-bot has been broadcasting on
// /ws/captions since caption-server.js landed. Purely additive -- if the
// socket never connects, everything else behaves exactly as before.
(function initCaptions() {
  try {
    if (typeof createCaptionClient !== "function") return;
    const el = document.getElementById("mana-captions");
    if (!el) return;
    createCaptionClient({
      onCaption: ({ text }) => {
        el.textContent = text;
        el.hidden = false;
      },
    }).connect();
  } catch (e) {
    // Captions must never take the conversation down with them.
  }
})();

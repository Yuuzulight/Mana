const { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, screen, session } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createBackendConfigStore } = require("./backend-config");
const { OPEN_CHAT_ACTION_INDEX, isProactiveToast, buildToastOptions } = require("./proactive-notifications");

let mainWindow;
let avatarWindow;
let artifactWindow = null;
let backendProcess = null;
let ttsProcess = null;
let retrieverProcess = null;
let fallbackKokoroProcess = null;
let searxngProcess = null;
let embedderProcess = null;
// Issue #190: the backend base URL used to be a hardcoded constant here and
// in 3 renderer files (32 occurrences total) -- now persisted so the
// Electron client can point at a remote node-bot instead of only a
// co-located one, the first step toward an always-on dedicated Mana box.
const backendConfigStore = createBackendConfigStore({
  configPath: path.join(app.getPath("userData"), "mana-config.json"),
});
const { getBackendBaseUrl, isBackendUrlLoopback } = backendConfigStore;

function getHealthUrl() {
  return `${getBackendBaseUrl()}/health`;
}

function getIdleReportUrl() {
  return `${getBackendBaseUrl()}/internal/idle-report`;
}

function getTrayWebSocketUrl() {
  return `${getBackendBaseUrl().replace(/^http/, "ws")}/ws/tray`;
}

ipcMain.handle("get-backend-url", async () => getBackendBaseUrl());
ipcMain.on("get-backend-url-sync", (event) => {
  event.returnValue = getBackendBaseUrl();
});
ipcMain.handle("set-backend-url", async (event, url) => {
  backendConfigStore.setBackendBaseUrl(url);
  return { ok: true };
});

const IDLE_REPORT_INTERVAL_MS = 60000;
const KOKORO_TTS_URL = "http://127.0.0.1:5011/health";
const GPT_SOVITS_TTS_URL = "http://127.0.0.1:9880/";
const FISH_TTS_URL = "http://127.0.0.1:8080/v1/health";
const ROOT_DIR = path.join(__dirname, "..");
// Used for the taskbar/window icon and the tray icon. Previously the tray
// loaded sprites/sprite-idle.png, a file deleted from the repo a while ago
// (issue #45/#46 purged the whole sprites/ folder for licensing reasons) --
// nativeImage.createFromPath() doesn't throw on a missing file, it just
// silently returns an empty image, which is why both showed up as a
// generic/blank icon instead of erroring visibly.
const APP_ICON_PATH = path.join(__dirname, "assets", "icon.png");
const TTS_DIR = path.join(ROOT_DIR, "tts-service");
const WHISPER_DIR = path.join(ROOT_DIR, "tools", "whisper");
const DEFAULT_WHISPER_BIN = path.join(
  WHISPER_DIR,
  "Release",
  "whisper-cli.exe",
);
const DEFAULT_WHISPER_MODEL = path.join(
  WHISPER_DIR,
  "models",
  "ggml-tiny.en.bin",
);
const HIDE_MAIN_WINDOW_AFTER_STARTUP =
  process.env.HIDE_MAIN_WINDOW_AFTER_STARTUP !== "0";
const AVATAR_SIZE = {
  width: Number(process.env.MANA_AVATAR_WIDTH || 234),
  height: Number(process.env.MANA_AVATAR_HEIGHT || 288),
};
const AVATAR_LEFT = Number(process.env.MANA_AVATAR_LEFT || 782);
const AVATAR_BOTTOM = Number(process.env.MANA_AVATAR_BOTTOM || 0);
const AVATAR_TOP_LEVEL = process.env.MANA_AVATAR_TOP_LEVEL || "screen-saver";
// Global "look at my screen" hotkey; set MANA_VISION_HOTKEY=off to disable.
const VISION_HOTKEY = process.env.MANA_VISION_HOTKEY || "Control+Alt+M";
// Global hotkey that toggles the Mana chat window; set to off to disable.
const WINDOW_HOTKEY = process.env.MANA_WINDOW_HOTKEY || "Control+Alt+Space";
// Issue #219: interrupts Mana mid-speech (calls the renderer's existing
// stopReplyAudio()) -- listenLoop() deliberately pauses mic recording
// while Mana is speaking (avoids the mic hearing Mana's own voice through
// the speakers), so a manual/hotkey interrupt is the low-risk way to let
// the user cut in without needing real echo cancellation. Set to off to
// disable.
const INTERRUPT_HOTKEY = process.env.MANA_INTERRUPT_HOTKEY || "Control+Alt+I";

async function isServiceRunning(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function isBackendRunning() {
  return isServiceRunning(getHealthUrl());
}

async function isTtsRunning() {
  const provider = process.env.TTS_PROVIDER || "fish";
  if (provider === "kokoro") {
    return isServiceRunning(KOKORO_TTS_URL);
  }
  if (provider === "gpt_sovits") {
    return isGptSovitsRunning();
  }
  if (provider === "fish") {
    // Fish Speech's server setup is separate from Mana (see
    // docs/fish_speech_tts.md) and not launcher-managed, but it can still be
    // health-checked here so the UI reflects reality.
    return isServiceRunning(FISH_TTS_URL);
  }
  // "cli" (or anything unrecognized) has no URL-based service to check.
  return false;
}

// GPT-SoVITS's api_v2.py has no dedicated /health route, so any HTTP
// response (even a 404/422 from an unmatched or param-less route) confirms
// the process is alive; only a connection failure means it's not running.
async function isGptSovitsRunning() {
  try {
    await fetch(GPT_SOVITS_TTS_URL);
    return true;
  } catch (error) {
    return false;
  }
}

async function isKokoroRunning() {
  return isServiceRunning(KOKORO_TTS_URL);
}

function startTtsService() {
  if (ttsProcess) {
    return;
  }

  const provider = process.env.TTS_PROVIDER || "fish";
  if (!["kokoro", "gpt_sovits"].includes(provider)) {
    // Fish Speech's server (api_server.py, serving S1-mini) is started
    // separately from Mana; see docs/fish_speech_tts.md.
    return;
  }

  if (provider === "kokoro") {
    ttsProcess = startKokoroService();
  } else {
    ttsProcess = startGptSovitsService();
    startFallbackKokoroIfEnabled();
  }

  ttsProcess.on("error", (error) => {
    console.error("Failed to start TTS service:", error);
    dialog.showErrorBox(
      "TTS start error",
      `Failed to start ${provider} TTS service: ${error.message}`,
    );
  });

  ttsProcess.stdout.on("data", (data) => {
    console.log(`TTS: ${data}`);
  });
  ttsProcess.stderr.on("data", (data) => {
    console.error(`TTS ERR: ${data}`);
  });
  ttsProcess.on("close", (code) => {
    console.log(`TTS service exited with code ${code}`);
    ttsProcess = null;
  });
}

function startKokoroService() {
  const python = path.join(TTS_DIR, "venv", "Scripts", "python.exe");
  const model = path.join(TTS_DIR, "kokoro", "kokoro-v1.0.int8.onnx");
  const voices = path.join(TTS_DIR, "kokoro", "voices-v1.0.bin");

  if (
    !fs.existsSync(python) ||
    !fs.existsSync(model) ||
    !fs.existsSync(voices)
  ) {
    return startTtsSetupScript("start_kokoro.ps1");
  }

  console.log("Starting Kokoro TTS service directly:", python);
  return spawn(
    python,
    ["-m", "uvicorn", "kokoro_service:app", "--host", "127.0.0.1", "--port", "5011"],
    {
      cwd: TTS_DIR,
      windowsHide: true,
    },
  );
}

// Keep Kokoro warm as the fallback voice so Mana never goes silent if the
// cloning model can't get GPU memory mid-game.
function startFallbackKokoroIfEnabled() {
  if (process.env.MANA_START_KOKORO_FALLBACK === "0" || fallbackKokoroProcess) {
    return;
  }
  fallbackKokoroProcess = startKokoroService();
  fallbackKokoroProcess.on("error", (error) => {
    console.warn("Fallback Kokoro failed to start:", error.message);
    fallbackKokoroProcess = null;
  });
  fallbackKokoroProcess.on("close", () => {
    fallbackKokoroProcess = null;
  });
}

// GPT-SoVITS is a trial voice option (see docs/gpt_sovits_setup.md): a large
// self-contained package under tools/gpt-sovits with its own bundled Python
// runtime, so it is launched via its own runtime.bat/python rather than a
// venv python.exe like the other TTS services.
function startGptSovitsService() {
  const gptSovitsDir = path.join(ROOT_DIR, "tools", "gpt-sovits");
  const runtimePython = path.join(gptSovitsDir, "runtime", "python.exe");
  const apiScript = path.join(gptSovitsDir, "api_v2.py");

  if (!fs.existsSync(runtimePython) || !fs.existsSync(apiScript)) {
    console.warn(
      `GPT-SoVITS not found at ${gptSovitsDir}; see docs/gpt_sovits_setup.md`,
    );
    dialog.showErrorBox(
      "GPT-SoVITS not installed",
      `TTS_PROVIDER is set to gpt_sovits, but ${gptSovitsDir} is missing its runtime. See docs/gpt_sovits_setup.md, or set TTS_PROVIDER back to fish or kokoro.`,
    );
    return startKokoroService();
  }

  console.log("Starting GPT-SoVITS:", runtimePython, apiScript);
  return spawn(runtimePython, [apiScript, "-a", "127.0.0.1", "-p", "9880"], {
    cwd: gptSovitsDir,
    windowsHide: true,
    env: {
      ...process.env,
      // GPT-SoVITS's TTS.py prints a Chinese debug line on every inference
      // call. Windows' console defaults to cp1252, which cannot encode
      // those characters, so the print() throws and GPT-SoVITS's own
      // except-block "safety net" catches it and silently returns 1 second
      // of digital silence instead of real audio, still as HTTP 200 — every
      // reply synthesizes successfully but produces no sound. Forcing UTF-8
      // stdio makes the print succeed so real inference actually runs.
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
}

function startTtsSetupScript(scriptName) {
  const ttsStartScript = path.join(TTS_DIR, scriptName);
  console.log("Starting TTS setup script:", ttsStartScript);
  return spawn(
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", ttsStartScript],
    {
      cwd: TTS_DIR,
      windowsHide: true,
    },
  );
}

const RETRIEVER_URL = "http://127.0.0.1:9000/health";

async function isRetrieverRunning() {
  return isServiceRunning(RETRIEVER_URL);
}

// The Python retriever gives Mana retrieval context and exact token counts.
// It is optional (the backend falls back to heuristics), so failures here
// only warn. Set MANA_START_RETRIEVER=0 to skip starting it.
function startRetrieverService() {
  if (retrieverProcess || process.env.MANA_START_RETRIEVER === "0") {
    return;
  }

  const retrieverScript = path.join(ROOT_DIR, "tools", "retriever_service.py");
  const venvPython = path.join(ROOT_DIR, "venv", "Scripts", "python.exe");
  if (!fs.existsSync(retrieverScript)) {
    console.warn(`Retriever script not found at ${retrieverScript}; skipping`);
    return;
  }
  const python = fs.existsSync(venvPython) ? venvPython : "python";

  console.log("Starting Python retriever:", python, retrieverScript);
  retrieverProcess = spawn(python, ["-u", retrieverScript], {
    cwd: ROOT_DIR,
    windowsHide: true,
  });

  retrieverProcess.on("error", (error) => {
    console.warn("Failed to start Python retriever:", error.message);
    retrieverProcess = null;
  });
  retrieverProcess.stdout.on("data", (data) => {
    console.log(`Retriever: ${data}`);
  });
  retrieverProcess.stderr.on("data", (data) => {
    console.error(`Retriever ERR: ${data}`);
  });
  retrieverProcess.on("close", (code) => {
    console.log(`Python retriever exited with code ${code}`);
    retrieverProcess = null;
  });
}

const EMBEDDER_URL = "http://127.0.0.1:9001/health";

async function isEmbedderRunning() {
  return isServiceRunning(EMBEDDER_URL);
}

// Local embedder (tools/local_embedder.py) computes the sentence-transformer
// embeddings behind /v1/embeddings and Mana's own memory retriever (when
// USE_EMBEDDINGS=1). Optional like the retriever/SearXNG services above --
// USE_EMBEDDINGS just stays off if this doesn't come up. Set
// MANA_START_EMBEDDER=0 to skip starting it.
function startEmbedderService() {
  if (embedderProcess || process.env.MANA_START_EMBEDDER === "0") {
    return;
  }

  const embedderScript = path.join(ROOT_DIR, "node-bot", "tools", "local_embedder.py");
  const venvPython = path.join(ROOT_DIR, "venv", "Scripts", "python.exe");
  if (!fs.existsSync(embedderScript)) {
    console.warn(`Embedder script not found at ${embedderScript}; skipping`);
    return;
  }
  const python = fs.existsSync(venvPython) ? venvPython : "python";

  console.log("Starting local embedder:", python, embedderScript);
  embedderProcess = spawn(
    python,
    [embedderScript, "--port", "9001", "--model", "Qwen/Qwen3-Embedding-0.6B"],
    {
      cwd: ROOT_DIR,
      windowsHide: true,
    },
  );

  embedderProcess.on("error", (error) => {
    console.warn("Failed to start local embedder:", error.message);
    embedderProcess = null;
  });
  embedderProcess.stdout.on("data", (data) => {
    console.log(`Embedder: ${data}`);
  });
  embedderProcess.stderr.on("data", (data) => {
    console.error(`Embedder ERR: ${data}`);
  });
  embedderProcess.on("close", (code) => {
    console.log(`Local embedder exited with code ${code}`);
    embedderProcess = null;
  });
}

const SEARXNG_URL = "http://127.0.0.1:8890/";

async function isSearxngRunning() {
  return isServiceRunning(SEARXNG_URL);
}

// Local SearXNG gives Mana web search, wiki lookups, and page browsing. It
// is optional (those replies just fail gracefully without it), so failures
// here only warn. Set MANA_START_SEARXNG=0 to skip starting it.
function startSearxngService() {
  if (searxngProcess || process.env.MANA_START_SEARXNG === "0") {
    return;
  }

  const searxngDir = path.join(ROOT_DIR, "tools", "searxng");
  const searxngVenvPython = path.join(searxngDir, "venv", "Scripts", "python.exe");
  const settingsPath = path.join(searxngDir, "mana-settings.yml");
  if (!fs.existsSync(searxngVenvPython)) {
    console.warn(
      `SearXNG venv not found at ${searxngVenvPython}; skipping. See docs/web_access_setup.md.`,
    );
    return;
  }

  console.log("Starting local SearXNG:", searxngVenvPython);
  searxngProcess = spawn(searxngVenvPython, ["-m", "searx.webapp"], {
    cwd: searxngDir,
    windowsHide: true,
    env: {
      ...process.env,
      SEARXNG_SETTINGS_PATH: settingsPath,
    },
  });

  searxngProcess.on("error", (error) => {
    console.warn("Failed to start SearXNG:", error.message);
    searxngProcess = null;
  });
  searxngProcess.stdout.on("data", (data) => {
    console.log(`SearXNG: ${data}`);
  });
  searxngProcess.stderr.on("data", (data) => {
    console.error(`SearXNG ERR: ${data}`);
  });
  searxngProcess.on("close", (code) => {
    console.log(`SearXNG exited with code ${code}`);
    searxngProcess = null;
  });
}

// Backend log tail for Settings > Logs (issue #138). Ring buffer so a
// Settings panel opened well after launch can still show recent history
// via ipcMain.handle("get-backend-log") instead of only what streams in
// from that point on.
const BACKEND_LOG_MAX_LINES = 500;
let backendLogBuffer = [];
function appendBackendLog(text) {
  backendLogBuffer.push(...text.split("\n").filter((line) => line.length > 0));
  if (backendLogBuffer.length > BACKEND_LOG_MAX_LINES) {
    backendLogBuffer = backendLogBuffer.slice(-BACKEND_LOG_MAX_LINES);
  }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("backend-log", text);
  }
}
ipcMain.handle("get-backend-log", async () => backendLogBuffer.join("\n"));

// Standalone view for a renderable artifact (issue #148) -- a plain
// resizable/framed window, unlike the frameless overlay avatarWindow uses,
// since this is meant to be read/scrolled like a real document. Reused
// across multiple "open in new window" clicks rather than spawning one
// per artifact.
ipcMain.on("open-artifact", (event, artifact) => {
  if (!artifactWindow || artifactWindow.isDestroyed()) {
    artifactWindow = new BrowserWindow({
      width: 900,
      height: 700,
      title: "Mana Artifact",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    artifactWindow.loadFile(path.join(__dirname, "artifact", "index.html"));
    artifactWindow.on("closed", () => {
      artifactWindow = null;
    });
  }

  const sendArtifact = () => {
    if (artifactWindow && !artifactWindow.isDestroyed()) {
      artifactWindow.webContents.send("artifact:show", artifact);
      artifactWindow.focus();
    }
  };
  if (artifactWindow.webContents.isLoadingMainFrame()) {
    artifactWindow.webContents.once("did-finish-load", sendArtifact);
  } else {
    sendArtifact();
  }
});

// Structured crash-forensic logging for the voice pipeline (issue #147):
// a failed recordUntilSilence()/listenLoop() attempt writes a timestamped
// entry here instead of only console.error, which is easy to lose once
// the window closes. userData (not the install directory) so it survives
// an uninstall/reinstall, matching desktop-client's local-data placement
// (issue #121).
const VOICE_CRASH_LOG_PATH = path.join(app.getPath("userData"), "logs", "voice-crash.log");
ipcMain.handle("log-voice-crash", async (event, details = {}) => {
  try {
    await fs.promises.mkdir(path.dirname(VOICE_CRASH_LOG_PATH), { recursive: true });
    const entry = { at: new Date().toISOString(), ...details };
    await fs.promises.appendFile(VOICE_CRASH_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (e) {
    console.error("Failed to write voice crash log:", e);
  }
});

// Issue #4: per-session transcription debug trail (wake-word matches,
// audio-stats/reject reasons, hallucination filtering, gain applied) --
// same JSON-lines-on-userData pattern as VOICE_CRASH_LOG_PATH above, so a
// "why didn't Mana hear me" report can be diagnosed after the fact. Only
// ever sent by the renderer when SPEECH_DEBUG_ENABLED is on, so this is a
// no-op file by default.
const SPEECH_DEBUG_LOG_PATH = path.join(app.getPath("userData"), "logs", "speech-debug.log");
ipcMain.on("log-speech-debug", async (event, details = {}) => {
  try {
    await fs.promises.mkdir(path.dirname(SPEECH_DEBUG_LOG_PATH), { recursive: true });
    const entry = { at: new Date().toISOString(), ...details };
    await fs.promises.appendFile(SPEECH_DEBUG_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (e) {
    console.error("Failed to write speech debug log:", e);
  }
});

// Native file picker for Settings > Model's "brain"/vision GGUF pickers --
// the renderer POSTs the chosen path to node-bot's /models/path,
// /models/brain-provider, or /models/vision-path routes to actually take
// effect; this handler only returns which file was picked.
ipcMain.handle("browse-model-file", async () => {
  const ggufModelsDir = path.join(ROOT_DIR, "tools", "llama", "gguf-models");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select a local GGUF model file",
    // Electron 43 dropped the OS-remembered-last-directory default in favor
    // of always opening to Downloads when defaultPath is unset; point it at
    // where GGUF models actually live instead (fs.existsSync isn't needed --
    // Electron falls back gracefully if this path doesn't exist yet).
    defaultPath: ggufModelsDir,
    properties: ["openFile"],
    filters: [
      { name: "GGUF model", extensions: ["gguf"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }
  return { canceled: false, filePath: result.filePaths[0] };
});

// Issue #153: session export writes to disk via a native save dialog
// instead of a browser-style auto-download, since this is Electron, not a
// browser tab -- the renderer fetches the JSONL text from node-bot and
// hands it here to actually write.
ipcMain.handle("save-export-file", async (event, { defaultFileName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export session",
    defaultPath: defaultFileName,
    filters: [
      { name: "JSON Lines", extensions: ["jsonl"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  fs.writeFileSync(result.filePath, content, "utf8");
  return { canceled: false, filePath: result.filePath };
});

function startWindowsServices() {
  // Only start one backend process.
  if (backendProcess) {
    return;
  }
  // Issue #190: pointing Settings > Connection at a remote box means that
  // box's own launcher (or a plain `node server.js`) is what starts
  // node-bot -- this client should not also spawn a second, redundant
  // local copy.
  if (!isBackendUrlLoopback()) {
    console.log(`Backend URL (${getBackendBaseUrl()}) is remote -- not spawning a local node-bot.`);
    return;
  }

  const nodeServer = path.join(ROOT_DIR, "node-bot", "server.js");
  console.log("Starting Node bot:", nodeServer);
  backendProcess = spawn("node", [nodeServer], {
    cwd: path.join(ROOT_DIR, "node-bot"),
    env: {
      ...process.env,
      // Quick note: these defaults let the launcher transcribe without a separate setup shell.
      WHISPER_BIN: process.env.WHISPER_BIN || DEFAULT_WHISPER_BIN,
      WHISPER_MODEL: process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
      TTS_PROVIDER: process.env.TTS_PROVIDER || "fish",
      KOKORO_TTS_URL:
        process.env.KOKORO_TTS_URL || "http://127.0.0.1:5011",
      VTUBE_STUDIO_URL:
        process.env.VTUBE_STUDIO_URL || "ws://127.0.0.1:8001",
      VTUBE_STUDIO_ENABLED: process.env.VTUBE_STUDIO_ENABLED || "1",
      // Embeddings power /v1/embeddings and Mana's own semantic memory
      // retrieval; on by default now that the launcher starts the local
      // embedder above. Set USE_EMBEDDINGS=0 to opt back out.
      USE_EMBEDDINGS: process.env.USE_EMBEDDINGS || "1",
      RETRIEVER_EMBEDDER_URL:
        process.env.RETRIEVER_EMBEDDER_URL || "http://127.0.0.1:9001",
    },
  });

  // Startup failures show up here.
  backendProcess.on("error", (error) => {
    console.error("Failed to start Node bot:", error);
    dialog.showErrorBox(
      "Backend start error",
      `Failed to start node-bot: ${error.message}`,
    );
  });

  backendProcess.stdout.on("data", (data) => {
    console.log(`Node: ${data}`);
    appendBackendLog(String(data));
  });
  backendProcess.stderr.on("data", (data) => {
    console.error(`Node ERR: ${data}`);
    appendBackendLog(String(data));
  });
  backendProcess.on("close", (code) => {
    console.log(`Node server exited with code ${code}`);
    backendProcess = null;
  });
}

// Chat-UI size vs. the startup-loading-screen size (issue #138) -- the
// window opens small, sized to the loading card itself, and grows to the
// real chat-UI size in finishStartup() once startup actually completes,
// instead of floating a small centered card inside a mostly-empty
// full-size window the whole time.
const MAIN_WINDOW_WIDTH = 1020;
const MAIN_WINDOW_HEIGHT = 720;
const MAIN_WINDOW_MIN_WIDTH = 640;
const MAIN_WINDOW_MIN_HEIGHT = 480;
const STARTUP_WINDOW_WIDTH = 440;
const STARTUP_WINDOW_HEIGHT = 460;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: STARTUP_WINDOW_WIDTH,
    height: STARTUP_WINDOW_HEIGHT,
    center: true,
    title: "Mana",
    icon: APP_ICON_PATH,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
      // Chromium throttles rAF-driven rendering (the Live2D avatar's idle
      // tilt/gaze/blink loop) to ~1fps once the window loses OS focus,
      // turning smooth idle drift into visible snapping between poses.
      // Mana is meant to keep animating while the user is elsewhere
      // (chatting, tabbed away), so that throttling defeats the point.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Always show first so the startup loading screen (issue #138) is
  // visible -- whether the window then hides into avatar-only mode is
  // decided once startup actually finishes, in runStartupSequence().
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // The overlay is Mana's minimized form: it deploys whenever the chat
  // window is hidden or minimized, and retracts when the window is up.
  mainWindow.on("show", syncOverlayVisibility);
  mainWindow.on("hide", syncOverlayVisibility);
  mainWindow.on("minimize", syncOverlayVisibility);
  mainWindow.on("restore", syncOverlayVisibility);

  // Intercepts the native close (the X button) -- the only quit path that
  // doesn't go through app.quit() first, so before-quit alone would fire
  // too late here (the window would already be destroyed by the time it
  // runs). The second attempt, once isQuitting is already true, is let
  // through normally so the window can actually finish closing.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    runGracefulShutdown();
  });

  mainWindow.on("closed", function () {
    mainWindow = null;
    app.quit();
  });
}

function isMainWindowActive() {
  return Boolean(
    mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      !mainWindow.isMinimized(),
  );
}

function toggleMainWindow(forceShow = false) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (!forceShow && isMainWindowActive()) {
    mainWindow.hide();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function getAvatarBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  // Quick rundown: these defaults place Mana near the lower-middle-left game UI area.
  // Use MANA_AVATAR_LEFT and MANA_AVATAR_BOTTOM if you need to nudge her later.
  return {
    width: AVATAR_SIZE.width,
    height: AVATAR_SIZE.height,
    x: workArea.x + AVATAR_LEFT,
    y: workArea.y + workArea.height - AVATAR_SIZE.height - AVATAR_BOTTOM,
  };
}

function positionAvatarWindow() {
  if (!avatarWindow) {
    return;
  }

  avatarWindow.setBounds(getAvatarBounds());
}

function showAvatarOverlay() {
  if (!avatarWindow || avatarWindow.isDestroyed()) {
    return;
  }

  positionAvatarWindow();
  avatarWindow.show();
  avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  avatarWindow.setAlwaysOnTop(true, AVATAR_TOP_LEVEL);
  avatarWindow.moveTop();
  avatarWindow.setIgnoreMouseEvents(true, { forward: true });
}

// Overlay = minimized Mana. Visible exactly when the chat window is not.
function syncOverlayVisibility() {
  if (!avatarWindow || avatarWindow.isDestroyed()) {
    return;
  }
  if (isMainWindowActive()) {
    avatarWindow.hide();
    return;
  }
  showAvatarOverlay();
}

function createAvatarWindow() {
  let avatarShown = false;
  const showAvatarWindow = () => {
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return;
    }

    avatarShown = true;
    syncOverlayVisibility();
  };

  avatarWindow = new BrowserWindow({
    ...getAvatarBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // focusable:false means this overlay never becomes the OS-focused
      // window, so Chromium's background rAF throttling (~1fps) kicks in
      // permanently even while it's visibly on top of the desktop -- the
      // idle motion ends up snapping between poses instead of drifting
      // smoothly. Disable it; this window is never truly "background".
      backgroundThrottling: false,
    },
  });

  avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  avatarWindow.setAlwaysOnTop(true, AVATAR_TOP_LEVEL);
  avatarWindow.loadFile(path.join(__dirname, "avatar", "index.html"));
  avatarWindow.once("ready-to-show", showAvatarWindow);
  avatarWindow.webContents.once("did-finish-load", showAvatarWindow);
  setTimeout(() => {
    if (!avatarShown) {
      showAvatarWindow();
    }
  }, 1000);

  avatarWindow.webContents.on("did-fail-load", (event, code, description) => {
    console.error(`Avatar failed to load (${code}): ${description}`);
  });

  avatarWindow.on("closed", () => {
    avatarWindow = null;
  });
}

// Startup loading screen (issue #138): shows the window immediately with a
// per-service progress list instead of an unexplained pause, then either
// reveals the chat UI or hides into avatar-only mode per
// HIDE_MAIN_WINDOW_AFTER_STARTUP once everything meaningful is up.
const STARTUP_OVERALL_TIMEOUT_MS = 25000;
const STARTUP_POLL_INTERVAL_MS = 600;
// Snapshot of the latest event per row, so a renderer that attaches its
// listener slightly late (e.g. after a reload) can still catch up via
// ipcMain.handle("get-startup-status") instead of missing early events.
const startupState = {};

function reportStartupProgress(id, status, label) {
  startupState[id] = { id, status, label };
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("startup-progress", startupState[id]);
  }
}

// fish/gpt_sovits both fall back to Kokoro if their configured primary
// never comes up (see the service-start block in app.whenReady below) --
// voice output still works via the fallback, so this has to check both
// instead of just the primary, or the default fish setup would wait
// forever for a Fish Speech server this app never starts itself (see
// docs/fish_speech_tts.md).
async function isVoiceReady() {
  if (await isTtsRunning()) return true;
  const provider = process.env.TTS_PROVIDER || "fish";
  if (["fish", "gpt_sovits"].includes(provider)) {
    return isKokoroRunning();
  }
  return false;
}

// Local AI (llama-server) is lazy-started on the first chat message unless
// MANA_EAGER_LLAMA_SERVER=1 -- with nothing eagerly starting, there's
// nothing to wait for, so this reports ready immediately instead of
// blocking the loading screen on a service that was never asked to start.
async function isLocalAiReady() {
  if (process.env.MANA_EAGER_LLAMA_SERVER !== "1") return true;
  try {
    const response = await fetch(getHealthUrl());
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body.llamaServerRunning);
  } catch (error) {
    return false;
  }
}

async function pollUntilReady(id, label, checkFn, deadline) {
  reportStartupProgress(id, "starting", label);
  while (Date.now() < deadline) {
    if (await checkFn()) {
      reportStartupProgress(id, "ready", label);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
  }
  // Not fatal -- the app is still usable, this just stops making the user
  // wait on something that's taking unusually long (or isn't launcher-
  // managed at all, e.g. a Fish Speech server started outside Mana).
  reportStartupProgress(id, "timeout", label);
}

async function runStartupSequence() {
  const deadline = Date.now() + STARTUP_OVERALL_TIMEOUT_MS;
  await Promise.all([
    pollUntilReady("backend", "Backend", isBackendRunning, deadline),
    pollUntilReady("voice", "Voice", isVoiceReady, deadline),
    pollUntilReady("websearch", "Web search", isSearxngRunning, deadline),
    pollUntilReady("localai", "Local AI", isLocalAiReady, deadline),
  ]);
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Grow from the small startup-card size to the real chat-UI size now
    // that there's real chat UI to show -- min size is only applied here
    // too, so the loading screen was never clamped up to a size bigger
    // than its own content. Resized *before* the IPC signal below: the
    // renderer's handleStartupComplete() measures the avatar canvas's real
    // box to size Live2D's renderer, so the window has to already be at
    // full size by the time that fires.
    mainWindow.setMinimumSize(MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT);
    mainWindow.setSize(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT);
    mainWindow.center();
    mainWindow.webContents.send("startup-complete");
  }
  if (HIDE_MAIN_WINDOW_AFTER_STARTUP && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
}

ipcMain.handle("get-startup-status", async () => startupState);

// Graceful quit (issue #228): today's app.on("quit", ...) below just kills
// every child process silently and instantly, and by the time it runs the
// window is already gone (late Electron lifecycle event) so there's nowhere
// to show progress even if it wanted to. This reuses the exact same
// #startupOverlay/#startupTitle/#startupSubtitle/.startup-row markup from
// startup (issue #138) via new shutdown-begin/shutdown-progress IPC events,
// and windows-launcher's own 3-state status vocabulary (starting/ready/
// timeout, already styled in CSS) rather than importing a separate one --
// see desktop-client/service-manager.js + main.js for the sibling app's
// already-shipped version of this same feature, which this mirrors.
const SHUTDOWN_OVERALL_TIMEOUT_MS = 15000;
const SHUTDOWN_STEP_TIMEOUT_MS = 8000;
let isQuitting = false;

function reportShutdownProgress(id, status, label) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("shutdown-progress", { id, status, label });
  }
}

// Force-kills once maxWaitMs is up so a hung process can't leave quitting
// (or one row's own wait) stuck open indefinitely.
function waitForExit(child, maxWaitMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (e) {}
      resolve(false);
    }, maxWaitMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// Backend + Local AI: one graceful POST /admin/shutdown call releases
// llama-server's VRAM/RAM before node-bot exits -- a plain kill() alone
// can't deliver a catchable signal to child processes on Windows and would
// orphan llama-server.exe (see node-bot/server.js's own comment on that
// route). Reported as two rows since the startup screen already splits
// Backend/Local AI the same way.
async function stopBackendAndLocalAi() {
  if (!backendProcess || backendProcess.exitCode !== null) {
    reportShutdownProgress("backend", "ready", "Backend");
    reportShutdownProgress("localai", "ready", "Local AI");
    return;
  }
  reportShutdownProgress("backend", "starting", "Backend");
  reportShutdownProgress("localai", "starting", "Local AI");

  try {
    const adminSecret = process.env.MANA_ADMIN_SECRET || "";
    const headers = adminSecret ? { Authorization: `Bearer ${adminSecret}` } : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(`${getBackendBaseUrl()}/admin/shutdown`, {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    console.warn("Graceful /admin/shutdown request failed:", e.message);
  }

  const exited = await waitForExit(backendProcess, SHUTDOWN_STEP_TIMEOUT_MS);
  if (exited) {
    reportShutdownProgress("backend", "ready", "Backend");
    reportShutdownProgress("localai", "ready", "Local AI");
  } else {
    console.warn(`backendProcess did not exit within ${SHUTDOWN_STEP_TIMEOUT_MS}ms -- force killed`);
    reportShutdownProgress("backend", "timeout", "Backend");
    reportShutdownProgress("localai", "timeout", "Local AI");
  }
}

// Kills every currently-running process behind one row and waits (bounded)
// for all of them to exit -- windows-launcher can have more than one
// process behind a single row (voice's primary TTS + its Kokoro fallback),
// unlike desktop-client's one-process-per-row shape.
async function stopRow(id, label, processes, maxWaitMs = SHUTDOWN_STEP_TIMEOUT_MS) {
  const running = processes.filter((p) => p && p.exitCode === null);
  if (!running.length) {
    reportShutdownProgress(id, "ready", label);
    return;
  }
  reportShutdownProgress(id, "starting", label);
  running.forEach((p) => {
    try {
      p.kill();
    } catch (e) {}
  });
  const results = await Promise.all(running.map((p) => waitForExit(p, maxWaitMs)));
  if (results.every(Boolean)) {
    reportShutdownProgress(id, "ready", label);
  } else {
    console.warn(`${id} did not exit within ${maxWaitMs}ms -- force killed`);
    reportShutdownProgress(id, "timeout", label);
  }
}

async function runGracefulShutdown() {
  isQuitting = true;
  try {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.hide();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      // The window may currently be minimized to the tray overlay (hidden,
      // still at full chat-UI size) -- shrink it back down to the startup
      // card size (lowering the minimum size first, same as the reverse
      // main->startup transition would need) and show it so the closing
      // screen is actually visible, regardless of what state it was in.
      mainWindow.setMinimumSize(STARTUP_WINDOW_WIDTH, STARTUP_WINDOW_HEIGHT);
      mainWindow.setSize(STARTUP_WINDOW_WIDTH, STARTUP_WINDOW_HEIGHT);
      mainWindow.center();
      mainWindow.show();
      mainWindow.webContents.send("shutdown-begin");
    }
  } catch (e) {}

  // Retriever/embedder have no dedicated row (same as startup, which never
  // surfaces them either) -- kill them alongside backend, not blocking any
  // visible row.
  try {
    retrieverProcess?.kill();
  } catch (e) {}
  try {
    embedderProcess?.kill();
  } catch (e) {}

  const stop = Promise.all([
    stopBackendAndLocalAi(),
    stopRow("voice", "Voice", [ttsProcess, fallbackKokoroProcess]),
    stopRow("websearch", "Web search", [searxngProcess]),
  ]);

  let timedOut = false;
  await Promise.race([
    stop,
    new Promise((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, SHUTDOWN_OVERALL_TIMEOUT_MS);
    }),
  ]);
  if (timedOut) {
    console.warn("Overall shutdown timed out -- forcing exit");
    try {
      backendProcess?.kill("SIGKILL");
    } catch (e) {}
  }

  // Brief grace period so the closing screen's final state (all rows
  // resolved) actually gets a frame to render before the process dies,
  // instead of the window vanishing the instant the last IPC message is
  // sent.
  await new Promise((resolve) => setTimeout(resolve, 400));
  app.exit(0);
}

app.whenReady().then(() => {
  // single instance check
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  // Mana has its own chat UI, not a document-editing app -- the default
  // Electron File/Edit/View/Window/Help menu bar (Chromium devtools/reload/
  // zoom shortcuts, an "Edit" menu with nothing in this app to cut/copy/
  // paste in the traditional sense) doesn't apply here and was never
  // intentionally added, just never explicitly removed either.
  Menu.setApplicationMenu(null);

  // The renderer loads over file://, which Chromium doesn't reliably
  // persist media permission grants for -- without this, getUserMedia()
  // re-prompts on every call (e.g. every Start listening after a Stop),
  // no matter what the user already allowed. This app's mic access is
  // always for the bundled local content, so auto-grant just "media".
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === "media");

  // Start the local Node backend before opening the UI.
  Promise.all([
    isBackendRunning(),
    isTtsRunning(),
    isKokoroRunning(),
    isRetrieverRunning(),
    isSearxngRunning(),
    isEmbedderRunning(),
  ])
    .then(
      ([
        backendRunning,
        ttsRunning,
        kokoroRunning,
        retrieverRunning,
        searxngRunning,
        embedderRunning,
      ]) => {
        if (!ttsRunning) {
          startTtsService();
        }
        // startTtsService() is what normally kicks off the Kokoro fallback
        // alongside gpt_sovits, but it's skipped whenever the primary is
        // already running (e.g. a leftover process from a previous launch)
        // -- and it never runs at all for fish, which the launcher doesn't
        // spawn itself. Kokoro is the fallback voice for fish and
        // gpt_sovits alike, so check for it independently of whether the
        // primary provider needed starting, or Mana goes silent the moment
        // the primary has a bad day.
        {
          const provider = process.env.TTS_PROVIDER || "fish";
          if (["fish", "gpt_sovits"].includes(provider) && !kokoroRunning) {
            startFallbackKokoroIfEnabled();
          }
        }
        if (!retrieverRunning) {
          startRetrieverService();
        }
        if (!searxngRunning) {
          startSearxngService();
        }
        if (!embedderRunning) {
          startEmbedderService();
        }
        if (!backendRunning) {
          startWindowsServices();
        }
      },
    )
    .catch((e) => {
      dialog.showErrorBox("Start error", String(e));
    });

  createWindow();
  createAvatarWindow();
  createTray();
  connectTrayNotifications();
  registerVisionHotkey();
  registerWindowHotkey();
  registerInterruptHotkey();
  runStartupSequence();

  screen.on("display-metrics-changed", positionAvatarWindow);
  screen.on("display-added", positionAvatarWindow);
  screen.on("display-removed", positionAvatarWindow);

  // Real OS idle detection (issue #69), reported to the backend so it can
  // trigger Dream Mode memory consolidation instead of only running on the
  // fixed hourly timer. Best-effort: the backend may not be up yet, or the
  // user may be running without windows-launcher at all -- either way the
  // hourly timer keeps working as the fallback.
  setInterval(() => {
    fetch(getIdleReportUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idleSeconds: powerMonitor.getSystemIdleTime() }),
    }).catch(() => {});
  }, IDLE_REPORT_INTERVAL_MS);

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let tray = null;

function createTray() {
  try {
    const icon = nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("Mana");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Mana", click: () => toggleMainWindow(true) },
        {
          label: "Minimize to overlay",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.hide();
            }
          },
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => toggleMainWindow());
  } catch (error) {
    console.warn(`Tray icon unavailable: ${error.message}`);
  }
}

// Issue #325: node-bot already broadcasts tray notifications over this
// WebSocket -- background-memory audit events, and now periodic Doctor
// warn/fail transitions (doctor-tray-poll.js) -- but nothing in
// windows-launcher ever listened, so every broadcast reached zero
// listeners. Surfaces a Doctor problem via the existing tray icon
// (tooltip + balloon) without requiring the user to open the Doctor popup.
// Uses Node's built-in WebSocket global (stable since Node 22, which
// Electron 39 bundles) rather than adding the `ws` package as a new
// windows-launcher dependency.
const TRAY_SOCKET_RECONNECT_DELAY_MS = 15000;

function connectTrayNotifications() {
  let socket;
  try {
    socket = new WebSocket(getTrayWebSocketUrl());
  } catch (error) {
    setTimeout(connectTrayNotifications, TRAY_SOCKET_RECONNECT_DELAY_MS);
    return;
  }

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (payload && payload.type === "doctor" && tray) {
      tray.setToolTip(`Mana - ${payload.title}: ${payload.text}`);
      if (typeof tray.displayBalloon === "function") {
        tray.displayBalloon({ title: payload.title, content: payload.text });
      }
    } else if (
      isProactiveToast(payload) &&
      process.env.MANA_PROACTIVE_TOASTS_ENABLED !== "0" &&
      Notification.isSupported()
    ) {
      // Issue #423: Dream Mode insights, cron job results, and Deep Research
      // staleness notes reach the user as a native toast even when the
      // launcher window isn't focused/visible, not just chat history.
      const notification = new Notification(buildToastOptions(payload));
      notification.on("action", (event) => {
        if (event.actionIndex !== OPEN_CHAT_ACTION_INDEX || !mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      });
      notification.show();
    }
  });
  // "close" fires after "error" for a failed/dropped connection, so one
  // reconnect-on-close handler covers both -- the backend may not be up
  // yet (e.g. running without windows-launcher, or a slow-starting node-bot).
  socket.addEventListener("close", () => {
    setTimeout(connectTrayNotifications, TRAY_SOCKET_RECONNECT_DELAY_MS);
  });
}

function registerWindowHotkey() {
  const disabled =
    !WINDOW_HOTKEY ||
    WINDOW_HOTKEY === "0" ||
    WINDOW_HOTKEY.toLowerCase() === "off";
  if (disabled) {
    return;
  }

  try {
    const registered = globalShortcut.register(WINDOW_HOTKEY, () => {
      toggleMainWindow();
    });
    if (registered) {
      console.log(`Window hotkey registered: ${WINDOW_HOTKEY}`);
    } else {
      console.warn(
        `Window hotkey ${WINDOW_HOTKEY} could not be registered (already in use by another app?). Set MANA_WINDOW_HOTKEY to change it.`,
      );
    }
  } catch (error) {
    console.warn(`Window hotkey registration failed: ${error.message}`);
  }
}

function registerVisionHotkey() {
  const disabled =
    !VISION_HOTKEY ||
    VISION_HOTKEY === "0" ||
    VISION_HOTKEY.toLowerCase() === "off";
  if (disabled) {
    return;
  }

  try {
    const registered = globalShortcut.register(VISION_HOTKEY, () => {
      // The renderer owns the capture/reply/TTS flow; just poke it.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("vision:hotkey");
      }
    });
    if (registered) {
      console.log(`Vision hotkey registered: ${VISION_HOTKEY}`);
    } else {
      console.warn(
        `Vision hotkey ${VISION_HOTKEY} could not be registered (already in use by another app?). Set MANA_VISION_HOTKEY to change it.`,
      );
    }
  } catch (error) {
    console.warn(`Vision hotkey registration failed: ${error.message}`);
  }
}

function registerInterruptHotkey() {
  const disabled =
    !INTERRUPT_HOTKEY ||
    INTERRUPT_HOTKEY === "0" ||
    INTERRUPT_HOTKEY.toLowerCase() === "off";
  if (disabled) {
    return;
  }

  try {
    const registered = globalShortcut.register(INTERRUPT_HOTKEY, () => {
      // The renderer owns stopReplyAudio()/the speech flow; just poke it.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("interrupt-speech");
      }
    });
    if (registered) {
      console.log(`Interrupt hotkey registered: ${INTERRUPT_HOTKEY}`);
    } else {
      console.warn(
        `Interrupt hotkey ${INTERRUPT_HOTKEY} could not be registered (already in use by another app?). Set MANA_INTERRUPT_HOTKEY to change it.`,
      );
    }
  } catch (error) {
    console.warn(`Interrupt hotkey registration failed: ${error.message}`);
  }
}

ipcMain.on("avatar:set-state", (event, state, preferredExpression) => {
  if (!avatarWindow) {
    return;
  }

  avatarWindow.webContents.send("avatar:state", state, preferredExpression);
});

// Relays speech amplitude (and spectral centroid, for mouth shape) from the
// control window to the avatar for lip sync.
ipcMain.on("avatar:set-mouth", (event, rms, centroidHz, viseme) => {
  if (!avatarWindow) {
    return;
  }

  avatarWindow.webContents.send("avatar:mouth", rms, centroidHz, viseme);
});

// Issue #283: lets the renderer presence-gate a screen-sensing glance
// before spending a vision-model call on an empty room -- reuses the same
// powerMonitor API already polled for Dream Mode's idle-report (issue #69),
// just exposed to the renderer too instead of being main-process-only.
ipcMain.handle("get-idle-seconds", async () => powerMonitor.getSystemIdleTime());

ipcMain.handle("screen:capture-primary", async () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      // Quick rundown: smaller captures make OCR faster and lighter while a game is open.
      width: Math.round(primaryDisplay.size.width * 0.65),
      height: Math.round(primaryDisplay.size.height * 0.65),
    },
  });
  const source =
    sources.find((item) => item.display_id === String(primaryDisplay.id)) ||
    sources[0];

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("No screen source was available");
  }

  const jpeg = source.thumbnail.toJPEG(75);
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
});

app.on("window-all-closed", function () {
  // Quit the app and stop the backend on non-macOS platforms.
  if (process.platform !== "darwin") app.quit();
});

// Fallback for quits that don't originate from mainWindow's own close
// (already intercepted above) -- the tray's "Quit" item and
// window-all-closed both call app.quit() directly.
app.on("before-quit", (event) => {
  if (isQuitting) return; // shutdown already ran (or is running); let this one through
  event.preventDefault();
  runGracefulShutdown();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// Last-resort safety net for any quit path that somehow reaches here
// without going through runGracefulShutdown()'s own cleanup above (that
// path already kills everything itself before app.exit(0), which skips
// this event entirely) -- e.g. a bug in that new code, or some other quit
// trigger this wasn't updated to intercept. Was previously referencing a
// fallbackTtsProcess variable that was never declared anywhere in this
// file (a real pre-existing bug -- ReferenceError, silently swallowed by
// Electron's own event dispatch, meant retrieverProcess/
// fallbackKokoroProcess/searxngProcess/embedderProcess below it never
// actually got killed via this path either).
app.on("quit", () => {
  if (backendProcess) {
    try {
      // Stop the local backend when the app closes.
      backendProcess.kill();
    } catch (e) {}
  }
  if (ttsProcess) {
    try {
      ttsProcess.kill();
    } catch (e) {}
  }
  if (retrieverProcess) {
    try {
      retrieverProcess.kill();
    } catch (e) {}
  }
  if (fallbackKokoroProcess) {
    try {
      fallbackKokoroProcess.kill();
    } catch (e) {}
  }
  if (searxngProcess) {
    try {
      searxngProcess.kill();
    } catch (e) {}
  }
  if (embedderProcess) {
    try {
      embedderProcess.kill();
    } catch (e) {}
  }
});

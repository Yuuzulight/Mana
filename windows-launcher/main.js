const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, screen, session } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

let mainWindow;
let avatarWindow;
let backendProcess = null;
let ttsProcess = null;
let fallbackTtsProcess = null;
let retrieverProcess = null;
let fallbackKokoroProcess = null;
let searxngProcess = null;
const BACKEND_URL = "http://localhost:5005/health";
const IDLE_REPORT_URL = "http://localhost:5005/internal/idle-report";
const IDLE_REPORT_INTERVAL_MS = 60000;
const CHATTERBOX_TTS_URL = "http://127.0.0.1:5010/health";
const KOKORO_TTS_URL = "http://127.0.0.1:5011/health";
const GPT_SOVITS_TTS_URL = "http://127.0.0.1:9880/";
const FISH_TTS_URL = "http://127.0.0.1:8080/v1/health";
const ROOT_DIR = path.join(__dirname, "..");
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
const START_FALLBACK_CHATTERBOX =
  process.env.START_FALLBACK_CHATTERBOX === "1";
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

async function isServiceRunning(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function isBackendRunning() {
  return isServiceRunning(BACKEND_URL);
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
    // health-checked here so the UI reflects reality instead of silently
    // checking Chatterbox's port instead.
    return isServiceRunning(FISH_TTS_URL);
  }
  return isServiceRunning(CHATTERBOX_TTS_URL);
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

async function isChatterboxRunning() {
  return isServiceRunning(CHATTERBOX_TTS_URL);
}

async function isKokoroRunning() {
  return isServiceRunning(KOKORO_TTS_URL);
}

function startTtsService() {
  if (ttsProcess) {
    return;
  }

  const provider = process.env.TTS_PROVIDER || "fish";
  if (!["kokoro", "chatterbox", "gpt_sovits"].includes(provider)) {
    // Fish Speech's server (api_server.py, serving S1-mini) is started
    // separately from Mana; see docs/fish_speech_tts.md.
    return;
  }

  if (provider === "kokoro") {
    ttsProcess = startKokoroService();
  } else if (provider === "gpt_sovits") {
    ttsProcess = startGptSovitsService();
    startFallbackKokoroIfEnabled();
  } else {
    ttsProcess = startTtsSetupScript("start.ps1");
    startFallbackKokoroIfEnabled();
  }

  ttsProcess.on("error", (error) => {
    console.error("Failed to start TTS service:", error);
    dialog.showErrorBox(
      "TTS start error",
      `Failed to start Chatterbox TTS service: ${error.message}`,
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
      `TTS_PROVIDER is set to gpt_sovits, but ${gptSovitsDir} is missing its runtime. See docs/gpt_sovits_setup.md, or set TTS_PROVIDER back to chatterbox.`,
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

function startFallbackChatterboxService() {
  if (fallbackTtsProcess) {
    return;
  }

  if (!START_FALLBACK_CHATTERBOX) {
    return;
  }

  if ((process.env.TTS_PROVIDER || "kokoro") !== "kokoro") {
    return;
  }

  const ttsStartScript = path.join(ROOT_DIR, "tts-service", "start.ps1");
  console.log("Starting fallback Chatterbox TTS service:", ttsStartScript);
  fallbackTtsProcess = spawn(
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", ttsStartScript],
    {
      cwd: path.join(ROOT_DIR, "tts-service"),
    },
  );

  fallbackTtsProcess.on("error", (error) => {
    console.error("Failed to start fallback Chatterbox TTS:", error);
  });

  fallbackTtsProcess.stdout.on("data", (data) => {
    console.log(`Fallback TTS: ${data}`);
  });
  fallbackTtsProcess.stderr.on("data", (data) => {
    console.error(`Fallback TTS ERR: ${data}`);
  });
  fallbackTtsProcess.on("close", (code) => {
    console.log(`Fallback Chatterbox TTS exited with code ${code}`);
    fallbackTtsProcess = null;
  });
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

function startWindowsServices() {
  // Only start one backend process.
  if (backendProcess) {
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
      CHATTERBOX_TTS_URL:
        process.env.CHATTERBOX_TTS_URL || "http://127.0.0.1:5010",
      VTUBE_STUDIO_URL:
        process.env.VTUBE_STUDIO_URL || "ws://127.0.0.1:8001",
      VTUBE_STUDIO_ENABLED: process.env.VTUBE_STUDIO_ENABLED || "1",
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
  });
  backendProcess.stderr.on("data", (data) => {
    console.error(`Node ERR: ${data}`);
  });
  backendProcess.on("close", (code) => {
    console.log(`Node server exited with code ${code}`);
    backendProcess = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: "Mana",
    show: !HIDE_MAIN_WINDOW_AFTER_STARTUP,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (HIDE_MAIN_WINDOW_AFTER_STARTUP) {
      // Quick rundown: keep the mic/listening page alive, just hide the chat
      // window; Mana stays on screen as the avatar overlay.
      mainWindow.hide();
      return;
    }

    mainWindow.show();
  });

  // The overlay is Mana's minimized form: it deploys whenever the chat
  // window is hidden or minimized, and retracts when the window is up.
  mainWindow.on("show", syncOverlayVisibility);
  mainWindow.on("hide", syncOverlayVisibility);
  mainWindow.on("minimize", syncOverlayVisibility);
  mainWindow.on("restore", syncOverlayVisibility);

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

app.whenReady().then(() => {
  // single instance check
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

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
    isChatterboxRunning(),
    isKokoroRunning(),
    isRetrieverRunning(),
    isSearxngRunning(),
  ])
    .then(
      ([
        backendRunning,
        ttsRunning,
        chatterboxRunning,
        kokoroRunning,
        retrieverRunning,
        searxngRunning,
      ]) => {
        if (!ttsRunning) {
          startTtsService();
        }
        // startTtsService() is what normally kicks off the Kokoro fallback
        // alongside chatterbox, but it's skipped whenever the primary is
        // already running (e.g. a leftover process from a previous launch)
        // -- and it never runs at all for fish, which the launcher doesn't
        // spawn itself. Kokoro is the fallback voice for fish, chatterbox,
        // and gpt_sovits alike, so check for it independently of whether
        // the primary provider needed starting, or Mana goes silent the
        // moment the primary has a bad day.
        {
          const provider = process.env.TTS_PROVIDER || "fish";
          if (
            ["fish", "chatterbox", "gpt_sovits"].includes(provider) &&
            !kokoroRunning
          ) {
            startFallbackKokoroIfEnabled();
          }
        }
        if (START_FALLBACK_CHATTERBOX && !chatterboxRunning) {
          startFallbackChatterboxService();
        }
        if (!retrieverRunning) {
          startRetrieverService();
        }
        if (!searxngRunning) {
          startSearxngService();
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
  registerVisionHotkey();
  registerWindowHotkey();

  screen.on("display-metrics-changed", positionAvatarWindow);
  screen.on("display-added", positionAvatarWindow);
  screen.on("display-removed", positionAvatarWindow);

  // Real OS idle detection (issue #69), reported to the backend so it can
  // trigger Dream Mode memory consolidation instead of only running on the
  // fixed hourly timer. Best-effort: the backend may not be up yet, or the
  // user may be running without windows-launcher at all -- either way the
  // hourly timer keeps working as the fallback.
  setInterval(() => {
    fetch(IDLE_REPORT_URL, {
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
    const icon = nativeImage
      .createFromPath(path.join(ROOT_DIR, "sprites", "sprite-idle.png"))
      .resize({ width: 16, height: 16 });
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

ipcMain.on("avatar:set-state", (event, state) => {
  if (!avatarWindow) {
    return;
  }

  avatarWindow.webContents.send("avatar:state", state);
});

// Relays speech amplitude from the control window to the avatar for lip sync.
ipcMain.on("avatar:set-mouth", (event, rms) => {
  if (!avatarWindow) {
    return;
  }

  avatarWindow.webContents.send("avatar:mouth", rms);
});

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

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

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
  if (fallbackTtsProcess) {
    try {
      fallbackTtsProcess.kill();
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
});

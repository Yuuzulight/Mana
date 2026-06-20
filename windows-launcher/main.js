const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

let mainWindow;
let avatarWindow;
let backendProcess = null;
let ttsProcess = null;
let fallbackTtsProcess = null;
const BACKEND_URL = "http://localhost:5005/health";
const CHATTERBOX_TTS_URL = "http://127.0.0.1:5010/health";
const KOKORO_TTS_URL = "http://127.0.0.1:5011/health";
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
  const provider = process.env.TTS_PROVIDER || "kokoro";
  const url = provider === "kokoro" ? KOKORO_TTS_URL : CHATTERBOX_TTS_URL;
  return isServiceRunning(url);
}

async function isChatterboxRunning() {
  return isServiceRunning(CHATTERBOX_TTS_URL);
}

function startTtsService() {
  if (ttsProcess) {
    return;
  }

  const provider = process.env.TTS_PROVIDER || "kokoro";
  if (!["kokoro", "chatterbox"].includes(provider)) {
    return;
  }

  if (provider === "kokoro") {
    ttsProcess = startKokoroService();
  } else {
    ttsProcess = startTtsSetupScript("start.ps1");
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
      TTS_PROVIDER: process.env.TTS_PROVIDER || "kokoro",
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
    width: 520,
    height: 380,
    show: !HIDE_MAIN_WINDOW_AFTER_STARTUP,
    skipTaskbar: HIDE_MAIN_WINDOW_AFTER_STARTUP,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (HIDE_MAIN_WINDOW_AFTER_STARTUP) {
      // Quick rundown: keep the mic/listening page alive, just hide the control window.
      mainWindow.hide();
      return;
    }

    mainWindow.show();
  });

  mainWindow.on("closed", function () {
    mainWindow = null;
    app.quit();
  });
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

function createAvatarWindow() {
  let avatarShown = false;
  const showAvatarWindow = () => {
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return;
    }

    avatarShown = true;
    positionAvatarWindow();
    avatarWindow.show();
    avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    avatarWindow.setAlwaysOnTop(true, AVATAR_TOP_LEVEL);
    avatarWindow.moveTop();
    avatarWindow.setIgnoreMouseEvents(true, { forward: true });
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

  // Start the local Node backend before opening the UI.
  Promise.all([isBackendRunning(), isTtsRunning(), isChatterboxRunning()])
    .then(([backendRunning, ttsRunning, chatterboxRunning]) => {
      if (!ttsRunning) {
        startTtsService();
      }
      if (START_FALLBACK_CHATTERBOX && !chatterboxRunning) {
        startFallbackChatterboxService();
      }
      if (!backendRunning) {
        startWindowsServices();
      }
    })
    .catch((e) => {
      dialog.showErrorBox("Start error", String(e));
    });

  createWindow();
  createAvatarWindow();

  screen.on("display-metrics-changed", positionAvatarWindow);
  screen.on("display-added", positionAvatarWindow);
  screen.on("display-removed", positionAvatarWindow);

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on("avatar:set-state", (event, state) => {
  if (!avatarWindow) {
    return;
  }

  avatarWindow.webContents.send("avatar:state", state);
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
});

const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let mainWindow;
let avatarWindow;
let backendProcess = null;
let ttsProcess = null;
const BACKEND_URL = "http://localhost:5005/health";
const TTS_URL = "http://127.0.0.1:5010/health";
const AVATAR_SIZE = {
  width: Number(process.env.MANA_AVATAR_WIDTH || 260),
  height: Number(process.env.MANA_AVATAR_HEIGHT || 320),
};
const AVATAR_MARGIN = Number(process.env.MANA_AVATAR_MARGIN || 12);

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
  return isServiceRunning(TTS_URL);
}

function startTtsService() {
  if (ttsProcess) {
    return;
  }

  const provider = process.env.TTS_PROVIDER || "chatterbox";
  if (provider !== "chatterbox") {
    return;
  }

  const ttsStartScript = path.join(__dirname, "..", "tts-service", "start.ps1");
  console.log("Starting Chatterbox TTS service:", ttsStartScript);
  ttsProcess = spawn(
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", ttsStartScript],
    {
      cwd: path.join(__dirname, "..", "tts-service"),
    },
  );

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

function startWindowsServices() {
  // Only start one backend process.
  if (backendProcess) {
    return;
  }

  const nodeServer = path.join(__dirname, "..", "node-bot", "server.js");
  console.log("Starting Node bot:", nodeServer);
  backendProcess = spawn("node", [nodeServer], {
    cwd: path.join(__dirname, "..", "node-bot"),
    env: {
      ...process.env,
      TTS_PROVIDER: process.env.TTS_PROVIDER || "chatterbox",
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("closed", function () {
    mainWindow = null;
    app.quit();
  });
}

function getAvatarBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    width: AVATAR_SIZE.width,
    height: AVATAR_SIZE.height,
    x: workArea.x + AVATAR_MARGIN,
    y: workArea.y + workArea.height - AVATAR_SIZE.height - AVATAR_MARGIN,
  };
}

function positionAvatarWindow() {
  if (!avatarWindow) {
    return;
  }

  avatarWindow.setBounds(getAvatarBounds());
}

function createAvatarWindow() {
  avatarWindow = new BrowserWindow({
    ...getAvatarBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
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

  avatarWindow.setAlwaysOnTop(true, "floating");
  avatarWindow.setIgnoreMouseEvents(true, { forward: true });
  avatarWindow.loadFile(path.join(__dirname, "avatar", "index.html"));
  avatarWindow.once("ready-to-show", () => {
    positionAvatarWindow();
    avatarWindow.showInactive();
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
  Promise.all([isBackendRunning(), isTtsRunning()])
    .then(([backendRunning, ttsRunning]) => {
      if (!ttsRunning) {
        startTtsService();
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
});

const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let mainWindow;
let backendProcess = null;
const BACKEND_URL = "http://localhost:5005/health";

async function isBackendRunning() {
  try {
    const response = await fetch(BACKEND_URL);
    return response.ok;
  } catch (error) {
    return false;
  }
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
  isBackendRunning()
    .then((running) => {
      if (!running) {
        startWindowsServices();
      }
    })
    .catch((e) => {
      dialog.showErrorBox("Start error", String(e));
    });

  createWindow();

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
});

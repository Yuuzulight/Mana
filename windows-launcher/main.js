const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let mainWindow;
let wslProcess = null;

function startWindowsServices() {
  // Start the Node backend instead of the Python-based service
  const nodeServer = path.join(__dirname, "..", "node-bot", "server.js");
  console.log("Starting Node bot:", nodeServer);
  wslProcess = spawn("node", [nodeServer], {
    cwd: path.join(__dirname, "..", "node-bot"),
    detached: true,
  });

  wslProcess.stdout.on("data", (data) => {
    console.log(`Node: ${data}`);
  });
  wslProcess.stderr.on("data", (data) => {
    console.error(`Node ERR: ${data}`);
  });
  wslProcess.on("close", (code) => {
    console.log(`Node server exited with code ${code}`);
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

  // Start WSL services which in turn starts the web UI and voice bridge
  try {
    startWindowsServices();
  } catch (e) {
    dialog.showErrorBox("Start error", String(e));
  }

  createWindow();

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", function () {
  // Quit the app. We do NOT kill WSL services so they continue running.
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  if (wslProcess) {
    try {
      wslProcess.kill();
    } catch (e) {}
  }
});

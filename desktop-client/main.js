const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow = null;
let backendProc = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function spawnBackend() {
  const nodeBin = process.execPath || 'node';
  const serverPath = path.join(__dirname, '..', 'node-bot', 'server.js');
  // Start backend in project root
  backendProc = spawn(nodeBin, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { NODE_ENV: process.env.NODE_ENV || '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProc.stdout.on('data', (b) => {
    const s = b.toString();
    console.log('[mana-backend]', s.trim());
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('backend-log', s);
    }
  });
  backendProc.stderr.on('data', (b) => {
    const s = b.toString();
    console.error('[mana-backend]', s.trim());
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('backend-log', s);
    }
  });
  backendProc.on('exit', (code, sig) => {
    console.log('backend exited', code, sig);
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('backend-exit', { code, sig });
  });
}

app.whenReady().then(() => {
  spawnBackend();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  try {
    if (backendProc) {
      backendProc.kill();
      backendProc = null;
    }
  } catch (e) {}
});

ipcMain.handle('show-error', async (ev, msg) => {
  dialog.showErrorBox('Mana Client Error', String(msg || ''));
});

// allow renderer to request backend logs or status via IPC if needed
ipcMain.handle('backend-status', async () => ({ running: !!backendProc && !backendProc.killed }));

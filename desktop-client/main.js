const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
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

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index_fixed.html'));
}

function findBundledNode() {
  try {
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..');
    // common locations inside packaged app or during dev
    const candidates = [
      path.join(resourcesPath, 'node_bin', process.platform === 'win32' ? 'node.exe' : 'bin/node'),
      path.join(resourcesPath, 'node-bin', process.platform === 'win32' ? 'node.exe' : 'bin/node'),
      // fallback to a repo-relative node-bin when running in dev
      path.join(__dirname, '..', '..', 'node-bin', process.platform === 'win32' ? 'node.exe' : 'bin/node'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } catch (e) {}
  return null;
}

function showBackendErrorDialog(title, message){
  try{
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: title || 'Mana backend error',
      message: message || 'Backend failed to start or exited unexpectedly',
      buttons: ['View logs','Open setup docs','Close'],
      defaultId: 0,
      cancelId: 2,
    }).then((res)=>{
      if (res.response === 0){
        // View logs
        const logPath = path.join(path.dirname(__dirname), 'node-bot', 'data', 'backend.out.log');
        if (fs.existsSync(logPath)) shell.openPath(logPath);
        else dialog.showMessageBox(mainWindow, { type:'info', message:'Logs not found: ' + logPath });
      } else if (res.response === 1){
        // Open docs
        const docs = path.join(path.dirname(__dirname), '..', 'BUILD_DESKTOP.md');
        shell.openPath(docs);
      }
    });
  } catch (e) {
    console.warn('Failed to show backend error dialog', e && e.message ? e.message : e);
  }
}

function spawnBackend() {
  // Prefer bundled Node runtime if present (for standalone installer builds)
  const bundled = findBundledNode();
  const nodeBin = bundled || 'node';
  const serverPath = path.join(__dirname, '..', 'node-bot', 'server.js');
  // Start backend in project root
  try{
    backendProc = spawn(nodeBin, [serverPath], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { NODE_ENV: process.env.NODE_ENV || '' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e){
    console.error('Failed to spawn backend', e);
    showBackendErrorDialog('Failed to start backend', String(e));
    return;
  }

  backendProc.stdout.on('data', (b) => {
    const s = b.toString();
    console.log('[mana-backend]', s.trim());
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('backend-log', s);
      // If backend emits a special excite marker, forward to renderer to animate
      try {
        if (String(s).includes('__MANA_EXCITE__')) {
          mainWindow.webContents.send('excite');
        }
      } catch (e) {}
    }
  });
  backendProc.stderr.on('data', (b) => {
    const s = b.toString();
    console.error('[mana-backend]', s.trim());
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('backend-log', s);
      try {
        if (String(s).includes('__MANA_EXCITE__')) {
          mainWindow.webContents.send('excite');
        }
      } catch (e) {}
    }
  });
  backendProc.on('exit', (code, sig) => {
    console.log('backend exited', code, sig);
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('backend-exit', { code, sig });
    if (code && code !== 0) {
      showBackendErrorDialog('Backend exited', `Backend exited with code ${code} (signal: ${sig})`);
    }
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

ipcMain.handle('open-logs', async () => {
  try{
    const logPath = path.join(path.dirname(__dirname), 'node-bot', 'data', 'backend.out.log');
    if (fs.existsSync(logPath)){
      await shell.openPath(logPath);
      return { ok: true, path: logPath };
    }
    return { ok: false, error: 'Log file not found: ' + logPath };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('open-docs', async () => {
  try{
    const docs = path.join(path.dirname(__dirname), '..', 'BUILD_DESKTOP.md');
    if (fs.existsSync(docs)){
      await shell.openPath(docs);
      return { ok: true, path: docs };
    }
    // fallback to open GitHub README URL
    await shell.openExternal('https://github.com/Yuuzulight/Mana/blob/main/BUILD_DESKTOP.md');
    return { ok: true, url: 'https://github.com/Yuuzulight/Mana/blob/main/BUILD_DESKTOP.md' };
  } catch (e) { return { ok: false, error: String(e) }; }
});

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { isAutoUpdateEnabled, createUpdateManager } = require('./update-manager');
const { getManaDataRoot, buildDataDirEnv, migrateLegacyData } = require('./data-dir-manager');
const { resolveAvatarModel } = require('./avatar/resolve-model');

let mainWindow = null;
let backendProc = null;
let updateManager = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The Live2D avatar driver used to read model/config files directly
      // off disk in the renderer, which required nodeIntegration on and
      // contextIsolation off. It now resolves that data over IPC (see
      // avatar/resolve-model.js + the 'avatar:resolve-model' handler
      // below) instead, so the renderer runs fully sandboxed like a normal
      // Electron app (see issue #122).
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
        const docs = path.join(path.dirname(__dirname), 'BUILD_DESKTOP.md');
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

  // Packaged builds only: node-bot's stores default to writing inside their
  // own directory, which for a packaged app is inside the install
  // directory -- normally wiped on uninstall with no prompt (issue #121).
  // Point them at the standard per-user Electron data directory instead,
  // migrating anything already sitting in the old (in-install-dir)
  // location so an upgrade doesn't lose data. Left untouched in dev
  // (`npm start`) so node-bot/data/ in the source tree keeps working the
  // way developers already expect.
  let dataDirEnv = {};
  if (app.isPackaged) {
    const dataRoot = getManaDataRoot(app);
    const legacyDataDir = path.join(path.dirname(serverPath), 'data');
    migrateLegacyData(legacyDataDir, dataRoot);
    dataDirEnv = buildDataDirEnv(dataRoot);
  }

  // Start backend in project root
  try{
    backendProc = spawn(nodeBin, [serverPath], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { NODE_ENV: process.env.NODE_ENV || '' }, dataDirEnv),
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
  // The renderer loads over file://, which Chromium doesn't reliably
  // persist media permission grants for -- without this, getUserMedia()
  // re-prompts on every launch no matter what the user already allowed.
  // This app's mic access is always for the bundled local content, so
  // auto-grant just "media".
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'media');

  spawnBackend();
  createWindow();

  if (isAutoUpdateEnabled()) {
    updateManager = createUpdateManager({ getMainWindow: () => mainWindow });
    // Silent: don't pop an error dialog just because a startup check failed
    // (offline, GitHub hiccup, etc.) -- only explicit "Check for Updates"
    // clicks should surface a failure to the user.
    updateManager.checkForUpdates({ silent: true });
  }

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

ipcMain.handle('avatar:resolve-model', async () => {
  try {
    return resolveAvatarModel();
  } catch (e) {
    console.error('resolveAvatarModel failed:', e);
    return { modelJson: null };
  }
});

// Runs scripts/fetch-sample-avatar.js (same as `npm run fetch-sample-avatar`)
// from the setup wizard, so getting a legally-clean default Live2D avatar
// doesn't require opening a terminal -- see issue #123.
ipcMain.handle('avatar:fetch-sample', async () => {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'scripts', 'fetch-sample-avatar.js')],
      {
        cwd: __dirname,
        // Runs the Electron binary as plain Node (no GUI) so this doesn't
        // depend on a bundled node.exe existing.
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        timeout: 60000,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, message: (stderr || error.message || '').trim() });
        } else {
          resolve({ ok: true, message: stdout.trim() });
        }
      },
    );
  });
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

ipcMain.handle('open-avatar-notice', async () => {
  try{
    const notice = path.join(__dirname, 'AVATAR_NOTICE.md');
    if (fs.existsSync(notice)){
      await shell.openPath(notice);
      return { ok: true, path: notice };
    }
    await shell.openExternal('https://github.com/Yuuzulight/Mana/blob/main/desktop-client/AVATAR_NOTICE.md');
    return { ok: true, url: 'https://github.com/Yuuzulight/Mana/blob/main/desktop-client/AVATAR_NOTICE.md' };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('open-external', async (ev, url) => {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'refusing to open non-http(s) URL' };
    }
    await shell.openExternal(parsed.href);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('get-app-version', async () => app.getVersion());

ipcMain.handle('check-for-updates', async () => {
  if (!updateManager) {
    return { ok: false, message: isAutoUpdateEnabled() ? 'Updater not initialized yet.' : 'Update checks are disabled (MANA_AUTO_UPDATE_ENABLED=0).' };
  }
  return updateManager.checkForUpdates({ silent: false });
});

ipcMain.handle('open-docs', async () => {
  try{
    const docs = path.join(path.dirname(__dirname), 'BUILD_DESKTOP.md');
    if (fs.existsSync(docs)){
      await shell.openPath(docs);
      return { ok: true, path: docs };
    }
    // fallback to open GitHub README URL
    await shell.openExternal('https://github.com/Yuuzulight/Mana/blob/main/BUILD_DESKTOP.md');
    return { ok: true, url: 'https://github.com/Yuuzulight/Mana/blob/main/BUILD_DESKTOP.md' };
  } catch (e) { return { ok: false, error: String(e) }; }
});

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { isAutoUpdateEnabled, createUpdateManager } = require('./update-manager');
const { getManaDataRoot, buildDataDirEnv, migrateLegacyData } = require('./data-dir-manager');
const { resolveAvatarModel } = require('./avatar/resolve-model');
const { createServiceManager } = require('./service-manager');
const { createFirstRunSetup } = require('./first-run-setup');
const { createLogFile } = require('./log-file');

let mainWindow = null;
let backendProc = null;
let updateManager = null;
let serviceManager = null;
let logFile = null;
let isQuitting = false;
const manaRoot = path.join(__dirname, '..');
// Snapshot of the latest startup-progress event per service, so the
// renderer can catch up on anything that happened before its IPC listener
// was ready (Electron doesn't replay missed ipcRenderer events -- the
// first 'backend: starting' can easily fire before the page has finished
// loading and attaching its listener).
const startupState = {};
// Shutdown doesn't need the same catch-up snapshot -- it only ever starts
// once this renderer is already up and listening (see before-quit below) --
// but the same reportProgress() feeds both, routed by isQuitting.
const shutdownState = {};

function reportProgress(update) {
  if (isQuitting) {
    shutdownState[update.id] = update;
    sendToRenderer('shutdown-progress', update);
  } else {
    startupState[update.id] = update;
    sendToRenderer('startup-progress', update);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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

  // Intercept the window's own close (X button / Alt+F4) so the closing
  // screen has a live window to render the shutdown overlay in -- letting
  // this fall through to 'window-all-closed' would destroy mainWindow
  // first, and every sendToRenderer() the graceful-shutdown flow makes
  // would silently no-op on an already-destroyed webContents.
  mainWindow.on('close', (event) => {
    if (isQuitting) return; // shutdown already running; let this one through
    event.preventDefault();
    runGracefulShutdown();
  });
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
        const logPath = logFile?.filePath;
        if (logPath && fs.existsSync(logPath)) shell.openPath(logPath);
        else dialog.showMessageBox(mainWindow, { type:'info', message:'No log entries yet.' });
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

// mainWindow being non-null doesn't mean it's still alive -- on quit, the
// window is destroyed before the backend child process's async 'exit'
// event fires, and calling .send() on a destroyed webContents throws
// "Object has been destroyed" as an uncaught exception in the main
// process. Every backendProc listener below routes through this instead
// of checking mainWindow directly.
function sendToRenderer(channel, payload) {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send(channel, payload);
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
      env: Object.assign(
        {},
        process.env,
        { NODE_ENV: process.env.NODE_ENV || '', MANA_EAGER_LLAMA_SERVER: '1' },
        dataDirEnv,
      ),
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
    sendToRenderer('backend-log', s);
    // If backend emits a special excite marker, forward to renderer to animate
    if (String(s).includes('__MANA_EXCITE__')) {
      sendToRenderer('excite');
    }
  });
  backendProc.stderr.on('data', (b) => {
    const s = b.toString();
    console.error('[mana-backend]', s.trim());
    sendToRenderer('backend-log', s);
    if (String(s).includes('__MANA_EXCITE__')) {
      sendToRenderer('excite');
    }
  });
  backendProc.on('exit', (code, sig) => {
    console.log('backend exited', code, sig);
    sendToRenderer('backend-exit', { code, sig });
    if (code && code !== 0) {
      showBackendErrorDialog('Backend exited', `Backend exited with code ${code} (signal: ${sig})`);
    }
  });
}

app.whenReady().then(async () => {
  // The renderer loads over file://, which Chromium doesn't reliably
  // persist media permission grants for -- without this, getUserMedia()
  // re-prompts on every launch no matter what the user already allowed.
  // This app's mic access is always for the bundled local content, so
  // auto-grant just "media".
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'media');

  logFile = createLogFile(app.getPath('userData'));
  spawnBackend();
  createWindow();

  // First launch only: tools/searxng and tts-service ship as source (see
  // extraResources in package.json) because a venv baked into the
  // installer isn't portable -- pyvenv.cfg hardcodes an absolute path to
  // the machine that built it. Build them locally here instead, once.
  // Kokoro's model files are bundled as plain data and need no download,
  // so "use the included voice" is just building its venv -- the prompt
  // below only asks whether to spend the time/disk on that now.
  const firstRunSetup = createFirstRunSetup({ manaRoot, onProgress: reportProgress });
  const needs = firstRunSetup.needsSetup();
  const setupTasks = [];
  if (needs.searxng) setupTasks.push(firstRunSetup.setupSearxng());
  if (needs.kokoro) {
    const promptFlag = path.join(app.getPath('userData'), '.mana-tts-setup-prompted');
    if (!fs.existsSync(promptFlag)) {
      try {
        fs.mkdirSync(path.dirname(promptFlag), { recursive: true });
        fs.writeFileSync(promptFlag, String(Date.now()));
      } catch (e) {}
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Use Included Voice (Recommended)', 'Skip For Now'],
        defaultId: 0,
        cancelId: 1,
        title: 'Set Up Voice',
        message: 'Mana includes a local voice (Kokoro TTS) with this installer.',
        detail:
          'Use the included voice now, or skip -- you can set up your own model later in tts-service and it will be picked up automatically.',
      });
      if (choice === 0) setupTasks.push(firstRunSetup.setupKokoro());
    }
  }
  if (setupTasks.length) await Promise.all(setupTasks);

  serviceManager = createServiceManager({ manaRoot, onProgress: reportProgress, logFile });
  serviceManager.startAll();

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

// Shows the closing screen (see #shutdownOverlay / renderer.js) and waits
// for each service to actually stop -- including asking node-bot to
// release llama-server's VRAM/RAM first, see server.js's
// POST /admin/shutdown -- before really exiting, instead of just killing
// everything and hoping. Bounded overall so a hung service can't leave the
// app stuck open: service-manager.js's stopAll already times out each step
// individually (6-8s), this is just a second, coarser backstop.
const SHUTDOWN_OVERALL_TIMEOUT_MS = 15000;

// Shared by both quit paths below: the window's own 'close' (the only way
// this app is normally closed -- no tray icon, no quit menu item) and
// 'before-quit' (a fallback for quits that don't originate from a window
// close, e.g. OS logoff/shutdown sending it directly).
function runGracefulShutdown() {
  isQuitting = true;
  (async () => {
    try {
      const stop = serviceManager
        ? serviceManager.stopAll(backendProc, { adminSecret: process.env.ADMIN_SECRET })
        : Promise.resolve();
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
        logFile?.append('[shutdown] overall shutdown timed out -- forcing exit');
        try {
          backendProc?.kill('SIGKILL');
        } catch (e) {}
      }
    } catch (e) {
      logFile?.append(`[shutdown] unexpected error: ${e && e.message ? e.message : e}`);
    }
    // Brief grace period so the closing screen's final state (all rows
    // resolved) actually gets a frame to render before the process dies,
    // instead of the window vanishing the instant the last IPC message is
    // sent.
    await new Promise((resolve) => setTimeout(resolve, 400));
    app.exit(0);
  })();
}

app.on('before-quit', (event) => {
  if (isQuitting) return; // shutdown already ran (or is running); let this one through
  event.preventDefault();
  runGracefulShutdown();
});

ipcMain.handle('show-error', async (ev, msg) => {
  dialog.showErrorBox('Mana Client Error', String(msg || ''));
});

ipcMain.handle('get-startup-status', async () => startupState);

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

// Manual "link a model file" path for Settings > Model and the first-run
// wizard -- the renderer has no filesystem access of its own (contextIsolation),
// so the native file picker has to run here. The picked path is only
// returned to the renderer; it still has to POST it to node-bot's
// /models/path route to actually take effect.
ipcMain.handle('browse-model-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a local LLM model file',
    properties: ['openFile'],
    filters: [
      { name: 'GGUF model', extensions: ['gguf'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }
  return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle('open-logs', async () => {
  try{
    const logPath = logFile?.filePath;
    if (logPath && fs.existsSync(logPath)){
      await shell.openPath(logPath);
      return { ok: true, path: logPath };
    }
    return { ok: false, error: 'No log entries yet.' };
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

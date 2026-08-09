// Wires electron-updater into the desktop client: checks GitHub Releases for
// a newer signed... well, for now unsigned (see issue #119) installer, and
// never downloads or installs anything without an explicit user click --
// autoDownload is off, so update-available/update-downloaded are always
// gated behind a dialog.

function isAutoUpdateEnabled(env = process.env) {
  return env.MANA_AUTO_UPDATE_ENABLED !== "0";
}

// Issue #323: downloadUpdate() has been observed to hang indefinitely on
// this machine -- neither resolving nor rejecting -- which left the UI
// stuck on "Downloading update..." forever with no error and no way to
// retry short of restarting the app. Racing it against a timeout turns
// that hang into a normal, displayable error instead.
const DOWNLOAD_TIMEOUT_MS =
  Number(process.env.MANA_UPDATE_DOWNLOAD_TIMEOUT_MS) || 5 * 60 * 1000;

function createUpdateManager({ getMainWindow, log = console } = {}) {
  const { autoUpdater } = require("electron-updater");
  const { dialog } = require("electron");

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let lastStatus = { state: "idle", message: "" };

  function downloadWithTimeout() {
    // The loser of the race keeps running in the background -- if the real
    // download settles after the timeout already won, swallow it here so a
    // late rejection doesn't surface as an unhandled promise rejection.
    const realDownload = autoUpdater.downloadUpdate();
    realDownload.catch(() => {});
    return Promise.race([
      realDownload,
      new Promise((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Download timed out after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s -- check your connection and try again`));
        }, DOWNLOAD_TIMEOUT_MS);
      }),
    ]);
  }

  function setStatus(state, message) {
    lastStatus = { state, message };
    const win = getMainWindow && getMainWindow();
    // win can be non-null but already destroyed (e.g. an in-flight update
    // check resolving during app quit) -- .send() on a destroyed
    // webContents throws, so isDestroyed() has to gate this too.
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send("update-status", lastStatus);
    }
  }

  autoUpdater.on("checking-for-update", () => {
    setStatus("checking", "Checking for updates...");
  });

  autoUpdater.on("update-not-available", () => {
    setStatus("up-to-date", "Mana is up to date.");
  });

  autoUpdater.on("update-available", (info) => {
    setStatus("available", `Version ${info.version} is available.`);
    const win = getMainWindow && getMainWindow();
    dialog
      .showMessageBox(win, {
        type: "info",
        title: "Update available",
        message: `Mana ${info.version} is available (you have ${require("electron").app.getVersion()}).`,
        detail: "Download it now? Nothing installs until you confirm again after it downloads.",
        buttons: ["Download", "Not now"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((res) => {
        if (res.response === 0) {
          setStatus("downloading", "Downloading update...");
          downloadWithTimeout().catch((err) => {
            setStatus("error", `Download failed: ${err.message}`);
          });
        } else {
          setStatus("available", `Version ${info.version} is available (not downloaded).`);
        }
      });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setStatus("downloaded", `Version ${info.version} downloaded.`);
    const win = getMainWindow && getMainWindow();
    dialog
      .showMessageBox(win, {
        type: "info",
        title: "Update ready",
        message: `Mana ${info.version} has been downloaded.`,
        detail: "Restart now to install it, or install it the next time you quit Mana.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((res) => {
        if (res.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    setStatus("error", err && err.message ? err.message : String(err));
    log.error("[update-manager]", err);
  });

  async function checkForUpdates({ silent = false } = {}) {
    if (!require("electron").app.isPackaged) {
      const message = "Update checks are disabled in dev (unpackaged) builds.";
      setStatus("dev", message);
      return { ok: false, message };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      if (!silent) {
        setStatus("error", err.message);
      }
      return { ok: false, message: err.message };
    }
  }

  function getStatus() {
    return lastStatus;
  }

  return { checkForUpdates, getStatus };
}

module.exports = { isAutoUpdateEnabled, createUpdateManager };

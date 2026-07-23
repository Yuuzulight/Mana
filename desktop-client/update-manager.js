// Wires electron-updater into the desktop client: checks GitHub Releases for
// a newer signed... well, for now unsigned (see issue #119) installer, and
// never downloads or installs anything without an explicit user click --
// autoDownload is off, so update-available/update-downloaded are always
// gated behind a dialog.

function isAutoUpdateEnabled(env = process.env) {
  return env.MANA_AUTO_UPDATE_ENABLED !== "0";
}

function createUpdateManager({ getMainWindow, log = console } = {}) {
  const { autoUpdater } = require("electron-updater");
  const { dialog } = require("electron");

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  let lastStatus = { state: "idle", message: "" };

  function setStatus(state, message) {
    lastStatus = { state, message };
    const win = getMainWindow && getMainWindow();
    if (win && win.webContents) {
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
          autoUpdater.downloadUpdate().catch((err) => {
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

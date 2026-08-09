const assert = require("node:assert/strict");
const test = require("node:test");

const { isAutoUpdateEnabled } = require("../update-manager");

test("isAutoUpdateEnabled defaults to true when unset", () => {
  assert.equal(isAutoUpdateEnabled({}), true);
});

test("isAutoUpdateEnabled is true for any value other than '0'", () => {
  assert.equal(isAutoUpdateEnabled({ MANA_AUTO_UPDATE_ENABLED: "1" }), true);
  assert.equal(isAutoUpdateEnabled({ MANA_AUTO_UPDATE_ENABLED: "yes" }), true);
});

test("isAutoUpdateEnabled is false when explicitly set to '0'", () => {
  assert.equal(isAutoUpdateEnabled({ MANA_AUTO_UPDATE_ENABLED: "0" }), false);
});

// createUpdateManager() requires "electron-updater"/"electron", which under
// plain `node --test` (not the real Electron binary) aren't usable as-is --
// require("electron") returns a path string outside Electron. There's no
// existing mock harness for this in the repo, so fake both modules via
// require.cache injection (no new dependency) to exercise issue #323's
// download-timeout path end to end.
test("a download that never settles times out with a displayable error, not an unhandled rejection", async () => {
  const updaterPath = require.resolve("electron-updater");
  const electronPath = require.resolve("electron");
  const managerPath = require.resolve("../update-manager");

  const handlers = {};
  const fakeAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event, cb) {
      handlers[event] = cb;
    },
    downloadUpdate: () => new Promise(() => {}), // never resolves or rejects
  };
  require.cache[updaterPath] = {
    id: updaterPath,
    filename: updaterPath,
    loaded: true,
    exports: { autoUpdater: fakeAutoUpdater },
  };
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: { isPackaged: true, getVersion: () => "0.0.0" },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
    },
  };
  delete require.cache[managerPath];

  process.env.MANA_UPDATE_DOWNLOAD_TIMEOUT_MS = "30";
  const { createUpdateManager } = require("../update-manager");
  delete process.env.MANA_UPDATE_DOWNLOAD_TIMEOUT_MS;

  try {
    const mgr = createUpdateManager({ getMainWindow: () => null });
    handlers["update-available"]({ version: "9.9.9" });

    // let the dialog's resolved promise + the 30ms timeout race play out
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(mgr.getStatus().state, "error");
    assert.match(mgr.getStatus().message, /timed out/i);
  } finally {
    delete require.cache[updaterPath];
    delete require.cache[electronPath];
    delete require.cache[managerPath];
  }
});

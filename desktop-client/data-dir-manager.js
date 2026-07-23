// Where Mana's local user data (chat history, saved credentials, job
// tracker, etc.) lives for a packaged desktop-client install, and how it
// gets there safely.
//
// node-bot's stores default to path.join(__dirname, "data", ...) -- inside
// node-bot's own directory, which is bundled into the app's install
// directory via extraResources. A normal uninstall deletes the whole
// install directory, so today that means uninstalling Mana silently
// deletes all local data with no prompt (see issue #121). The fix: point
// every store at the standard per-user Electron userData directory
// instead, via each store's existing dataDir env var override, and
// migrate anything already sitting in the old location so nobody loses
// data on upgrade.
const fs = require("fs");
const path = require("path");

function getManaDataRoot(app) {
  return path.join(app.getPath("userData"), "node-bot-data");
}

// Maps each store's own dataDir env var to a subdirectory of the shared
// root. Every one of these already exists in node-bot -- see
// acp-memory-store.js, presets-store.js, auth-store.js,
// mobile-memory-store.js, mobile-device-store.js, plugins/job-applications/
// job-applications-store.js, server.js/acp-autonomous-loop.js
// (MANA_PENDING_WRITES_DIR), and utils/talk_budget.js.
function buildDataDirEnv(dataRoot) {
  return {
    MANA_ACP_MEMORY_DIR: path.join(dataRoot, "acp-memory"),
    MANA_PRESETS_DIR: path.join(dataRoot, "presets"),
    MANA_AUTH_DIR: dataRoot,
    MOBILE_MEMORY_DIR: path.join(dataRoot, "mobile-memory"),
    MANA_JOB_APPLICATIONS_DIR: path.join(dataRoot, "job-applications"),
    MANA_MOBILE_DEVICES_DIR: dataRoot,
    MANA_PENDING_WRITES_DIR: path.join(dataRoot, "pending_writes"),
    MANA_TALK_BUDGET_DIR: dataRoot,
  };
}

// One-time, best-effort copy (never a move -- the legacy copy is left in
// place as a safety net) from the old in-install-dir location into the new
// userData location. No-ops if the new location already has anything, or
// the old one doesn't exist.
function migrateLegacyData(legacyDataDir, dataRoot, log = console) {
  try {
    if (fs.existsSync(dataRoot) && fs.readdirSync(dataRoot).length > 0) {
      return { migrated: false, reason: "destination already populated" };
    }
    if (!fs.existsSync(legacyDataDir)) {
      return { migrated: false, reason: "no legacy data to migrate" };
    }
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(legacyDataDir, dataRoot, { recursive: true });
    log.log(`Migrated existing Mana data: ${legacyDataDir} -> ${dataRoot}`);
    return { migrated: true };
  } catch (err) {
    log.error("Data migration failed (continuing with a fresh data dir):", err);
    return { migrated: false, reason: err.message };
  }
}

module.exports = { getManaDataRoot, buildDataDirEnv, migrateLegacyData };

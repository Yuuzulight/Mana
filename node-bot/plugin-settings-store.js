// Which optional plugins (capabilities with a `category` -- see GET
// /plugins) are enabled. A single small JSON object, same persistence
// pattern as presets-store.js. Missing keys fall back to the plugin's own
// defaultEnabled (true unless the plugin says otherwise, e.g. ffxivMarket).
const fs = require("node:fs");
const path = require("node:path");

function createPluginSettingsStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_PLUGIN_SETTINGS_DIR ||
    path.join(__dirname, "data");
  const filePath = path.join(dataDir, "plugin-settings.json");

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function readAll() {
    ensureDir();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeAll(settings) {
    ensureDir();
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  }

  function isEnabled(key, defaultEnabled = true) {
    const settings = readAll();
    return Object.prototype.hasOwnProperty.call(settings, key)
      ? Boolean(settings[key])
      : Boolean(defaultEnabled);
  }

  function setEnabled(key, enabled) {
    const settings = readAll();
    settings[key] = Boolean(enabled);
    writeAll(settings);
    return settings[key];
  }

  // Consent tracking for Add-Ons (tier: "addon")
  function getConsent(key) {
    const settings = readAll();
    return Object.prototype.hasOwnProperty.call(settings, `consent_${key}`)
      ? Boolean(settings[`consent_${key}`])
      : false;
  }

  function setConsent(key, consented) {
    const settings = readAll();
    settings[`consent_${key}`] = Boolean(consented);
    writeAll(settings);
    return settings[`consent_${key}`];
  }

  return { dataDir, isEnabled, setEnabled, getConsent, setConsent };
}

module.exports = { createPluginSettingsStore };

// Pure logic for issue #190's backend-URL centralization, kept separate
// from main.js so it's testable without requiring "electron" (same
// pure-logic-vs-orchestration split this codebase already uses for
// artifact-detector.js/live2d-logic.js). main.js wires this to
// app.getPath("userData") and the actual ipcMain handlers.
const fs = require("fs");
const path = require("path");

const DEFAULT_BACKEND_BASE_URL = "http://localhost:5005";

// Same http/https-only validation model-management.js's brain-provider
// settings and other user-configured-endpoint fields already use.
function assertValidBackendBaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw new Error(`invalid backend URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("backend URL must use http or https");
  }
  return url;
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

// options.configPath: injectable so tests don't touch a real userData dir.
function createBackendConfigStore(options = {}) {
  const configPath = options.configPath;

  function readConfig() {
    if (!fs.existsSync(configPath)) return {};
    try {
      const raw = fs.readFileSync(configPath, "utf8").trim();
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function writeConfig(patch) {
    const next = { ...readConfig(), ...patch };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, configPath);
  }

  function getBackendBaseUrl() {
    return readConfig().backendUrl || DEFAULT_BACKEND_BASE_URL;
  }

  function setBackendBaseUrl(rawUrl) {
    const validated = assertValidBackendBaseUrl(rawUrl);
    writeConfig({ backendUrl: validated.href.replace(/\/$/, "") });
  }

  function isBackendUrlLoopback() {
    try {
      return isLoopbackHostname(new URL(getBackendBaseUrl()).hostname);
    } catch (e) {
      return true;
    }
  }

  return { getBackendBaseUrl, setBackendBaseUrl, isBackendUrlLoopback };
}

module.exports = {
  DEFAULT_BACKEND_BASE_URL,
  assertValidBackendBaseUrl,
  isLoopbackHostname,
  createBackendConfigStore,
};

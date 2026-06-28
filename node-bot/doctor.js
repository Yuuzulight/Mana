const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createZedIntegration } = require("./zed-integration");

const DEFAULT_NODE_MAJOR = 18;
const DEFAULT_BACKEND_PORT = 5005;

function checkPathExists(filePath) {
  return typeof filePath === "string" && filePath.trim() && fs.existsSync(filePath);
}

function hasRemoteAiEnabled(env) {
  return String(env.MANA_ALLOW_REMOTE_AI || "").trim() === "1";
}

function normalizeStatus(status) {
  return ["pass", "warn", "fail"].includes(status) ? status : "warn";
}

function makeCheck(id, label, status, message, details = {}) {
  return {
    id,
    label,
    status: normalizeStatus(status),
    message,
    details,
  };
}

function summarizeChecks(checks) {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function getNodeMajor(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function checkNodeRuntime(version) {
  const major = getNodeMajor(version);
  if (major >= DEFAULT_NODE_MAJOR) {
    return makeCheck(
      "node-runtime",
      "Node runtime",
      "pass",
      `Node ${version} is available.`,
      { version },
    );
  }

  return makeCheck(
    "node-runtime",
    "Node runtime",
    "fail",
    `Node ${version || "unknown"} is too old. Use Node ${DEFAULT_NODE_MAJOR} or newer.`,
    { version },
  );
}

function checkLocalAiPolicy(env) {
  if (!hasRemoteAiEnabled(env)) {
    return makeCheck(
      "local-ai-policy",
      "Local AI policy",
      "pass",
      "Remote AI is disabled.",
    );
  }

  return makeCheck(
    "local-ai-policy",
    "Local AI policy",
    "warn",
    "Remote AI is enabled. Set MANA_ALLOW_REMOTE_AI=0 for strictly local replies.",
  );
}

function checkRequiredFile(id, label, filePath, missingConfigMessage) {
  if (!filePath) {
    return makeCheck(id, label, "warn", missingConfigMessage);
  }

  if (checkPathExists(filePath)) {
    return makeCheck(id, label, "pass", `${label} found.`, {
      path: filePath,
    });
  }

  return makeCheck(id, label, "fail", `${label} not found at configured path.`, {
    path: filePath,
  });
}

function checkWhisperConfig(env) {
  const bin = env.WHISPER_BIN || "";
  const model = env.WHISPER_MODEL || "";

  if (!bin && !model) {
    return makeCheck(
      "whisper-config",
      "Whisper config",
      "warn",
      "Whisper is not configured. Voice transcription will be unavailable.",
    );
  }

  if (checkPathExists(bin) && checkPathExists(model)) {
    return makeCheck(
      "whisper-config",
      "Whisper config",
      "pass",
      "Whisper binary and model are configured.",
      { bin, model },
    );
  }

  return makeCheck(
    "whisper-config",
    "Whisper config",
    "fail",
    "Whisper binary or model path is missing.",
    { bin, model },
  );
}

function checkTtsServices(services = []) {
  if (!services.length) {
    return makeCheck(
      "tts-services",
      "TTS services",
      "warn",
      "No TTS service checks were configured.",
    );
  }

  const available = services.filter((service) => service.ok);
  if (available.length > 0) {
    return makeCheck(
      "tts-services",
      "TTS services",
      "pass",
      `${available.length} TTS service check passed.`,
      { services },
    );
  }

  return makeCheck("tts-services", "TTS services", "warn", "No TTS service responded.", {
    services,
  });
}

function checkMobileAuth(env) {
  const hash = env.MOBILE_PASSCODE_HASH || env.MANA_MOBILE_PASSCODE_HASH || "";
  const secret = env.MOBILE_SESSION_SECRET || "";

  if (hash && secret) {
    return makeCheck(
      "mobile-auth",
      "Mobile auth",
      "pass",
      "Mobile passcode hash and session secret are configured.",
    );
  }

  return makeCheck(
    "mobile-auth",
    "Mobile auth",
    "warn",
    "Mobile passcode hash or session secret is missing.",
  );
}

function checkStorage(paths = {}) {
  const dataDir = paths.dataDir || path.join(__dirname, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    return makeCheck("storage", "Storage", "pass", "Local storage is writable.", {
      dataDir,
    });
  } catch (error) {
    return makeCheck("storage", "Storage", "fail", "Local storage is not writable.", {
      dataDir,
      error: error.message,
    });
  }
}

function checkZedEditor(options = {}) {
  const status = createZedIntegration({
    env: options.env || process.env,
    commandResolver: options.commandResolver,
  }).getStatus();

  return makeCheck(
    "zed-editor",
    "Zed editor",
    status.available ? "pass" : "warn",
    status.message,
    {
      command: status.command,
      source: status.source,
    },
  );
}

function withHealthPath(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/health";
    }
    return url.toString();
  } catch (error) {
    return "";
  }
}

function getConfiguredTtsHealthTargets(env) {
  const provider = String(env.TTS_PROVIDER || "").trim().toLowerCase();
  const targets = [];

  if ((!provider || provider === "chatterbox") && env.CHATTERBOX_TTS_URL) {
    targets.push({
      id: "chatterbox",
      url: withHealthPath(env.CHATTERBOX_TTS_URL),
    });
  }

  if ((!provider || provider === "kokoro") && env.KOKORO_TTS_URL) {
    targets.push({
      id: "kokoro",
      url: withHealthPath(env.KOKORO_TTS_URL),
    });
  }

  if ((!provider || provider === "fish") && env.FISH_TTS_URL) {
    targets.push({
      id: "fish",
      url: withHealthPath(env.FISH_TTS_URL),
    });
  }

  return targets.filter((target) => target.url);
}

async function probeHttpHealth({ id, url, timeoutMs = 750 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      id,
      url,
      ok: response.ok,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      id,
      url,
      ok: false,
      error: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTtsServices(env, services) {
  if (Array.isArray(services)) {
    return services;
  }

  const targets = getConfiguredTtsHealthTargets(env);
  return Promise.all(targets.map((target) => probeHttpHealth(target)));
}

function normalizePortNumber(value, fallback) {
  const port = Number(value || fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function getDefaultPortChecks(env) {
  return [
    {
      id: "mana-backend",
      host: "127.0.0.1",
      port: normalizePortNumber(env.PORT, DEFAULT_BACKEND_PORT),
    },
  ];
}

function probePortAvailability({ id = "port", host = "127.0.0.1", port, timeoutMs = 500 }) {
  return new Promise((resolve) => {
    if (!port) {
      resolve({ id, host, port, ok: false, error: "missing port" });
      return;
    }

    const socket = net.createConnection({ host, port });
    const finish = (ok, error = "") => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ id, host, port, ok, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(false, "port is already in use"));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        finish(true);
        return;
      }
      finish(false, error.code || error.message);
    });
  });
}

async function probePorts(ports = []) {
  return Promise.all(ports.map((port) => probePortAvailability(port)));
}

function buildDoctorResult(checks, now = () => new Date()) {
  const summary = summarizeChecks(checks);
  return {
    ok: summary.fail === 0,
    generatedAt: now().toISOString(),
    summary,
    checks,
  };
}

function runDoctorChecks(options = {}) {
  const env = options.env || process.env;
  const versions = options.versions || { node: process.version };
  const paths = options.paths || {
    dataDir: env.MOBILE_MEMORY_DIR || path.join(__dirname, "data"),
  };

  const checks = [
    checkNodeRuntime(versions.node),
    checkLocalAiPolicy(env),
    checkRequiredFile(
      "llama-binary",
      "Llama binary",
      env.LLAMA_BIN || "",
      "LLAMA_BIN is not configured. Local replies will use a placeholder.",
    ),
    checkRequiredFile(
      "llama-model",
      "Llama model",
      env.LLAMA_MODEL || "",
      "LLAMA_MODEL is not configured. Local replies will use a placeholder.",
    ),
    checkWhisperConfig(env),
    checkTtsServices(options.services || []),
    checkMobileAuth(env),
    checkStorage(paths),
    checkZedEditor({
      env,
      commandResolver: options.zedCommandResolver,
    }),
  ];

  return buildDoctorResult(checks, options.now);
}

async function runDoctorChecksAsync(options = {}) {
  const env = options.env || process.env;
  const services = await probeTtsServices(env, options.services);
  const portChecks = [...getDefaultPortChecks(env), ...(options.ports || [])];
  const portResults = await probePorts(portChecks);
  const checks = runDoctorChecks({
    ...options,
    env,
    services,
  }).checks;

  if (portResults.length) {
    const unavailable = portResults.filter((port) => !port.ok);
    checks.push(
      makeCheck(
        "ports",
        "Ports",
        unavailable.length ? "warn" : "pass",
        unavailable.length
          ? `${unavailable.length} configured port is unavailable.`
          : "Configured ports are available.",
        { ports: portResults },
      ),
    );
  }

  return buildDoctorResult(checks, options.now);
}

if (require.main === module) {
  runDoctorChecksAsync()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}${os.EOL}`);
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`Mana doctor failed: ${error.message}${os.EOL}`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildDoctorResult,
  runDoctorChecks,
  runDoctorChecksAsync,
};

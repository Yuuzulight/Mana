const MANA_RESTART_EXIT_CODE = 77;
const RESTART_ACCEPTED_MESSAGE =
  "Mana backend soft restart requested. The launcher or supervisor will start it again.";

function normalizeCommandText(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isRestartCommand(text) {
  const command = normalizeCommandText(text);
  return (
    command === "/restart" ||
    command === "/soft-restart" ||
    command === "soft restart mana" ||
    command === "restart mana"
  );
}

function isLoopbackAddress(address) {
  const normalized = String(address || "").trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function getRequestAddress(req) {
  return req?.ip || req?.socket?.remoteAddress || "";
}

function buildRestartAcceptedPayload() {
  return {
    ok: true,
    action: "restart",
    scope: "backend",
    exitCode: MANA_RESTART_EXIT_CODE,
    message: RESTART_ACCEPTED_MESSAGE,
  };
}

function createRestartController(options = {}) {
  const {
    exitProcess = process.exit,
    schedule = setTimeout,
    delayMs = 250,
  } = options;

  return function restartController(req) {
    if (!isLoopbackAddress(getRequestAddress(req))) {
      return {
        ok: false,
        action: "restart",
        scope: "backend",
        message: "Mana backend soft restart is not allowed from this address.",
      };
    }

    schedule(() => exitProcess(MANA_RESTART_EXIT_CODE), delayMs);
    return buildRestartAcceptedPayload();
  };
}

function formatRestartClientResult(result) {
  if (result?.ok) {
    return "Mana backend soft restart requested. Mana should be available again shortly.";
  }

  return "Mana backend is not reachable. Start Mana or check the backend launcher, then try again.";
}

module.exports = {
  MANA_RESTART_EXIT_CODE,
  isRestartCommand,
  isLoopbackAddress,
  getRequestAddress,
  buildRestartAcceptedPayload,
  createRestartController,
  formatRestartClientResult,
};

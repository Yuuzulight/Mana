// Issue #1343 Phase 3: Tri-mode multi-LoRA & on-demand engineering session manager.
// Maintains sticky coding mode across conversation turns, prevents regex profile ping-pong,
// masks model load latency via spoken phrases, and enforces strict gaming VRAM guards.

const CODING_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const EXIT_PATTERNS = [
  /^(done|exit|quit|stop|leave|close)(\s+(coding|code|dev|workspace|mode))?$/i,
  /^exit\s+(coding|code)\s+mode$/i,
  /^(thanks|thank you)(,\s*(that's all|we're done|i'm done))?$/i,
  /^(we're done|i'm done|all done|back to chat|switch to chat)$/i,
];

const ENTER_PATTERNS = [
  /\b(let's code|start coding|enter coding mode|code mode|open dev workspace|open coding workspace|switch to coding mode)\b/i,
];

const MASKING_PHRASES = [
  "Opening the dev workspace...",
  "Switching to coding mode...",
  "Opening the coding workshop...",
];

function isExitCommand(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim().toLowerCase();
  return EXIT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isEnterCommand(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim().toLowerCase();
  return ENTER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function getMaskingPhrase() {
  return MASKING_PHRASES[0];
}

function createCodingSessionManager({
  idleTimeoutMs = CODING_SESSION_IDLE_TIMEOUT_MS,
  isGaming = () => false,
  nowMs = () => Date.now(),
  onSessionTimeout = () => {},
  onSessionExit = () => {},
} = {}) {
  // Key: sessionId (string) -> { sessionId, startedAt, lastActivityAt }
  const sessions = new Map();
  const timers = new Map();
  let defaultSession = null;
  let defaultTimer = null;

  function clearSessionTimer(key) {
    if (!key) {
      if (defaultTimer) {
        clearTimeout(defaultTimer);
        defaultTimer = null;
      }
    } else {
      const t = timers.get(key);
      if (t) {
        clearTimeout(t);
        timers.delete(key);
      }
    }
  }

  function armSessionTimer(key) {
    clearSessionTimer(key);
    if (idleTimeoutMs > 0) {
      const t = setTimeout(() => {
        stop(key, "idle_timeout");
        onSessionTimeout(key);
      }, idleTimeoutMs);
      if (typeof t.unref === "function") {
        t.unref();
      }
      if (!key) {
        defaultTimer = t;
      } else {
        timers.set(key, t);
      }
    }
  }

  function getSession(sessionId) {
    if (!sessionId) return defaultSession;
    return sessions.get(sessionId) || null;
  }

  function isActive(sessionId) {
    const session = getSession(sessionId);
    if (!session) return false;
    // If a game started while the session was alive, auto-terminate it immediately.
    if (isGaming()) {
      stop(sessionId, "game_started");
      return false;
    }
    return true;
  }

  function start(sessionId) {
    if (isGaming()) {
      return {
        ok: false,
        reason: "gaming_active",
        message: "Gaming active: heavy coding engine is held to protect game performance.",
      };
    }

    const now = nowMs();
    const session = {
      sessionId: sessionId || "default",
      startedAt: now,
      lastActivityAt: now,
    };

    if (sessionId) {
      sessions.set(sessionId, session);
    } else {
      defaultSession = session;
    }

    armSessionTimer(sessionId);

    return { ok: true, session: { ...session }, maskingPhrase: getMaskingPhrase() };
  }

  function touch(sessionId) {
    const session = getSession(sessionId);
    if (!session) return false;

    session.lastActivityAt = nowMs();
    armSessionTimer(sessionId);
    return true;
  }

  function stop(sessionId, reason = "user_exit") {
    const session = getSession(sessionId);
    if (!session) return false;

    clearSessionTimer(sessionId);

    if (sessionId) {
      sessions.delete(sessionId);
    } else {
      defaultSession = null;
    }

    onSessionExit(sessionId, reason);
    return true;
  }

  function stopAll(reason = "game_started") {
    if (defaultSession) stop(null, reason);
    for (const id of Array.from(sessions.keys())) {
      stop(id, reason);
    }
  }

  return {
    isActive,
    start,
    touch,
    stop,
    stopAll,
    isExitCommand,
    isEnterCommand,
    getMaskingPhrase,
  };
}

module.exports = {
  createCodingSessionManager,
  CODING_SESSION_IDLE_TIMEOUT_MS,
  isExitCommand,
  isEnterCommand,
  getMaskingPhrase,
};

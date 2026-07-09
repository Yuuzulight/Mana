const express = require('express');
const crypto = require('crypto');

<<<<<<< HEAD
const { createMobileAuth } = require("./mobile-auth");
const { createMobileMemoryStore } = require("./mobile-memory-store");
const {
  ValidationError,
  optionalString,
  requireFile,
  requireString,
  sendValidationError,
} = require("./request-validation");

function createDefaultMobileAuth() {
  return createMobileAuth({
    passcodeHash: process.env.MOBILE_PASSCODE_HASH || "",
    sessionSecret: process.env.MOBILE_SESSION_SECRET || "",
    sessionTtlMs: Number(
      process.env.MOBILE_SESSION_TTL_MS || 12 * 60 * 60 * 1000,
    ),
  });
=======
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
>>>>>>> c664616 (Add mobile device pairing and management (device store, mobile routes, admin UI, tests))
}

function isLocalRequest(req) {
  const ip = (req.ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

<<<<<<< HEAD
function cleanPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return fallback;
  }
  return number;
}

function createUnlockRateLimiter(options = {}) {
  const maxAttempts = cleanPositiveInteger(
    options.maxAttempts || process.env.MOBILE_UNLOCK_MAX_ATTEMPTS,
    5,
  );
  const windowMs = cleanPositiveInteger(
    options.windowMs || process.env.MOBILE_UNLOCK_WINDOW_MS,
    5 * 60 * 1000,
  );
  const now = options.now || Date.now;
  const attempts = options.attempts || new Map();

  function getRecord(key, currentTime) {
    const existing = attempts.get(key);
    if (!existing || existing.expiresAt <= currentTime) {
      const fresh = { count: 0, expiresAt: currentTime + windowMs };
      attempts.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  function keyFor(req) {
    return (
      req.ip ||
      req.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown"
    );
  }

  function isLimited(key) {
    const record = attempts.get(key);
    return Boolean(
      record && record.expiresAt > now() && record.count >= maxAttempts,
    );
  }

  function recordFailure(key) {
    const currentTime = now();
    const record = getRecord(key, currentTime);
    record.count += 1;
    return record.count > maxAttempts;
  }

  function clear(key) {
    attempts.delete(key);
  }

  return {
    clear,
    isLimited,
    keyFor,
    recordFailure,
  };
}

function getRequiredDeps(deps) {
  return {
    mobileAuth: deps.mobileAuth || createDefaultMobileAuth(),
    mobileMemoryStore: deps.mobileMemoryStore || createMobileMemoryStore(),
    buildAssistantReply: deps.buildAssistantReply,
    synthesizeReply: deps.synthesizeReply,
    runWhisper: deps.runWhisper,
    normalizeUploadedAudio: deps.normalizeUploadedAudio,
    cleanupUploadedAudio: deps.cleanupUploadedAudio,
    mobileUnlockRateLimiter:
      deps.mobileUnlockRateLimiter ||
      createUnlockRateLimiter(deps.mobileUnlockRateLimit),
  };
}

function registerMobileRoutes(app, deps = {}) {
=======
module.exports = function createMobileRoutes({ deviceStore }) {
>>>>>>> c664616 (Add mobile device pairing and management (device store, mobile routes, admin UI, tests))
  const router = express.Router();

  // Create pairing code (admin UI only, local requests only)
  router.post('/pair/request', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'admin-only' });
    const { code, expiresAt } = deviceStore.generatePairingCode(5);
    // return code and expiration; admin UI will display QR/code
    res.json({ code, expiresAt });
  });

<<<<<<< HEAD
  router.post("/auth/unlock", (req, res) => {
    const clientKey = mobileUnlockRateLimiter.keyFor(req);
    if (mobileUnlockRateLimiter.isLimited(clientKey)) {
      return res.status(429).json({
        ok: false,
        error: "Too many unlock attempts. Try again later.",
      });
    }

    let passcode;
    try {
      passcode = requireString(req.body?.passcode, "passcode");
    } catch (error) {
      if (error instanceof ValidationError) {
        return sendValidationError(res, error);
      }
      throw error;
    }
    const unlocked = mobileAuth.unlock(passcode);
    if (!unlocked.ok) {
      if (mobileUnlockRateLimiter.recordFailure(clientKey)) {
        return res.status(429).json({
          ok: false,
          error: "Too many unlock attempts. Try again later.",
        });
      }
      return res.status(401).json({ ok: false, error: unlocked.error });
    }
    mobileUnlockRateLimiter.clear(clientKey);

    return res.json({
      ok: true,
      token: unlocked.token,
      expiresAt: unlocked.expiresAt,
    });
  });

  router.post("/chat/text", requireAuth, async (req, res) => {
    try {
      const text = requireString(req.body?.text, "text");

      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const assistantMode = optionalString(
        req.body?.assistantMode,
        "assistantMode",
        null,
      );
      const reply = await buildAssistantReply(
        text,
        "",
        "",
        "default",
        sessionId,
        assistantMode,
      );
      return res.json({ text, reply });
    } catch (error) {
      if (error instanceof ValidationError) {
        return sendValidationError(res, error);
      }
      console.error(error);
      return res.status(500).json({ error: String(error) });
    }
  });

  router.post(
    "/chat/audio",
    requireAuth,
    upload.single("file"),
    async (req, res) => {
      let uploadPaths = null;
      try {
        requireFile(req.file, "file");

        uploadPaths = { tmpPath: req.file.path, audioPath: req.file.path };
        uploadPaths = normalizeUploadedAudio(req.file);
        const transcript = runWhisper(uploadPaths.audioPath);
        const sessionId = optionalString(
          req.body?.sessionId,
          "sessionId",
          null,
        );
        const assistantMode = optionalString(
          req.body?.assistantMode,
          "assistantMode",
          null,
        );
        const reply = await buildAssistantReply(
          transcript,
          "",
          "",
          "default",
          sessionId,
          assistantMode,
        );
        return res.json({ transcript, reply });
      } catch (error) {
        if (error instanceof ValidationError) {
          return sendValidationError(res, error);
        }
        console.error(error);
        return res.status(500).json({ error: String(error) });
      } finally {
        if (uploadPaths) {
          cleanupUploadedAudio(uploadPaths.tmpPath, uploadPaths.audioPath);
        }
      }
    },
  );

  router.post("/synthesize", requireAuth, async (req, res) => {
    try {
      const text = requireString(req.body?.text, "text");

      const audio = await synthesizeReply(text);
      res.setHeader("Content-Type", "audio/wav");
      return res.send(audio);
    } catch (error) {
      if (error instanceof ValidationError) {
        return sendValidationError(res, error);
      }
      console.error(error);
      return res.status(500).json({ error: String(error) });
    }
  });

  router.post("/summaries", requireAuth, (req, res) => {
    try {
      const summary = mobileMemoryStore.saveSummary({
        id: optionalString(req.body?.id, "id", ""),
        source: optionalString(req.body?.source, "source", "phone") || "phone",
        direction: "phone-to-pc",
        chatId: optionalString(req.body?.chatId, "chatId", ""),
        title: optionalString(req.body?.title, "title", ""),
        summary: requireString(req.body?.summary, "summary"),
      });
      return res.json({ summary });
    } catch (error) {
      if (error instanceof ValidationError) {
        return sendValidationError(res, error);
      }
      return res.status(400).json({ error: error.message });
    }
=======
  // Complete pairing: mobile sends code + deviceName, server returns token (one-time)
  router.post('/pair/complete', express.json(), (req, res) => {
    const { code, deviceName } = req.body || {};
    if (!code || !deviceName) return res.status(400).json({ error: 'missing' });
    const ok = deviceStore.consumePairingCode(String(code));
    if (!ok) return res.status(400).json({ error: 'invalid_or_expired_code' });
    const token = randomToken();
    const dev = deviceStore.addDevice({ name: deviceName, token, allowMemorySync: false });
    // return the token once; server stores only hash
    res.json({ token, device: { id: dev.id, name: dev.name, createdAt: dev.createdAt } });
  });

  // Admin: list devices
  router.get('/devices', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'admin-only' });
    const list = deviceStore.listDevices();
    res.json({ devices: list });
  });

  // Admin: revoke device
  router.post('/devices/:id/revoke', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'admin-only' });
    const id = req.params.id;
    const ok = deviceStore.revokeDevice(id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  // Admin: rotate token (returns new token value)
  router.post('/devices/:id/rotate', (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'admin-only' });
    const id = req.params.id;
    const newToken = randomToken();
    const ok = deviceStore.rotateToken(id, newToken);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ token: newToken });
  });

  // Mobile endpoint example: token-protected ping
  router.get('/ping', (req, res) => {
    const auth = req.get('authorization') || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing_token' });
    const token = auth.slice('Bearer '.length).trim();
    const dev = deviceStore.findDeviceByToken(token);
    if (!dev) return res.status(401).json({ error: 'invalid_token' });
    deviceStore.updateLastSeen(dev.id);
    res.json({ ok: true, device: { id: dev.id, name: dev.name } });
>>>>>>> c664616 (Add mobile device pairing and management (device store, mobile routes, admin UI, tests))
  });

  return router;
};

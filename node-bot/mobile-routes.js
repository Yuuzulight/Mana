const express = require("express");
const multer = require("multer");
const path = require("path");

const { createMobileAuth } = require("./mobile-auth");
const { createMobileMemoryStore } = require("./mobile-memory-store");

function createDefaultMobileAuth() {
  return createMobileAuth({
    passcodeHash: process.env.MOBILE_PASSCODE_HASH || "",
    sessionSecret: process.env.MOBILE_SESSION_SECRET || "",
    sessionTtlMs: Number(
      process.env.MOBILE_SESSION_TTL_MS || 12 * 60 * 60 * 1000,
    ),
  });
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

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
    return Boolean(record && record.expiresAt > now() && record.count >= maxAttempts);
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
  const router = express.Router();
  const upload = multer({ dest: path.join(__dirname, "tmp") });
  const {
    mobileAuth,
    mobileMemoryStore,
    buildAssistantReply,
    synthesizeReply,
    runWhisper,
    normalizeUploadedAudio,
    cleanupUploadedAudio,
    mobileUnlockRateLimiter,
  } = getRequiredDeps(deps);
  const requireAuth = mobileAuth.requireAuth;

  router.get("/health", (req, res) => {
    return res.json({
      ok: true,
      authConfigured: Boolean(mobileAuth.isConfigured),
    });
  });

  router.post("/auth/unlock", (req, res) => {
    const clientKey = mobileUnlockRateLimiter.keyFor(req);
    if (mobileUnlockRateLimiter.isLimited(clientKey)) {
      return res.status(429).json({
        ok: false,
        error: "Too many unlock attempts. Try again later.",
      });
    }

    const passcode = cleanText(req.body?.passcode);
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
      const text = cleanText(req.body?.text);
      if (!text) {
        return res.status(400).json({ error: "no text" });
      }

      const reply = await buildAssistantReply(text);
      return res.json({ text, reply });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: String(error) });
    }
  });

  router.post("/chat/audio", requireAuth, upload.single("file"), async (req, res) => {
    let uploadPaths = null;
    try {
      if (!req.file) {
        return res.status(400).json({ error: "no file" });
      }

      uploadPaths = { tmpPath: req.file.path, audioPath: req.file.path };
      uploadPaths = normalizeUploadedAudio(req.file);
      const transcript = runWhisper(uploadPaths.audioPath);
      const reply = await buildAssistantReply(transcript);
      return res.json({ transcript, reply });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: String(error) });
    } finally {
      if (uploadPaths) {
        cleanupUploadedAudio(uploadPaths.tmpPath, uploadPaths.audioPath);
      }
    }
  });

  router.post("/synthesize", requireAuth, async (req, res) => {
    try {
      const text = cleanText(req.body?.text);
      if (!text) {
        return res.status(400).json({ error: "no text" });
      }

      const audio = await synthesizeReply(text);
      res.setHeader("Content-Type", "audio/wav");
      return res.send(audio);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: String(error) });
    }
  });

  router.post("/summaries", requireAuth, (req, res) => {
    try {
      const summary = mobileMemoryStore.saveSummary({
        id: req.body?.id,
        source: req.body?.source || "phone",
        direction: "phone-to-pc",
        chatId: req.body?.chatId,
        title: req.body?.title,
        summary: req.body?.summary,
      });
      return res.json({ summary });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get("/summaries", requireAuth, (req, res) => {
    try {
      const direction = cleanText(req.query?.direction);
      const filter = direction ? { direction } : {};
      return res.json({ summaries: mobileMemoryStore.listSummaries(filter) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.use(
    "/mobile/app",
    express.static(path.join(__dirname, "mobile-app"), {
      extensions: ["html"],
      index: "index.html",
    }),
  );

  app.use("/mobile", router);
}

module.exports = {
  createDefaultMobileAuth,
  createUnlockRateLimiter,
  registerMobileRoutes,
};

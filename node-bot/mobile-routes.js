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

function getRequiredDeps(deps) {
  return {
    mobileAuth: deps.mobileAuth || createDefaultMobileAuth(),
    mobileMemoryStore: deps.mobileMemoryStore || createMobileMemoryStore(),
    buildAssistantReply: deps.buildAssistantReply,
    synthesizeReply: deps.synthesizeReply,
    runWhisper: deps.runWhisper,
    normalizeUploadedAudio: deps.normalizeUploadedAudio,
    cleanupUploadedAudio: deps.cleanupUploadedAudio,
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
  } = getRequiredDeps(deps);
  const requireAuth = mobileAuth.requireAuth;

  router.get("/health", (req, res) => {
    return res.json({
      ok: true,
      authConfigured: Boolean(mobileAuth.isConfigured),
    });
  });

  router.post("/auth/unlock", (req, res) => {
    const passcode = cleanText(req.body?.passcode);
    const unlocked = mobileAuth.unlock(passcode);
    if (!unlocked.ok) {
      return res.status(401).json({ ok: false, error: unlocked.error });
    }

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

  app.use("/mobile", router);
}

module.exports = {
  createDefaultMobileAuth,
  registerMobileRoutes,
};

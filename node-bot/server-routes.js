const {
  ValidationError,
  optionalString,
  requireFile,
  requireString,
  sendValidationError,
} = require("./request-validation");
const {
  getRequestAddress,
  isLoopbackAddress,
  isRestartCommand,
} = require("./admin-restart");

const RESTART_LOCAL_ONLY_ERROR = "restart is only available from this PC";

function getSocketAddress(req) {
  return req?.socket?.remoteAddress || "";
}

function getFirstForwardedAddress(req) {
  const forwardedFor =
    typeof req.get === "function"
      ? req.get("x-forwarded-for")
      : req?.headers?.["x-forwarded-for"];
  const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return String(value || "")
    .split(",")[0]
    .trim();
}

// Loopback-only, and if a proxy claims the socket is loopback (e.g. a
// LAN tunnel terminating on the same box), an X-Forwarded-For header
// pointing elsewhere still disqualifies the request.
function isLocalRestartRequest(req) {
  const socketAddress = getSocketAddress(req);
  const requestAddress = getRequestAddress(req);
  const forwardedAddress = getFirstForwardedAddress(req);
  return (
    isLoopbackAddress(socketAddress || requestAddress) &&
    (!forwardedAddress || isLoopbackAddress(forwardedAddress))
  );
}

function hasRestartController(restartController) {
  return (
    restartController &&
    typeof restartController.buildAcceptedPayload === "function" &&
    typeof restartController.scheduleRestart === "function"
  );
}

function scheduleRestartAfterFinish(res, restartController) {
  res.once("finish", () => restartController.scheduleRestart());
}

function registerCoreRoutes(app, upload, deps) {
  const {
    UNIVERSALIS_DEFAULT_WORLD,
    TTS_PROVIDER,
    buildAssistantReply,
    capabilities,
    contributePluginPromptContext,
    cleanupUploadedAudio,
    clampInteger,
    fs,
    getActiveModelProfile,
    marketDataClient,
    normalizeLlamaModelProfile,
    normalizeUploadedAudio,
    readScreenText,
    recordChatTurn,
    restartController,
    runVisionReply,
    getVisionStatus,
    runWhisper,
    synthesizeReply,
    clampText,
    SCREEN_CONTEXT_MAX_CHARS,
  } = deps;

  app.post("/admin/restart", (req, res) => {
    if (!hasRestartController(restartController)) {
      return res.status(500).json({ error: "restart controller is not configured" });
    }
    if (!isLocalRestartRequest(req)) {
      return res.status(403).json({ error: RESTART_LOCAL_ONLY_ERROR });
    }

    const payload = restartController.buildAcceptedPayload();
    scheduleRestartAfterFinish(res, restartController);
    return res.json(payload);
  });

  app.post("/transcribe-only", upload.single("file"), async (req, res) => {
    try {
      requireFile(req.file, "file");

      const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);
      const transcript = runWhisper(audioPath);
      cleanupUploadedAudio(tmpPath, audioPath);

      return res.json({ transcript });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/screen/read", async (req, res) => {
    try {
      const image = typeof req.body?.image === "string" ? req.body.image : "";
      if (!image) {
        return res.status(400).json({ error: "no screen image" });
      }

      const text = await readScreenText(image);
      return res.json({ text });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // /market/stock/* and /market/watchlist now live in
  // plugins/stock-market/index.js, registered via the capabilities array
  // (see server.js). marketDataClient stays in this file's deps because
  // /reply and /transcribe below pass it through to
  // contributePluginPromptContext (issue #108) for stock market prompt
  // context.

  app.post("/vision/describe", async (req, res) => {
    try {
      const image = requireString(req.body?.image, "image");
      const prompt = optionalString(req.body?.prompt, "prompt", "");
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);

      if (typeof getVisionStatus === "function") {
        const vision = getVisionStatus();
        if (!vision || !vision.available) {
          return res.status(503).json({
            error: "no local vision model available",
            detail: vision ? vision.reason : undefined,
          });
        }
      }

      const reply = await runVisionReply(prompt, [image]);
      if (sessionId && typeof recordChatTurn === "function") {
        recordChatTurn(sessionId, prompt || "(shared an image)", reply);
      }
      return res.json({
        reply,
        ttsConfigured: TTS_PROVIDER !== "none",
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/reply", async (req, res) => {
    try {
      // An attached image routes the reply through the local vision model;
      // text becomes optional because the image can carry the question.
      const image =
        typeof req.body?.image === "string" && req.body.image.trim()
          ? req.body.image.trim()
          : null;
      const transcript = image
        ? optionalString(req.body?.text, "text", "")
        : requireString(req.body?.text, "text");

      if (isRestartCommand(transcript)) {
        if (!hasRestartController(restartController)) {
          return res.status(500).json({ error: "restart controller is not configured" });
        }

        const payload = restartController.buildAcceptedPayload();
        scheduleRestartAfterFinish(res, restartController);
        return res.json({
          reply: payload.message,
          restart: payload,
          ttsConfigured: false,
        });
      }

      if (image) {
        const sessionId = optionalString(
          req.body?.sessionId,
          "sessionId",
          null,
        );
        if (typeof getVisionStatus === "function") {
          const vision = getVisionStatus();
          if (!vision || !vision.available) {
            return res.status(503).json({
              error: "no local vision model available",
              detail: vision ? vision.reason : undefined,
            });
          }
        }
        const reply = await runVisionReply(transcript, [image]);
        if (sessionId && typeof recordChatTurn === "function") {
          recordChatTurn(sessionId, transcript || "(shared an image)", reply);
        }
        return res.json({
          reply,
          ttsConfigured: TTS_PROVIDER !== "none",
        });
      }
      const screenText = clampText(
        optionalString(req.body?.screenText, "screenText", ""),
        SCREEN_CONTEXT_MAX_CHARS,
      );
      const hasModelProfile = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "modelProfile",
      );
      const modelProfile = hasModelProfile
        ? normalizeLlamaModelProfile(req.body?.modelProfile)
        : normalizeLlamaModelProfile(
            typeof getActiveModelProfile === "function"
              ? getActiveModelProfile()
              : "default",
          );
      const includeContext = req.body?.includeContext !== false;
      const world = optionalString(
        req.body?.ffxivWorld,
        "ffxivWorld",
        UNIVERSALIS_DEFAULT_WORLD,
      );
      // Tries each plugin's contributePromptContext in capabilities-array
      // order, first non-empty result wins (issue #108) -- each plugin's own
      // builder decides relevance, this just picks the first that answers.
      const marketText = includeContext
        ? await contributePluginPromptContext(capabilities, transcript, {
            marketDataClient,
            world,
            screenText,
          })
        : "";
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const assistantMode = optionalString(
        req.body?.assistantMode,
        "assistantMode",
        null,
      );
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      const reply = await buildAssistantReply(
        transcript,
        screenText,
        marketText,
        modelProfile,
        sessionId,
        assistantMode,
        presetId,
      );
      return res.json({
        reply,
        ttsConfigured: TTS_PROVIDER !== "none",
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/transcribe", upload.single("file"), async (req, res) => {
    try {
      requireFile(req.file, "file");
      console.log("Got file upload:", req.file);
      const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);

      console.log(
        "audioPath ->",
        audioPath,
        "exists=",
        fs.existsSync(audioPath),
        "size=",
        fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0,
      );
      const transcript = runWhisper(audioPath);

      // Same generic plugin prompt-context chain /reply uses (issue #108).
      // No screenText/ffxivWorld here since /transcribe has no OCR or
      // per-request world override -- UNIVERSALIS_DEFAULT_WORLD covers it.
      const marketText = await contributePluginPromptContext(
        capabilities,
        transcript,
        { marketDataClient, world: UNIVERSALIS_DEFAULT_WORLD, screenText: "" },
      );
      const sessionId = optionalString(req.body?.sessionId, "sessionId", null);
      const assistantMode = optionalString(
        req.body?.assistantMode,
        "assistantMode",
        null,
      );
      const presetId = optionalString(req.body?.presetId, "presetId", null);
      const reply = await buildAssistantReply(
        transcript,
        "",
        marketText,
        "default",
        sessionId,
        assistantMode,
        presetId,
      );
      cleanupUploadedAudio(tmpPath, audioPath);

      return res.json({
        transcript,
        reply,
        ttsConfigured: TTS_PROVIDER !== "none",
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/synthesize", async (req, res) => {
    try {
      const text = requireString(req.body?.text, "text");
      if (TTS_PROVIDER === "none") {
        return res.status(400).json({ error: "TTS not configured" });
      }

      const audio = await synthesizeReply(text);
      res.setHeader("Content-Type", "audio/wav");
      return res.send(audio);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

module.exports = {
  registerCoreRoutes,
  isLocalRestartRequest,
};

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

async function buildOptionalPromptContext(label, builder) {
  try {
    return (await builder()) || "";
  } catch (error) {
    console.warn(`Optional ${label} context unavailable:`, error.message);
    return "";
  }
}

function registerCoreRoutes(app, upload, deps) {
  const {
    UNIVERSALIS_DEFAULT_WORLD,
    TTS_PROVIDER,
    buildAssistantReply,
    buildCraftProfitContextForPrompt,
    buildMarketContextForPrompt,
    buildUniversalisContextForPrompt,
    buildWebContextForPrompt,
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
    textLooksLikeCraftProfitQuestion,
    textLooksLikeMarketQuestion,
    textLooksLikeStockMarketQuestion,
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

  app.get("/market/stock/summary", async (req, res) => {
    try {
      const symbol =
        typeof req.query.symbol === "string" ? req.query.symbol : "";
      const summary = await marketDataClient.getStockSummary(symbol);
      return res.json({
        ...summary,
        disclaimer: "Market analysis only. Not financial advice.",
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/market/stock/compare", async (req, res) => {
    try {
      const symbols =
        typeof req.query.symbols === "string" ? req.query.symbols : "";
      const results = await marketDataClient.compareStocks(symbols);
      return res.json({
        source: "Alpha Vantage",
        symbols: results.map((item) => item.symbol),
        results,
        disclaimer: "Market analysis only. Not financial advice.",
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/market/watchlist", async (req, res) => {
    try {
      const results = await marketDataClient.getWatchlistSummary();
      return res.json({
        source: "Alpha Vantage",
        symbols: results.map((item) => item.symbol),
        results,
        disclaimer: "Market analysis only. Not financial advice.",
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

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
      const wantsCraftProfit =
        includeContext && typeof textLooksLikeCraftProfitQuestion === "function"
          ? textLooksLikeCraftProfitQuestion(transcript)
          : false;
      const wantsUniversalis =
        includeContext && typeof textLooksLikeMarketQuestion === "function"
          ? textLooksLikeMarketQuestion(transcript)
          : false;
      const wantsStockMarket =
        includeContext && typeof textLooksLikeStockMarketQuestion === "function"
          ? textLooksLikeStockMarketQuestion(transcript)
          : false;
      const craftProfitText = wantsCraftProfit
        ? await buildOptionalPromptContext("craft profit", () =>
            buildCraftProfitContextForPrompt(transcript, world),
          )
        : "";
      const marketText =
        craftProfitText ||
        (wantsUniversalis
          ? await buildOptionalPromptContext("Universalis", () =>
              buildUniversalisContextForPrompt(transcript, world, screenText),
            )
          : "") ||
        (wantsStockMarket
          ? await buildOptionalPromptContext("market", () =>
              buildMarketContextForPrompt(transcript, marketDataClient),
            )
          : "") ||
        (includeContext && typeof buildWebContextForPrompt === "function"
          ? await buildOptionalPromptContext("web access", () =>
              buildWebContextForPrompt(transcript),
            )
          : "");
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

      const stockMarketText = await buildMarketContextForPrompt(
        transcript,
        marketDataClient,
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
        stockMarketText,
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

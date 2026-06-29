const {
  ValidationError,
  optionalString,
  requireFile,
  requireString,
  sendValidationError,
} = require("./request-validation");

function registerCoreRoutes(app, upload, deps) {
  const {
    UNIVERSALIS_DEFAULT_WORLD,
    TTS_PROVIDER,
    buildAssistantReply,
    buildCraftProfitContextForPrompt,
    buildMarketContextForPrompt,
    buildUniversalisContextForPrompt,
    cleanupUploadedAudio,
    clampInteger,
    fs,
    getActiveModelProfile,
    marketDataClient,
    normalizeLlamaModelProfile,
    normalizeUploadedAudio,
    readScreenText,
    runWhisper,
    synthesizeReply,
    clampText,
    SCREEN_CONTEXT_MAX_CHARS,
  } = deps;

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
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "";
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

  app.post("/reply", async (req, res) => {
    try {
      const transcript = requireString(req.body?.text, "text");
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
      const world = optionalString(req.body?.ffxivWorld, "ffxivWorld", UNIVERSALIS_DEFAULT_WORLD);
      const craftProfitText = await buildCraftProfitContextForPrompt(
        transcript,
        world,
      );
      const marketText =
        craftProfitText ||
        (await buildUniversalisContextForPrompt(transcript, world, screenText)) ||
        (await buildMarketContextForPrompt(transcript, marketDataClient));
      const reply = await buildAssistantReply(
        transcript,
        screenText,
        marketText,
        modelProfile,
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
      const reply = await buildAssistantReply(transcript, "", stockMarketText);
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
};

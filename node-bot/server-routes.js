const {
  ValidationError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireFile,
  requireOneOf,
  requireString,
  sendValidationError,
} = require("./request-validation");

function registerCoreRoutes(app, upload, deps) {
  const {
    UNIVERSALIS_DEFAULT_WORLD,
    FFXIV_PROFIT_TOP_LIMIT,
    FFXIV_RECIPE_SOURCE,
    XIVAPI_RECIPE_PAGE_SIZE,
    XIVAPI_RECIPE_SCAN_LIMIT,
    TTS_PROVIDER,
    buildAssistantReply,
    buildCraftProfitContextForPrompt,
    buildMarketContextForPrompt,
    buildUniversalisContextForPrompt,
    cleanupUploadedAudio,
    clampInteger,
    extractExplicitItemNameFromText,
    extractHoveredItemName,
    findProfitableCrafts,
    fs,
    getActiveModelProfile,
    getUniversalisMarketSummary,
    marketDataClient,
    normalizeCraftRankingMode,
    normalizeGatheringJobFilter,
    normalizeGatheringSourceFilter,
    normalizeLlamaModelProfile,
    normalizeUploadedAudio,
    nowMs,
    logPerf,
    readScreenText,
    resolveFfxivItemByName,
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

  app.get("/ffxiv/market", async (req, res) => {
    try {
      const world = optionalString(req.query.world, "world", UNIVERSALIS_DEFAULT_WORLD);
      let itemName = optionalString(req.query.itemName, "itemName", "");
      const rawItemId = req.query.itemId || req.query.itemID || req.query.id;
      const parsedItemId = Number(rawItemId);
      let itemId =
        Number.isSafeInteger(parsedItemId) && parsedItemId > 0
          ? parsedItemId
          : null;
      requireOneOf([
        { value: itemId, label: "itemId" },
        { value: itemName, label: "itemName" },
      ]);
      let resolvedItem = null;
      if (!itemId) {
        resolvedItem = await resolveFfxivItemByName(itemName);
        itemId = resolvedItem.itemId;
        itemName = resolvedItem.name;
      }

      const summary = await getUniversalisMarketSummary(world, itemId, itemName);
      return res.json({
        ...summary,
        resolvedItem,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/ffxiv/crafting/profit", async (req, res) => {
    try {
      const world = optionalString(req.query.world, "world", UNIVERSALIS_DEFAULT_WORLD);
      const query = optionalString(req.query.query, "query", "");
      const limit = optionalInteger(req.query.limit, "limit", {
        min: 1,
        max: 25,
        defaultValue: FFXIV_PROFIT_TOP_LIMIT,
      });
      const scanLimit = optionalInteger(req.query.scanLimit, "scanLimit", {
        min: 1,
        max: 5000,
        defaultValue: XIVAPI_RECIPE_SCAN_LIMIT,
      });
      const pageSize = optionalInteger(req.query.pageSize, "pageSize", {
        min: 1,
        max: 500,
        defaultValue: XIVAPI_RECIPE_PAGE_SIZE,
      });
      const recipeSource = optionalString(req.query.recipeSource, "recipeSource", FFXIV_RECIPE_SOURCE);
      const useSalesHistory = optionalBoolean(req.query.useSalesHistory, "useSalesHistory", false);
      const historyDays = optionalInteger(req.query.historyDays, "historyDays", {
        min: 1,
        max: 90,
        defaultValue: 30,
      });
      const rankBy = normalizeCraftRankingMode(req.query.rankBy, useSalesHistory);
      const gatherableOnly = optionalBoolean(req.query.gatherableOnly, "gatherableOnly", false);
      const gatheringSources = normalizeGatheringSourceFilter(
        req.query.gatheringSources || req.query.allowedGatheringSources,
      );
      const gatheringJobs = normalizeGatheringJobFilter(req.query.gatheringJobs);
      const minUnitsSold = optionalInteger(req.query.minUnitsSold, "minUnitsSold", {
        min: 0,
        max: 999999,
        defaultValue: 0,
      });
      const startedAt = nowMs();
      const report = await findProfitableCrafts({
        world,
        query,
        limit,
        scanLimit,
        pageSize,
        recipeSource,
        useSalesHistory,
        historyDays,
        rankBy,
        gatherableOnly,
        gatheringSources,
        gatheringJobs,
        minUnitsSold,
      });
      logPerf("ffxiv-crafting-profit", startedAt);
      return res.json(report);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/ffxiv/market/from-screen", async (req, res) => {
    try {
      const world =
        typeof req.body?.world === "string" && req.body.world.trim()
          ? req.body.world.trim()
          : UNIVERSALIS_DEFAULT_WORLD;
      const screenText =
        typeof req.body?.screenText === "string" ? req.body.screenText : "";
      const itemName =
        extractExplicitItemNameFromText(req.body?.text || "") ||
        extractHoveredItemName(screenText);
      if (!itemName) {
        return res
          .status(400)
          .json({ error: "Could not find an item name in the screen text" });
      }

      const resolvedItem = await resolveFfxivItemByName(itemName);
      const summary = await getUniversalisMarketSummary(
        world,
        resolvedItem.itemId,
        resolvedItem.name,
      );
      return res.json({
        ...summary,
        hoveredItemName: itemName,
        resolvedItem,
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

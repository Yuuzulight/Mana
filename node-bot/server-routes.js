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
      if (!req.file) return res.status(400).json({ error: "no file" });

      const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);
      const transcript = runWhisper(audioPath);
      cleanupUploadedAudio(tmpPath, audioPath);

      return res.json({ transcript });
    } catch (e) {
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
      const world =
        typeof req.query.world === "string" && req.query.world.trim()
          ? req.query.world.trim()
          : UNIVERSALIS_DEFAULT_WORLD;
      let itemName =
        typeof req.query.itemName === "string" && req.query.itemName.trim()
          ? req.query.itemName.trim()
          : "";
      let itemId = Number(req.query.itemId || req.query.itemID || req.query.id);
      let resolvedItem = null;
      if (!Number.isInteger(itemId) || itemId <= 0) {
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
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/ffxiv/crafting/profit", async (req, res) => {
    try {
      const world =
        typeof req.query.world === "string" && req.query.world.trim()
          ? req.query.world.trim()
          : UNIVERSALIS_DEFAULT_WORLD;
      const query =
        typeof req.query.query === "string" && req.query.query.trim()
          ? req.query.query.trim()
          : "";
      const limit = clampInteger(req.query.limit, 1, 25, FFXIV_PROFIT_TOP_LIMIT);
      const scanLimit = clampInteger(
        req.query.scanLimit,
        1,
        5000,
        XIVAPI_RECIPE_SCAN_LIMIT,
      );
      const pageSize = clampInteger(
        req.query.pageSize,
        1,
        500,
        XIVAPI_RECIPE_PAGE_SIZE,
      );
      const recipeSource =
        typeof req.query.recipeSource === "string" &&
        req.query.recipeSource.trim()
          ? req.query.recipeSource.trim()
          : FFXIV_RECIPE_SOURCE;
      const useSalesHistory =
        req.query.useSalesHistory === "1" ||
        String(req.query.useSalesHistory || "").toLowerCase() === "true";
      const historyDays = clampInteger(req.query.historyDays, 1, 90, 30);
      const rankBy = normalizeCraftRankingMode(req.query.rankBy, useSalesHistory);
      const gatherableOnly =
        req.query.gatherableOnly === "1" ||
        String(req.query.gatherableOnly || "").toLowerCase() === "true";
      const gatheringSources = normalizeGatheringSourceFilter(
        req.query.gatheringSources || req.query.allowedGatheringSources,
      );
      const gatheringJobs = normalizeGatheringJobFilter(req.query.gatheringJobs);
      const minUnitsSold = clampInteger(req.query.minUnitsSold, 0, 999999, 0);
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
      const transcript =
        typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!transcript) {
        return res.status(400).json({ error: "no text" });
      }

      const screenText =
        typeof req.body?.screenText === "string"
          ? clampText(req.body.screenText, SCREEN_CONTEXT_MAX_CHARS)
          : "";
      const modelProfile = normalizeLlamaModelProfile(req.body?.modelProfile);
      const world =
        typeof req.body?.ffxivWorld === "string" && req.body.ffxivWorld.trim()
          ? req.body.ffxivWorld.trim()
          : UNIVERSALIS_DEFAULT_WORLD;
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
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/transcribe", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "no file" });
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
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/synthesize", async (req, res) => {
    try {
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text) {
        return res.status(400).json({ error: "no text" });
      }
      if (TTS_PROVIDER === "none") {
        return res.status(400).json({ error: "TTS not configured" });
      }

      const audio = await synthesizeReply(text);
      res.setHeader("Content-Type", "audio/wav");
      return res.send(audio);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

module.exports = {
  registerCoreRoutes,
};

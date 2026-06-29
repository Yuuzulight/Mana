const {
  ValidationError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireOneOf,
  sendValidationError,
} = require("../request-validation");

function registerFfxivMarketRoutes(app, deps) {
  const {
    UNIVERSALIS_DEFAULT_WORLD,
    FFXIV_PROFIT_TOP_LIMIT,
    FFXIV_RECIPE_SOURCE,
    XIVAPI_RECIPE_PAGE_SIZE,
    XIVAPI_RECIPE_SCAN_LIMIT,
    extractExplicitItemNameFromText,
    extractHoveredItemName,
    findProfitableCrafts,
    getUniversalisMarketSummary,
    logPerf,
    normalizeCraftRankingMode,
    normalizeGatheringJobFilter,
    normalizeGatheringSourceFilter,
    nowMs,
    resolveFfxivItemByName,
  } = deps;

  app.get("/ffxiv/market", async (req, res) => {
    try {
      const world = optionalString(
        req.query.world,
        "world",
        UNIVERSALIS_DEFAULT_WORLD,
      );
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
      const world = optionalString(
        req.query.world,
        "world",
        UNIVERSALIS_DEFAULT_WORLD,
      );
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
      const recipeSource = optionalString(
        req.query.recipeSource,
        "recipeSource",
        FFXIV_RECIPE_SOURCE,
      );
      const useSalesHistory = optionalBoolean(
        req.query.useSalesHistory,
        "useSalesHistory",
        false,
      );
      const historyDays = optionalInteger(req.query.historyDays, "historyDays", {
        min: 1,
        max: 90,
        defaultValue: 30,
      });
      const rankBy = normalizeCraftRankingMode(
        req.query.rankBy,
        useSalesHistory,
      );
      const gatherableOnly = optionalBoolean(
        req.query.gatherableOnly,
        "gatherableOnly",
        false,
      );
      const gatheringSources = normalizeGatheringSourceFilter(
        req.query.gatheringSources || req.query.allowedGatheringSources,
      );
      const gatheringJobs = normalizeGatheringJobFilter(req.query.gatheringJobs);
      const minUnitsSold = optionalInteger(
        req.query.minUnitsSold,
        "minUnitsSold",
        {
          min: 0,
          max: 999999,
          defaultValue: 0,
        },
      );
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
}

const ffxivMarketCapability = {
  key: "ffxivMarket",
  registerRoutes: registerFfxivMarketRoutes,
  getHealth: () => ({
    status: "configured",
    configured: true,
    message: "FFXIV market providers are configured from local defaults.",
    universalisConfigured: true,
    xivapiConfigured: true,
  }),
};

module.exports = {
  ffxivMarketCapability,
  registerFfxivMarketRoutes,
};

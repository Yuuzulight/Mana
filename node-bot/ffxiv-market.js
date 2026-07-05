const http = require("http");
const https = require("https");

const UNIVERSALIS_API_URL =
  process.env.UNIVERSALIS_API_URL || "https://universalis.app/api/v2";
const UNIVERSALIS_DEFAULT_WORLD =
  process.env.UNIVERSALIS_DEFAULT_WORLD || "Adamantoise";
const UNIVERSALIS_CACHE_MS = Number(process.env.UNIVERSALIS_CACHE_MS || 60000);
const XIVAPI_SEARCH_URL =
  process.env.XIVAPI_SEARCH_URL || "https://v2.xivapi.com/api/search";
const XIVAPI_SHEET_URL =
  process.env.XIVAPI_SHEET_URL || "https://v2.xivapi.com/api/sheet";
const XIVAPI_RECIPE_SCAN_LIMIT = Number(
  process.env.XIVAPI_RECIPE_SCAN_LIMIT || 500,
);
const XIVAPI_RECIPE_PAGE_SIZE = Number(
  process.env.XIVAPI_RECIPE_PAGE_SIZE || 100,
);
const FFXIV_PROFIT_TOP_LIMIT = Number(process.env.FFXIV_PROFIT_TOP_LIMIT || 10);
const FFXIV_RECIPE_SOURCE = process.env.FFXIV_RECIPE_SOURCE || "garland";
const GARLAND_TOOLS_BASE_URL =
  process.env.GARLAND_TOOLS_BASE_URL || "https://www.garlandtools.org";
const GATHERING_SOURCE_FILTERS = [
  "normal",
  "timed",
  "legendary",
  "ephemeral",
  "folklore",
];
const GATHERING_JOB_FILTERS = ["mining", "botany"];
const IGNORED_GATHERING_MATERIAL_IDS = new Set(
  Array.from({ length: 18 }, (_, index) => index + 2),
);

let runtimeHooks = {
  nowMs: Date.now,
  logPerf: () => {},
};

function configureFfxivMarketTools(hooks = {}) {
  runtimeHooks = {
    nowMs: hooks.nowMs || runtimeHooks.nowMs || Date.now,
    logPerf: hooks.logPerf || runtimeHooks.logPerf || (() => {}),
  };
  return module.exports;
}

function nowMs() {
  return runtimeHooks.nowMs();
}

function logPerf(label, startedAt) {
  return runtimeHooks.logPerf(label, startedAt);
}
function normalizeUniversalisTimestamp(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) {
    return 0;
  }
  return value > 9999999999 ? value : value * 1000;
}

function medianNumber(values) {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return null;
  }

  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function summarizeSalesHistory(
  sales = [],
  { now = Date.now(), historyDays = 30 } = {},
) {
  const safeHistoryDays = Math.max(1, Number(historyDays) || 30);
  const cutoff = now - safeHistoryDays * 24 * 60 * 60 * 1000;
  const recentSales = (Array.isArray(sales) ? sales : [])
    .map((sale) => ({
      pricePerUnit: Number(sale?.pricePerUnit || 0),
      quantity: Number(sale?.quantity || 1),
      timestampMs: normalizeUniversalisTimestamp(sale?.timestamp),
      hq: Boolean(sale?.hq),
    }))
    .filter(
      (sale) =>
        sale.pricePerUnit > 0 &&
        sale.timestampMs >= cutoff &&
        sale.timestampMs <= now,
    );
  const salesCount = recentSales.length;
  const unitsSold = recentSales.reduce(
    (sum, sale) => sum + Math.max(1, sale.quantity || 1),
    0,
  );
  const totalSalePrice = recentSales.reduce(
    (sum, sale) => sum + sale.pricePerUnit,
    0,
  );

  return {
    historyDays: safeHistoryDays,
    salesCount,
    unitsSold,
    medianSalePrice: medianNumber(recentSales.map((sale) => sale.pricePerUnit)),
    averageSalePrice:
      salesCount > 0 ? Math.round(totalSalePrice / salesCount) : null,
    lastSaleAt: recentSales.length
      ? new Date(
          Math.max(...recentSales.map((sale) => sale.timestampMs)),
        ).toISOString()
      : null,
  };
}

function getCraftMarketabilityRequirement(saleUnitPrice) {
  const price = Number(saleUnitPrice || 0);
  if (price >= 10_000_000) {
    return { tier: "premium", minimumSales: 1 };
  }
  if (price >= 1_000_000) {
    return { tier: "expensive", minimumSales: 3 };
  }
  if (price >= 100_000) {
    return { tier: "mid", minimumSales: 8 };
  }
  return { tier: "low", minimumSales: 20 };
}

function getSalesHistoryAdjustedPrice({
  currentListingPrice,
  materialCost,
  amountResult = 1,
  salesHistory = [],
  historyDays = 30,
  now = Date.now(),
} = {}) {
  const salesSummary = summarizeSalesHistory(salesHistory, { now, historyDays });
  const requirement = getCraftMarketabilityRequirement(currentListingPrice);
  const marketabilityPassed =
    salesSummary.salesCount >= requirement.minimumSales;
  if (!marketabilityPassed) {
    return {
      marketabilityPassed: false,
      reason: "insufficient_sales",
      requirement,
      salesSummary,
      estimatedUnitPrice: null,
      estimatedRevenue: null,
      estimatedProfit: null,
    };
  }

  const salePriceCandidates = [
    Number(currentListingPrice || 0),
    Number(salesSummary.medianSalePrice || 0),
  ].filter((price) => price > 0);
  const estimatedUnitPrice = salePriceCandidates.length
    ? Math.min(...salePriceCandidates)
    : null;
  const estimatedRevenue = estimatedUnitPrice
    ? estimatedUnitPrice * Math.max(1, Number(amountResult || 1))
    : null;
  const estimatedProfit =
    estimatedRevenue === null ? null : estimatedRevenue - Number(materialCost || 0);

  return {
    marketabilityPassed: true,
    reason: "passed",
    requirement,
    salesSummary,
    estimatedUnitPrice,
    estimatedRevenue,
    estimatedProfit,
  };
}

function normalizeCraftRankingMode(rankBy, useSalesHistory = false) {
  const normalized = String(rankBy || "")
    .trim()
    .toLowerCase();
  if (normalized === "profit") {
    return "profit";
  }
  if (normalized === "salesvelocity" || normalized === "sales_velocity") {
    return "salesVelocity";
  }
  if (normalized === "balanced") {
    return "balanced";
  }
  return useSalesHistory ? "balanced" : "profit";
}

function getCraftRankingValue(candidate, rankBy = "profit") {
  const profit = Number(candidate?.profit || 0);
  const unitsSold = Math.max(
    0,
    Number(candidate?.salesHistory?.unitsSold || 0),
  );
  if (rankBy === "salesVelocity") {
    return unitsSold;
  }
  if (rankBy === "balanced") {
    return profit * Math.max(1, unitsSold);
  }
  return profit;
}

function formatCraftRankingDetails(item, report = {}) {
  const salesText = item.salesHistory
    ? `, ${item.salesHistory.salesCount} sales in ${item.salesHistory.historyDays}d, ${item.salesHistory.unitsSold} units sold`
    : "";
  const monthlyText =
    item.estimatedMonthlyProfit !== null &&
    item.estimatedMonthlyProfit !== undefined
      ? `, ${item.estimatedMonthlyProfit} gil estimated ${item.salesHistory?.historyDays || report.historyDays || 30}d profit`
      : "";
  return `${salesText}${monthlyText}`;
}

function isIgnoredGatheringMaterial(material = {}) {
  const itemId = Number(material.itemId || material.id || 0);
  const itemName = String(material.itemName || material.name || "");
  return (
    IGNORED_GATHERING_MATERIAL_IDS.has(itemId) ||
    /\b(?:shard|crystal|cluster)\b/i.test(itemName)
  );
}

function normalizeGatheringSourceFilter(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((entry) => entry.trim());
  const normalized = [];
  for (const rawValue of rawValues) {
    const source = String(rawValue || "")
      .trim()
      .toLowerCase();
    if (!source) {
      continue;
    }
    if (source === "all") {
      return [...GATHERING_SOURCE_FILTERS];
    }
    if (source === "unspoiled" || source === "time" || source === "timed") {
      normalized.push("timed");
      continue;
    }
    if (GATHERING_SOURCE_FILTERS.includes(source)) {
      normalized.push(source);
    }
  }
  return [...new Set(normalized.length ? normalized : ["normal"])];
}

function normalizeGatheringJobFilter(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((entry) => entry.trim());
  const normalized = [];
  for (const rawValue of rawValues) {
    const job = String(rawValue || "")
      .trim()
      .toLowerCase();
    if (job === "all") {
      return [...GATHERING_JOB_FILTERS];
    }
    if (job === "miner" || job === "min") {
      normalized.push("mining");
      continue;
    }
    if (job === "botanist" || job === "btn") {
      normalized.push("botany");
      continue;
    }
    if (GATHERING_JOB_FILTERS.includes(job)) {
      normalized.push(job);
    }
  }
  return [...new Set(normalized.length ? normalized : GATHERING_JOB_FILTERS)];
}

function getGarlandNodeGatheringJob(node = {}) {
  const nodeType = Number(node.t);
  if (nodeType === 0 || nodeType === 1) {
    return "mining";
  }
  if (nodeType === 2 || nodeType === 3) {
    return "botany";
  }
  return null;
}

function getGarlandNodeGatheringSources(node = {}, item = {}) {
  const limitedType = String(node.lt || "")
    .trim()
    .toLowerCase();
  const sources = [];
  if (limitedType === "unspoiled") {
    sources.push("timed");
  } else if (limitedType === "legendary") {
    sources.push("legendary");
  } else if (limitedType === "ephemeral") {
    sources.push("ephemeral");
  } else {
    sources.push("normal");
  }
  if (item.unlockId) {
    sources.push("folklore");
  }
  return [...new Set(sources)];
}

function materialPassesGatheringFilters(
  material = {},
  {
    allowedGatheringSources = ["normal"],
    allowedGatheringJobs = GATHERING_JOB_FILTERS,
  } = {},
) {
  if (isIgnoredGatheringMaterial(material)) {
    return {
      passes: true,
      ignored: true,
      reason: "ignored_crystal_shard_or_cluster",
      matchingNodes: [],
    };
  }

  const allowedSources = new Set(
    normalizeGatheringSourceFilter(allowedGatheringSources),
  );
  const allowedJobs = new Set(normalizeGatheringJobFilter(allowedGatheringJobs));
  const nodes = Array.isArray(material.nodes) ? material.nodes : [];
  const matchingNodes = nodes
    .map((node) => {
      const job = getGarlandNodeGatheringJob(node);
      const sources = getGarlandNodeGatheringSources(node, material);
      return {
        id: node.i || node.id || null,
        name: node.n || null,
        level: node.l || null,
        job,
        sources,
      };
    })
    .filter(
      (node) =>
        node.job &&
        allowedJobs.has(node.job) &&
        node.sources.some((source) => allowedSources.has(source)),
    );

  return {
    passes: matchingNodes.length > 0,
    ignored: false,
    reason: matchingNodes.length ? "passed" : "not_allowed_gathering_source",
    matchingNodes,
  };
}

function getGarlandDocNodes(doc = {}) {
  const itemNodes = Array.isArray(doc?.item?.nodes) ? doc.item.nodes : [];
  if (itemNodes.length === 0) {
    return [];
  }
  const itemNodeIds = new Set(
    itemNodes
      .map(Number)
      .filter((nodeId) => Number.isInteger(nodeId) && nodeId > 0),
  );
  return (Array.isArray(doc?.partials) ? doc.partials : [])
    .filter((partial) => partial?.type === "node" && partial.obj)
    .map((partial) => partial.obj)
    .filter((node) => itemNodeIds.has(Number(node.i || node.id)));
}

function buildGatheringMaterialFromGarlandDoc(doc = {}, fallback = {}) {
  return {
    itemId: Number(doc?.item?.id || fallback.itemId || fallback.id || 0),
    itemName: doc?.item?.name || fallback.itemName || fallback.name || "",
    quantity: Number(fallback.quantity || 0),
    unlockId: doc?.item?.unlockId || null,
    nodes: getGarlandDocNodes(doc),
  };
}

function mergeGatheringMaterials(materials) {
  const byItemId = new Map();
  for (const material of materials) {
    const itemId = Number(material.itemId || 0);
    if (!itemId) {
      continue;
    }
    const existing = byItemId.get(itemId);
    if (existing) {
      existing.quantity += Number(material.quantity || 0);
      continue;
    }
    byItemId.set(itemId, {
      ...material,
      quantity: Number(material.quantity || 0),
    });
  }
  return [...byItemId.values()];
}

async function expandGatheringIngredient(
  ingredient,
  {
    getItemDoc,
    allowedGatheringSources = ["normal"],
    allowedGatheringJobs = GATHERING_JOB_FILTERS,
    maxDepth = 6,
    depth = 0,
    path = new Set(),
  } = {},
) {
  const itemId = Number(ingredient.itemId || ingredient.id || 0);
  const quantity = Number(ingredient.quantity || ingredient.amount || 0);
  const fallback = {
    itemId,
    itemName: ingredient.itemName || ingredient.name || "",
    quantity,
  };

  if (!itemId || quantity <= 0 || isIgnoredGatheringMaterial(fallback)) {
    return { passes: true, materials: [], failures: [] };
  }
  if (typeof getItemDoc !== "function") {
    return {
      passes: false,
      materials: [],
      failures: [{ ...fallback, reason: "missing_garland_item_doc_fetcher" }],
    };
  }
  if (depth > maxDepth || path.has(itemId)) {
    return {
      passes: false,
      materials: [],
      failures: [{ ...fallback, reason: "crafting_expansion_depth_exceeded" }],
    };
  }

  const doc = await getItemDoc(itemId);
  if (!doc?.item) {
    return {
      passes: false,
      materials: [],
      failures: [{ ...fallback, reason: "missing_garland_item_doc" }],
    };
  }

  const material = buildGatheringMaterialFromGarlandDoc(doc, fallback);
  const gatheringResult = materialPassesGatheringFilters(material, {
    allowedGatheringSources,
    allowedGatheringJobs,
  });
  if (gatheringResult.passes) {
    return {
      passes: true,
      materials: [
        {
          ...material,
          gathering: {
            sources: [
              ...new Set(gatheringResult.matchingNodes.flatMap((node) => node.sources)),
            ],
            jobs: [
              ...new Set(gatheringResult.matchingNodes.map((node) => node.job)),
            ],
            nodes: gatheringResult.matchingNodes,
          },
        },
      ],
      failures: [],
    };
  }

  const crafts = Array.isArray(doc.item.craft) ? doc.item.craft : [];
  for (const craft of crafts) {
    const craftYield = Math.max(1, Number(craft.yield || 1));
    const craftCount = Math.ceil(quantity / craftYield);
    const childResults = [];
    const childFailures = [];
    const nextPath = new Set(path);
    nextPath.add(itemId);
    for (const child of Array.isArray(craft.ingredients)
      ? craft.ingredients
      : []) {
      const childResult = await expandGatheringIngredient(
        {
          itemId: Number(child.id || 0),
          quantity: Number(child.amount || 0) * craftCount,
        },
        {
          getItemDoc,
          allowedGatheringSources,
          allowedGatheringJobs,
          maxDepth,
          depth: depth + 1,
          path: nextPath,
        },
      );
      if (!childResult.passes) {
        childFailures.push(...childResult.failures);
      }
      childResults.push(...childResult.materials);
    }
    if (childFailures.length === 0) {
      return {
        passes: true,
        materials: mergeGatheringMaterials(childResults),
        failures: [],
      };
    }
  }

  return {
    passes: false,
    materials: [],
    failures: [
      {
        ...material,
        reason: gatheringResult.reason,
      },
    ],
  };
}

async function resolveGatherableRecipeMaterials(recipe, options = {}) {
  const materials = [];
  const failures = [];
  for (const ingredient of Array.isArray(recipe?.ingredients)
    ? recipe.ingredients
    : []) {
    const result = await expandGatheringIngredient(ingredient, options);
    if (!result.passes) {
      failures.push(...result.failures);
    }
    materials.push(...result.materials);
  }

  return {
    passes: failures.length === 0,
    materials: mergeGatheringMaterials(materials),
    failures,
  };
}


function getJson(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mana local assistant",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(
              new Error(`GET ${urlString} failed (${res.statusCode}): ${text}`),
            );
            return;
          }

          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

const universalisCache = new Map();
const xivapiItemCache = new Map();
const xivapiRecipeCache = new Map();
const garlandItemCache = new Map();
const RECIPE_PROFIT_FIELDS =
  "ItemResult.Name,AmountResult,Ingredient[].Name,AmountIngredient,CanHq";

function extractItemIdFromText(text) {
  const itemIdMatch = String(text || "").match(
    /\b(?:item\s*id|itemid|id)\s*[:#-]?\s*(\d{1,8})\b/i,
  );
  if (itemIdMatch) {
    return Number(itemIdMatch[1]);
  }

  return null;
}

function textLooksLikeMarketQuestion(text) {
  return /\b(universalis|marketboard|market board|price|prices|listing|listings|sale|sales|gil|hover|hovered|mouse over|mouseover)\b/i.test(
    text || "",
  );
}

function textLooksLikeCraftProfitQuestion(text) {
  return (
    /\b(craft|crafted|crafting|recipe|recipes|materials?|mats?)\b/i.test(
      text || "",
    ) &&
    /\b(profit|profitable|margin|flip|gil|marketboard|market board|universalis)\b/i.test(
      text || "",
    )
  );
}

function extractTopLimitFromText(text, fallback = FFXIV_PROFIT_TOP_LIMIT) {
  const match = String(text || "").match(/\btop\s+(\d{1,2})\b/i);
  const limit = match ? Number(match[1]) : fallback;
  return clampInteger(limit, 1, 25, fallback);
}

function cleanItemNameCandidate(text) {
  return String(text || "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]+\)/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExplicitItemNameFromText(text) {
  const match = String(text || "").match(
    /\b(?:item|item name|name)\s*[:#-]\s*["']?([^"'\n\r]{2,80})/i,
  );
  return match ? cleanItemNameCandidate(match[1]) : "";
}

function extractHoveredItemName(screenText) {
  const blockedPatterns = [
    /\bmarket board\b/i,
    /\binventory\b/i,
    /\barmoury chest\b/i,
    /\bcharacter\b/i,
    /\bitem level\b/i,
    /\bunique\b/i,
    /\buntradable\b/i,
    /\bextractable\b/i,
    /\bprojectable\b/i,
    /\bdesynthesizable\b/i,
    /\bsells for\b/i,
    /\brepair level\b/i,
  ];
  const lines = String(screenText || "")
    .split(/\r?\n| {2,}/)
    .map(cleanItemNameCandidate)
    .filter((line) => line.length >= 3 && line.length <= 80)
    .filter((line) => /[A-Za-z]/.test(line))
    .filter((line) => !blockedPatterns.some((pattern) => pattern.test(line)));

  return lines[0] || "";
}

async function resolveFfxivItemByName(itemName) {
  const cleanName = cleanItemNameCandidate(itemName);
  if (!cleanName) {
    throw new Error("itemName is required");
  }

  const cacheKey = cleanName.toLowerCase();
  const cached = xivapiItemCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
    return cached.value;
  }

  const query = encodeURIComponent(`Name~"${cleanName.replace(/"/g, "")}"`);
  const url = `${XIVAPI_SEARCH_URL}?sheets=Item&query=${query}&fields=Name&limit=10`;
  const data = await getJson(url);
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    throw new Error(`No FFXIV item matched "${cleanName}"`);
  }

  const exact = results.find(
    (result) =>
      String(result?.fields?.Name || "").toLowerCase() ===
      cleanName.toLowerCase(),
  );
  const best = exact || results[0];
  const value = {
    itemId: best.row_id,
    name: best.fields?.Name || cleanName,
    score: best.score || null,
    matches: results.slice(0, 5).map((result) => ({
      itemId: result.row_id,
      name: result.fields?.Name || "",
      score: result.score || null,
    })),
  };

  xivapiItemCache.set(cacheKey, {
    createdAt: Date.now(),
    value,
  });
  return value;
}

async function getUniversalisMarketSummary(world, itemId, itemName = "") {
  const safeWorld = encodeURIComponent(world || UNIVERSALIS_DEFAULT_WORLD);
  const safeItemId = Number(itemId);
  if (!Number.isInteger(safeItemId) || safeItemId <= 0) {
    throw new Error("itemId must be a positive integer");
  }

  const cacheKey = `${safeWorld}:${safeItemId}`;
  const cached = universalisCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
    return cached.value;
  }

  const url = `${UNIVERSALIS_API_URL}/${safeWorld}/${safeItemId}?listings=5&entries=5`;
  const data = await getJson(url);
  const listings = Array.isArray(data.listings) ? data.listings : [];
  const recentHistory = Array.isArray(data.recentHistory)
    ? data.recentHistory
    : [];
  const lowestListings = listings.slice(0, 5).map((listing) => ({
    pricePerUnit: listing.pricePerUnit,
    quantity: listing.quantity,
    total: listing.total,
    hq: Boolean(listing.hq),
  }));
  const recentSales = recentHistory.slice(0, 5).map((sale) => ({
    pricePerUnit: sale.pricePerUnit,
    quantity: sale.quantity,
    total: sale.total,
    hq: Boolean(sale.hq),
    timestamp: sale.timestamp,
  }));

  const summary = {
    source: "Universalis",
    world: data.worldName || world || UNIVERSALIS_DEFAULT_WORLD,
    itemId: data.itemID || safeItemId,
    itemName,
    lastUploadTime: data.lastUploadTime || null,
    listingsCount: data.listingsCount || listings.length,
    unitsForSale: data.unitsForSale || 0,
    minPrice: data.minPrice || null,
    minPriceNq: data.minPriceNQ || null,
    minPriceHq: data.minPriceHQ || null,
    averagePrice: data.averagePrice || null,
    currentAveragePrice: data.currentAveragePrice || null,
    saleVelocity: data.regularSaleVelocity || null,
    lowestListings,
    recentSales,
  };

  universalisCache.set(cacheKey, {
    createdAt: Date.now(),
    value: summary,
  });
  return summary;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, number));
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function getXivapiRefName(ref) {
  return typeof ref?.fields?.Name === "string" ? ref.fields.Name : "";
}

function getXivapiRefId(ref) {
  const id = Number(ref?.row_id || ref?.value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function normalizeRecipeRow(row) {
  const fields = row?.fields || {};
  const resultItemId = getXivapiRefId(fields.ItemResult);
  const resultItemName = getXivapiRefName(fields.ItemResult);
  const amountResult = Number(fields.AmountResult || 1);
  const amountIngredient = Array.isArray(fields.AmountIngredient)
    ? fields.AmountIngredient
    : [];
  const ingredients = (
    Array.isArray(fields.Ingredient) ? fields.Ingredient : []
  )
    .map((ingredient, index) => ({
      itemId: getXivapiRefId(ingredient),
      itemName: getXivapiRefName(ingredient),
      quantity: Number(amountIngredient[index] || 0),
    }))
    .filter(
      (ingredient) =>
        ingredient.itemId > 0 &&
        ingredient.quantity > 0 &&
        ingredient.itemName.trim(),
    );

  if (
    !resultItemId ||
    !resultItemName ||
    !amountResult ||
    ingredients.length === 0
  ) {
    return null;
  }

  return {
    recipeId: row.row_id,
    resultItemId,
    resultItemName,
    amountResult,
    canHq: Boolean(fields.CanHq),
    ingredients,
  };
}

async function getXivapiRecipeCandidates({ query = "", scanLimit, pageSize }) {
  const safeScanLimit = clampInteger(
    scanLimit,
    1,
    5000,
    XIVAPI_RECIPE_SCAN_LIMIT,
  );
  const safePageSize = clampInteger(pageSize, 1, 500, XIVAPI_RECIPE_PAGE_SIZE);
  const cleanQuery = cleanItemNameCandidate(query);
  const cacheKey = `${cleanQuery.toLowerCase() || "*"}:${safeScanLimit}:${safePageSize}`;
  const cached = xivapiRecipeCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
    return cached.value;
  }

  const recipes = [];
  if (cleanQuery) {
    const encodedQuery = encodeURIComponent(
      `ItemResult.Name~"${cleanQuery.replace(/"/g, "")}"`,
    );
    const url = `${XIVAPI_SEARCH_URL}?sheets=Recipe&query=${encodedQuery}&fields=${encodeURIComponent(RECIPE_PROFIT_FIELDS)}&limit=${safeScanLimit}`;
    const data = await getJson(url);
    const results = Array.isArray(data.results) ? data.results : [];
    recipes.push(...results.map(normalizeRecipeRow).filter(Boolean));
  } else {
    let after = 0;
    while (recipes.length < safeScanLimit) {
      const limit = Math.min(safePageSize, safeScanLimit - recipes.length);
      const url = `${XIVAPI_SHEET_URL}/Recipe?fields=${encodeURIComponent(RECIPE_PROFIT_FIELDS)}&limit=${limit}&after=${after}`;
      const data = await getJson(url);
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (rows.length === 0) {
        break;
      }

      recipes.push(...rows.map(normalizeRecipeRow).filter(Boolean));
      after = Number(rows[rows.length - 1]?.row_id || after);
      if (!after) {
        break;
      }
    }
  }

  const value = recipes.slice(0, safeScanLimit);
  xivapiRecipeCache.set(cacheKey, {
    createdAt: Date.now(),
    value,
  });
  return value;
}

function normalizeRecipeSource(source) {
  const normalized = String(
    source || FFXIV_RECIPE_SOURCE || "garland",
  ).toLowerCase();
  return normalized === "xivapi" ? "xivapi" : "garland";
}

async function getGarlandItemDoc(itemId) {
  const safeItemId = Number(itemId);
  if (!Number.isInteger(safeItemId) || safeItemId <= 0) {
    throw new Error("Garland item id must be a positive integer");
  }

  const cacheKey = String(safeItemId);
  const cached = garlandItemCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
    return cached.value;
  }

  const url = `${GARLAND_TOOLS_BASE_URL}/db/doc/item/en/3/${safeItemId}.json`;
  const data = await getJson(url);
  garlandItemCache.set(cacheKey, {
    createdAt: Date.now(),
    value: data,
  });
  return data;
}

function buildGarlandItemNameMap(doc) {
  const names = new Map();
  if (doc?.item?.id && doc?.item?.name) {
    names.set(Number(doc.item.id), doc.item.name);
  }

  for (const item of Array.isArray(doc?.ingredients) ? doc.ingredients : []) {
    if (item?.id && item?.name) {
      names.set(Number(item.id), item.name);
    }
  }

  for (const partial of Array.isArray(doc?.partials) ? doc.partials : []) {
    if (partial?.type === "item" && partial?.obj?.i && partial?.obj?.n) {
      names.set(Number(partial.obj.i), partial.obj.n);
    }
  }
  return names;
}

function normalizeGarlandRecipeDoc(doc) {
  const resultItemId = Number(doc?.item?.id || 0);
  const resultItemName = doc?.item?.name || "";
  const nameMap = buildGarlandItemNameMap(doc);
  return (Array.isArray(doc?.item?.craft) ? doc.item.craft : [])
    .map((craft) => {
      const ingredients = (
        Array.isArray(craft.ingredients) ? craft.ingredients : []
      )
        .map((ingredient) => ({
          itemId: Number(ingredient.id || 0),
          itemName:
            nameMap.get(Number(ingredient.id || 0)) ||
            `item ID ${ingredient.id}`,
          quantity: Number(ingredient.amount || 0),
        }))
        .filter(
          (ingredient) => ingredient.itemId > 0 && ingredient.quantity > 0,
        );

      if (!resultItemId || !resultItemName || ingredients.length === 0) {
        return null;
      }

      return {
        recipeId: craft.id,
        resultItemId,
        resultItemName,
        amountResult: Number(craft.yield || 1),
        canHq: Boolean(craft.hq),
        recipeLevel: craft.lvl || null,
        recipeSource: "garland",
        ingredients,
      };
    })
    .filter(Boolean);
}

async function searchGarlandCraftableItemIds(query, scanLimit) {
  const cleanQuery = cleanItemNameCandidate(query);
  if (!cleanQuery) {
    return [];
  }

  const url = `${GARLAND_TOOLS_BASE_URL}/api/search.php?text=${encodeURIComponent(cleanQuery)}&lang=en`;
  const data = await getJson(url);
  const values = Array.isArray(data?.value) ? data.value : [];
  return values
    .filter((entry) => entry?.type === "item" && Array.isArray(entry?.obj?.f))
    .map((entry) => Number(entry.id || entry.obj?.i || 0))
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0)
    .slice(0, scanLimit);
}

async function getGarlandRecipeCandidates({ query = "", scanLimit, pageSize }) {
  const safeScanLimit = clampInteger(
    scanLimit,
    1,
    5000,
    XIVAPI_RECIPE_SCAN_LIMIT,
  );
  let itemIds = await searchGarlandCraftableItemIds(query, safeScanLimit);
  if (itemIds.length === 0) {
    const xivapiCandidates = await getXivapiRecipeCandidates({
      query,
      scanLimit: safeScanLimit,
      pageSize,
    });
    itemIds = xivapiCandidates.map((recipe) => recipe.resultItemId);
  }

  const uniqueItemIds = [...new Set(itemIds)].slice(0, safeScanLimit);
  const docs = await mapWithConcurrency(uniqueItemIds, 6, async (itemId) => {
    try {
      return await getGarlandItemDoc(itemId);
    } catch (error) {
      console.warn(`Garland item ${itemId} lookup failed: ${error}`);
      return null;
    }
  });

  return docs
    .filter(Boolean)
    .flatMap(normalizeGarlandRecipeDoc)
    .slice(0, safeScanLimit);
}

function summarizeUniversalisRawItem(rawItem, fallbackWorld, fallbackItemId) {
  const itemId = Number(rawItem?.itemID || fallbackItemId);
  const minPrice = Number(rawItem?.minPrice || 0);
  const minPriceNq = Number(rawItem?.minPriceNQ || 0);
  const minPriceHq = Number(rawItem?.minPriceHQ || 0);
  const currentAveragePrice = Number(rawItem?.currentAveragePrice || 0);
  const averagePrice = Number(rawItem?.averagePrice || 0);
  const listingsCount = Number(rawItem?.listingsCount || 0);
  const recentHistory = Array.isArray(rawItem?.recentHistory)
    ? rawItem.recentHistory
    : [];
  return {
    itemId,
    world: rawItem?.worldName || fallbackWorld || UNIVERSALIS_DEFAULT_WORLD,
    minPrice: minPrice > 0 ? minPrice : null,
    minPriceNq: minPriceNq > 0 ? minPriceNq : null,
    minPriceHq: minPriceHq > 0 ? minPriceHq : null,
    currentAveragePrice: currentAveragePrice > 0 ? currentAveragePrice : null,
    averagePrice: averagePrice > 0 ? averagePrice : null,
    listingsCount,
    unitsForSale: rawItem?.unitsForSale || 0,
    lastUploadTime: rawItem?.lastUploadTime || null,
    recentHistory,
    hasData: Boolean(rawItem?.hasData || minPrice > 0 || listingsCount > 0),
  };
}

async function getUniversalisMarketItems(
  world,
  itemIds,
  { includeHistory = false, historyDays = 30 } = {},
) {
  const safeWorld = encodeURIComponent(world || UNIVERSALIS_DEFAULT_WORLD);
  const safeHistoryDays = Math.max(1, Number(historyDays) || 30);
  const historySeconds = safeHistoryDays * 24 * 60 * 60;
  const uniqueIds = [
    ...new Set(
      itemIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  const summaries = new Map();
  const missingIds = [];

  for (const itemId of uniqueIds) {
    const cacheKey = `${safeWorld}:raw:${includeHistory ? `history${safeHistoryDays}` : "nohistory"}:${itemId}`;
    const cached = universalisCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
      summaries.set(itemId, cached.value);
    } else {
      missingIds.push(itemId);
    }
  }

  for (const chunk of chunkArray(missingIds, 100)) {
    const entriesParam = includeHistory
      ? `entriesWithin=${historySeconds}`
      : "entries=0";
    const url = `${UNIVERSALIS_API_URL}/${safeWorld}/${chunk.join(",")}?listings=0&${entriesParam}`;
    const data = await getJson(url);
    const rawItems =
      data?.items && typeof data.items === "object"
        ? data.items
        : { [String(chunk[0])]: data };

    for (const itemId of chunk) {
      const summary = summarizeUniversalisRawItem(
        rawItems[String(itemId)] || {},
        data.worldName || world,
        itemId,
      );
      const cacheKey = `${safeWorld}:raw:${includeHistory ? `history${safeHistoryDays}` : "nohistory"}:${itemId}`;
      universalisCache.set(cacheKey, {
        createdAt: Date.now(),
        value: summary,
      });
      summaries.set(itemId, summary);
    }
  }

  return summaries;
}

function getMarketComparisonPrice(summary) {
  return summary?.minPrice || null;
}

async function findProfitableCrafts({
  world = UNIVERSALIS_DEFAULT_WORLD,
  query = "",
  limit = FFXIV_PROFIT_TOP_LIMIT,
  scanLimit = XIVAPI_RECIPE_SCAN_LIMIT,
  pageSize = XIVAPI_RECIPE_PAGE_SIZE,
  recipeSource = FFXIV_RECIPE_SOURCE,
  useSalesHistory = false,
  historyDays = 30,
  rankBy,
  gatherableOnly = false,
  gatheringSources,
  gatheringJobs,
  minUnitsSold = 0,
} = {}) {
  const safeLimit = clampInteger(limit, 1, 25, FFXIV_PROFIT_TOP_LIMIT);
  const safeScanLimit = clampInteger(
    scanLimit,
    1,
    5000,
    XIVAPI_RECIPE_SCAN_LIMIT,
  );
  const safeRecipeSource = normalizeRecipeSource(recipeSource);
  const safeHistoryDays = clampInteger(historyDays, 1, 90, 30);
  const safeRankBy = normalizeCraftRankingMode(rankBy, Boolean(useSalesHistory));
  const safeGatherableOnly = Boolean(gatherableOnly);
  const safeGatheringSources = normalizeGatheringSourceFilter(gatheringSources);
  const safeGatheringJobs = normalizeGatheringJobFilter(gatheringJobs);
  const safeMinUnitsSold = clampInteger(minUnitsSold, 0, 999999, 0);
  const recipes =
    safeRecipeSource === "garland"
      ? await getGarlandRecipeCandidates({
          query,
          scanLimit: safeScanLimit,
          pageSize,
        })
      : await getXivapiRecipeCandidates({
          query,
          scanLimit: safeScanLimit,
          pageSize,
      });

  const recipeGatheringPlans = new Map();
  if (safeGatherableOnly) {
    const gatheringPlans = await mapWithConcurrency(
      recipes,
      6,
      async (recipe) => ({
        key: `${recipe.recipeId}:${recipe.resultItemId}`,
        plan: await resolveGatherableRecipeMaterials(recipe, {
          getItemDoc: getGarlandItemDoc,
          allowedGatheringSources: safeGatheringSources,
          allowedGatheringJobs: safeGatheringJobs,
        }),
      }),
    );
    for (const { key, plan } of gatheringPlans) {
      recipeGatheringPlans.set(key, plan);
    }
  }

  const itemIds = [];
  for (const recipe of recipes) {
    itemIds.push(recipe.resultItemId);
    const gatheringPlan = recipeGatheringPlans.get(
      `${recipe.recipeId}:${recipe.resultItemId}`,
    );
    const ingredientsForPricing =
      safeGatherableOnly && gatheringPlan?.passes
        ? gatheringPlan.materials
        : recipe.ingredients;
    for (const ingredient of ingredientsForPricing) {
      itemIds.push(ingredient.itemId);
    }
  }

  const marketItems = await getUniversalisMarketItems(world, itemIds, {
    includeHistory: Boolean(useSalesHistory),
    historyDays: safeHistoryDays,
  });
  const skipped = {
    missingResultPrice: 0,
    missingMaterialPrice: 0,
    insufficientSalesHistory: 0,
    insufficientUnitsSold: 0,
    nonGatherableMaterials: 0,
  };
  const bestByResultItem = new Map();

  for (const recipe of recipes) {
    const gatheringPlan = recipeGatheringPlans.get(
      `${recipe.recipeId}:${recipe.resultItemId}`,
    );
    if (safeGatherableOnly && !gatheringPlan?.passes) {
      skipped.nonGatherableMaterials += 1;
      continue;
    }

    const resultMarket = marketItems.get(recipe.resultItemId);
    const resultUnitPrice = getMarketComparisonPrice(resultMarket);
    if (!resultUnitPrice) {
      skipped.missingResultPrice += 1;
      continue;
    }

    const pricedIngredients = [];
    let materialCost = 0;
    let hasMissingMaterial = false;
    const ingredientsForPricing =
      safeGatherableOnly && gatheringPlan?.passes
        ? gatheringPlan.materials
        : recipe.ingredients;
    for (const ingredient of ingredientsForPricing) {
      const materialMarket = marketItems.get(ingredient.itemId);
      const unitPrice = getMarketComparisonPrice(materialMarket);
      if (!unitPrice) {
        hasMissingMaterial = true;
        break;
      }

      const total = unitPrice * ingredient.quantity;
      materialCost += total;
      pricedIngredients.push({
        ...ingredient,
        unitPrice,
        total,
      });
    }

    if (hasMissingMaterial) {
      skipped.missingMaterialPrice += 1;
      continue;
    }

    const salesAdjustment = useSalesHistory
      ? getSalesHistoryAdjustedPrice({
          currentListingPrice: resultUnitPrice,
          materialCost,
          amountResult: recipe.amountResult,
          salesHistory: resultMarket?.recentHistory || [],
          historyDays: safeHistoryDays,
        })
      : null;
    if (useSalesHistory && !salesAdjustment.marketabilityPassed) {
      skipped.insufficientSalesHistory += 1;
      continue;
    }
    if (
      useSalesHistory &&
      safeMinUnitsSold > 0 &&
      salesAdjustment.salesSummary.unitsSold < safeMinUnitsSold
    ) {
      skipped.insufficientUnitsSold += 1;
      continue;
    }

    const adjustedUnitPrice =
      salesAdjustment?.estimatedUnitPrice || resultUnitPrice;
    const resultRevenue = adjustedUnitPrice * recipe.amountResult;
    const profit = resultRevenue - materialCost;
    const profitMargin = materialCost > 0 ? profit / materialCost : null;
    const salesUnitsSold = salesAdjustment?.salesSummary.unitsSold || 0;
    const estimatedMonthlyProfit = useSalesHistory
      ? profit * Math.max(1, Number(salesUnitsSold || 0))
      : null;
    const candidate = {
      recipeId: recipe.recipeId,
      itemId: recipe.resultItemId,
      itemName: recipe.resultItemName,
      world: resultMarket?.world || world || UNIVERSALIS_DEFAULT_WORLD,
      amountResult: recipe.amountResult,
      canHq: recipe.canHq,
      saleUnitPrice: adjustedUnitPrice,
      currentListingUnitPrice: resultUnitPrice,
      saleRevenue: resultRevenue,
      materialCost,
      profit,
      profitMargin,
      rankBy: safeRankBy,
      rankingValue: null,
      estimatedMonthlyProfit,
      salesVelocityScore: useSalesHistory ? Number(salesUnitsSold || 0) : null,
      ingredients: pricedIngredients,
      gathering: safeGatherableOnly
        ? {
            gatherableOnly: true,
            allowedSources: safeGatheringSources,
            allowedJobs: safeGatheringJobs,
            ignoredMaterials: "Crystals, shards, and clusters are ignored.",
          }
        : null,
      resultMarket: {
        minPrice: resultMarket?.minPrice ?? null,
        minPriceNq: resultMarket?.minPriceNq ?? null,
        minPriceHq: resultMarket?.minPriceHq ?? null,
        currentAveragePrice: resultMarket?.currentAveragePrice ?? null,
        listingsCount: resultMarket?.listingsCount ?? 0,
        unitsForSale: resultMarket?.unitsForSale ?? 0,
        lastUploadTime: resultMarket?.lastUploadTime ?? null,
      },
      salesHistory: salesAdjustment
        ? {
            historyDays: safeHistoryDays,
            salesCount: salesAdjustment.salesSummary.salesCount,
            unitsSold: salesAdjustment.salesSummary.unitsSold,
            medianSalePrice: salesAdjustment.salesSummary.medianSalePrice,
            averageSalePrice: salesAdjustment.salesSummary.averageSalePrice,
            lastSaleAt: salesAdjustment.salesSummary.lastSaleAt,
            marketabilityTier: salesAdjustment.requirement.tier,
            minimumSales: salesAdjustment.requirement.minimumSales,
            marketabilityPassed: salesAdjustment.marketabilityPassed,
          }
        : null,
    };
    candidate.rankingValue = getCraftRankingValue(candidate, safeRankBy);

    const existing = bestByResultItem.get(recipe.resultItemId);
    if (
      !existing ||
      candidate.rankingValue > existing.rankingValue ||
      (candidate.rankingValue === existing.rankingValue &&
        candidate.profit > existing.profit)
    ) {
      bestByResultItem.set(recipe.resultItemId, candidate);
    }
  }

  const results = [...bestByResultItem.values()]
    .filter((result) => result.profit > 0)
    .sort(
      (left, right) =>
        right.rankingValue - left.rankingValue || right.profit - left.profit,
    )
    .slice(0, safeLimit);

  return {
    source: `${safeRecipeSource === "garland" ? "Garland Tools" : "XIVAPI"} + Universalis`,
    recipeSource: safeRecipeSource,
    world: world || UNIVERSALIS_DEFAULT_WORLD,
    query: cleanItemNameCandidate(query) || null,
    limit: safeLimit,
    scanLimit: safeScanLimit,
    useSalesHistory: Boolean(useSalesHistory),
    historyDays: safeHistoryDays,
    rankBy: safeRankBy,
    gatherableOnly: safeGatherableOnly,
    gatheringSources: safeGatheringSources,
    gatheringJobs: safeGatheringJobs,
    minUnitsSold: safeMinUnitsSold,
    recipesScanned: recipes.length,
    recipesPriced: bestByResultItem.size,
    skipped,
    priceBasis:
      useSalesHistory
        ? `Lower of current Universalis listing price and 30-day median sale price, filtered by 30-day sales frequency. Balanced ranking uses estimated profit multiplied by units sold in the sales-history window.${safeGatherableOnly ? " Gatherable-only scans expand craftable intermediates to base Mining/Botany materials and ignore crystals, shards, and clusters." : ""}`
        : "Lowest current Universalis listing price. Revenue is item price multiplied by recipe yield.",
    results,
  };
}

function formatProfitableCraftsForPrompt(report) {
  const lines = [
    "FFXIV crafting profit scan:",
    `World: ${report.world}`,
    `Recipes scanned: ${report.recipesScanned}`,
    `Price basis: ${report.priceBasis}`,
  ];
  if (report.rankBy) {
    lines.push(`Rank by: ${report.rankBy}`);
  }

  if (!report.results.length) {
    lines.push(
      "No profitable fully priced crafts were found in the scanned recipes.",
    );
  } else {
    lines.push("Top profitable crafts:");
    for (const [index, item] of report.results.entries()) {
      const margin =
        item.profitMargin === null
          ? "unknown margin"
          : `${Math.round(item.profitMargin * 100)}% margin`;
      const rankingDetails = formatCraftRankingDetails(item, report);
      lines.push(
        `${index + 1}. ${item.itemName}: ${item.profit} gil profit (${item.saleRevenue} revenue - ${item.materialCost} mats, ${margin}${rankingDetails})`,
      );
    }
  }

  lines.push(
    "Answer with the ranked item names, profit, sale revenue, material cost, and world. Mention when sales-history filtering was used and that prices can move.",
  );
  return lines.join("\n");
}

async function buildCraftProfitContextForPrompt(text, requestedWorld) {
  if (!textLooksLikeCraftProfitQuestion(text)) {
    return "";
  }

  const limit = extractTopLimitFromText(text);
  const startedAt = nowMs();
  const report = await findProfitableCrafts({
    world: requestedWorld || UNIVERSALIS_DEFAULT_WORLD,
    limit,
  });
  logPerf("ffxiv-crafting-profit", startedAt);
  return formatProfitableCraftsForPrompt(report);
}

async function buildUniversalisContextForPrompt(
  text,
  requestedWorld,
  screenText = "",
) {
  if (!textLooksLikeMarketQuestion(text)) {
    return "";
  }

  let itemId = extractItemIdFromText(text);
  let itemName = extractExplicitItemNameFromText(text);
  if (
    !itemId &&
    !itemName &&
    /\b(hover|hovered|mouse over|mouseover|this item)\b/i.test(text || "")
  ) {
    itemName = extractHoveredItemName(screenText);
  }

  if (!itemId && itemName) {
    const resolvedItem = await resolveFfxivItemByName(itemName);
    itemId = resolvedItem.itemId;
    itemName = resolvedItem.name;
  }

  if (!itemId) {
    return "";
  }

  const startedAt = nowMs();
  const summary = await getUniversalisMarketSummary(
    requestedWorld || UNIVERSALIS_DEFAULT_WORLD,
    itemId,
    itemName,
  );
  logPerf("universalis", startedAt);
  const listingLines = summary.lowestListings
    .slice(0, 3)
    .map((listing, index) => {
      const quality = listing.hq ? "HQ" : "NQ";
      return `${index + 1}. ${listing.pricePerUnit} gil each (${quality}), stack ${listing.quantity}, total ${listing.total} gil`;
    });
  const saleLines = summary.recentSales.slice(0, 3).map((sale, index) => {
    const quality = sale.hq ? "HQ" : "NQ";
    return `${index + 1}. ${sale.pricePerUnit} gil each (${quality}), quantity ${sale.quantity}`;
  });

  return [
    "Universalis market data:",
    `World: ${summary.world}`,
    `Item: ${summary.itemName || "item ID " + summary.itemId}`,
    `Item ID: ${summary.itemId}`,
    `Lowest NQ: ${summary.minPriceNq ?? "unknown"} gil`,
    `Lowest HQ: ${summary.minPriceHq ?? "unknown"} gil`,
    `Average sale price: ${summary.averagePrice ?? "unknown"} gil`,
    `Current average listing price: ${summary.currentAveragePrice ?? "unknown"} gil`,
    `Units for sale: ${summary.unitsForSale}`,
    "Lowest listings:",
    ...(listingLines.length ? listingLines : ["No current listings found."]),
    "Recent sales:",
    ...(saleLines.length ? saleLines : ["No recent sales found."]),
    "",
    "The user is asking for marketboard price, not item description. Answer with the resolved item name and the lowest NQ/HQ prices first. Keep it concise.",
  ].join("\n");
}
module.exports = {
  FFXIV_PROFIT_TOP_LIMIT,
  FFXIV_RECIPE_SOURCE,
  XIVAPI_RECIPE_PAGE_SIZE,
  XIVAPI_RECIPE_SCAN_LIMIT,
  UNIVERSALIS_DEFAULT_WORLD,
  buildCraftProfitContextForPrompt,
  buildUniversalisContextForPrompt,
  clampInteger,
  cleanItemNameCandidate,
  configureFfxivMarketTools,
  extractExplicitItemNameFromText,
  extractHoveredItemName,
  findProfitableCrafts,
  formatCraftRankingDetails,
  formatProfitableCraftsForPrompt,
  getCraftMarketabilityRequirement,
  getCraftRankingValue,
  getGarlandNodeGatheringJob,
  getGarlandNodeGatheringSources,
  getSalesHistoryAdjustedPrice,
  getUniversalisMarketSummary,
  isIgnoredGatheringMaterial,
  materialPassesGatheringFilters,
  normalizeCraftRankingMode,
  normalizeGatheringJobFilter,
  normalizeGatheringSourceFilter,
  resolveFfxivItemByName,
  resolveGatherableRecipeMaterials,
  summarizeSalesHistory,
  textLooksLikeCraftProfitQuestion,
  textLooksLikeMarketQuestion,
};

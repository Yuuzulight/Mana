// Adzuna Job Search API client (https://developer.adzuna.com/), same shape
// as plugins/stock-market/market-data.js's Alpha Vantage client: fetch +
// cache + isConfigured, so job-search-adzuna's index.js/health/routes stay
// as thin as ffxiv-market's and stock-market's.
const https = require("https");

const DEFAULT_BASE_URL = "https://api.adzuna.com/v1/api/jobs";
const DEFAULT_COUNTRY = "us";
const DEFAULT_CACHE_MS = 300000;
const DEFAULT_RESULTS_PER_PAGE = 10;
const MAX_RESULTS_PER_PAGE = 20;

function fetchJsonWithHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function clampPage(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function clampResultsPerPage(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RESULTS_PER_PAGE;
  return Math.min(safe, MAX_RESULTS_PER_PAGE);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .trim();
}

// Adzuna's raw listing shape has more fields than we need; this keeps only
// what a human (or the /jobs/match prompt) actually uses.
function normalizeListing(raw = {}) {
  return {
    id: String(raw.id || ""),
    title: String(raw.title || "").trim(),
    company: raw.company?.display_name || "",
    location: raw.location?.display_name || "",
    description: stripHtml(raw.description),
    url: raw.redirect_url || "",
    createdAt: raw.created || "",
    salaryMin: raw.salary_min ?? null,
    salaryMax: raw.salary_max ?? null,
  };
}

function createAdzunaClient(options = {}) {
  const appId = options.appId ?? process.env.ADZUNA_APP_ID ?? "";
  const appKey = options.appKey ?? process.env.ADZUNA_APP_KEY ?? "";
  const country = options.country || process.env.ADZUNA_COUNTRY || DEFAULT_COUNTRY;
  const baseUrl = options.baseUrl || process.env.ADZUNA_BASE_URL || DEFAULT_BASE_URL;
  const cacheMs = Number(
    options.cacheMs ?? process.env.ADZUNA_CACHE_MS ?? DEFAULT_CACHE_MS,
  );
  const now = options.now || Date.now;
  const fetchJson = options.fetchJson || fetchJsonWithHttps;
  const cache = new Map();

  async function searchJobs({ what, where, page, resultsPerPage } = {}) {
    if (!appId || !appKey) {
      throw new Error("Adzuna API credentials are not configured");
    }
    const cleanWhat = String(what || "").trim();
    if (!cleanWhat) {
      throw new Error("what (search keywords) is required");
    }
    const cleanWhere = String(where || "").trim();
    const cleanPage = clampPage(page);
    const cleanResultsPerPage = clampResultsPerPage(resultsPerPage);

    const cacheKey = `${cleanWhat.toLowerCase()}|${cleanWhere.toLowerCase()}|${cleanPage}|${cleanResultsPerPage}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.createdAt < cacheMs) {
      return cached.value;
    }

    const url = new URL(`${baseUrl}/${country}/search/${cleanPage}`);
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("results_per_page", String(cleanResultsPerPage));
    url.searchParams.set("what", cleanWhat);
    if (cleanWhere) {
      url.searchParams.set("where", cleanWhere);
    }
    url.searchParams.set("content-type", "application/json");

    const data = await fetchJson(url);
    const listings = Array.isArray(data?.results) ? data.results.map(normalizeListing) : [];
    const result = { count: Number(data?.count) || listings.length, listings };

    cache.set(cacheKey, { createdAt: now(), value: result });
    return result;
  }

  return {
    searchJobs,
    isConfigured: Boolean(appId && appKey),
    country,
  };
}

module.exports = {
  createAdzunaClient,
  normalizeListing,
};

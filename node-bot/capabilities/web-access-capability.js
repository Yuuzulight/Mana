const {
  ValidationError,
  optionalInteger,
  requireString,
  sendValidationError,
} = require("../request-validation");
const {
  fetchPage: defaultFetchPage,
  getSearxngUrl,
  isWebAccessEnabled,
  searchWeb: defaultSearchWeb,
  wikiLookup: defaultWikiLookup,
} = require("../tools/web-access");

const KEY = "webAccess";

function registerWebAccessRoutes(app, context = {}) {
  const searchWeb = context.searchWeb || defaultSearchWeb;
  const fetchPage = context.fetchPage || defaultFetchPage;
  const wikiLookup = context.wikiLookup || defaultWikiLookup;

  app.post("/web/search", async (req, res) => {
    try {
      const query = requireString(req.body?.query, "query");
      const limit = optionalInteger(req.body?.limit, "limit", {
        min: 1,
        max: 10,
        defaultValue: 5,
      });
      const results = await searchWeb(query, { limit });
      return res.json({ query, results });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/web/read", async (req, res) => {
    try {
      const url = requireString(req.body?.url, "url");
      const page = await fetchPage(url);
      return res.json(page);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/wiki/:term", async (req, res) => {
    try {
      const term = requireString(req.params?.term, "term");
      const entry = await wikiLookup(term);
      if (!entry) {
        return res.status(404).json({ error: "no matching Wikipedia page" });
      }
      return res.json(entry);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

async function checkSearxngHealth() {
  const base = getSearxngUrl();
  try {
    const resp = await fetch(base + "/", { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

const webAccessCapability = {
  key: KEY,
  registerRoutes: registerWebAccessRoutes,
  getHealth: () => ({
    status: isWebAccessEnabled() ? "configured" : "disabled",
    configured: isWebAccessEnabled(),
    message: isWebAccessEnabled()
      ? "Web search, wiki lookups, and page reads are enabled. Search needs local SearXNG running; wiki and page reads only need internet."
      : "Web access is disabled (MANA_WEB_ACCESS_ENABLED=0).",
    searxngUrl: getSearxngUrl(),
  }),
  checkSearxngHealth,
};

module.exports = {
  registerWebAccessRoutes,
  webAccessCapability,
};

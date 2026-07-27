const fs = require("fs");
const { createBrowserSession } = require("./browser-automation");

// Windows ships Edge (Chromium-based) on every install -- since Mana
// targets Windows, this is the "already available" browser rather than
// asking the user to separately install one. MANA_BROWSER_EXECUTABLE_PATH
// overrides this (e.g. to point at Chrome, or a `playwright install
// chromium`-downloaded browser) for anyone who wants something else.
const DEFAULT_EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function resolveExecutablePath(env, fsLike = fs) {
  if (env.MANA_BROWSER_EXECUTABLE_PATH) {
    return env.MANA_BROWSER_EXECUTABLE_PATH;
  }
  return DEFAULT_EDGE_PATHS.find((p) => fsLike.existsSync(p)) || null;
}

// Module-level singleton -- one ongoing browser session shared across
// requests (navigate/click/type/snapshot are steps in the same flow, not
// independent one-shot calls), same pattern as cron-scheduler's scheduler
// singleton.
let session = null;
let browserHandle = null;

async function getSession(deps) {
  if (session) return session;

  const env = deps.env || process.env;
  const executablePath = resolveExecutablePath(env);
  if (!executablePath) {
    throw new Error(
      "no browser executable found -- set MANA_BROWSER_EXECUTABLE_PATH, or install Edge/Chrome",
    );
  }

  const chromium = deps.chromium || require("playwright-core").chromium;
  const headless = env.MANA_BROWSER_HEADLESS !== "0";
  browserHandle = await chromium.launch({ executablePath, headless });
  const page = await browserHandle.newPage();
  session = createBrowserSession({ page });
  return session;
}

async function closeSession() {
  if (browserHandle) {
    await browserHandle.close().catch(() => {});
  }
  browserHandle = null;
  session = null;
}

function registerBrowserAutomationRoutes(app, deps = {}) {
  const isLocalRequest = deps.isLocalRestartRequest || (() => true);

  function requireLocal(req, res) {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: "this endpoint is only available from this PC" });
      return false;
    }
    return true;
  }

  app.post("/browser/navigate", async (req, res) => {
    if (!requireLocal(req, res)) return;
    try {
      const browserSession = await getSession(deps);
      const result = await browserSession.navigate(req.body?.url);
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/browser/snapshot", async (req, res) => {
    if (!requireLocal(req, res)) return;
    try {
      const browserSession = await getSession(deps);
      const result = await browserSession.snapshot();
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/browser/click", async (req, res) => {
    if (!requireLocal(req, res)) return;
    try {
      const browserSession = await getSession(deps);
      const result = await browserSession.click(req.body?.ref);
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/browser/type", async (req, res) => {
    if (!requireLocal(req, res)) return;
    try {
      const browserSession = await getSession(deps);
      const result = await browserSession.type(req.body?.ref, req.body?.text);
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/browser/close", async (req, res) => {
    if (!requireLocal(req, res)) return;
    await closeSession();
    return res.json({ ok: true });
  });
}

module.exports = {
  key: "browserAutomation",
  name: "Browser Automation",
  category: "Web",
  defaultEnabled: false,
  description:
    "Navigate/click/type/read a live page via a local Chromium-family browser (Edge by default on Windows) -- for driving a specific site interaction, not general search-and-extract (see web-access.js for that). Local-only routes.",
  registerRoutes: registerBrowserAutomationRoutes,
  getHealth: (deps = {}) => {
    const env = deps.env || process.env;
    const executablePath = resolveExecutablePath(env);
    return {
      status: executablePath ? "configured" : "unavailable",
      configured: Boolean(executablePath),
      message: executablePath
        ? `Browser automation ready (${executablePath})`
        : "No browser executable found -- set MANA_BROWSER_EXECUTABLE_PATH, or install Edge/Chrome",
    };
  },
  resolveExecutablePath,
  // Test-only escape hatch to reset the module-level singleton between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    session = null;
    browserHandle = null;
  },
};

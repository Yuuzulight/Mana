const fs = require("fs");
const path = require("path");
const { createBrowserSession } = require("./browser-automation");
const { refuseIfLocalOnly } = require("../../node-bot/local-only");
const { systemRamPercent, MAX_RAM_PERCENT } = require("../../node-bot/self-work");

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
//
// #1137: a persistent Edge profile of Mana's own, so a site I log in to
// once stays logged in; started on her first browser call, one page, no
// GPU, and closed again when idle, when a game starts or when RAM is high.
const PROFILE_DIR = path.join(__dirname, "..", "..", "node-bot", "data", "browser-profile");
const LAUNCH_ARGS = ["--disable-gpu", "--renderer-process-limit=1"];
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const CHECK_EVERY_MS = 30 * 1000;

let session = null;
let context = null;
let starting = null;
let closing = null;
let checkTimer = null;
let lastUsedAt = 0;
// The latest caller's deps: the game/RAM gates, the clock, and whether
// the rail's Browser panel is watching.
let gateDeps = {};

// Why her browser mustn't run right now, or null -- self-work's gates.
function blocker(deps) {
  if (deps.isGaming?.()) return "a game is running";
  const ram = (deps.ramPercent || systemRamPercent)();
  return ram > MAX_RAM_PERCENT ? `RAM is at ${ram}%` : null;
}

async function getSession(deps = {}) {
  gateDeps = deps;
  const blocked = blocker(deps);
  if (blocked) {
    await closeSession();
    throw new Error(`the browser stays closed while ${blocked}`);
  }
  lastUsedAt = (deps.now || Date.now)();
  if (session) return session;
  starting = starting || startSession(deps).finally(() => (starting = null));
  return starting;
}

async function startSession(deps) {
  const env = deps.env || process.env;
  // #670: the browser is its own program, outside node-bot's connection
  // guard, and any page can pull from the internet.
  refuseIfLocalOnly("browser automation", env);
  const executablePath = resolveExecutablePath(env);
  if (!executablePath) {
    throw new Error(
      "no browser executable found -- set MANA_BROWSER_EXECUTABLE_PATH, or install Edge/Chrome",
    );
  }

  // playwright-core lives in node-bot's packages; a bare require from this
  // folder never found it.
  const chromium = deps.chromium || require("../../node-bot/node_modules/playwright-core").chromium;
  const headless = env.MANA_BROWSER_HEADLESS !== "0";
  // A profile is locked while any browser has it open.
  await closing;
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath, headless, args: LAUNCH_ARGS });
  // Edge went away under us (crashed, killed): start fresh next call.
  ctx.on("close", () => context === ctx && forget());
  let page;
  try {
    page = ctx.pages()[0] || (await ctx.newPage());
    // Images, video and fonts only while the rail's Browser panel is
    // watching, for its screenshot; she reads and acts without them.
    await page.route("**/*", (route) =>
      BLOCKED_RESOURCE_TYPES.has(route.request().resourceType()) && !gateDeps.isWatched?.()
        ? route.abort()
        : route.continue(),
    );
  } catch (e) {
    await ctx.close().catch(() => {});
    throw e;
  }
  context = ctx;
  session = createBrowserSession({ page });
  checkTimer = setInterval(checkSession, CHECK_EVERY_MS);
  checkTimer.unref?.();
  return session;
}

// Closes her browser after IDLE_CLOSE_MS without a call, and at once when
// a game starts or RAM climbs past the limit.
async function checkSession() {
  if (!session) return;
  const idle = (gateDeps.now || Date.now)() - lastUsedAt >= IDLE_CLOSE_MS;
  if (idle || blocker(gateDeps)) await closeSession();
}

function forget() {
  clearInterval(checkTimer);
  checkTimer = null;
  context = null;
  session = null;
}

async function closeSession() {
  if (starting) await starting.catch(() => {});
  const ctx = context;
  forget();
  if (ctx) {
    closing = ctx.close().catch(() => {});
    await closing;
  }
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
  // Issue #188: exported so the tool-calling adapter
  // (browser-automation-tool-source.js) shares this exact singleton
  // session -- a tool-calling-initiated action and an HTTP-route-initiated
  // one operate on the same live browser tab, not two Chromium instances.
  getSession,
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
  checkSession,
  closeSession,
  PROFILE_DIR,
  IDLE_CLOSE_MS,
  // Test-only escape hatch to reset the module-level singleton between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    forget();
    starting = null;
    closing = null;
    gateDeps = {};
  },
};

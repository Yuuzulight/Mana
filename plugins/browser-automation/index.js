const fs = require("fs");
const path = require("path");
const { createBrowserSession } = require("./browser-automation");
const { isAdHost } = require("./ad-hosts");
const { refuseIfLocalOnly } = require("../../node-bot/local-only");
const { systemRamPercent, MAX_RAM_PERCENT } = require("../../node-bot/self-work");
const trayNotifier = require("../../node-bot/tray-notifier");
const { isCredentialPath, trimEnd } = require("../../node-bot/ai/tool-policy");

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
// #1159: tabs she may have open at once (MANA_BROWSER_MAX_TABS, 1 to 5).
const DEFAULT_MAX_TABS = 3;
const SESSION_METHODS = ["navigate", "click", "type", "select", "scroll", "hover", "press", "drag", "back", "find", "snapshot", "lookAndClick", "devtools"];
const CHECK_EVERY_MS = 30 * 1000;
// #1161: console messages and requests kept per page.
const MAX_LOG = 100;
// #1158: how long a file I point her to stays hers to upload.
const OFFER_MS = 30 * 60 * 1000;
// Resolved, lower-cased path -> until when she may upload it.
const offered = new Map();

let session = null;
let context = null;
// #1159: her open tabs ([{ page, session }]) and which one she's on.
let tabs = [];
let current = 0;
let starting = null;
let closing = null;
let checkTimer = null;
let lastUsedAt = 0;
// The latest caller's deps: the game/RAM gates, the clock, and whether
// the rail's Browser panel is watching.
let gateDeps = {};
// #1139: while I've taken over, the visible Edge window on her profile;
// where she picks up after Done; and why she asked me to take over.
let takenOver = null;
let opening = false;
let resumeUrl = null;
let needsYou = null;
// #1161: a site test loads images whether or not the panel watches.
let loadMedia = false;
let epoch = 0;
const agentActions = new Set();
let personalBrowser = null;
let personalRequest = null;
function runAgent(action) {
  const running = Promise.resolve().then(action);
  agentActions.add(running);
  return running.finally(() => agentActions.delete(running));
}
const manualControl = require('./manual-control').createManualControl({
  getContext: () => personalBrowser?.getContext() || context,
  getPage: () => personalBrowser?.getPage() || currentPage(),
  touch: () => { lastUsedAt = (gateDeps.now || Date.now)(); },
  async prepare(deps, fallbackUrl) {
    if (takenOver || opening) throw new Error('Browser control is already changing');
    opening = true;
    epoch += 1;
    try {
      await Promise.allSettled([...agentActions]);
      if (personalBrowser) {
        await personalBrowser.getSession({ ...deps, sessionId: personalBrowser.sessionId });
        needsYou = null;
        return;
      }
      if (starting) await starting;
      if (!context) {
        starting ||= startSession({ ...deps, env: { ...(deps.env || process.env), MANA_BROWSER_HEADLESS: '1' } }).finally(() => { starting = null; });
        await starting;
      }
      gateDeps = deps;
      lastUsedAt = (deps.now || Date.now)();
      if (/^https?:/i.test(fallbackUrl || '') && currentPage().url() === 'about:blank') await currentPage().goto(fallbackUrl);
      needsYou = null;
    } finally { opening = false; }
  },
  async resume() {
    epoch += 1;
    personalBrowser?.invalidate();
    lastUsedAt = (gateDeps.now || Date.now)();
    if (context) session = tabbedSession(gateDeps);
  },
});

// Why her browser mustn't run right now, or null -- self-work's gates.
function blocker(deps) {
  if (deps.isGaming?.()) return "a game is running";
  const ram = (deps.ramPercent || systemRamPercent)();
  return ram > MAX_RAM_PERCENT ? `RAM is at ${ram}%` : null;
}

async function getSession(deps = {}) {
  gateDeps = deps;
  if (takenOver || opening || manualControl.isActive()) throw new Error("the user has the browser right now; wait until they press Done");
  if (personalBrowser) {
    if (personalBrowser.isClosed()) {
      const ended = personalBrowser;
      personalBrowser = null;
      await ended.close();
      throw new Error('Your personal-browser connection ended. Reconnect it or use the dedicated Mana browser');
    }
    refuseIfLocalOnly('browser automation', deps.env || process.env);
    return personalBrowser.getSession(deps);
  }
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

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

// Mana's profile in installed Edge: headless for her, visible for me.
async function launch(deps, options) {
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
  // A profile is locked while any browser has it open.
  await closing;
  const profileDir = env.MANA_BROWSER_PROFILE_DIR || PROFILE_DIR;
  if (!path.isAbsolute(profileDir)) throw new Error("MANA_BROWSER_PROFILE_DIR must be an absolute path");
  return chromium.launchPersistentContext(profileDir, { executablePath, args: LAUNCH_ARGS, ...options });
}

// One tab: its page, with the resource blocking and health counters, and
// the session that reads and acts on it.
async function setUpTab(page) {
  const health = { blockedAds: 0 };
  // #1161: the current page's console and network, for her dev tools.
  const log = { console: [], network: [] };
  // Requests we abort ourselves (ads, media) aren't the site's failures.
  const aborted = new WeakSet();
  // #1168: what the current page lost to ad blocking.
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    health.blockedAds = 0;
    log.console = [];
    log.network = [];
  });
  const keep = (list, entry) => list.push(entry) > MAX_LOG && list.shift();
  page.on("console", (message) => keep(log.console, { type: message.type(), text: String(message.text()).slice(0, 500) }));
  page.on("pageerror", (error) => keep(log.console, { type: "error", text: String(error?.message || error).slice(0, 500) }));
  page.on("requestfinished", async (request) => {
    const response = await request.response().catch(() => null);
    keep(log.network, { method: request.method(), url: request.url(), status: response?.status() ?? null, ms: Math.round(request.timing()?.responseEnd ?? -1) });
  });
  page.on("requestfailed", (request) => {
    if (aborted.has(request)) return;
    keep(log.network, { method: request.method(), url: request.url(), failure: request.failure()?.errorText || "failed" });
  });
  // #1158: a download waits for my OK (the tool source); from anywhere
  // else (the HTTP routes) it's dropped.
  page.on("download", (download) => {
    Promise.resolve(gateDeps.onDownload ? gateDeps.onDownload(download) : download.cancel()).catch(() => {});
  });
  // Images, video and fonts only while the rail's Browser panel is
  // watching, for its screenshot; she reads and acts without them. Ad
  // and tracker domains never (#1168).
  await page.route("**/*", (route) => {
    const request = route.request();
    if (isAdHost(hostOf(request.url()))) {
      health.blockedAds += 1;
      aborted.add(request);
      return route.abort();
    }
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType()) && !manualControl.isActive() && !gateDeps.isWatched?.() && !loadMedia) {
      aborted.add(request);
      return route.abort();
    }
    return route.continue();
  });
  // #704: her cursor shows while I'm watching: the Browser panel, or her
  // window (MANA_BROWSER_HEADLESS=0). Take over closes this page, so my
  // window never has it.
  const cursor = () => Boolean(gateDeps.isWatched?.()) || (gateDeps.env || process.env).MANA_BROWSER_HEADLESS === "0";
  return { page, session: createBrowserSession({ page, pageHealth: () => ({ ...health }), pageLog: () => log, cursor }) };
}

async function startSession(deps) {
  const env = deps.env || process.env;
  const ctx = await launch(deps, { headless: env.MANA_BROWSER_HEADLESS !== "0" });
  // Edge went away under us (crashed, killed): start fresh next call.
  ctx.on("close", () => context === ctx && forget());
  let tab;
  try {
    tab = await setUpTab(ctx.pages()[0] || (await ctx.newPage()));
    // #1139: after I hand back, she carries on where I left off.
    if (resumeUrl) await tab.page.goto(resumeUrl).catch(() => {});
    resumeUrl = null;
  } catch (e) {
    await ctx.close().catch(() => {});
    throw e;
  }
  context = ctx;
  tabs = [tab];
  current = 0;
  session = tabbedSession(deps);
  checkTimer = setInterval(checkSession, CHECK_EVERY_MS);
  checkTimer.unref?.();
  return session;
}

const currentPage = () => tabs[current]?.page || null;

// #1159: what the tools call -- every page action on the tab she's on,
// each result listing her tabs once there's more than one, plus
// tab({ do: "open" | "switch" | "close" }).
function tabbedSession(deps) {
  const owner = context;
  const generation = epoch;
  const env = deps.env || process.env;
  const maxTabs = Math.min(5, Math.max(1, Math.floor(Number(env.MANA_BROWSER_MAX_TABS)) || DEFAULT_MAX_TABS));

  async function withTabs(result) {
    if (tabs.length < 2) return result;
    const list = await Promise.all(tabs.map(async (t, i) => `${i + 1}. ${await t.page.title()} -- ${await t.page.url()}${i === current ? " (current)" : ""}`));
    return { ...result, tabs: list };
  }

  function tabNumber(number) {
    const n = Number(number);
    if (!Number.isInteger(n) || n < 1 || n > tabs.length) throw new Error(`there's no tab ${number}; she has ${tabs.length}`);
    return n - 1;
  }

  async function open(url) {
    if (tabs.length >= maxTabs) throw new Error(`${tabs.length} tabs are open, the most she may have; close one first`);
    // The RAM gate applies to every tab she adds.
    const blocked = blocker(gateDeps);
    if (blocked) throw new Error(`no new tab while ${blocked}`);
    const tab = await setUpTab(await context.newPage());
    try {
      const result = await tab.session.navigate(url);
      tabs.push(tab);
      current = tabs.length - 1;
      return withTabs(result);
    } catch (e) {
      await tab.page.close().catch(() => {});
      throw e;
    }
  }

  async function close(number) {
    const i = tabNumber(number);
    if (tabs.length === 1) throw new Error("that's her only tab");
    const [tab] = tabs.splice(i, 1);
    if (current > i || current === tabs.length) current -= 1;
    await tab.page.close().catch(() => {});
    return withTabs(await tabs[current].session.snapshot());
  }

  async function tab(args = {}) {
    if (args.do === "open") return open(args.url);
    if (args.do === "switch") {
      current = tabNumber(args.number);
      return withTabs(await tabs[current].session.snapshot());
    }
    if (args.do === "close") return close(args.number);
    throw new Error('do must be "open", "switch" or "close"');
  }

  // #1158: only a file I pointed her to.
  async function upload(ref, file) {
    if (!isOffered(file)) {
      throw new Error("she can only upload a file the user pointed her to (the Browser panel's \"Give her a file\", or its full path in their message)");
    }
    return withTabs(await tabs[current].session.upload(ref, path.resolve(String(file))));
  }

  // #1161: a site test sees the pages as I would, images included.
  async function testPage(url, sizes) {
    loadMedia = true;
    try {
      return await tabs[current].session.testPage(url, sizes);
    } finally {
      loadMedia = false;
    }
  }

  const facade = { tab, upload, testPage, screenshot: () => tabs[current].session.screenshot(), url: () => currentPage().url() };
  for (const name of SESSION_METHODS) {
    facade[name] = async (...args) => withTabs(await tabs[current].session[name](...args));
  }
  // A caller may retain this handle across Take over, idle close or a crash.
  for (const [name, run] of Object.entries(facade)) {
    facade[name] = async (...args) => {
      if (takenOver || opening || manualControl.isActive()) throw new Error("the user has the browser right now; wait until they press Done");
      if (context !== owner || !session || epoch !== generation) throw new Error("this browser session has closed; obtain a fresh session");
      const blocked = blocker(gateDeps);
      if (blocked) {
        await closeSession();
        throw new Error(`the browser stays closed while ${blocked}`);
      }
      lastUsedAt = (gateDeps.now || Date.now)();
      const action = Promise.resolve().then(() => run(...args));
      agentActions.add(action);
      try { return await action; }
      finally { agentActions.delete(action); }
    };
  }
  return facade;
}

// #1158: files I point her to -- from the Browser panel's picker, or full
// paths in my own chat message -- are the only ones she may upload, for
// OFFER_MS. Returns the ones that exist and aren't secrets.
function offerFiles(paths, now = Date.now()) {
  const added = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const full = path.resolve(String(p));
    // Keys and secrets (.env, id_rsa, *.pem...) never, even if I name them.
    if (isCredentialPath(path.basename(full))) continue;
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch (e) {
      continue;
    }
    offered.set(full.toLowerCase(), now + OFFER_MS);
    added.push(full);
  }
  return added;
}

function isOffered(file, now = Date.now()) {
  return (offered.get(path.resolve(String(file || "")).toLowerCase()) || 0) > now;
}

// Full paths in a message: "C:\with spaces\a.pdf" in quotes, or
// C:\no\spaces.pdf (or /no/spaces.pdf) without.
function pathsIn(text) {
  // #1204: Windows (C:\...) or POSIX (/...) -- whichever the backend runs
  // on; only files that exist are offered, so the other kind finds nothing.
  const quoted = [...String(text || "").matchAll(/"((?:[a-zA-Z]:\\|\/)[^"\n]+)"/g)].map((m) => m[1]);
  const bare = [...String(text || "").matchAll(/(?:^|\s)((?:[a-zA-Z]:\\|\/)[^\s"'<>|?*]+)/g)].map((m) => trimEnd(m[1], (c) => ".,;:!)".includes(c)));
  return [...quoted, ...bare];
}

function offerFilesFromMessage(text) {
  return offerFiles(pathsIn(text));
}

// #1159: when her task (the reply) ends, only the tab she's on stays --
// popups a site opened by itself go too.
async function closeExtraTabs() {
  if (personalBrowser) return;
  if (manualControl.isActive() || opening) return;
  if (!tabs.length) return;
  const keep = tabs[current];
  const extra = new Set([...tabs.map((t) => t.page), ...(context?.pages?.() || [])]);
  extra.delete(keep.page);
  tabs = [keep];
  current = 0;
  await Promise.all([...extra].map((page) => page.close().catch(() => {})));
}

// #1139: Chromium can't turn a headless session visible, so Take over
// closes hers and opens the same profile as a normal Edge window at her
// page (or fallbackUrl, the page the Browser panel shows). I do the login,
// CAPTCHA or payment there myself; nothing I type goes to the model. Not
// gated on games or RAM: I asked for it.
async function takeOver(deps = {}, fallbackUrl = null) {
  if (manualControl.isActive()) throw new Error('Use Done in the Browser panel to hand back manual control');
  if (takenOver || opening) return;
  opening = true;
  try {
    let url = currentPage() ? await currentPage().url() : null;
    if (!/^https?:/i.test(url || "")) url = /^https?:/i.test(fallbackUrl || "") ? fallbackUrl : null;
    await closeSession();
    // No viewport emulation (the page fits the window), and no "controlled
    // by automated software" flag, which some sign-in pages refuse.
    const ctx = await launch(deps, { headless: false, viewport: null, ignoreDefaultArgs: ["--enable-automation"] });
    takenOver = ctx;
    needsYou = null;
    resumeUrl = url;
    // Closing the window myself counts as Done.
    ctx.on("close", () => takenOver === ctx && (takenOver = null));
    const page = ctx.pages()[0] || (await ctx.newPage());
    if (url) await page.goto(url).catch(() => {});
  } finally {
    opening = false;
  }
}

// Done: the window closes; her next call reopens the profile headless (my
// login kept) at the page I finished on.
async function handBack() {
  const ctx = takenOver;
  if (!ctx) return;
  const page = ctx.pages()[0];
  if (page && /^https?:/i.test(await page.url())) resumeUrl = await page.url();
  takenOver = null;
  closing = ctx.close().catch(() => {});
  await closing;
}

// #1169: a new request also pops a toast with Take over (the launcher's
// tray feed), except while a game runs: then it just waits in the panel.
// She never opens the window herself.
function requestHandOver(reason, deps = gateDeps) {
  const text = String(reason || "she needs you").slice(0, 200);
  if (text === needsYou || takenOver) return;
  needsYou = text;
  if (deps.isGaming?.()) return;
  (deps.notifyTray || trayNotifier.notifyTray)({ type: "browser-hand-over", title: "Mana needs you in her browser", text }).catch?.(() => {});
}

function takeOverStatus() {
  return { active: Boolean(takenOver || opening || manualControl.isActive()), ...(manualControl.isActive() ? { embedded: true } : {}), needsYou };
}

// Closes her browser after IDLE_CLOSE_MS without a call, and at once when
// a game starts or RAM climbs past the limit.
async function checkSession() {
  if (!session) return;
  const idle = (gateDeps.now || Date.now)() - lastUsedAt >= IDLE_CLOSE_MS;
  if (idle || blocker(gateDeps)) await closeSession();
}

function forget() {
  manualControl.clear();
  epoch += 1;
  clearInterval(checkTimer);
  checkTimer = null;
  context = null;
  tabs = [];
  current = 0;
  session = null;
}

async function closeSession(startRequest = null) {
  if (personalRequest && personalRequest !== startRequest) personalRequest.cancelled = true;
  if (personalBrowser) {
    const ended = personalBrowser;
    personalBrowser = null;
    manualControl.clear();
    await ended.close();
  }
  const manualWindow = takenOver;
  takenOver = null;
  if (manualWindow) await manualWindow.close().catch(() => {});
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
    needsYou = null;
    await closeSession();
    return res.json({ ok: true });
  });

  // #1139: the Browser panel's Take over and Done.
  const checkAdminAuth = deps.checkAdminAuth || (() => true);

  // #1158: the Browser panel's "Give her a file".
  app.post("/browser/offer-files", (req, res) => {
    if (!requireLocal(req, res) || !checkAdminAuth(req, res)) return;
    return res.json({ offered: offerFiles(req.body?.paths) });
  });
  app.post("/browser/take-over", async (req, res) => {
    if (!requireLocal(req, res) || !checkAdminAuth(req, res)) return;
    try {
      await takeOver(deps, req.body?.url);
      return res.json(takeOverStatus());
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/browser/hand-back", async (req, res) => {
    if (!requireLocal(req, res) || !checkAdminAuth(req, res)) return;
    await handBack();
    return res.json(takeOverStatus());
  });

  app.post('/browser/manual/start', async (req, res) => {
    if (!requireLocal(req, res) || !checkAdminAuth(req, res)) return;
    try { res.json(await manualControl.takeOver(deps, req.body?.url)); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/browser/personal/start', async (req, res) => {
    if (!requireLocal(req, res) || !checkAdminAuth(req, res)) return;
    let ticket = null;
    try {
      refuseIfLocalOnly('personal browser', deps.env || process.env);
      if (opening || manualControl.isActive()) throw new Error('Finish manual browser control before connecting Chrome');
      if (typeof req.body?.sessionId !== 'string' || !req.body.sessionId.trim()) throw new Error('Choose a chat before connecting Chrome');
      opening = true;
      ticket = { cancelled: false };
      personalRequest = ticket;
      epoch += 1;
      await Promise.allSettled([...agentActions]);
      await closeSession(ticket);
      const chromium = deps.chromium || require('../../node-bot/node_modules/playwright-core').chromium;
      const candidate = await require('./personal-browser').createPersonalBrowser({
        sessionId: req.body.sessionId, origins: req.body.origins || [], chromium, runAgent,
        isPaused: () => opening || manualControl.isActive(),
      });
      if (ticket.cancelled) { await candidate.close(); throw new Error('Personal-browser connection was cancelled'); }
      personalBrowser = candidate;
      res.json({ connectionCode: personalBrowser.connectionCode });
    } catch (error) { res.status(400).json({ error: error.message }); }
    finally { if (ticket && personalRequest === ticket) { personalRequest = null; opening = false; } }
  });
  app.get('/browser/personal/status', (req, res) => {
    if (!requireLocal(req, res) || !checkAdminAuth(req, res)) return;
    res.json({ connected: Boolean(personalBrowser?.isConnected()), sessionId: personalBrowser?.sessionId || null });
  });
  for (const [method, url, run] of [
    ['get', '/browser/manual/frame', req => manualControl.frame(req.get('x-mana-manual-token'))],
    ['post', '/browser/manual/input', req => manualControl.input(req.get('x-mana-manual-token'), req.body)],
    ['post', '/browser/manual/done', req => manualControl.handBack(req.get('x-mana-manual-token'))],
  ]) {
    app[method](url, async (req, res) => {
      if (!requireLocal(req, res) || !checkAdminAuth(req, res)) return;
      try { res.json(await run(req)); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
  }
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
  closeExtraTabs,
  offerFiles,
  offerFilesFromMessage,
  pathsIn,
  takeOver,
  handBack,
  requestHandOver,
  takeOverStatus,
  PROFILE_DIR,
  IDLE_CLOSE_MS,
  // Test-only escape hatch to reset the module-level singleton between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    const ended = personalBrowser;
    personalBrowser = null;
    if (ended) void ended.close().catch(() => {});
    forget();
    starting = null;
    closing = null;
    gateDeps = {};
    takenOver = null;
    opening = false;
    offered.clear();
    loadMedia = false;
    resumeUrl = null;
    needsYou = null;
  },
};

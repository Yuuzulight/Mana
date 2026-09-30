const assert = require("node:assert/strict");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const browserAutomationPlugin = require("../index");
const { extractTextInPage } = require("../browser-automation");

async function withServer(app, fn) {
  const http = require("node:http");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json();
  return { response, payload };
}

function buildApp(deps) {
  browserAutomationPlugin._resetForTests();
  const app = express();
  app.use(express.json());
  browserAutomationPlugin.registerRoutes(app, deps);
  return app;
}

test("resolveExecutablePath prefers MANA_BROWSER_EXECUTABLE_PATH over the Edge default", () => {
  const path = browserAutomationPlugin.resolveExecutablePath(
    { MANA_BROWSER_EXECUTABLE_PATH: "C:\\custom\\chrome.exe" },
    { existsSync: () => true },
  );
  assert.equal(path, "C:\\custom\\chrome.exe");
});

test("resolveExecutablePath falls back to a detected Edge install, or null if none exists", () => {
  const found = browserAutomationPlugin.resolveExecutablePath({}, { existsSync: () => true });
  assert.match(found, /msedge\.exe$/);

  const notFound = browserAutomationPlugin.resolveExecutablePath({}, { existsSync: () => false });
  assert.equal(notFound, null);
});

test("every route rejects a non-loopback forwarded request without touching the browser", async () => {
  let sessionCalls = 0;
  const app = buildApp({
    isLocalRestartRequest: () => false,
    chromium: { launchPersistentContext: async () => { sessionCalls += 1; return {}; } },
  });

  await withServer(app, async (baseUrl) => {
    for (const route of ["navigate", "snapshot", "click", "type", "close"]) {
      const { response, payload } = await postJson(`${baseUrl}/browser/${route}`, {
        url: "https://example.com",
      });
      assert.equal(response.status, 403, `${route} should reject`);
      assert.deepEqual(payload, { error: "this endpoint is only available from this PC" });
    }
  });
  assert.equal(sessionCalls, 0);
});

test("POST /browser/navigate surfaces a clear error when no browser executable is configured", async () => {
  const app = buildApp({
    isLocalRestartRequest: () => true,
    env: { MANA_BROWSER_EXECUTABLE_PATH: "" },
    ramPercent: () => 50,
  });
  // Force "not found" by pointing at a path that can't exist.
  const originalExists = require("fs").existsSync;
  require("fs").existsSync = () => false;
  try {
    await withServer(app, async (baseUrl) => {
      const { response, payload } = await postJson(`${baseUrl}/browser/navigate`, {
        url: "https://example.com",
      });
      assert.equal(response.status, 400);
      assert.match(payload.error, /no browser executable found/);
    });
  } finally {
    require("fs").existsSync = originalExists;
  }
});

// A fake playwright-core chromium: launchPersistentContext() gives a
// context holding one page, which records its route handler.
function createFakeChromium(pageOverrides = {}) {
  const launches = [];
  let closeListener = null;
  const page = {
    routeHandler: null,
    listeners: {},
    on(event, fn) { this.listeners[event] = fn; },
    mainFrame() { return "main"; },
    async route(pattern, handler) { this.routeHandler = handler; },
    async goto(url) { this._url = url; },
    async ariaSnapshot() { return '- button "Go" [ref=e1]'; },
    async evaluate(fn) {
      if (fn === extractTextInPage) return "page text";
      if (fn.name === "sensitiveInPage") return null;
      throw new Error("unexpected evaluate() call in test");
    },
    async title() { return "Example"; },
    async url() { return this._url; },
    ...pageOverrides,
  };
  const context = {
    closed: 0,
    pages: () => [page],
    newPage: async () => { throw new Error("the persistent context already has a page"); },
    on: (event, fn) => { if (event === "close") closeListener = fn; },
    async close() { this.closed += 1; closeListener?.(); },
  };
  const chromium = {
    async launchPersistentContext(dir, options) {
      launches.push({ dir, options });
      return context;
    },
  };
  return { chromium, launches, context, page };
}

const FAKE_ENV = { MANA_BROWSER_EXECUTABLE_PATH: "C:\\fake\\msedge.exe" };

test("POST /browser/navigate drives an injected fake chromium/page end to end", async () => {
  const { chromium } = createFakeChromium();
  const app = buildApp({
    isLocalRestartRequest: () => true,
    env: FAKE_ENV,
    chromium,
    ramPercent: () => 50,
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/browser/navigate`, {
      url: "https://example.com",
    });
    assert.equal(response.status, 200);
    assert.equal(payload.title, "Example");
    assert.equal(payload.text, "page text");
    assert.deepEqual(payload.elements, ['button "Go" [ref=e1]']);
  });
});

test("#1137: Edge starts lazily, once, on Mana's own profile with no GPU and one renderer", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, launches } = createFakeChromium();
  const deps = { env: FAKE_ENV, chromium, ramPercent: () => 50 };
  assert.equal(launches.length, 0);

  // Two first calls at once still launch one browser.
  const [a, b] = await Promise.all([browserAutomationPlugin.getSession(deps), browserAutomationPlugin.getSession(deps)]);
  assert.equal(a, b);
  assert.equal(await browserAutomationPlugin.getSession(deps), a);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].dir, browserAutomationPlugin.PROFILE_DIR);
  assert.match(launches[0].dir, /node-bot[\\/]data[\\/]browser-profile$/);
  assert.deepEqual(launches[0].options, {
    executablePath: "C:\\fake\\msedge.exe",
    headless: true,
    args: ["--disable-gpu", "--renderer-process-limit=1"],
  });
  await browserAutomationPlugin.closeSession();
});

test("#1137: images, video and fonts are blocked unless the Browser panel is watching", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, page } = createFakeChromium();
  let watched = false;
  await browserAutomationPlugin.getSession({ env: FAKE_ENV, chromium, ramPercent: () => 50, isWatched: () => watched });

  async function outcome(resourceType) {
    let result = null;
    await page.routeHandler({
      request: () => ({ resourceType: () => resourceType, url: () => "https://site.test/x" }),
      abort: async () => (result = "abort"),
      continue: async () => (result = "continue"),
    });
    return result;
  }
  for (const type of ["image", "media", "font"]) assert.equal(await outcome(type), "abort", type);
  for (const type of ["document", "script", "stylesheet", "xhr"]) assert.equal(await outcome(type), "continue", type);
  watched = true;
  assert.equal(await outcome("image"), "continue");
  await browserAutomationPlugin.closeSession();
});

test("#1137: the browser closes after 5 idle minutes and starts again on her next call", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, launches, context } = createFakeChromium();
  let now = 1_000_000;
  const deps = { env: FAKE_ENV, chromium, ramPercent: () => 50, now: () => now };
  await browserAutomationPlugin.getSession(deps);

  now += browserAutomationPlugin.IDLE_CLOSE_MS - 1;
  await browserAutomationPlugin.checkSession();
  assert.equal(context.closed, 0);

  now += 1;
  await browserAutomationPlugin.checkSession();
  assert.equal(context.closed, 1);

  await browserAutomationPlugin.getSession(deps);
  assert.equal(launches.length, 2);
  await browserAutomationPlugin.closeSession();
});

test("#1137: never starts while a game runs or RAM is above 85%, and closes at once when either starts", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, launches, context } = createFakeChromium();
  let gaming = true;
  let ram = 50;
  const deps = { env: FAKE_ENV, chromium, isGaming: () => gaming, ramPercent: () => ram };

  await assert.rejects(() => browserAutomationPlugin.getSession(deps), /closed while a game is running/);
  gaming = false;
  ram = 85.5;
  await assert.rejects(() => browserAutomationPlugin.getSession(deps), /closed while RAM is at 85.5%/);
  assert.equal(launches.length, 0);

  ram = 85;
  await browserAutomationPlugin.getSession(deps);
  assert.equal(launches.length, 1);

  gaming = true;
  await browserAutomationPlugin.checkSession();
  assert.equal(context.closed, 1);
});

test("#1137: Edge closing under her (crash) means a fresh start next call", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, launches, context } = createFakeChromium();
  const deps = { env: FAKE_ENV, chromium, ramPercent: () => 50 };
  await browserAutomationPlugin.getSession(deps);
  await context.close();
  await browserAutomationPlugin.getSession(deps);
  assert.equal(launches.length, 2);
  await browserAutomationPlugin.closeSession();
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(browserAutomationPlugin.key, "browserAutomation");
  assert.equal(browserAutomationPlugin.category, "Web");
  assert.equal(browserAutomationPlugin.defaultEnabled, false);
});

// Separate fakes for her headless Edge and my visible window, handed out
// in launch order; each records where its page went.
function createFakeEdge() {
  const launches = [];
  function makeContext(headless) {
    let closeListener = null;
    const page = {
      gone: [],
      _url: "about:blank",
      on() {},
      mainFrame() {},
      async route() {},
      async goto(url) { this.gone.push(url); this._url = url; },
      async url() { return this._url; },
    };
    return {
      headless,
      page,
      closed: 0,
      pages: () => [page],
      on: (event, fn) => { if (event === "close") closeListener = fn; },
      async close() { this.closed += 1; closeListener?.(); },
    };
  }
  const chromium = {
    async launchPersistentContext(dir, options) {
      const ctx = makeContext(options.headless);
      launches.push({ dir, options, ctx });
      return ctx;
    },
  };
  return { chromium, launches };
}

test("#1139: take over reopens her profile visibly at her page; Done hands it back headless at mine", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, launches } = createFakeEdge();
  const deps = { env: FAKE_ENV, chromium, ramPercent: () => 50 };
  await browserAutomationPlugin.getSession(deps);
  launches[0].ctx.page._url = "https://shop.test/cart";
  browserAutomationPlugin.requestHandOver("Log in to the shop");
  assert.deepEqual(browserAutomationPlugin.takeOverStatus(), { active: false, needsYou: "Log in to the shop" });

  await browserAutomationPlugin.takeOver(deps);
  assert.equal(launches[0].ctx.closed, 1);
  assert.equal(launches[1].dir, browserAutomationPlugin.PROFILE_DIR);
  assert.equal(launches[1].options.headless, false);
  assert.equal(launches[1].options.viewport, null);
  assert.deepEqual(launches[1].options.ignoreDefaultArgs, ["--enable-automation"]);
  assert.deepEqual(launches[1].ctx.page.gone, ["https://shop.test/cart"]);
  assert.deepEqual(browserAutomationPlugin.takeOverStatus(), { active: true, needsYou: null });

  // She waits while I have it, and a second click doesn't open another window.
  await assert.rejects(() => browserAutomationPlugin.getSession(deps), /the user has the browser/);
  await browserAutomationPlugin.takeOver(deps);
  assert.equal(launches.length, 2);
  // Nor does the idle check close my window.
  await browserAutomationPlugin.checkSession();
  assert.equal(launches[1].ctx.closed, 0);

  launches[1].ctx.page._url = "https://shop.test/account";
  await browserAutomationPlugin.handBack();
  assert.equal(launches[1].ctx.closed, 1);
  assert.deepEqual(browserAutomationPlugin.takeOverStatus(), { active: false, needsYou: null });

  await browserAutomationPlugin.getSession(deps);
  assert.equal(launches[2].options.headless, true);
  assert.deepEqual(launches[2].ctx.page.gone, ["https://shop.test/account"]);
  await browserAutomationPlugin.closeSession();
});

test("#1139: closing the window myself counts as Done; with no page of hers, take over opens the panel's page", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, launches } = createFakeEdge();
  const deps = { env: FAKE_ENV, chromium, ramPercent: () => 50 };
  await browserAutomationPlugin.takeOver(deps, "javascript:alert(1)");
  assert.deepEqual(launches[0].ctx.page.gone, []);
  await launches[0].ctx.close();
  assert.equal(browserAutomationPlugin.takeOverStatus().active, false);

  await browserAutomationPlugin.takeOver(deps, "https://shop.test/cart");
  assert.deepEqual(launches[1].ctx.page.gone, ["https://shop.test/cart"]);
  await browserAutomationPlugin.handBack();
});

test("#1139: the take-over and Done routes are local and admin-only", async () => {
  const { chromium, launches } = createFakeEdge();
  let adminOk = false;
  const app = buildApp({
    isLocalRestartRequest: () => true,
    checkAdminAuth: (req, res) => adminOk || (res.status(401).json({ error: "admin key required" }), false),
    env: FAKE_ENV,
    chromium,
    ramPercent: () => 50,
  });
  await withServer(app, async (baseUrl) => {
    assert.equal((await postJson(`${baseUrl}/browser/take-over`, {})).response.status, 401);
    assert.equal(launches.length, 0);
    adminOk = true;
    const { payload } = await postJson(`${baseUrl}/browser/take-over`, { url: "https://shop.test/" });
    assert.deepEqual(payload, { active: true, needsYou: null });
    const done = await postJson(`${baseUrl}/browser/hand-back`, {});
    assert.deepEqual(done.payload, { active: false, needsYou: null });
  });
  assert.equal(launches[0].ctx.closed, 1);
});

test("#1168: ad and tracker domains are always blocked and counted per page, which the session sees", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, page } = createFakeChromium();
  const session = await browserAutomationPlugin.getSession({ env: FAKE_ENV, chromium, ramPercent: () => 50, isWatched: () => true });

  async function outcome(url, resourceType = "script") {
    let result = null;
    await page.routeHandler({
      request: () => ({ resourceType: () => resourceType, url: () => url }),
      abort: async () => (result = "abort"),
      continue: async () => (result = "continue"),
    });
    return result;
  }
  assert.equal(await outcome("https://securepubads.g.doubleclick.net/tag/js/gpt.js"), "abort");
  assert.equal(await outcome("https://www.googletagmanager.com/gtm.js"), "abort");
  assert.equal(await outcome("https://site.test/app.js"), "continue");
  assert.equal(await outcome("https://site.test/logo.png", "image"), "continue"); // watched
  page.listeners.pageerror(new Error("adsbygoogle is not defined"));

  // The page is empty and threw: the session flags what was blocked.
  page.ariaSnapshot = async () => "";
  page.evaluate = async (fn) => (fn.name === "extractTextInPage" ? "" : null);
  page._url = "https://site.test/";
  assert.equal((await session.snapshot()).blockedMayBreak, 2);

  // A new page starts from zero.
  page.listeners.framenavigated("main");
  assert.equal((await session.snapshot()).blockedMayBreak, undefined);
  await browserAutomationPlugin.closeSession();
});

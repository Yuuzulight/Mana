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
  // The page is empty: the session flags what was blocked.
  page.ariaSnapshot = async () => "";
  page.evaluate = async (fn) => (fn.name === "extractTextInPage" ? "" : null);
  page._url = "https://site.test/";
  assert.equal((await session.snapshot()).blockedMayBreak, 2);

  // A new page starts from zero.
  page.listeners.framenavigated("main");
  assert.equal((await session.snapshot()).blockedMayBreak, undefined);
  await browserAutomationPlugin.closeSession();
});

test("#1169: a new hand-over request pops one toast, never while gaming, and never opens a window", async () => {
  browserAutomationPlugin._resetForTests();
  const toasts = [];
  let gaming = false;
  const { chromium, launches } = createFakeEdge();
  const deps = { env: FAKE_ENV, chromium, isGaming: () => gaming, notifyTray: async (p) => toasts.push(p) };

  browserAutomationPlugin.requestHandOver("Log in to the shop", deps);
  browserAutomationPlugin.requestHandOver("Log in to the shop", deps); // the same request again
  assert.deepEqual(toasts, [{ type: "browser-hand-over", title: "Mana needs you in her browser", text: "Log in to the shop" }]);
  assert.equal(launches.length, 0);

  gaming = true;
  browserAutomationPlugin.requestHandOver("This page asks for a password.", deps);
  assert.equal(toasts.length, 1);
  assert.equal(browserAutomationPlugin.takeOverStatus().needsYou, "This page asks for a password.");

  // While I have the browser, nothing new.
  gaming = false;
  await browserAutomationPlugin.takeOver(deps);
  browserAutomationPlugin.requestHandOver("Something else", deps);
  assert.equal(toasts.length, 1);
  await browserAutomationPlugin.handBack();
});

// A fake context that opens as many pages as asked, each a small fake page.
function createFakeTabs() {
  const pages = [];
  function makePage(n) {
    return {
      n,
      closed: false,
      _url: "about:blank",
      on() {},
      mainFrame() {},
      async route() {},
      async goto(url) { this._url = url; },
      async ariaSnapshot() { return `- button "Go ${n}" [ref=e1]`; },
      async evaluate(fn) { return fn.name === "extractTextInPage" ? `page ${n}` : null; },
      async title() { return `Page ${n}`; },
      async url() { return this._url; },
      async close() { this.closed = true; },
    };
  }
  const context = {
    pages: () => pages.slice(0, 1),
    async newPage() {
      const page = makePage(pages.length + 1);
      pages.push(page);
      return page;
    },
    on() {},
    async close() {},
  };
  return { chromium: { launchPersistentContext: async () => context }, pages };
}

test("#1159: she opens, lists, switches and closes up to three tabs, and extra ones close when her task ends", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, pages } = createFakeTabs();
  let ram = 50;
  const session = await browserAutomationPlugin.getSession({ env: FAKE_ENV, chromium, ramPercent: () => ram });
  await session.navigate("https://a.test/");
  assert.equal((await session.snapshot()).tabs, undefined); // one tab: no list

  const second = await session.tab({ do: "open", url: "https://b.test/" });
  assert.equal(second.url, "https://b.test/");
  assert.deepEqual(second.tabs, ["1. Page 1 -- https://a.test/", "2. Page 2 -- https://b.test/ (current)"]);
  await session.tab({ do: "open", url: "https://c.test/" });
  await assert.rejects(() => session.tab({ do: "open", url: "https://d.test/" }), /3 tabs are open, the most she may have/);

  const switched = await session.tab({ do: "switch", number: 1 });
  assert.equal(switched.url, "https://a.test/");
  assert.match(switched.tabs[0], /\(current\)$/);
  assert.equal(await session.url(), "https://a.test/");
  await assert.rejects(() => session.tab({ do: "switch", number: 4 }), /there's no tab 4; she has 3/);

  const closed = await session.tab({ do: "close", number: 2 });
  assert.equal(pages[1].closed, true);
  assert.deepEqual(closed.tabs, ["1. Page 1 -- https://a.test/ (current)", "2. Page 3 -- https://c.test/"]);

  // RAM gate: no new tab above the limit.
  ram = 86;
  await assert.rejects(() => session.tab({ do: "open", url: "https://e.test/" }), /no new tab while RAM is at 86%/);
  ram = 50;

  await session.tab({ do: "switch", number: 2 });
  await browserAutomationPlugin.closeExtraTabs();
  assert.equal(pages[0].closed, true);
  assert.equal(pages[2].closed, false);
  assert.equal(await session.url(), "https://c.test/");
  await assert.rejects(() => session.tab({ do: "close", number: 1 }), /her only tab/);
  await browserAutomationPlugin.closeSession();
});

test("#1159: a tab that fails to open closes again, and MANA_BROWSER_MAX_TABS sets the limit", async () => {
  browserAutomationPlugin._resetForTests();
  const { chromium, pages } = createFakeTabs();
  const session = await browserAutomationPlugin.getSession({ env: { ...FAKE_ENV, MANA_BROWSER_MAX_TABS: "2" }, chromium, ramPercent: () => 50 });
  await assert.rejects(() => session.tab({ do: "open", url: "file:///C:/x" }), /only http\/https/);
  assert.equal(pages[1].closed, true);
  await session.tab({ do: "open", url: "https://b.test/" });
  await assert.rejects(() => session.tab({ do: "open", url: "https://c.test/" }), /2 tabs are open/);
  await browserAutomationPlugin.closeSession();
});

test("#1158: only files I point her to can be uploaded: the panel's picker or full paths in my message", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  browserAutomationPlugin._resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-offer-"));
  const cv = path.join(dir, "my cv.pdf");
  const notes = path.join(dir, "notes.txt");
  fs.writeFileSync(cv, "cv");
  fs.writeFileSync(notes, "n");

  assert.deepEqual(browserAutomationPlugin.pathsIn(`upload "${cv}" and ${notes}, thanks`), [cv, notes]);
  assert.deepEqual(browserAutomationPlugin.offerFilesFromMessage(`upload "${cv}" and C:\\nope\\missing.pdf`), [cv]);
  const secret = path.join(dir, ".env");
  fs.writeFileSync(secret, "TOKEN=x");
  assert.deepEqual(browserAutomationPlugin.offerFiles([secret]), []); // never a secret

  const { chromium } = createFakeTabs();
  const session = await browserAutomationPlugin.getSession({ env: FAKE_ENV, chromium, ramPercent: () => 50 });
  await assert.rejects(() => session.upload("e1", notes), /only upload a file the user pointed her to/);
  await assert.rejects(() => session.upload("e1", "C:\\Windows\\win.ini"), /only upload a file the user pointed her to/);

  // The Browser panel's picker, through its route (admin only).
  let admin = false;
  const app = buildApp({ isLocalRestartRequest: () => true, checkAdminAuth: (req, res) => admin || (res.status(401).json({}), false) });
  await withServer(app, async (baseUrl) => {
    assert.equal((await postJson(`${baseUrl}/browser/offer-files`, { paths: [notes] })).response.status, 401);
    admin = true;
    const { payload } = await postJson(`${baseUrl}/browser/offer-files`, { paths: [notes, path.join(dir, "gone.txt")] });
    assert.deepEqual(payload, { offered: [notes] });
  });
  // Offered through the panel, it passes the check (Windows paths ignore case).
  const again = await browserAutomationPlugin.getSession({ env: FAKE_ENV, chromium: createFakeTabs().chromium, ramPercent: () => 50 });
  await assert.rejects(() => again.upload("e1", notes.toUpperCase()), (e) => !/only upload/.test(e.message));
  await browserAutomationPlugin.closeSession();
});

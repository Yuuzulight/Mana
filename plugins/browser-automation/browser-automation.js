// Interactive browser automation: navigate/click/type/read a live page,
// not just search-and-extract (that's web-access.js's job, and stays
// untouched). Driven through a narrow "page-like" interface (goto,
// ariaSnapshot, locator, evaluate, goBack, mouse, title, url, screenshot)
// rather than exposing Playwright's full API directly -- production passes
// a real Playwright page, tests inject a plain fake object.
//
// #1138: what she reads is Playwright's AI accessibility snapshot
// (`page.ariaSnapshot({ mode: "ai" })`, iframes included), cut down to the
// interactive elements, plus a short text excerpt. She acts by the
// snapshot's refs (`aria-ref=e5`).
const MAX_PAGE_TEXT_CHARS = 1500;
const MAX_ELEMENTS = 150;
const SNAPSHOT_DEPTH = 40;
// A stale ref fails fast instead of waiting out Playwright's 30 seconds.
const ACTION_TIMEOUT_MS = 5000;
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio",
  "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);
const REF_RE = /^(?:f\d+)?e\d+$/;
// #1161: the sizes she tests a page at.
const VIEWPORTS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 720 } };
const MAX_JS_RESULT_CHARS = 2000;
const { inspectInPage, MAX_LINKS } = require("./site-test");
// #1155: keys she may press -- the page's own keys, never a shortcut that
// acts outside it (closing or opening tabs, printing, saving, devtools).
const NAMED_KEYS = new Map(
  ["Enter", "Escape", "Tab", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]
    .map((k) => [k.toLowerCase(), k === "Space" ? " " : k]),
);
NAMED_KEYS.set("esc", "Escape");
NAMED_KEYS.set("return", "Enter");
// Editing shortcuts only: select all, undo, redo, bold, italic, underline.
// No copy, cut or paste: those reach my own clipboard.
const CONTROL_LETTERS = new Set(["a", "z", "y", "b", "i", "u"]);

// "Ctrl+A", "shift+tab", "Enter" -> Playwright's "Control+a", "Shift+Tab",
// "Enter"; throws on anything else.
function pageKey(key) {
  const parts = String(key ?? "").split("+").map((p) => p.trim().toLowerCase());
  const base = parts.pop();
  const mods = new Set(parts.map((m) => (m === "ctrl" ? "control" : m)));
  if (![...mods].every((m) => m === "control" || m === "shift")) {
    throw new Error(`only Ctrl and Shift combinations are allowed, not "${key}"`);
  }
  const named = NAMED_KEYS.get(base);
  const letter = /^[a-z0-9]$/.test(base) ? base : null;
  if (!named && !letter) throw new Error(`"${key}" isn't a key she can press (Enter, Escape, Tab, arrows, a letter...)`);
  if (mods.has("control") && letter && !CONTROL_LETTERS.has(letter)) {
    throw new Error(`Ctrl+${letter.toUpperCase()} isn't allowed: only the page's editing shortcuts (Ctrl+A/Z/Y/B/I/U)`);
  }
  return [...(mods.has("control") ? ["Control"] : []), ...(mods.has("shift") ? ["Shift"] : []), named || letter].join("+");
}

// The snapshot's interactive lines, flattened: `link "More" [ref=e6]`,
// `textbox "Search" [ref=e9]: current value`. Lines without a ref can't be
// acted on, so they go too.
function interactiveElements(ariaSnapshot) {
  const lines = [];
  for (const raw of String(ariaSnapshot || "").split("\n")) {
    const match = /^\s*- (\w+)\b(.*)$/.exec(raw);
    if (!match || !INTERACTIVE_ROLES.has(match[1]) || !/\[ref=/.test(match[2])) continue;
    lines.push((match[1] + match[2].replace(/ \[cursor=pointer\]/g, "")).replace(/:$/, ""));
  }
  return lines;
}

// #1156: the words in a description that name a kind of element, and the
// snapshot roles they mean.
const ROLE_WORDS = new Map([
  ["button", ["button"]], ["link", ["link"]], ["tab", ["tab"]], ["checkbox", ["checkbox"]],
  ["radio", ["radio"]], ["switch", ["switch", "checkbox"]], ["toggle", ["switch", "checkbox", "button"]],
  ["slider", ["slider"]], ["option", ["option"]], ["menu", ["menuitem", "combobox", "button"]],
  ["box", ["textbox", "searchbox", "combobox"]], ["field", ["textbox", "searchbox", "combobox"]],
  ["input", ["textbox", "searchbox", "combobox"]], ["search", ["searchbox", "textbox"]],
  ["dropdown", ["combobox", "listbox"]], ["select", ["combobox", "listbox"]],
]);
const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "on", "in", "for", "that", "with", "and", "or", "my", "this", "it", "at"]);
const MAX_MATCHES = 5;

const words = (text) => String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// The snapshot lines that best fit what she describes ("the Sign in
// button", "the search box"), best first: words of the element's name
// count most, a whole-phrase match more, a matching kind of element a bit.
// ponytail: plain word overlap, no stemming or synonyms beyond ROLE_WORDS.
function findElements(elements, description) {
  const wanted = words(description).filter((w) => !STOP_WORDS.has(w));
  const roles = new Set(wanted.flatMap((w) => ROLE_WORDS.get(w) || []));
  const nameWords = wanted.filter((w) => !ROLE_WORDS.has(w) || !roles.size);
  const phrase = nameWords.join(" ");
  const scored = elements.map((line) => {
    const [, role = "", name = ""] = /^(\w+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line) || [];
    const have = new Set(words(`${name} ${line.split("]: ")[1] || ""}`));
    let score = nameWords.filter((w) => have.has(w)).length * 2;
    if (phrase && name.toLowerCase().includes(phrase)) score += 2;
    if (roles.has(role)) score += score > 0 || !nameWords.length ? 1 : 0;
    return { line, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES)
    .map((s) => s.line);
}

// A plain, token-efficient text extraction -- not a screenshot or raw
// HTML dump.
function extractTextInPage(maxChars) {
  return (document.body?.innerText || "").trim().replace(/\n{3,}/g, "\n\n").slice(0, maxChars);
}

// #1139: a page asking for a password or payment details is mine: she
// never types credentials or pays. Runs in the page; why, or null.
// ponytail: field and URL heuristics; a card form in a provider's iframe we
// don't list, on a URL without these words, slips past -- add it here.
function sensitiveInPage() {
  const has = (selector) => Boolean(document.querySelector(selector));
  if (has('input[type="password" i], [autocomplete~="current-password"], [autocomplete~="new-password"], [autocomplete~="one-time-code"]')) {
    return "a password";
  }
  if (
    has('[autocomplete*="cc-"], input[name*="cardnumber" i], input[name*="card_number" i], input[name*="cvc" i], input[name*="cvv" i]') ||
    has('iframe[src*="stripe.com"], iframe[src*="paypal.com"], iframe[src*="braintree"], iframe[src*="adyen"]') ||
    /checkout|payment|billing/i.test(location.pathname)
  ) {
    return "payment details";
  }
  return null;
}

// "e5", or the model's "[ref=e5]" / "ref=e5" -- nothing else reaches the
// selector.
function refSelector(ref) {
  const id = String(ref ?? "").replace(/^\[?(?:ref=)?|\]$/g, "");
  if (!id) throw new Error("ref is required");
  if (!REF_RE.test(id)) throw new Error(`"${ref}" isn't a ref from the page snapshot (like e5)`);
  return `aria-ref=${id}`;
}

// #704: her cursor, drawn in the page where she's about to act, so I can
// see what she's doing (the visible window, the Browser panel's
// screenshot). Takes no clicks, stays out of her snapshot (aria-hidden, no
// text), and fades on its own. Runs in the page; box is the element's
// viewport box, or a point (width/height 0) for a click by sight.
const CURSOR_ID = "__mana_agent_cursor";
function drawCursorInPage({ id, x, y, width, height }) {
  document.getElementById(id)?.remove();
  const root = document.createElement("div");
  root.id = id;
  root.setAttribute("aria-hidden", "true");
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;transition:opacity .4s";
  if (width > 0 && height > 0) {
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${width}px;height:${height}px;outline:2px solid #ff4fa3;outline-offset:2px;border-radius:4px;box-shadow:0 0 0 6px rgba(255,79,163,.2)`;
    root.append(box);
  }
  const dot = document.createElement("div");
  dot.style.cssText = `position:fixed;left:${x + width / 2 - 9}px;top:${y + height / 2 - 9}px;width:18px;height:18px;border-radius:50%;background:rgba(255,79,163,.85);border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.5)`;
  root.append(dot);
  (document.body || document.documentElement).append(root);
  setTimeout(() => (root.style.opacity = "0"), 1500);
  setTimeout(() => root.remove(), 2000);
}

function clearCursorInPage(id) {
  document.getElementById(id)?.remove();
}

function blockedNote(count) {
  return `this site may need the ${count} ad or tracker request${count === 1 ? "" : "s"} that were blocked; the user can open it in their own browser (don't retry without blocking)`;
}

// options.page: the injected page-like object (see file header).
function createBrowserSession(options = {}) {
  const page = options.page;
  if (!page || typeof page.goto !== "function") {
    throw new Error("a page-like object ({goto, ariaSnapshot, locator, evaluate, title, url, screenshot}) is required");
  }
  const maxTextChars = Math.max(200, Number(options.maxTextChars) || MAX_PAGE_TEXT_CHARS);
  // #1168: { blockedAds } for the current page (index.js).
  const pageHealth = options.pageHealth || (() => ({ blockedAds: 0 }));
  let last = null;
  // #704: whether I'm watching (index.js): only then is her cursor drawn.
  const showCursor = options.cursor || (() => false);

  // Best-effort: a cursor that can't be drawn never stops the action.
  async function cursorAt(target) {
    if (!showCursor()) return;
    try {
      const box = typeof target.boundingBox === "function" ? await target.boundingBox({ timeout: ACTION_TIMEOUT_MS }) : { ...target, width: 0, height: 0 };
      if (box) await page.evaluate(drawCursorInPage, { id: CURSOR_ID, x: box.x, y: box.y, width: box.width, height: box.height });
    } catch (e) {
      // the page moved on; nothing to point at
    }
  }

  // Her vision model sees the page, not her cursor.
  async function clearCursor() {
    if (showCursor()) await page.evaluate(clearCursorInPage, CURSOR_ID).catch(() => {});
  }

  // Ads or trackers were blocked and the page looks broken (next to
  // nothing to read or use): the count, else 0. #1179: script errors alone
  // don't count -- ad-heavy pages throw them once their ads are gone and
  // still work. A timeout counts too (acting, below). She doesn't retry
  // without blocking; I can open it in my own browser.
  function blockedMayBreak(elements, text) {
    const { blockedAds } = pageHealth();
    const thin = elements.length < 3 && String(text || "").length < 200;
    return blockedAds > 0 && thin ? blockedAds : 0;
  }

  // An action that timed out on a page with blocked ads says so too.
  async function acting(run) {
    try {
      return await run();
    } catch (e) {
      const { blockedAds } = pageHealth();
      if (blockedAds > 0 && /timeout/i.test(e?.message || "")) {
        e.message += ` -- ${blockedNote(blockedAds)}`;
        e.blockedMayBreak = blockedAds;
      }
      throw e;
    }
  }

  async function snapshot() {
    const [aria, text, title, url, sensitive] = await Promise.all([
      page.ariaSnapshot({ mode: "ai", depth: SNAPSHOT_DEPTH }),
      page.evaluate(extractTextInPage, maxTextChars),
      page.title(),
      page.url(),
      page.evaluate(sensitiveInPage),
    ]);
    const all = interactiveElements(aria);
    const elements = all.slice(0, MAX_ELEMENTS);
    if (all.length > elements.length) elements.push(`(${all.length - elements.length} more not shown)`);
    const blocked = blockedMayBreak(all, text);
    last = { url, title, elements, text, ...(sensitive ? { sensitive } : {}), ...(blocked ? { blockedMayBreak: blocked } : {}) };
    return last;
  }

  // #1156: the best-fitting elements for a description, from a fresh look
  // at the whole page (not just the 150 a snapshot shows).
  async function find(description) {
    if (!String(description || "").trim()) throw new Error("say what to look for, like \"the Sign in button\"");
    const [aria, title, url] = await Promise.all([page.ariaSnapshot({ mode: "ai", depth: SNAPSHOT_DEPTH }), page.title(), page.url()]);
    return { url, title, description: String(description), matches: findElements(interactiveElements(aria), description) };
  }

  // After an action: on the same page, only what changed; on a new page
  // (or when most of it changed), a fresh snapshot.
  async function afterAction() {
    const before = last;
    const now = await snapshot();
    if (!before || before.url !== now.url) return now;
    const was = new Set(before.elements);
    const is = new Set(now.elements);
    const added = now.elements.filter((l) => !was.has(l));
    const removed = before.elements.filter((l) => !is.has(l));
    if (added.length + removed.length > now.elements.length / 2) return now;
    return {
      url: now.url,
      title: now.title,
      added,
      removed,
      ...(now.text !== before.text ? { text: now.text } : {}),
      ...(now.sensitive ? { sensitive: now.sensitive } : {}),
      ...(now.blockedMayBreak ? { blockedMayBreak: now.blockedMayBreak } : {}),
    };
  }

  async function navigate(url) {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      throw new Error(`invalid URL: ${url}`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("only http/https URLs can be navigated to");
    }
    await acting(() => page.goto(target.href));
    return snapshot();
  }

  // Checked fresh before every click, type and select: the page may have
  // changed since her last look.
  async function refuseIfSensitive() {
    const reason = await page.evaluate(sensitiveInPage);
    if (reason) {
      throw new Error(`this page asks for ${reason}, so it's the user's to do: don't act on it, hand it over (browser_automation__hand_over)`);
    }
  }

  async function click(ref) {
    await refuseIfSensitive();
    const target = page.locator(refSelector(ref));
    await cursorAt(target);
    await acting(() => target.click({ timeout: ACTION_TIMEOUT_MS }));
    return afterAction();
  }

  // Replaces the field's text; submit presses Enter after.
  async function type(ref, text, submit = false) {
    await refuseIfSensitive();
    const field = page.locator(refSelector(ref));
    await cursorAt(field);
    await acting(async () => {
      await field.fill(String(text ?? ""), { timeout: ACTION_TIMEOUT_MS });
      if (submit) await field.press("Enter", { timeout: ACTION_TIMEOUT_MS });
    });
    return afterAction();
  }

  // An option's label or value.
  async function select(ref, value) {
    await refuseIfSensitive();
    const target = page.locator(refSelector(ref));
    await cursorAt(target);
    await acting(() => target.selectOption(String(value ?? ""), { timeout: ACTION_TIMEOUT_MS }));
    return afterAction();
  }

  // Most of a screen, with the wheel over the page's middle so a scrolling
  // panel scrolls too, not just the window.
  async function scroll(direction) {
    if (direction !== "up" && direction !== "down") throw new Error('direction must be "up" or "down"');
    const { width, height } = page.viewportSize?.() || { width: 1280, height: 720 };
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, (direction === "down" ? 0.8 : -0.8) * height);
    return afterAction();
  }

  // #1155: menus that open on hover.
  async function hover(ref) {
    const target = page.locator(refSelector(ref));
    await cursorAt(target);
    await acting(() => target.hover({ timeout: ACTION_TIMEOUT_MS }));
    return afterAction();
  }

  // On the element (ref) or wherever the focus is.
  async function press(key, ref) {
    const combo = pageKey(key);
    await refuseIfSensitive();
    await acting(() => (ref ? page.locator(refSelector(ref)).press(combo, { timeout: ACTION_TIMEOUT_MS }) : page.keyboard.press(combo)));
    return afterAction();
  }

  // Sliders, reordering.
  async function drag(fromRef, toRef) {
    const from = page.locator(refSelector(fromRef));
    const to = page.locator(refSelector(toRef));
    await refuseIfSensitive();
    await cursorAt(from);
    await acting(() => from.dragTo(to, { timeout: ACTION_TIMEOUT_MS }));
    return afterAction();
  }

  // #1158: a file I pointed her to (index.js checks that) into a file
  // input, or through the file chooser a button opens.
  async function upload(ref, file) {
    await refuseIfSensitive();
    const target = page.locator(refSelector(ref));
    await cursorAt(target);
    await acting(async () => {
      const isFileInput = await target.evaluate((el) => el.tagName === "INPUT" && el.type === "file", undefined, { timeout: ACTION_TIMEOUT_MS });
      if (isFileInput) {
        await target.setInputFiles(file, { timeout: ACTION_TIMEOUT_MS });
      } else {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT_MS }), target.click({ timeout: ACTION_TIMEOUT_MS })]);
        await chooser.setFiles(file);
      }
    });
    return afterAction();
  }

  // #1161: her dev tools, on the current page. options.pageLog is the
  // page's { console, network } (index.js). look(image) is her vision
  // model's description of a screenshot.
  const pageLog = options.pageLog || (() => ({ console: [], network: [] }));
  async function devtools(args = {}, look = null) {
    const { url, title } = { url: await page.url(), title: await page.title() };
    if (args.do === "console") {
      const messages = pageLog().console;
      const rank = (m) => (m.type === "error" ? 0 : m.type === "warning" ? 1 : 2);
      return { url, title, devtools: [...messages].sort((a, b) => rank(a) - rank(b)).slice(0, 30).map((m) => `${m.type}: ${m.text}`), what: `Console (${messages.length} messages, errors first)` };
    }
    if (args.do === "network") {
      const requests = pageLog().network;
      const failed = requests.filter((r) => r.failure || r.status >= 400);
      const slowest = requests.filter((r) => r.ms >= 0).sort((a, b) => b.ms - a.ms).slice(0, 5);
      return {
        url,
        title,
        what: `Network (${requests.length} requests, ${failed.length} failed)`,
        devtools: [
          ...failed.slice(0, 20).map((r) => `failed: ${r.method} ${r.url} -- ${r.failure || `HTTP ${r.status}`}`),
          ...slowest.map((r) => `slow: ${r.ms} ms ${r.method} ${r.url}`),
        ],
      };
    }
    if (args.do === "run_js") {
      await refuseIfSensitive();
      const code = String(args.code || "").trim();
      if (!code) throw new Error("code is required: a JavaScript expression to run on the page");
      const value = await acting(() => page.evaluate(code));
      let shown;
      try {
        shown = JSON.stringify(value) ?? "undefined";
      } catch (e) {
        shown = String(value);
      }
      return { url, title, what: "Result", devtools: [shown.slice(0, MAX_JS_RESULT_CHARS)] };
    }
    if (args.do === "viewport") {
      const size = VIEWPORTS[args.size];
      if (!size) throw new Error('size must be "phone", "tablet" or "desktop"');
      await page.setViewportSize(size);
      return snapshot();
    }
    if (args.do === "color_scheme") {
      if (args.scheme !== "light" && args.scheme !== "dark") throw new Error('scheme must be "light" or "dark"');
      await page.emulateMedia({ colorScheme: args.scheme });
      return snapshot();
    }
    if (args.do === "look") {
      await refuseIfSensitive();
      if (!look) throw new Error("looking at the page isn't available right now");
      await clearCursor();
      const shot = await page.screenshot({ type: "jpeg", quality: 70 });
      const seen = await look(`data:image/jpeg;base64,${shot.toString("base64")}`, String(args.question || "Describe this page's layout and anything that looks broken."));
      return { url, title, what: "What she sees", devtools: [String(seen || "")] };
    }
    throw new Error('do must be "console", "network", "run_js", "viewport", "color_scheme" or "look"');
  }

  // #1161: "Test this site" for one page: at each size, what inspectInPage
  // finds plus the console errors, failed requests and a screenshot; then
  // its links on the same site (at most MAX_LINKS), checked once, together.
  // Other sites' links aren't fetched: she has no permission there.
  async function testPage(url, sizes) {
    const checks = [];
    let links = [];
    try {
      for (const size of sizes) {
        const viewport = VIEWPORTS[size];
        if (!viewport) throw new Error(`"${size}" isn't a size (phone, tablet, desktop)`);
        await page.setViewportSize(viewport);
        await navigate(url);
        const found = await page.evaluate(inspectInPage);
        const { console: messages, network } = pageLog();
        const shot = await page.screenshot({ type: "jpeg", quality: 40 });
        checks.push({
          size,
          ...viewport,
          consoleErrors: messages.filter((m) => m.type === "error").map((m) => m.text),
          failedRequests: network.filter((r) => r.failure || r.status >= 400).map((r) => `${r.method} ${r.url} -- ${r.failure || `HTTP ${r.status}`}`),
          layout: found.layout,
          a11y: found.a11y,
          screenshot: `data:image/jpeg;base64,${shot.toString("base64")}`,
        });
        if (!links.length) links = found.links;
      }
    } finally {
      await page.setViewportSize(VIEWPORTS.desktop).catch(() => {});
    }
    const origin = new URL(await page.url()).origin;
    const toCheck = links.filter((l) => new URL(l).origin === origin).slice(0, MAX_LINKS);
    const results = await Promise.all(
      toCheck.map(async (link) => {
        try {
          const response = await page.request.head(link, { timeout: ACTION_TIMEOUT_MS, failOnStatusCode: false });
          // 405: the server just doesn't answer HEAD.
          return response.status() >= 400 && response.status() !== 405 ? `${link} (HTTP ${response.status()})` : null;
        } catch (e) {
          return `${link} (${String(e.message || e).split("\n")[0].slice(0, 80)})`;
        }
      }),
    );
    const brokenLinks = results.filter(Boolean);
    return { url, title: await page.title(), sizes: checks, brokenLinks, linksChecked: toCheck.length };
  }

  // #1157: for pages with no useful accessibility info (canvas apps,
  // unlabeled custom UIs). locate(imageDataUrl, width, height) is her
  // vision model's answer: { x, y } in the screenshot, or null.
  async function lookAndClick(description, locate) {
    await refuseIfSensitive();
    const { width, height } = page.viewportSize?.() || { width: 1280, height: 720 };
    await clearCursor();
    const shot = await page.screenshot({ type: "jpeg", quality: 70 });
    const point = await locate(`data:image/jpeg;base64,${shot.toString("base64")}`, width, height);
    if (!point) throw new Error(`she couldn't see "${description}" on the page`);
    await cursorAt(point);
    await acting(() => page.mouse.click(point.x, point.y));
    return { ...(await afterAction()), clickedAt: point };
  }

  async function back() {
    await page.goBack();
    return snapshot();
  }

  // Issue #418: a human-facing "what's it doing" feed for the launcher's
  // Browser panel -- the model never sees a screenshot.
  async function screenshot() {
    const buffer = await page.screenshot({ type: "jpeg", quality: 50 });
    return buffer.toString("base64");
  }

  return { navigate, click, type, select, scroll, hover, press, drag, upload, lookAndClick, devtools, testPage, back, find, snapshot, screenshot, url: () => page.url() };
}

module.exports = {
  MAX_PAGE_TEXT_CHARS,
  MAX_ELEMENTS,
  createBrowserSession,
  interactiveElements,
  findElements,
  extractTextInPage,
  sensitiveInPage,
  refSelector,
  pageKey,
  blockedNote,
  VIEWPORTS,
  drawCursorInPage,
  clearCursorInPage,
};

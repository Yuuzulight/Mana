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
  // #1168: { blockedAds, pageErrors } for the current page (index.js).
  const pageHealth = options.pageHealth || (() => ({ blockedAds: 0, pageErrors: 0 }));
  let last = null;

  // Ads or trackers were blocked and the page looks broken (script errors,
  // or next to nothing to read or use): the count, else 0. She doesn't
  // retry without blocking; I can open it in my own browser.
  function blockedMayBreak(elements, text) {
    const { blockedAds, pageErrors } = pageHealth();
    const empty = elements.length < 3 && String(text || "").length < 200;
    return blockedAds > 0 && (pageErrors > 0 || empty) ? blockedAds : 0;
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
    await acting(() => page.locator(refSelector(ref)).click({ timeout: ACTION_TIMEOUT_MS }));
    return afterAction();
  }

  // Replaces the field's text; submit presses Enter after.
  async function type(ref, text, submit = false) {
    await refuseIfSensitive();
    const field = page.locator(refSelector(ref));
    await acting(async () => {
      await field.fill(String(text ?? ""), { timeout: ACTION_TIMEOUT_MS });
      if (submit) await field.press("Enter", { timeout: ACTION_TIMEOUT_MS });
    });
    return afterAction();
  }

  // An option's label or value.
  async function select(ref, value) {
    await refuseIfSensitive();
    await acting(() => page.locator(refSelector(ref)).selectOption(String(value ?? ""), { timeout: ACTION_TIMEOUT_MS }));
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

  return { navigate, click, type, select, scroll, back, snapshot, screenshot, url: () => page.url() };
}

module.exports = {
  MAX_PAGE_TEXT_CHARS,
  MAX_ELEMENTS,
  createBrowserSession,
  interactiveElements,
  extractTextInPage,
  sensitiveInPage,
  refSelector,
  blockedNote,
};

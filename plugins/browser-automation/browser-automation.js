// Interactive browser automation: navigate/click/type/read a live page,
// not just search-and-extract (that's web-access.js's job, and stays
// untouched). Local-only by default, driven through a narrow "page-like"
// interface (goto/evaluate/click/type/title/url/screenshot) rather than exposing
// Playwright's full API directly -- this is what makes the module testable
// without a real browser: production wraps a real Playwright page,
// test-suite implementations inject a plain fake object. No real browser
// was launched in the process that built this (CI runners have no
// Windows/Edge install to launch, and this plugin defaults to Edge --
// see index.js); every behavior here is exercised against a fake page.
const MAX_PAGE_TEXT_CHARS = 6000; // matches web-access.js's own budget

// Runs in the real page's context via page.evaluate() -- assigns a stable
// data-mana-ref attribute to each visible interactive element (only once
// per element, so refs stay stable across repeated snapshots of the same
// page) and returns a compact description of each. Kept as a single
// stringified function so it can cross into the page's own JS context;
// the fake page used in tests just calls it directly.
function snapshotInPage() {
  const SELECTOR =
    'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
  window.__manaRefCounter = window.__manaRefCounter || 0;
  const elements = Array.from(document.querySelectorAll(SELECTOR)).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  return elements.map((el) => {
    if (!el.hasAttribute("data-mana-ref")) {
      window.__manaRefCounter += 1;
      el.setAttribute("data-mana-ref", String(window.__manaRefCounter));
    }
    const label =
      el.getAttribute("aria-label") ||
      el.textContent?.trim().slice(0, 80) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("value") ||
      "";
    return {
      ref: el.getAttribute("data-mana-ref"),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      label,
    };
  });
}

// A plain, token-efficient text extraction -- not a screenshot or raw
// HTML dump, matching the issue's explicit requirement.
function extractTextInPage(maxChars) {
  return (document.body?.innerText || "").trim().slice(0, maxChars);
}

// options.page: the injected page-like object (see file header). Kept as
// a plain object of async methods rather than a class -- matches this
// codebase's existing dependency-injection style (acp-memory-store.js,
// cron-scheduler.js, etc.).
function createBrowserSession(options = {}) {
  const page = options.page;
  if (!page || typeof page.goto !== "function") {
    throw new Error("a page-like object ({goto, evaluate, click, type, title, url, screenshot}) is required");
  }
  const maxTextChars = Math.max(500, Number(options.maxTextChars) || MAX_PAGE_TEXT_CHARS);

  async function snapshot() {
    const [interactiveElements, text, title, url] = await Promise.all([
      page.evaluate(snapshotInPage),
      page.evaluate(extractTextInPage, maxTextChars),
      page.title(),
      page.url(),
    ]);
    return { url, title, text, interactiveElements };
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
    await page.goto(target.href);
    return snapshot();
  }

  async function click(ref) {
    if (!ref) throw new Error("ref is required");
    await page.click(`[data-mana-ref="${ref}"]`);
    return snapshot();
  }

  async function type(ref, text) {
    if (!ref) throw new Error("ref is required");
    await page.type(`[data-mana-ref="${ref}"]`, String(text ?? ""));
    return snapshot();
  }

  // Issue #418: a human-facing "what's it doing" activity feed for the
  // launcher UI -- entirely separate from snapshot()'s token-efficient text
  // extraction, which stays the only thing the model itself ever reads (see
  // the file header: no screenshot/raw HTML ever reaches the model). Real
  // Playwright pages already expose .screenshot() natively (index.js passes
  // the raw page object straight into createBrowserSession, not a narrowed
  // wrapper), so this is required on the page-like interface the same way
  // goto/evaluate/click/type/title/url already are.
  async function screenshot() {
    const buffer = await page.screenshot({ type: "jpeg", quality: 50 });
    return buffer.toString("base64");
  }

  return { navigate, click, type, snapshot, screenshot };
}

module.exports = { MAX_PAGE_TEXT_CHARS, createBrowserSession, snapshotInPage, extractTextInPage };

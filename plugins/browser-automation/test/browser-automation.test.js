const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_PAGE_TEXT_CHARS,
  MAX_ELEMENTS,
  createBrowserSession,
  interactiveElements,
  extractTextInPage,
  sensitiveInPage,
  refSelector,
} = require("../browser-automation");

// A real `page.ariaSnapshot({ mode: "ai" })` shape: nested roles, refs,
// cursor hints, a link's url child, and an iframe's f1-prefixed refs.
const ARIA = `- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "Home" [ref=e3] [cursor=pointer]:
      - /url: /
    - searchbox "Search" [ref=e4]: cats
    - button "Go" [ref=e5] [cursor=pointer]
  - heading "Welcome" [level=1] [ref=e6]
  - paragraph [ref=e7]: Some text
  - combobox "Size" [ref=e8]:
    - option "Small" [selected]
    - option "Large"
  - checkbox "Remember me" [checked] [ref=e9]
  - iframe [ref=e10]:
    - button "Accept" [ref=f1e2] [cursor=pointer]`;

// A fake Playwright page: ariaSnapshot/evaluate return what the test
// sets, and locator(selector) records the actions taken on it.
function createFakePage(overrides = {}) {
  const state = { url: "about:blank", aria: overrides.aria ?? ARIA, text: overrides.text ?? "page text", sensitive: null, calls: [] };
  return {
    state,
    async goto(url) {
      state.calls.push(["goto", url]);
      state.url = url;
    },
    async ariaSnapshot(options) {
      state.calls.push(["ariaSnapshot", options]);
      return state.aria;
    },
    async evaluate(fn, arg) {
      if (fn === extractTextInPage) return state.text.slice(0, arg);
      if (fn === sensitiveInPage) return state.sensitive;
      throw new Error("unexpected evaluate() call in test");
    },
    locator(selector) {
      return {
        click: async (o) => state.calls.push(["click", selector, o]),
        fill: async (text) => state.calls.push(["fill", selector, text]),
        press: async (key) => state.calls.push(["press", selector, key]),
        selectOption: async (value) => state.calls.push(["select", selector, value]),
      };
    },
    mouse: {
      move: async (x, y) => state.calls.push(["move", x, y]),
      wheel: async (x, y) => state.calls.push(["wheel", x, y]),
    },
    viewportSize: () => ({ width: 1000, height: 500 }),
    async goBack() {
      state.calls.push(["back"]);
      state.url = "https://example.com/previous";
    },
    async title() {
      return "Fake Page";
    },
    async url() {
      return state.url;
    },
    async screenshot() {
      state.calls.push(["screenshot"]);
      return Buffer.from("fake-jpeg-bytes");
    },
  };
}

const actions = (page) => page.state.calls.filter((c) => c[0] !== "ariaSnapshot");

test("createBrowserSession requires a page-like object", () => {
  assert.throws(() => createBrowserSession({}), /page-like object/);
});

test("interactiveElements keeps only the actionable lines, flattened, iframes included", () => {
  assert.deepEqual(interactiveElements(ARIA), [
    'link "Home" [ref=e3]',
    'searchbox "Search" [ref=e4]: cats',
    'button "Go" [ref=e5]',
    'combobox "Size" [ref=e8]',
    'checkbox "Remember me" [checked] [ref=e9]',
    'button "Accept" [ref=f1e2]',
  ]);
  assert.deepEqual(interactiveElements(""), []);
});

test("snapshot reads the AI aria snapshot, depth-limited, plus a short text excerpt", async () => {
  const page = createFakePage({ text: "x".repeat(5000) });
  const result = await createBrowserSession({ page }).snapshot();
  assert.deepEqual(page.state.calls[0], ["ariaSnapshot", { mode: "ai", depth: 40 }]);
  assert.equal(result.title, "Fake Page");
  assert.equal(result.elements.length, 6);
  assert.equal(result.text.length, MAX_PAGE_TEXT_CHARS);
  assert.equal(MAX_PAGE_TEXT_CHARS, 1500);
});

test("snapshot caps the element list and says how many it left out", async () => {
  const aria = Array.from({ length: MAX_ELEMENTS + 5 }, (_, i) => `- link "L${i}" [ref=e${i}]`).join("\n");
  const { elements } = await createBrowserSession({ page: createFakePage({ aria }) }).snapshot();
  assert.equal(elements.length, MAX_ELEMENTS + 1);
  assert.equal(elements.at(-1), "(5 more not shown)");
});

test("navigate rejects a non-http(s) URL without calling goto", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  await assert.rejects(() => session.navigate("file:///etc/passwd"), /only http\/https/);
  await assert.rejects(() => session.navigate("not a url"), /invalid URL/);
  assert.equal(page.state.calls.length, 0);
});

test("navigate opens the page and returns a full snapshot", async () => {
  const page = createFakePage();
  const result = await createBrowserSession({ page }).navigate("https://example.com/login");
  assert.deepEqual(page.state.calls[0], ["goto", "https://example.com/login"]);
  assert.equal(result.url, "https://example.com/login");
  assert.ok(result.elements.includes('button "Go" [ref=e5]'));
  assert.equal(result.text, "page text");
});

test("refSelector takes e5, f1e2 and the model's [ref=e5], and refuses anything else", () => {
  assert.equal(refSelector("e5"), "aria-ref=e5");
  assert.equal(refSelector("f1e2"), "aria-ref=f1e2");
  assert.equal(refSelector("[ref=e5]"), "aria-ref=e5");
  assert.equal(refSelector("ref=e5"), "aria-ref=e5");
  assert.throws(() => refSelector(), /ref is required/);
  assert.throws(() => refSelector("5"), /isn't a ref/);
  assert.throws(() => refSelector("e5 >> css=input"), /isn't a ref/);
  assert.throws(() => refSelector('[data-mana-ref="3"]'), /isn't a ref/);
});

test("click acts by aria-ref and, on the same page, returns only what changed", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  await session.navigate("https://example.com/");
  page.state.aria = ARIA.replace('- button "Go" [ref=e5] [cursor=pointer]', '- button "Stop" [ref=e11]');
  page.state.text = "after click";

  const result = await session.click("e5");
  assert.deepEqual(actions(page)[1], ["click", "aria-ref=e5", { timeout: 5000 }]);
  assert.deepEqual(result, {
    url: "https://example.com/",
    title: "Fake Page",
    added: ['button "Stop" [ref=e11]'],
    removed: ['button "Go" [ref=e5]'],
    text: "after click",
  });
});

test("an action that leaves the text alone doesn't repeat it", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  await session.navigate("https://example.com/");
  const result = await session.click("e3");
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.equal("text" in result, false);
});

test("an action that lands on a new page, or changes most of it, returns a fresh snapshot", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  await session.navigate("https://example.com/");
  page.state.url = "https://example.com/next";
  assert.ok((await session.click("e3")).elements);

  page.state.aria = '- link "Only" [ref=e20]';
  assert.deepEqual((await session.click("e3")).elements, ['link "Only" [ref=e20]']);
});

test("type fills the field (coercing to a string) and presses Enter only on submit", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  await session.type("e4", 42);
  await session.type("e4", "cats", true);
  assert.deepEqual(actions(page), [
    ["fill", "aria-ref=e4", "42"],
    ["fill", "aria-ref=e4", "cats"],
    ["press", "aria-ref=e4", "Enter"],
  ]);
  await assert.rejects(() => session.type(undefined, "x"), /ref is required/);
});

test("select picks an option by label or value", async () => {
  const page = createFakePage();
  await createBrowserSession({ page }).select("e8", "Large");
  assert.deepEqual(actions(page), [["select", "aria-ref=e8", "Large"]]);
});

test("scroll wheels most of a screen over the page's middle, up or down only", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  await session.scroll("down");
  await session.scroll("up");
  assert.deepEqual(actions(page), [
    ["move", 500, 250],
    ["wheel", 0, 400],
    ["move", 500, 250],
    ["wheel", 0, -400],
  ]);
  await assert.rejects(() => session.scroll("sideways"), /direction must be/);
});

test("back goes back and returns a full snapshot", async () => {
  const page = createFakePage();
  const result = await createBrowserSession({ page }).back();
  assert.deepEqual(actions(page), [["back"]]);
  assert.equal(result.url, "https://example.com/previous");
  assert.ok(result.elements);
});

test("screenshot returns a base64-encoded JPEG for the Browser panel", async () => {
  const page = createFakePage();
  const result = await createBrowserSession({ page }).screenshot();
  assert.equal(result, Buffer.from("fake-jpeg-bytes").toString("base64"));
});

test("extractTextInPage trims, squeezes blank runs and truncates document.body.innerText", () => {
  global.document = { body: { innerText: "  hello\n\n\n\nworld  " } };
  try {
    assert.equal(extractTextInPage(3), "hel");
    assert.equal(extractTextInPage(100), "hello\n\nworld");
  } finally {
    delete global.document;
  }
});

test("#1139: on a password or payment page she reads, but never clicks, types or selects", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  page.state.sensitive = "a password";
  const result = await session.navigate("https://example.com/login");
  assert.equal(result.sensitive, "a password");

  await assert.rejects(() => session.type("e4", "hunter2"), /asks for a password, so it's the user's to do/);
  await assert.rejects(() => session.click("e5"), /hand it over/);
  page.state.sensitive = "payment details";
  await assert.rejects(() => session.select("e8", "Visa"), /asks for payment details/);
  assert.deepEqual(actions(page), [["goto", "https://example.com/login"]]);

  // She can still leave.
  page.state.sensitive = null;
  await session.back();
  await session.click("e5");
  assert.deepEqual(actions(page).slice(1), [["back"], ["click", "aria-ref=e5", { timeout: 5000 }]]);
});

test("#1139: sensitiveInPage spots password, one-time-code and card fields, and checkout URLs", () => {
  function check(selectorsPresent, pathname = "/") {
    global.document = { querySelector: (s) => (selectorsPresent.some((p) => s.includes(p)) ? {} : null) };
    global.location = { pathname };
    try {
      return sensitiveInPage();
    } finally {
      delete global.document;
      delete global.location;
    }
  }
  assert.equal(check(['input[type="password" i]']), "a password");
  assert.equal(check(['[autocomplete~="one-time-code"]']), "a password");
  assert.equal(check(['[autocomplete*="cc-"]']), "payment details");
  assert.equal(check(['iframe[src*="stripe.com"]']), "payment details");
  assert.equal(check([], "/cart/Checkout"), "payment details");
  assert.equal(check([], "/wiki/Cats"), null);
});

test("#1168: isAdHost matches listed domains and their subdomains only", () => {
  const { isAdHost } = require("../ad-hosts");
  assert.equal(isAdHost("doubleclick.net"), true);
  assert.equal(isAdHost("securepubads.g.doubleclick.net"), true);
  assert.equal(isAdHost("connect.facebook.net"), true);
  assert.equal(isAdHost("facebook.net"), false);
  assert.equal(isAdHost("notdoubleclick.net"), false);
  assert.equal(isAdHost("www.bbc.co.uk"), false);
  assert.equal(isAdHost(""), false);
});

test("#1168: blocked ads only flag the page when it looks broken: errors or next to nothing there", async () => {
  let health = { blockedAds: 4, pageErrors: 0 };
  const page = createFakePage();
  const session = createBrowserSession({ page, pageHealth: () => health });
  assert.equal((await session.snapshot()).blockedMayBreak, undefined); // 6 elements, fine

  health = { blockedAds: 4, pageErrors: 1 };
  assert.equal((await session.snapshot()).blockedMayBreak, 4);

  health = { blockedAds: 4, pageErrors: 0 };
  page.state.aria = '- button "Only" [ref=e1]';
  page.state.text = "Loading...";
  assert.equal((await session.snapshot()).blockedMayBreak, 4);

  health = { blockedAds: 0, pageErrors: 3 };
  assert.equal((await session.snapshot()).blockedMayBreak, undefined);
});

test("#1168: an action that times out on a page with blocked ads says the site may need them", async () => {
  const page = createFakePage();
  page.locator = () => ({
    click: async () => {
      throw new Error("locator.click: Timeout 5000ms exceeded.");
    },
  });
  const noAds = createBrowserSession({ page });
  await assert.rejects(() => noAds.click("e5"), (e) => !/may need/.test(e.message));

  const session = createBrowserSession({ page, pageHealth: () => ({ blockedAds: 2, pageErrors: 0 }) });
  await assert.rejects(
    () => session.click("e5"),
    (e) => /Timeout 5000ms exceeded\. -- this site may need the 2 ad or tracker requests that were blocked/.test(e.message) && e.blockedMayBreak === 2,
  );
});

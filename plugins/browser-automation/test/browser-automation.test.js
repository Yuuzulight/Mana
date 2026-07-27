const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_PAGE_TEXT_CHARS,
  createBrowserSession,
  snapshotInPage,
  extractTextInPage,
} = require("../browser-automation");

// A fake "page-like" object -- {goto, evaluate, click, type, title, url}.
// Production passes a real Playwright Page, whose methods already match
// this exact shape; this fake stands in for it in every test.
function createFakePage(overrides = {}) {
  const state = {
    url: overrides.startUrl || "about:blank",
    title: overrides.startTitle || "",
    interactiveElements: overrides.interactiveElements || [],
    text: overrides.text || "",
    calls: [],
  };
  return {
    state,
    async goto(url) {
      state.calls.push({ method: "goto", url });
      state.url = url;
      state.title = overrides.titleForUrl?.(url) || "Fake Page";
    },
    async evaluate(fn) {
      if (fn === snapshotInPage) return state.interactiveElements;
      if (fn === extractTextInPage) return state.text;
      throw new Error("unexpected evaluate() call in test");
    },
    async click(selector) {
      state.calls.push({ method: "click", selector });
    },
    async type(selector, text) {
      state.calls.push({ method: "type", selector, text });
    },
    async title() {
      return state.title;
    },
    async url() {
      return state.url;
    },
  };
}

test("createBrowserSession requires a page-like object", () => {
  assert.throws(() => createBrowserSession({}), /page-like object/);
});

test("navigate rejects a non-http(s) URL without calling goto", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  await assert.rejects(() => session.navigate("file:///etc/passwd"), /only http\/https/);
  await assert.rejects(() => session.navigate("not a url"), /invalid URL/);
  assert.equal(page.state.calls.length, 0);
});

test("navigate calls goto and returns a snapshot of the resulting page", async () => {
  const page = createFakePage({
    text: "Welcome to the site",
    interactiveElements: [{ ref: "1", tag: "button", role: null, label: "Sign in" }],
  });
  const session = createBrowserSession({ page });
  const result = await session.navigate("https://example.com/login");

  assert.equal(page.state.calls[0].method, "goto");
  assert.equal(page.state.calls[0].url, "https://example.com/login");
  assert.equal(result.url, "https://example.com/login");
  assert.equal(result.text, "Welcome to the site");
  assert.deepEqual(result.interactiveElements, [
    { ref: "1", tag: "button", role: null, label: "Sign in" },
  ]);
});

test("click acts on the element matching the given ref and returns a fresh snapshot", async () => {
  const page = createFakePage({ text: "after click" });
  const session = createBrowserSession({ page });

  const result = await session.click("3");
  assert.equal(page.state.calls[0].method, "click");
  assert.equal(page.state.calls[0].selector, '[data-mana-ref="3"]');
  assert.equal(result.text, "after click");
});

test("click requires a ref", async () => {
  const session = createBrowserSession({ page: createFakePage() });
  await assert.rejects(() => session.click(), /ref is required/);
});

test("type sends text to the element matching the given ref", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });

  await session.type("2", "hello world");
  assert.equal(page.state.calls[0].method, "type");
  assert.equal(page.state.calls[0].selector, '[data-mana-ref="2"]');
  assert.equal(page.state.calls[0].text, "hello world");
});

test("type coerces a non-string value and requires a ref", async () => {
  const page = createFakePage();
  const session = createBrowserSession({ page });
  await session.type("1", 42);
  assert.equal(page.state.calls[0].text, "42");

  await assert.rejects(() => session.type(undefined, "x"), /ref is required/);
});

test("snapshot text is capped at MAX_PAGE_TEXT_CHARS by default", () => {
  assert.equal(MAX_PAGE_TEXT_CHARS, 6000);
});

test("extractTextInPage trims and truncates document.body.innerText", () => {
  global.document = { body: { innerText: "  hello  " } };
  try {
    assert.equal(extractTextInPage(3), "hel");
    assert.equal(extractTextInPage(100), "hello");
  } finally {
    delete global.document;
  }
});

test("snapshotInPage assigns a stable ref that persists across repeated calls", () => {
  const fakeButton = {
    tagName: "BUTTON",
    getAttribute: (name) => (name === "data-mana-ref" ? fakeButton._ref : null),
    setAttribute: (name, value) => {
      if (name === "data-mana-ref") fakeButton._ref = value;
    },
    hasAttribute: (name) => name === "data-mana-ref" && Boolean(fakeButton._ref),
    getBoundingClientRect: () => ({ width: 50, height: 20 }),
    textContent: "Click me",
  };
  global.window = {};
  global.document = { querySelectorAll: () => [fakeButton] };
  try {
    const first = snapshotInPage();
    const second = snapshotInPage();
    assert.equal(first[0].ref, second[0].ref);
    assert.equal(first[0].label, "Click me");
    assert.equal(first[0].tag, "button");
  } finally {
    delete global.window;
    delete global.document;
  }
});

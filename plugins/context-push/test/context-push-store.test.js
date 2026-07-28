const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createContextPushStore,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} = require("../context-push-store");

test("push requires a url", () => {
  const store = createContextPushStore();
  assert.throws(() => store.push({ title: "no url" }), /url is required/);
});

test("push then getCurrent returns the stored entry", () => {
  const store = createContextPushStore();
  store.push({ url: "https://example.com", title: "Example", text: "hello world" });
  const current = store.getCurrent();
  assert.equal(current.url, "https://example.com");
  assert.equal(current.title, "Example");
  assert.equal(current.text, "hello world");
});

test("push overwrites the previous entry -- only ever one current entry", () => {
  const store = createContextPushStore();
  store.push({ url: "https://a.example", title: "A" });
  store.push({ url: "https://b.example", title: "B" });
  assert.equal(store.getCurrent().url, "https://b.example");
});

test("push clamps oversized fields instead of storing them unbounded", () => {
  const store = createContextPushStore();
  store.push({
    url: "https://example.com",
    title: "x".repeat(MAX_TITLE_CHARS + 500),
    text: "y".repeat(MAX_TEXT_CHARS + 500),
  });
  const current = store.getCurrent();
  assert.equal(current.title.length, MAX_TITLE_CHARS);
  assert.equal(current.text.length, MAX_TEXT_CHARS);
});

test("push clamps an oversized url too", () => {
  const store = createContextPushStore();
  store.push({ url: `https://example.com/${"z".repeat(MAX_URL_CHARS)}` });
  assert.equal(store.getCurrent().url.length, MAX_URL_CHARS);
});

test("getCurrent returns null and clears state once the entry expires", () => {
  let time = 1000;
  const store = createContextPushStore({ ttlMs: 100, now: () => time });
  store.push({ url: "https://example.com" });
  assert.ok(store.getCurrent());
  time += 101;
  assert.equal(store.getCurrent(), null);
  // Confirmed cleared, not just expired-but-still-checked each time.
  time -= 50;
  assert.equal(store.getCurrent(), null);
});

test("getCurrent returns null before anything has been pushed", () => {
  const store = createContextPushStore();
  assert.equal(store.getCurrent(), null);
});

test("clear removes the current entry immediately", () => {
  const store = createContextPushStore();
  store.push({ url: "https://example.com" });
  store.clear();
  assert.equal(store.getCurrent(), null);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const { looksLikeReference, buildContextForPrompt } = require("../context-push");

test("looksLikeReference matches obvious page/video references", () => {
  assert.equal(looksLikeReference("what does this page say"), true);
  assert.equal(looksLikeReference("what am I watching"), true);
  assert.equal(looksLikeReference("read the article for me"), true);
  assert.equal(looksLikeReference("what's the caption say"), true);
});

test("looksLikeReference does not match unrelated messages", () => {
  assert.equal(looksLikeReference("what time is it"), false);
  assert.equal(looksLikeReference("tell me a joke"), false);
  assert.equal(looksLikeReference(""), false);
});

test("buildContextForPrompt returns empty string with no active entry", () => {
  assert.equal(buildContextForPrompt("what does this page say", null), "");
});

test("buildContextForPrompt returns empty string when the message doesn't reference it", () => {
  const entry = { url: "https://example.com", title: "Example", text: "hello" };
  assert.equal(buildContextForPrompt("what time is it", entry), "");
});

test("buildContextForPrompt includes title/url/text when the message references the page", () => {
  const entry = { url: "https://example.com", title: "Example Site", text: "Some page content." };
  const result = buildContextForPrompt("what does this page say", entry);
  assert.match(result, /Example Site/);
  assert.match(result, /https:\/\/example\.com/);
  assert.match(result, /Some page content\./);
});

test("buildContextForPrompt includes video captions when present", () => {
  const entry = {
    url: "https://youtube.com/watch?v=x",
    title: "A Video",
    text: "",
    videoSubtitle: "hello and welcome",
  };
  const result = buildContextForPrompt("what's this video about", entry);
  assert.match(result, /hello and welcome/);
});

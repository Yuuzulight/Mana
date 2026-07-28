const { createContextPushStore } = require("./context-push-store");

const store = createContextPushStore();

// Issue #189: contributes context "if asked", not on every single reply --
// unconditionally injecting a page dump into every message would make
// every reply implicitly "aware" of browsing regardless of relevance, and
// bloat context for no reason. Same self-guarding pattern as
// ffxiv-market/stock-market's contributePromptContext.
const REFERENCE_KEYWORDS = [
  "page",
  "website",
  "site",
  "tab",
  "browser",
  "browsing",
  "looking at",
  "reading",
  "article",
  "video",
  "watching",
  "subtitle",
  "caption",
  "this",
];

function looksLikeReference(text) {
  const lower = String(text || "").toLowerCase();
  return REFERENCE_KEYWORDS.some((kw) => lower.includes(kw));
}

function buildContextForPrompt(text, entry) {
  if (!entry || !looksLikeReference(text)) return "";

  const lines = [`Current browser tab: "${entry.title}" (${entry.url})`];
  if (entry.videoSubtitle) {
    lines.push(`Video captions currently visible: ${entry.videoSubtitle}`);
  }
  if (entry.text) {
    lines.push(`Page text: ${entry.text}`);
  }
  return lines.join("\n");
}

async function contributePromptContext(text) {
  return buildContextForPrompt(text, store.getCurrent());
}

module.exports = {
  store,
  looksLikeReference,
  buildContextForPrompt,
  contributePromptContext,
};

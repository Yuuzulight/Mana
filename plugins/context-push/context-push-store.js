// Issue #189: ephemeral "what the user is currently looking at" state, fed
// by a browser extension's content script. Deliberately in-memory only
// (never written to disk, never fed into acp-memory-store's retriever) --
// this is live, private browsing context, not something that should
// survive a restart or turn into a permanent record of every page
// visited.

const MAX_TEXT_CHARS = 4000;
const MAX_TITLE_CHARS = 300;
const MAX_URL_CHARS = 2000;
const MAX_SUBTITLE_CHARS = 2000;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // "expires quickly" per the issue

function clamp(value, maxLength) {
  const s = String(value || "");
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

function createContextPushStore(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const now = options.now || (() => Date.now());
  let current = null;

  function push({ url, title, text, videoSubtitle } = {}) {
    if (!url || typeof url !== "string") {
      throw new Error("url is required");
    }
    current = {
      url: clamp(url, MAX_URL_CHARS),
      title: clamp(title, MAX_TITLE_CHARS),
      text: clamp(text, MAX_TEXT_CHARS),
      videoSubtitle: clamp(videoSubtitle, MAX_SUBTITLE_CHARS),
      receivedAt: now(),
    };
    return { ok: true };
  }

  // Returns null once the entry ages past ttlMs, rather than serving stale
  // "what you were looking at 20 minutes ago" as if it were current.
  function getCurrent() {
    if (!current) return null;
    if (now() - current.receivedAt > ttlMs) {
      current = null;
      return null;
    }
    return current;
  }

  function clear() {
    current = null;
  }

  return { push, getCurrent, clear, ttlMs };
}

module.exports = { createContextPushStore, MAX_TEXT_CHARS, MAX_TITLE_CHARS, MAX_URL_CHARS, MAX_SUBTITLE_CHARS, DEFAULT_TTL_MS };

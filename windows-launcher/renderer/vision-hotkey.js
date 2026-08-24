// Shared logic for the global "look at my screen" hotkey. Kept DOM-free so
// the launcher tests can cover it directly.

const DEFAULT_VISION_HOTKEY_PROMPT =
  "Take a look at my screen and tell me what you see. Answer briefly.";

// Issue #450: the clip-review hotkey sends several frames spanning the last
// few seconds instead of one. The span is stated explicitly and computed
// from the buffer's real timestamps rather than hardcoding the target ~15s
// window, since claiming a longer span than what's actually captured (e.g.
// right after app start, before the buffer has filled) would give the
// vision model a false premise to reason from -- verified as the deciding
// factor when this was put to a 30-way agent vote.
function buildClipHotkeyPrompt(spanSeconds) {
  const rounded = Math.round(spanSeconds || 0);
  if (rounded < 1) {
    return "Look back at what just happened and tell me. Answer briefly.";
  }
  return `Look back over the last ${rounded} second${rounded === 1 ? "" : "s"} and tell me what just happened. Answer briefly.`;
}

function describeVisionHotkeyError(status, detail) {
  if (status === 503) {
    return "Mana has no vision model installed. See docs/vision_setup.md.";
  }
  const trimmed = String(detail || "").trim();
  return trimmed
    ? `Mana couldn't look at the screen: ${trimmed}`
    : "Mana couldn't look at the screen.";
}

async function extractReplyErrorDetail(response) {
  try {
    const body = await response.json();
    return body.detail || body.error || "";
  } catch (e) {
    try {
      return await response.text();
    } catch (e2) {
      return "";
    }
  }
}

module.exports = {
  DEFAULT_VISION_HOTKEY_PROMPT,
  buildClipHotkeyPrompt,
  describeVisionHotkeyError,
  extractReplyErrorDetail,
};

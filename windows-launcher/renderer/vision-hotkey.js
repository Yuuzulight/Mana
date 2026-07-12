// Shared logic for the global "look at my screen" hotkey. Kept DOM-free so
// the launcher tests can cover it directly.

const DEFAULT_VISION_HOTKEY_PROMPT =
  "Take a look at my screen and tell me what you see. Answer briefly.";

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
  describeVisionHotkeyError,
  extractReplyErrorDetail,
};

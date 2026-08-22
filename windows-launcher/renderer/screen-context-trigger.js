// Issue #344: deterministic keyword-based gate for whether a conversational
// turn should trigger a screen read, instead of either "always" (a privacy
// concern -- ambient capture on every turn, previously the non-gaming
// default) or requiring an explicit hotkey. The gaming-mode gate this
// reuses was added for a different reason (a latency throttle -- "Tune
// Mana performance for gaming"), but the mechanism -- a fixed keyword list,
// no model call -- is exactly what this issue asks for, so it's now
// applied outside gaming mode too, toggleable independently.
//
// Kept dependency-free (accepts already-cleaned/lowercased text) so it's
// testable without electron, same split as accessibility-tree.js.

const SCREEN_CONTEXT_KEYWORDS = [
  "screen",
  "see",
  "seeing",
  "look",
  "looking",
  "read",
  "icon",
  "image",
  "picture",
  "menu",
  "chat",
  "game",
  "ffxiv",
  "map",
  "quest",
  "window",
  // Issue #344's own motivating example ("what does this error say") needs
  // this -- none of the words above appear in it.
  "error",
];

function shouldReadScreenForCommand(normalizedText, options = {}) {
  const { gamingModeActive = false, keywordGateEnabled = true } = options;
  if (!gamingModeActive && !keywordGateEnabled) {
    return true;
  }
  return SCREEN_CONTEXT_KEYWORDS.some((keyword) => normalizedText.includes(keyword));
}

module.exports = { SCREEN_CONTEXT_KEYWORDS, shouldReadScreenForCommand };

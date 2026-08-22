// Pure logic for issue #343's UI-Automation-tree screen-context path, kept
// separate from main.js so it's testable without requiring "electron" (same
// pure-logic-vs-orchestration split proactive-notifications.js already
// uses). No electron dependency -- both main.js (to read the focused
// window's owning process id, to detect "the focused window is Mana's own
// launcher") and renderer.js (to decide whether the tree beat the
// empty-tree threshold) require this directly.

const OUTPUT_SEPARATOR = "---";
const MIN_USABLE_LINES = 3;
const MIN_USABLE_CHARS = 20;

// Parses read-accessibility-tree.ps1's stdout: a "PID:<n>" line, a "---"
// separator, then the extracted element text (one Name/Value per line).
function parseAccessibilityTreeOutput(stdout) {
  const raw = String(stdout || "");
  const separatorIndex = raw.indexOf(OUTPUT_SEPARATOR);
  if (separatorIndex === -1) {
    return { ownerPid: 0, text: "" };
  }
  const pidLine = raw.slice(0, separatorIndex);
  const match = pidLine.match(/PID:(\d+)/);
  const ownerPid = match ? Number(match[1]) : 0;
  const text = raw.slice(separatorIndex + OUTPUT_SEPARATOR.length).trim();
  return { ownerPid, text };
}

// A token tree (one generic pane, a blank window title) technically isn't a
// failure, but carries nothing worth using over OCR -- require a few
// distinct non-empty lines and a minimum length before trusting it over the
// existing screenshot+OCR path.
function isAccessibilityTreeTextUsable(text) {
  const value = String(text || "").trim();
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length >= MIN_USABLE_LINES && value.length >= MIN_USABLE_CHARS;
}

module.exports = {
  MIN_USABLE_LINES,
  MIN_USABLE_CHARS,
  parseAccessibilityTreeOutput,
  isAccessibilityTreeTextUsable,
};

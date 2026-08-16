// Issue #357: the editable half of Mana's identity. persona.js holds the
// immutable core -- what Mana fundamentally is, which feedback cannot move
// -- and this holds the part that should move: tone, formality, verbosity.
// The split is the point. "Be more casual" adjusts how she speaks; it must
// never be able to erode who she is, and a single editable blob would make
// that distinction impossible to keep.
//
// One JSON file rather than per-item files, same reasoning presets-store.js
// gives: there is exactly one personality and it is small.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_FILE_PATH = path.join(__dirname, "data", "personality.json");
// Bounded like acp-memory-store's MAX_FACT_HISTORY. This is enough depth to
// walk back a bad adjustment, not an audit log -- "be more chill" overshot
// and needs undoing is the case being served.
const MAX_HISTORY = 10;
const MAX_TRAITS_CHARS = 600;

function cleanTraits(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TRAITS_CHARS);
}

// options.filePath: injectable so tests never write into node-bot's real
// data directory (same pattern as presets-store.js/acp-memory-store.js).
function createPersonalityStore(options = {}) {
  const filePath = options.filePath || DEFAULT_FILE_PATH;
  const now = options.now || (() => new Date().toISOString());

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        traits: cleanTraits(parsed?.traits),
        updatedAt: parsed?.updatedAt || null,
        reason: parsed?.reason || null,
        history: Array.isArray(parsed?.history) ? parsed.history : [],
      };
    } catch (e) {
      // Missing or unreadable file means no adjustment has been made yet,
      // which is a valid state -- Mana runs on her core alone.
      return { traits: "", updatedAt: null, reason: null, history: [] };
    }
  }

  function write(state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
    return state;
  }

  function get() {
    return read();
  }

  // reason is what the user actually said ("be more chill"), kept alongside
  // the value it produced so the history reads as a sequence of decisions
  // rather than a diff of anonymous strings.
  function set(traits, options2 = {}) {
    const cleaned = cleanTraits(traits);
    if (!cleaned) {
      throw new Error("traits is required");
    }
    const current = read();
    const history = current.traits
      ? [
          ...current.history,
          { traits: current.traits, updatedAt: current.updatedAt, reason: current.reason },
        ]
      : current.history;
    return write({
      traits: cleaned,
      updatedAt: now(),
      reason: cleanTraits(options2.reason) || null,
      history: history.slice(-MAX_HISTORY),
    });
  }

  // "Be more casual" is easy to overshoot, so stepping back has to be one
  // action rather than the user reconstructing the old wording from memory.
  function revert() {
    const current = read();
    const previous = current.history[current.history.length - 1];
    if (!previous) return current;
    return write({
      traits: cleanTraits(previous.traits),
      updatedAt: now(),
      reason: previous.reason || null,
      history: current.history.slice(0, -1),
    });
  }

  // Back to the core alone. Recorded in history like any other change, so
  // it is just as reversible as an adjustment.
  function clear() {
    const current = read();
    if (!current.traits) return current;
    return write({
      traits: "",
      updatedAt: now(),
      reason: null,
      history: [
        ...current.history,
        { traits: current.traits, updatedAt: current.updatedAt, reason: current.reason },
      ].slice(-MAX_HISTORY),
    });
  }

  return { filePath, get, set, revert, clear };
}

module.exports = { createPersonalityStore, MAX_HISTORY, DEFAULT_FILE_PATH };

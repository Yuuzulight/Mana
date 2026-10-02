// Issue #700: Mana's mood -- a slow state (energy, sociability, stress)
// that drifts over the day and reacts to what happens, so she feels alive
// across a day rather than per reply. The hard limit from the design: mood
// only ever changes *how* she says things -- never whether she helps, how
// carefully, or how correct she is. So it reaches the model as tone and
// length guidance only, never as a token budget, a tool list or a
// decision, and task-shaped (coding) replies don't get it at all.
//
// Kept apart from acp-memory-store's emotional-state.json on purpose: that
// file is the *user's* affect and is rewritten whole on every turn.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = { energy: 0.7, sociability: 0.5, stress: 0.2 };
const KEYS = Object.keys(DEFAULTS);

// Per-event nudges, each with a daily cap so none can be farmed (praising
// her fifty times doesn't make her fifty times calmer). "turn" is one chat
// message: a long chat drains energy and slowly sates her sociability.
const EVENTS = {
  turn: { delta: { energy: -0.02, sociability: -0.02 }, dailyCap: 60 },
  praise: { delta: { stress: -0.1, sociability: 0.05 }, dailyCap: 5 },
  task_failed: { delta: { stress: 0.08 }, dailyCap: 6 },
  approval_rejected: { delta: { stress: 0.1 }, dailyCap: 4 },
};

// Quiet time (between messages, overnight, PC off -- it's all wall-clock
// time since the last update): energy recovers toward full, stress eases
// toward none, and sociability builds toward missing you. Half-lives in
// hours; a night's sleep restores most of the energy a long session drained.
const REST_HALF_LIVES = { energy: 4, stress: 6, sociability: 12 };
const REST_TARGETS = { energy: 1, stress: 0, sociability: 1 };
// A gap this long is worth a line in the history ("rested 8h").
const REST_HISTORY_MIN_HOURS = 1;
const MAX_HISTORY = 50;

const PRAISE_PATTERN =
  /\b(thanks|thank you|thx|good (job|girl|work)|great (job|work)|nice (job|work|one)|well done|you'?re (the best|amazing|awesome|great|so smart)|love you|you rock)\b/i;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const round = (value) => Math.round(value * 1000) / 1000;

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// In the morning she's a little brighter whatever the stored value says;
// this is a view-time nudge, not stored, so it never compounds. No
// late-night dip: removed at the user's request (Q32).
function timeOfDayEnergyNudge(ms) {
  const hour = new Date(ms).getHours();
  if (hour >= 7 && hour < 11) return 0.05;
  return 0;
}

function freshState(ms) {
  return {
    ...DEFAULTS,
    frozen: false,
    updatedAt: new Date(ms).toISOString(),
    counts: { day: localDay(ms), byEvent: {} },
    history: [],
  };
}

function normalize(parsed, ms) {
  const state = freshState(ms);
  if (!parsed || typeof parsed !== "object") return state;
  for (const key of KEYS) {
    if (Number.isFinite(parsed[key])) state[key] = clamp01(parsed[key]);
  }
  state.frozen = parsed.frozen === true;
  if (!Number.isNaN(Date.parse(parsed.updatedAt))) state.updatedAt = parsed.updatedAt;
  if (parsed.counts && typeof parsed.counts.day === "string") {
    state.counts = { day: parsed.counts.day, byEvent: { ...parsed.counts.byEvent } };
  }
  if (Array.isArray(parsed.history)) state.history = parsed.history.slice(-MAX_HISTORY);
  return state;
}

function pushHistory(state, entry) {
  state.history = [...state.history, entry].slice(-MAX_HISTORY);
}

// Applies quiet-time drift from state.updatedAt up to ms. A frozen mood
// doesn't drift -- freeze means steady.
function advance(state, ms) {
  const hours = (ms - Date.parse(state.updatedAt)) / 3600000;
  if (state.frozen || !(hours > 0)) return state;
  const before = { energy: state.energy, sociability: state.sociability, stress: state.stress };
  for (const key of KEYS) {
    const kept = Math.pow(0.5, hours / REST_HALF_LIVES[key]);
    state[key] = clamp01(REST_TARGETS[key] + (state[key] - REST_TARGETS[key]) * kept);
  }
  state.updatedAt = new Date(ms).toISOString();
  if (hours >= REST_HISTORY_MIN_HOURS) {
    const change = {};
    for (const key of KEYS) change[key] = round(state[key] - before[key]);
    pushHistory(state, { at: state.updatedAt, event: "rest", hours: round(hours), change });
  }
  return state;
}

function levelWord(value) {
  if (value < 0.35) return "low";
  if (value > 0.65) return "high";
  return "moderate";
}

// A short line for the tray tooltip / status line, e.g. "tired, chatty".
function describeMood(mood) {
  if (mood.frozen) return "steady (mood frozen)";
  const words = [];
  if (mood.energy < 0.35) words.push("tired");
  else if (mood.energy > 0.75) words.push("lively");
  if (mood.sociability > 0.7) words.push("chatty");
  else if (mood.sociability < 0.3) words.push("talked out");
  if (mood.stress > 0.6) words.push("stressed");
  else if (mood.stress < 0.2) words.push("calm");
  return words.length ? words.join(", ") : "okay";
}

// Part of #700: the one emotion tag (utils/emotion-tags.js) her mood leans
// toward, or null when it doesn't lean. Clients reuse the tag paths they
// already have: her idle face, and /synthesize's pace for an untagged
// sentence (a few percent slower or faster, never more).
function moodEmotion(mood) {
  if (!mood || mood.frozen) return null;
  if (mood.stress > 0.6 || mood.energy < 0.35) return "thinking";
  if (mood.energy > 0.75 || mood.sociability > 0.7) return "happy";
  return null;
}

// The system-message text for one reply, or null when mood shouldn't show:
// frozen (steady neutral Mana), or a coding/developer reply -- the
// task-performing mode, where only the work matters.
function moodPromptBlock(mood, mode) {
  if (!mood || mood.frozen) return null;
  if (mode === "coding" || mode === "developer") return null;
  const hints = [];
  if (mood.energy < 0.35) hints.push("you're tired: keep replies shorter and a little sleepy");
  else if (mood.energy > 0.75) hints.push("you're full of energy: a bit more upbeat");
  // Part of #700: missing them never turns into guilt or prying.
  if (mood.sociability > 0.7) {
    hints.push(
      "you've missed them: be chattier and tease a little more, but say you missed them lightly and at most once, never guilt-trip, never ask why they were away, and be glad they have other plans and people",
    );
  }
  else if (mood.sociability < 0.3) hints.push("you've talked a lot today: keep the small talk light");
  if (mood.stress > 0.6) hints.push("you're a little frazzled: a touch terse, but still patient");
  const pct = (value) => `${Math.round(value * 100)}%`;
  return [
    `Your mood right now (it's real -- if asked how you feel, answer honestly from it): energy ${levelWord(mood.energy)} (${pct(mood.energy)}), sociability ${levelWord(mood.sociability)} (${pct(mood.sociability)}), stress ${levelWord(mood.stress)} (${pct(mood.stress)}).`,
    hints.length ? `Let it color your tone: ${hints.join("; ")}.` : "",
    "Never say these numbers or percentages out loud: if it comes up, put it in words.",
    "Mood only changes how you say things: never whether you help, how thoroughly, or how accurate you are.",
  ]
    .filter(Boolean)
    .join("\n");
}

// options.filePath: where the mood persists across restarts; omit it for
// an in-memory store (tests, and server.js under NODE_ENV=test).
// options.now: injectable clock (ms), for drift/cap tests.
function createMoodStore(options = {}) {
  const filePath = options.filePath || null;
  const now = options.now || (() => Date.now());
  let memoryState = null;

  function load(ms) {
    if (!filePath) return memoryState ? normalize(memoryState, ms) : freshState(ms);
    try {
      return normalize(JSON.parse(fs.readFileSync(filePath, "utf8")), ms);
    } catch (e) {
      // Missing or corrupt: start from the defaults, like any other store here.
      return freshState(ms);
    }
  }

  function save(state) {
    if (!filePath) {
      memoryState = state;
      return;
    }
    // Mood is flavour: a failed write is logged, never thrown into the
    // reply, denial or tool call that triggered it.
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
      console.warn("Failed to save mood:", e.message);
    }
  }

  function view(state, ms) {
    const energy = state.frozen ? state.energy : clamp01(state.energy + timeOfDayEnergyNudge(ms));
    const mood = {
      energy: round(energy),
      sociability: round(state.sociability),
      stress: round(state.stress),
      frozen: state.frozen,
      updatedAt: state.updatedAt,
      history: state.history,
    };
    mood.summary = describeMood(mood);
    mood.emotion = moodEmotion(mood);
    return mood;
  }

  // Current mood, with drift up to now (read-only: nothing is persisted).
  function get() {
    const ms = now();
    return view(advance(load(ms), ms), ms);
  }

  // Applies one event (see EVENTS). Ignored while frozen or once today's
  // cap for that event is reached; returns the resulting mood either way.
  function record(event) {
    const spec = EVENTS[event];
    if (!spec) throw new Error(`unknown mood event: ${event}`);
    const ms = now();
    const state = advance(load(ms), ms);
    if (state.frozen) return view(state, ms);
    const day = localDay(ms);
    if (state.counts.day !== day) state.counts = { day, byEvent: {} };
    const used = state.counts.byEvent[event] || 0;
    if (used >= spec.dailyCap) return view(state, ms);
    state.counts.byEvent[event] = used + 1;
    const change = {};
    for (const [key, delta] of Object.entries(spec.delta)) {
      const next = clamp01(state[key] + delta);
      change[key] = round(next - state[key]);
      state[key] = next;
    }
    state.updatedAt = new Date(ms).toISOString();
    pushHistory(state, { at: state.updatedAt, event, change });
    save(state);
    return view(state, ms);
  }

  // One user chat message: the turn itself, plus praise if it was praise.
  function recordTurn(text) {
    record("turn");
    if (PRAISE_PATTERN.test(String(text || ""))) record("praise");
  }

  function reset() {
    const ms = now();
    const state = freshState(ms);
    pushHistory(state, { at: state.updatedAt, event: "reset" });
    save(state);
    return view(state, ms);
  }

  // Freeze holds the values steady (no drift, no events) and Mana acts
  // neutral; unfreezing resumes from the held values, the frozen stretch
  // not counting as rest.
  function setFrozen(frozen) {
    const ms = now();
    const state = advance(load(ms), ms);
    state.frozen = Boolean(frozen);
    state.updatedAt = new Date(ms).toISOString();
    pushHistory(state, { at: state.updatedAt, event: state.frozen ? "freeze" : "unfreeze" });
    save(state);
    return view(state, ms);
  }

  return { get, record, recordTurn, reset, setFrozen };
}

module.exports = { DEFAULTS, EVENTS, createMoodStore, levelWord, moodEmotion, moodPromptBlock };

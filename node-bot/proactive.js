// Issue #697: the core of proactive Mana. Anything that wants to speak up
// unprompted offers a candidate here instead of toasting directly. A
// candidate goes out only if its score clears the threshold and the daily
// budget has room (urgent ones skip both), never while a game is being
// played except one per detected break, and a minute apart so remarks don't
// arrive in a burst. Held candidates wait for a later flush (server.js runs
// one every 30 s) and expire when stale. Delivery is today's proactive
// toast path (tray-notifier). An explicit candidate -- something the user
// asked for, like a reminder (#905) -- is urgent and also gets through
// mid-game.
const fs = require("node:fs");
const path = require("node:path");
const { notifyTray } = require("./tray-notifier");

const SCORE_THRESHOLD = 0.5;
// The issue's starting budget is "around 6-8" a day; adapting it (3-10)
// from engagement comes with learning from reactions.
const DAILY_BUDGET = 7;
// "Your build finished" is stale after an hour.
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_HELD = 20;
const MIN_GAP_MS = 60 * 1000;

// candidate: { reason, payload, score (0..1, default 1), urgent, explicit, ttlMs }.
// payload is the tray notification, sent as-is.
function createProactive({ deliver, isGaming = () => false, inBreak = () => false, now = Date.now }) {
  let held = [];
  let day = "";
  let spentToday = 0;
  let breakUsed = false;
  let lastSentAt = -Infinity;
  let file = null;

  // #986: held candidates and today's spend survive a backend restart.
  function persistTo(filePath) {
    file = filePath;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      held = Array.isArray(saved.held) ? saved.held.filter((c) => c?.payload && Number.isFinite(c.expiresAt)) : [];
      day = typeof saved.day === "string" ? saved.day : "";
      spentToday = Number(saved.spentToday) || 0;
    } catch {
      // Nothing saved yet, or unreadable: start empty; the next change rewrites it.
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ held, day, spentToday }), "utf8");
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.warn(`Couldn't save held remarks to ${file}:`, e.message);
    }
  }

  // Delivers at most one held candidate and returns it (or null).
  function flush() {
    const t = now();
    const count = held.length;
    held = held.filter((c) => c.expiresAt > t);
    const today = new Date(t).toDateString();
    if (today !== day) {
      day = today;
      spentToday = 0;
    }
    const gaming = isGaming();
    const inGameBreak = gaming && inBreak();
    if (!inGameBreak) breakUsed = false;
    const gameHold = gaming && (!inGameBreak || breakUsed);
    const next = t - lastSentAt < MIN_GAP_MS ? null : held.find((c) => (gameHold ? c.explicit : c.urgent || spentToday < DAILY_BUDGET));
    if (next) {
      held.splice(held.indexOf(next), 1);
      if (!next.urgent) spentToday += 1;
      if (inGameBreak && !next.explicit) breakUsed = true;
      lastSentAt = t;
      Promise.resolve()
        .then(() => deliver(next.payload))
        .catch(() => {});
    }
    if (held.length !== count) save();
    return next ?? null;
  }

  // Returns "delivered", "held" or "dropped".
  function offer({ reason, payload, score = 1, urgent = false, explicit = false, ttlMs = DEFAULT_TTL_MS }) {
    urgent = Boolean(urgent || explicit);
    if (!urgent && !(score >= SCORE_THRESHOLD)) return "dropped";
    if (held.some((c) => c.reason === reason && c.payload.text === payload.text)) return "held";
    const candidate = { reason, payload, score, urgent, explicit: Boolean(explicit), expiresAt: now() + ttlMs };
    held.push(candidate);
    held.sort((a, b) => b.urgent - a.urgent || b.score - a.score);
    held = held.slice(0, MAX_HELD);
    const delivered = flush() === candidate;
    save();
    if (delivered) return "delivered";
    return held.includes(candidate) ? "held" : "dropped";
  }

  // #1124: what's waiting, for the launcher's Background tasks panel.
  function listHeld() {
    return held.map(({ reason, payload, urgent, expiresAt }) => ({ reason, title: payload.title, text: payload.text, urgent, expiresAt }));
  }

  return { offer, flush, persistTo, listHeld };
}

// The process-wide instance; server.js hands it the gaming watch, its file
// and who's speaking.
let gamingCheck = () => false;
let breakCheck = () => false;
// #914: the active character when it goes out (a held remark can outlast a
// switch), named in the toast unless she's Mana (null).
let speakerName = () => null;
const proactive = createProactive({
  deliver: (payload) => {
    const name = speakerName();
    return notifyTray(name ? { ...payload, title: payload.title ? `${name}: ${payload.title}` : name } : payload);
  },
  isGaming: () => gamingCheck(),
  inBreak: () => breakCheck(),
});

function watchGaming(isGaming, inBreak = () => false) {
  gamingCheck = isGaming;
  breakCheck = inBreak;
}

function watchSpeaker(nameOf) {
  speakerName = nameOf;
}

module.exports = {
  createProactive,
  watchGaming,
  watchSpeaker,
  offer: proactive.offer,
  flush: proactive.flush,
  persistTo: proactive.persistTo,
  listHeld: proactive.listHeld,
  DAILY_BUDGET,
};

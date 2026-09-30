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
// ponytail: held candidates live in memory, so a restart drops them.
function createProactive({ deliver, isGaming = () => false, inBreak = () => false, now = Date.now }) {
  let held = [];
  let day = "";
  let spentToday = 0;
  let breakUsed = false;
  let lastSentAt = -Infinity;

  // Delivers at most one held candidate and returns it (or null).
  function flush() {
    const t = now();
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
    if (t - lastSentAt < MIN_GAP_MS) return null;
    const next = held.find((c) => (gameHold ? c.explicit : c.urgent || spentToday < DAILY_BUDGET));
    if (!next) return null;
    held.splice(held.indexOf(next), 1);
    if (!next.urgent) spentToday += 1;
    if (inGameBreak && !next.explicit) breakUsed = true;
    lastSentAt = t;
    Promise.resolve()
      .then(() => deliver(next.payload))
      .catch(() => {});
    return next;
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
    if (flush() === candidate) return "delivered";
    return held.includes(candidate) ? "held" : "dropped";
  }

  return { offer, flush };
}

// The process-wide instance; server.js hands it the gaming watch.
let gamingCheck = () => false;
let breakCheck = () => false;
const proactive = createProactive({
  deliver: notifyTray,
  isGaming: () => gamingCheck(),
  inBreak: () => breakCheck(),
});

function watchGaming(isGaming, inBreak = () => false) {
  gamingCheck = isGaming;
  breakCheck = inBreak;
}

module.exports = {
  createProactive,
  watchGaming,
  offer: proactive.offer,
  flush: proactive.flush,
  DAILY_BUDGET,
};

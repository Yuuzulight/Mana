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
//
// #1282: non-urgent remarks are also held during quiet hours (a window,
// off by default), while "not now" snoozes them, and while I'm away (idle
// past the launcher's idle threshold). "Never for this kind" mutes one
// reason until it's turned back on: those are dropped, not held, except
// explicit ones -- I asked for those.
const fs = require("node:fs");
const path = require("node:path");
const { notifyTray, hasListeners } = require("./tray-notifier");

const SCORE_THRESHOLD = 0.5;
// The issue's starting budget is "around 6-8" a day; adapting it (3-10)
// from engagement comes with learning from reactions.
const DAILY_BUDGET = 7;
// "Your build finished" is stale after an hour.
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_HELD = 20;
const MIN_GAP_MS = 60 * 1000;
const DEFAULT_SNOOZE_MINUTES = 60;
const MAX_REASON_CHARS = 40;

function defaultSettings() {
  return { quietHours: { enabled: false, start: "01:00", end: "09:00" }, snoozedUntil: 0, muted: [] };
}

function minutesOfDay(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!(hour <= 23 && minute <= 59)) throw new Error("quiet hours take 24-hour HH:MM times, e.g. 01:00");
  return hour * 60 + minute;
}

// The window may cross midnight (01:00-09:00 doesn't, 23:00-07:00 does).
function inQuietHours({ enabled, start, end }, t) {
  if (!enabled) return false;
  const d = new Date(t);
  const m = d.getHours() * 60 + d.getMinutes();
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

// candidate: { reason, payload, score (0..1, default 1), urgent, explicit, ttlMs }.
// payload is the tray notification, sent as-is.
// canDeliver: false while nobody would receive it -- the candidate stays
// held (a reminder that fired just after a backend start isn't lost).
// isAway: true while I've been idle past the idle threshold.
function createProactive({ deliver, isGaming = () => false, inBreak = () => false, isAway = () => false, canDeliver = () => true, now = Date.now }) {
  let held = [];
  let settings = defaultSettings();
  let lastSent = null;
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
      const q = saved.settings?.quietHours;
      // A hand-edited bad time keeps the default settings, not a flush that throws.
      if (q) [q.start, q.end].forEach((hhmm) => hhmm === undefined || minutesOfDay(hhmm));
      settings = {
        quietHours: q && typeof q === "object" ? { ...settings.quietHours, ...q, enabled: q.enabled === true } : settings.quietHours,
        snoozedUntil: Number(saved.settings?.snoozedUntil) || 0,
        muted: Array.isArray(saved.settings?.muted) ? saved.settings.muted.filter((r) => typeof r === "string") : [],
      };
    } catch {
      // Nothing saved yet, or unreadable: start empty; the next change rewrites it.
    }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ held, day, spentToday, settings }), "utf8");
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
    const quiet = inQuietHours(settings.quietHours, t) || t < settings.snoozedUntil || isAway();
    const next =
      t - lastSentAt < MIN_GAP_MS || !canDeliver()
        ? null
        : held.find((c) => (gameHold ? c.explicit : c.urgent || (!quiet && spentToday < DAILY_BUDGET)));
    if (next) {
      held.splice(held.indexOf(next), 1);
      if (!next.urgent) spentToday += 1;
      if (inGameBreak && !next.explicit) breakUsed = true;
      lastSentAt = t;
      lastSent = { reason: next.reason, title: next.payload.title ?? null, text: next.payload.text ?? null, at: t };
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
    if (!explicit && settings.muted.includes(reason)) return "dropped";
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

  // For Settings, the chat tool and "why did you say that": lastRemark is
  // the reason to mute after "don't bring this up again".
  function getSettings() {
    const t = now();
    return {
      quietHours: { ...settings.quietHours },
      inQuietHours: inQuietHours(settings.quietHours, t),
      snoozedUntil: settings.snoozedUntil > t ? settings.snoozedUntil : null,
      muted: [...settings.muted],
      away: Boolean(isAway()),
      lastRemark: lastSent,
    };
  }

  // patch: any of { quietHours: { enabled, start, end }, snoozeMinutes
  // (0 resumes), mute: reason, unmute: reason }. Validates everything before
  // changing anything.
  function updateSettings(patch = {}) {
    const next = { ...settings, quietHours: { ...settings.quietHours }, muted: [...settings.muted] };
    if (patch.quietHours !== undefined) {
      const q = patch.quietHours || {};
      if (q.enabled !== undefined) next.quietHours.enabled = q.enabled === true;
      for (const key of ["start", "end"]) {
        if (q[key] === undefined) continue;
        minutesOfDay(q[key]);
        next.quietHours[key] = String(q[key]).trim().padStart(5, "0");
      }
    }
    if (patch.snoozeMinutes !== undefined) {
      const minutes = patch.snoozeMinutes === null ? DEFAULT_SNOOZE_MINUTES : Number(patch.snoozeMinutes);
      if (!(minutes >= 0 && minutes <= 7 * 24 * 60)) throw new Error("snoozeMinutes must be 0 to 10080");
      next.snoozedUntil = minutes ? now() + Math.round(minutes * 60 * 1000) : 0;
    }
    const reasonOf = (value) => {
      const r = typeof value === "string" ? value.trim() : "";
      if (!r || r.length > MAX_REASON_CHARS) throw new Error("mute/unmute take a remark kind, e.g. briefing");
      return r;
    };
    if (patch.mute !== undefined) {
      const r = reasonOf(patch.mute);
      if (!next.muted.includes(r)) next.muted.push(r);
      held = held.filter((c) => c.explicit || c.reason !== r);
    }
    if (patch.unmute !== undefined) {
      const r = reasonOf(patch.unmute);
      next.muted = next.muted.filter((m) => m !== r);
    }
    settings = next;
    save();
    return getSettings();
  }

  return { offer, flush, persistTo, listHeld, getSettings, updateSettings };
}

// The process-wide instance; server.js hands it the gaming watch, its file
// and who's speaking.
let gamingCheck = () => false;
let breakCheck = () => false;
let away = false;
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
  isAway: () => away,
  canDeliver: hasListeners,
});

function watchGaming(isGaming, inBreak = () => false) {
  gamingCheck = isGaming;
  breakCheck = inBreak;
}

function watchSpeaker(nameOf) {
  speakerName = nameOf;
}

// #1282: server.js's /internal/idle-report says whether I'm away.
function setAway(isAway) {
  away = Boolean(isAway);
}

// #1282: Settings (and the launcher, later) read and change quiet hours,
// "not now" and muted kinds here. POST takes updateSettings's patch.
function registerRoutes(app, p = proactive) {
  app.get("/proactive/settings", (req, res) => res.json({ ok: true, ...p.getSettings() }));
  app.post("/proactive/settings", (req, res) => {
    try {
      return res.json({ ok: true, ...p.updateSettings(req.body || {}) });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  createProactive,
  watchGaming,
  watchSpeaker,
  setAway,
  registerRoutes,
  offer: proactive.offer,
  flush: proactive.flush,
  persistTo: proactive.persistTo,
  listHeld: proactive.listHeld,
  getSettings: proactive.getSettings,
  updateSettings: proactive.updateSettings,
  inQuietHours,
  DAILY_BUDGET,
};

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

// Learning from reactions: each kind keeps an engagement score in -1..1.
// A reply within REPLY_WINDOW_MS counts as engaged; silence as ignored
// (implicit, half weight). Every reaction pulls the score LEARN_RATE of the
// way toward its weight, and scores fade toward neutral with a two-week
// half-life. The score sets the kind's multiplier, 2^-score (0.5x liked to
// 2x disliked): it scales the threshold, and a disliked kind also waits up
// to DISLIKE_COOLDOWN_MS after its last remark. Neutral changes nothing.
// Urgent/explicit remarks are neither learned from nor throttled.
// ponytail: one score per kind; per-context buckets (time of day, activity)
// and Thompson-style exploration from #697 come later.
const REPLY_WINDOW_MS = 5 * 60 * 1000;
const LEARN_RATE = 0.25;
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const DISLIKE_COOLDOWN_MS = 60 * 60 * 1000;
const REACTION_WEIGHTS = { engaged: 1, ignored: -0.5, dismissed: -1, notNow: -1, never: -1 };

function defaultSettings() {
  return { quietHours: { enabled: false, start: "01:00", end: "09:00" }, snoozedUntil: 0, muted: [], learned: {} };
}

// The score as of t, faded toward neutral since it was last updated.
function decayedScore(entry, t) {
  if (!entry) return 0;
  return entry.score * 0.5 ** (Math.max(0, t - entry.at) / HALF_LIFE_MS);
}

const multiplierFor = (score) => 2 ** -score;

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
        learned: Object.fromEntries(
          Object.entries(saved.settings?.learned || {})
            .filter(([, e]) => Number.isFinite(e?.score) && Number.isFinite(e?.at))
            .map(([r, e]) => [r, { score: Math.max(-1, Math.min(1, e.score)), at: e.at, lastAt: Number(e.lastAt) || 0 }]),
        ),
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

  function learn(reason, signal, t) {
    const entry = settings.learned[reason];
    const score = decayedScore(entry, t);
    settings.learned[reason] = { score: score + LEARN_RATE * (REACTION_WEIGHTS[signal] - score), at: t, lastAt: entry?.lastAt || 0 };
  }

  const multiplier = (reason, t) => multiplierFor(decayedScore(settings.learned[reason], t));

  // A disliked kind waits longer after its last remark; neutral/liked don't.
  function coolingDown(reason, t) {
    const lastAt = settings.learned[reason]?.lastAt || 0;
    return t - lastAt < DISLIKE_COOLDOWN_MS * Math.max(0, multiplier(reason, t) - 1);
  }

  // The last learnable remark waits here until I react or the reply window
  // passes (then it was ignored). In memory only: a restart forgets one.
  let pending = null;
  function settle(t) {
    if (!pending || t - pending.at < REPLY_WINDOW_MS) return false;
    learn(pending.reason, pending.signal || "ignored", t);
    pending = null;
    return true;
  }

  // signal: engaged (I replied / clicked it) or a negative one (dismissed,
  // notNow, never), about the last remark. Negative ones count right away
  // and win over a reply in the same window ("not now" is itself a reply).
  // Returns whether anything was recorded.
  function react(signal, t = now()) {
    if (!(signal in REACTION_WEIGHTS)) throw new Error(`reaction must be one of ${Object.keys(REACTION_WEIGHTS).join(", ")}`);
    const settled = settle(t);
    if (!pending) {
      if (settled) save();
      return false;
    }
    if (signal === "engaged") {
      pending.signal = "engaged";
      return true;
    }
    learn(pending.reason, signal, t);
    pending = null;
    save();
    return true;
  }

  // Delivers at most one held candidate and returns it (or null).
  function flush() {
    const t = now();
    const settled = settle(t);
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
        : held.find((c) => (gameHold ? c.explicit : c.urgent || (!quiet && spentToday < DAILY_BUDGET && !coolingDown(c.reason, t))));
    if (next) {
      held.splice(held.indexOf(next), 1);
      if (!next.urgent) {
        spentToday += 1;
        // ponytail: back-to-back remarks share one reply window, so only the
        // latest is learned from; an earlier one gets its reply credited.
        if (pending?.signal) learn(pending.reason, pending.signal, t);
        pending = { reason: next.reason, at: t, signal: null };
        const entry = settings.learned[next.reason];
        settings.learned[next.reason] = entry ? { ...entry, lastAt: t } : { score: 0, at: t, lastAt: t };
      }
      if (inGameBreak && !next.explicit) breakUsed = true;
      lastSentAt = t;
      lastSent = { reason: next.reason, title: next.payload.title ?? null, text: next.payload.text ?? null, at: t };
      Promise.resolve()
        .then(() => deliver(next.payload))
        .catch(() => {});
    }
    if (held.length !== count || settled) save();
    return next ?? null;
  }

  // Returns "delivered", "held" or "dropped".
  function offer({ reason, payload, score = 1, urgent = false, explicit = false, ttlMs = DEFAULT_TTL_MS }) {
    urgent = Boolean(urgent || explicit);
    if (!explicit && settings.muted.includes(reason)) return "dropped";
    if (!urgent && !(score >= Math.min(1, SCORE_THRESHOLD * multiplier(reason, now())))) return "dropped";
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
      // Read-only: what she has learned per kind (score -1..1, multiplier 0.5..2).
      learned: Object.fromEntries(
        Object.keys(settings.learned).map((r) => {
          const score = decayedScore(settings.learned[r], t);
          return [r, { score: Math.round(score * 1000) / 1000, multiplier: Math.round(multiplierFor(score) * 1000) / 1000 }];
        }),
      ),
    };
  }

  // patch: any of { quietHours: { enabled, start, end }, snoozeMinutes
  // (0 resumes), mute: reason, unmute: reason, reaction: dismissed|engaged }.
  // Validates everything before changing anything. Snoozing and muting also
  // count as reactions to the last remark.
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
    // The launcher reports what happened to the toast: dismissed or engaged.
    if (patch.reaction !== undefined && !["dismissed", "engaged"].includes(patch.reaction)) {
      throw new Error("reaction must be dismissed or engaged");
    }
    settings = next;
    // Turned back on by hand: a fresh start, not the dislike that muted it.
    if (patch.unmute !== undefined) delete settings.learned[reasonOf(patch.unmute)];
    const t = now();
    if (patch.reaction !== undefined) react(patch.reaction, t);
    if (patch.snoozeMinutes !== undefined && next.snoozedUntil > t) react("notNow", t);
    if (patch.mute !== undefined) {
      // "Don't bring this up again" about the last remark, or any kind by name.
      const r = reasonOf(patch.mute);
      if (pending?.reason === r) react("never", t);
      else learn(r, "never", t);
    }
    save();
    return getSettings();
  }

  return { offer, flush, persistTo, listHeld, getSettings, updateSettings, react };
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
  react: proactive.react,
  DAILY_BUDGET,
};

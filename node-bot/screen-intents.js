// #1283 (part of #698): standing intents that fire on what's on screen --
// the foreground app and window title (foreground.js) and the glance text
// (UI tree / OCR, #690) -- matched the same way chat matches them. A match
// is offered to the proactive pipeline like any other remark, at most once
// per intent per cooldown. Nothing fires while gaming, and a private
// window is never matched at all.
const DEFAULT_COOLDOWN_MINUTES = 30;
// Password managers. MANA_PRIVATE_APPS replaces the list.
const DEFAULT_PRIVATE_APPS = "keepass.exe,keepassxc.exe,1password.exe,bitwarden.exe,proton pass.exe";
const PRIVATE_TITLE = /\b(?:inprivate|incognito|private browsing)\b/i;

function privateApps() {
  return (process.env.MANA_PRIVATE_APPS ?? DEFAULT_PRIVATE_APPS)
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function isPrivateWindow({ app = "", title = "" } = {}) {
  return privateApps().includes(String(app).toLowerCase()) || PRIVATE_TITLE.test(title);
}

function cooldownMs() {
  return (Number(process.env.MANA_SCREEN_INTENT_COOLDOWN_MINUTES) || DEFAULT_COOLDOWN_MINUTES) * 60 * 1000;
}

function createScreenIntents({ matchIntents, offer, isGaming = () => false, now = Date.now }) {
  // ponytail: in memory, so a restart can repeat a remark once; persist if that bites.
  const lastFired = new Map();

  // screen: { app, title, text, gaming }. Resolves to the intents offered.
  async function check({ app = "", title = "", text = "", gaming = false } = {}) {
    if (gaming || isGaming() || isPrivateWindow({ app, title })) return [];
    const screen = [app, title, text].filter(Boolean).join("\n").trim();
    if (!screen) return [];
    const matched = await matchIntents(screen);
    const t = now();
    const due = matched.filter((fact) => !(t - lastFired.get(fact.key) < cooldownMs()));
    for (const fact of due) {
      lastFired.set(fact.key, t);
      offer({
        reason: "standing-intent",
        score: 0.7,
        payload: { type: "cron", kind: "reminder", title: `About ${fact.trigger}`, text: fact.text, speak: fact.text },
      });
    }
    return due;
  }

  return { check };
}

module.exports = { createScreenIntents, isPrivateWindow };

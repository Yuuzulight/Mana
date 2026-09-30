// #697 part 1 (Q9): which app is in front, as the native launcher reports
// it whenever the foreground window changes (POST /internal/foreground-report).
// Kept in memory only -- a window title can name a private document or an
// email subject. The proactive pipeline reads it; context-aware delivery
// and learning (the next parts of #697) build on it.
const MAX_TITLE_CHARS = 300;

let current = null; // { app: "code.exe", title }

function reportForeground({ app, title } = {}) {
  const name = typeof app === "string" ? app.trim().toLowerCase() : "";
  if (!name) throw new Error("app is required");
  current = {
    app: name,
    title: typeof title === "string" ? title.slice(0, MAX_TITLE_CHARS) : "",
  };
  return current;
}

function getForeground() {
  return current;
}

// Alt-tabbed out of a running game: one of #697's natural breaks, where a
// held remark may go out. Unknown (no launcher reporting) is not a break,
// and neither is a companion app I use while playing -- a Discord call or
// OBS in front is still the game. MANA_GAME_COMPANION_APPS replaces the list.
const DEFAULT_COMPANION_APPS = "discord.exe,discordptb.exe,discordcanary.exe,obs64.exe,obs32.exe";

function companionApps() {
  return (process.env.MANA_GAME_COMPANION_APPS ?? DEFAULT_COMPANION_APPS)
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function isAwayFromGame(gameProcessNames) {
  return Boolean(current) && !gameProcessNames.includes(current.app) && !companionApps().includes(current.app);
}

module.exports = { getForeground, isAwayFromGame, reportForeground };

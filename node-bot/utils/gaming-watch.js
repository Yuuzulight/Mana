// Cached "is a watched game running?" for the request path (#754/#760).
// A blocking tasklist is too slow to run on every turn, so server.js polls
// check() in the background instead and reads isGaming() (getGamingStatus()
// too). onGameStart fires once per game session, on the poll
// that first sees it; onGameEnd (#889) on the poll that first sees it gone.
// #908: check may return the matched process name, which game() reports.

// While a game runs, a turn that needs the embedder or reranker may still
// start it, but it stops this soon after its last use instead of holding
// VRAM/RAM for the normal 1-hour idle.
const GAMING_IDLE_MS = 2 * 60 * 1000;

function createGamingWatch({ check, onGameStart, onGameEnd = () => {} }) {
  let gaming = false;
  let game = null;

  // A failed check keeps the last answer.
  async function poll() {
    try {
      const found = await check();
      const now = Boolean(found);
      if (now && !gaming) onGameStart();
      if (!now && gaming) onGameEnd();
      gaming = now;
      game = now && typeof found === "string" ? found : null;
    } catch (e) {}
    return gaming;
  }

  return { poll, isGaming: () => gaming, game: () => game };
}

module.exports = { createGamingWatch, GAMING_IDLE_MS };

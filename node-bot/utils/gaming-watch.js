// Cached "is a watched game running?" for the request path (#754/#760).
// getGamingStatus() in server.js runs a blocking tasklist, too slow to call
// on every turn, so server.js polls check() in the background instead and
// reads isGaming(). onGameStart fires once per game session, on the poll
// that first sees it.

// While a game runs, a turn that needs the embedder or reranker may still
// start it, but it stops this soon after its last use instead of holding
// VRAM/RAM for the normal 1-hour idle.
const GAMING_IDLE_MS = 2 * 60 * 1000;

function createGamingWatch({ check, onGameStart }) {
  let gaming = false;

  // A failed check keeps the last answer.
  async function poll() {
    try {
      const now = Boolean(await check());
      if (now && !gaming) onGameStart();
      gaming = now;
    } catch (e) {}
    return gaming;
  }

  return { poll, isGaming: () => gaming };
}

module.exports = { createGamingWatch, GAMING_IDLE_MS };

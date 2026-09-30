const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { getForeground, isAwayFromGame, reportForeground } = require("../foreground");
const { withServer } = require("./helpers");

const GAMES = ["ffxiv_dx11.exe"];

test("the launcher's foreground report is kept, and alt-tabbing out of a game counts as a break (#697)", async () => {
  assert.equal(isAwayFromGame(GAMES), false, "nothing reported yet: not a break");

  await withServer(createApp(), async (baseUrl) => {
    const report = (body) =>
      fetch(`${baseUrl}/internal/foreground-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await report({ app: "FFXIV_DX11.exe", title: "FINAL FANTASY XIV" })).status, 200);
    assert.equal(getForeground().app, "ffxiv_dx11.exe");
    assert.equal(isAwayFromGame(GAMES), false);

    assert.equal((await report({ app: "chrome.exe", title: "x".repeat(1000) })).status, 200);
    assert.equal(getForeground().title.length, 300);
    assert.equal(isAwayFromGame(GAMES), true);

    assert.equal((await report({ title: "no app" })).status, 400);
    assert.equal(getForeground().app, "chrome.exe");
  });
});

test("Discord or OBS in front mid-game isn't a break; MANA_GAME_COMPANION_APPS replaces the list", () => {
  const saved = process.env.MANA_GAME_COMPANION_APPS;
  try {
    delete process.env.MANA_GAME_COMPANION_APPS;
    reportForeground({ app: "Discord.exe" });
    assert.equal(isAwayFromGame(GAMES), false);
    reportForeground({ app: "obs64.exe" });
    assert.equal(isAwayFromGame(GAMES), false);

    process.env.MANA_GAME_COMPANION_APPS = " Spotify.exe ";
    assert.equal(isAwayFromGame(GAMES), true, "OBS isn't on my list");
    reportForeground({ app: "spotify.exe" });
    assert.equal(isAwayFromGame(GAMES), false);
  } finally {
    if (saved === undefined) delete process.env.MANA_GAME_COMPANION_APPS;
    else process.env.MANA_GAME_COMPANION_APPS = saved;
  }
});

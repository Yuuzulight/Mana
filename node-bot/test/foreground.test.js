const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { getForeground, isAwayFromGame } = require("../foreground");
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

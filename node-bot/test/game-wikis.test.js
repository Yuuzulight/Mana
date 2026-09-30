// #908
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadGameWikis } = require("../game-wikis");
const { createGamingWatch } = require("../utils/gaming-watch");

test("loadGameWikis finds FFXIV by default and takes my own games from the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-game-wikis-"));
  assert.deepEqual(loadGameWikis(path.join(dir, "missing.json")).gameFor("FFXIV_DX11.EXE").sites, ["ffxiv.consolegameswiki.com", "finalfantasyxiv.com"]);

  const file = path.join(dir, "game-wikis.json");
  fs.writeFileSync(file, JSON.stringify({ Hades: { processes: ["Hades.exe"], sites: ["hades.fandom.com", "bad site OR x"] }, NoSites: { processes: ["nosites.exe"], sites: [] } }));
  const { gameFor, processes } = loadGameWikis(file);
  // #945: every listed game is watched.
  assert.ok(processes.includes("hades.exe") && processes.includes("ffxiv_dx11.exe") && processes.includes("eldenring.exe"));
  assert.ok(!processes.includes("nosites.exe"));
  assert.deepEqual(gameFor("hades.exe"), { name: "Hades", sites: ["hades.fandom.com"] });
  assert.equal(gameFor("ffxiv_dx11.exe").name, "Final Fantasy XIV");
  assert.equal(gameFor("notepad.exe"), null);
  assert.equal(gameFor(null), null);
});

test("the gaming watch reports which game is running", async () => {
  let running = "ffxiv_dx11.exe";
  const watch = createGamingWatch({ check: async () => running, onGameStart() {} });
  await watch.poll();
  assert.equal(watch.game(), "ffxiv_dx11.exe");
  running = false;
  await watch.poll();
  assert.equal(watch.game(), null);
});

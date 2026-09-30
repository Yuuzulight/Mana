// #908: which wiki a game's questions are answered from. One small JSON file
// I can edit by hand (data/game-wikis.json), same shape as the defaults:
//   { "Game name": { "processes": ["game.exe"], "sites": ["wiki.example.com"] } }
// Its entries add games or replace a default of the same name. A site also
// covers its subdomains. Every listed process is also a watched game (#945),
// so gaming mode turns on for it. Read at backend start.
const fs = require("node:fs");

const DEFAULT_GAME_WIKIS = {
  "Final Fantasy XIV": {
    processes: ["ffxiv_dx11.exe", "ffxiv.exe", "ffxivboot.exe", "ffxivboot64.exe", "ffxivlauncher.exe", "ffxivlauncher64.exe"],
    // Console Games Wiki, and the Lodestone for patch notes.
    sites: ["ffxiv.consolegameswiki.com", "finalfantasyxiv.com"],
  },
  "Elden Ring": { processes: ["eldenring.exe"], sites: ["eldenring.wiki.fextralife.com"] },
  "Genshin Impact": { processes: ["genshinimpact.exe"], sites: ["genshin-impact.fandom.com"] },
  "World of Warcraft": { processes: ["wow.exe"], sites: ["warcraft.wiki.gg", "wowhead.com"] },
  "Stardew Valley": { processes: ["stardew valley.exe"], sites: ["stardewvalleywiki.com"] },
  "Baldur's Gate 3": { processes: ["bg3.exe", "bg3_dx11.exe"], sites: ["bg3.wiki"] },
};

// Sites go into the search query, so only plain host names.
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string").map((v) => v.trim().toLowerCase()) : [];
}

// gameFor: processName -> { name, sites } or null; processes: every game's.
function loadGameWikis(filePath) {
  let mine = {};
  try {
    mine = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`Couldn't read ${filePath}, using the default game wikis:`, e.message);
  }
  const games = Object.entries({ ...DEFAULT_GAME_WIKIS, ...mine })
    .map(([name, game]) => ({ name, processes: strings(game?.processes), sites: strings(game?.sites).filter((s) => HOST_RE.test(s)) }))
    .filter((game) => game.processes.length && game.sites.length);
  return {
    processes: games.flatMap((game) => game.processes),
    gameFor(processName) {
      const game = games.find((g) => g.processes.includes(String(processName || "").toLowerCase()));
      return game ? { name: game.name, sites: game.sites } : null;
    },
  };
}

module.exports = { loadGameWikis };

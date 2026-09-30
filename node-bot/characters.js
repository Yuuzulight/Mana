// Issue #914: more than one character. A character is a prompt, not a model:
// one chat model and one TTS model serve them all. Each has a name, a
// persona (the core persona.js's MANA_PERSONA is for Mana), a handoff line
// she says when she takes over, and optionally her own Qwen3-TTS voice and
// Live2D model -- without them she uses Mana's.
//
// Mana and an Evil Mana example are built in. More (or a voice/model for a
// built-in one) come from data/characters.json, a JSON array edited by hand:
//
//   [{ "id": "evil-mana", "voice": { "refAudio": "voices/evil.wav",
//      "refText": "exact words spoken in the clip" },
//      "live2dModel": "models/evil/evil.model3.json" },
//    { "id": "aoi", "name": "Aoi", "persona": "You are Aoi, ...",
//      "handoff": "Aoi here, taking over from {previous}." }]
//
// An entry with a built-in id only overrides the fields it sets. Relative
// paths are relative to the file's folder; voice clips must be under it
// (tools/qwen3tts_service.py refuses any other file). The active character
// is remembered across restarts (options.activeFilePath).
//
// Facts about the user stay shared; each character's mood and personality
// layer are her own (perCharacter below, wired in server.js).
const fs = require("node:fs");
const path = require("node:path");
const { MANA_PERSONA, SPOKEN_STYLE } = require("./persona");

const DEFAULT_ID = "mana";
const DEFAULT_FILE_PATH = path.join(__dirname, "data", "characters.json");
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_PERSONA_CHARS = 4000;
// A switch request is a short line; longer text that merely mentions one
// (a pasted story) goes to the model as usual.
const MAX_SWITCH_REQUEST_CHARS = 160;

const BUILT_IN = [
  { id: DEFAULT_ID, name: "Mana", persona: MANA_PERSONA, handoff: "Mana's back~ Did you miss me?" },
  {
    id: "evil-mana",
    name: "Evil Mana",
    persona:
      "You are Evil Mana, Mana's mischievous twin: the same original anime little sister, but smug, sarcastic and gleefully chaotic. You tease harder and brag about being the better sister, yet you still actually help, and you are never cruel or genuinely insulting. Replies in the history from Mana were your sister, not you. You may add one fitting emoji or kaomoji like (￣▽￣) or (｀∀´), at most one per reply.",
    handoff: "Evil Mana here. {previous} is taking a break, so you're stuck with me~",
  },
];

const text = (value, max) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

// One file entry, merged over the built-in of the same id. Null (and a
// warning) for an entry that can't be a character.
function normalize(entry, baseDir, builtIn) {
  const id = typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : "";
  if (!ID_PATTERN.test(id)) return null;
  const base = builtIn.find((c) => c.id === id) || {};
  const character = {
    id,
    name: text(entry.name, 60) || base.name,
    persona: text(entry.persona, MAX_PERSONA_CHARS) || base.persona,
    handoff: text(entry.handoff, 300) || base.handoff || null,
    voice: null,
    live2dModel: null,
  };
  if (!character.name || !character.persona) return null;
  const refAudio = text(entry.voice?.refAudio, 1000);
  const refText = text(entry.voice?.refText, 1000);
  if (refAudio && refText) character.voice = { refAudio: path.resolve(baseDir, refAudio), refText };
  const model = text(entry.live2dModel, 1000);
  if (model) character.live2dModel = path.resolve(baseDir, model);
  return character;
}

// options.filePath: injectable for tests. options.onSwitch(character,
// previous) runs after every change of the active character.
// options.activeFilePath: where the active character's id is kept so a
// restart brings her back; omit it to keep it in memory only.
// options.isGaming: whether a game is being played (group mode pauses);
// options.onGroupChange(partner or null) runs whenever the character
// replying alongside the active one changes.
function createCharacterStore(options = {}) {
  const filePath = options.filePath || DEFAULT_FILE_PATH;
  const activeFilePath = options.activeFilePath || null;
  const onSwitch = options.onSwitch || (() => {});
  const isGaming = options.isGaming || (() => false);
  const onGroupChange = options.onGroupChange || (() => {});
  const builtIn = BUILT_IN.map((c) => ({ ...c, voice: null, live2dModel: null }));
  let activeId = DEFAULT_ID;
  if (activeFilePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(activeFilePath, "utf8"))?.id;
      if (typeof saved === "string" && ID_PATTERN.test(saved)) activeId = saved;
    } catch (e) {
      // no file yet (or a broken one): Mana
    }
  }
  // Read again only when the file changes: active() runs every turn and
  // every spoken sentence, and a bad file should warn once, not each time.
  let cache = { mtimeMs: null, characters: builtIn };

  function list() {
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch (e) {
      // no file: the built-ins alone
    }
    if (mtimeMs === cache.mtimeMs) return cache.characters;
    const characters = [...builtIn];
    if (mtimeMs !== null) {
      try {
        const entries = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!Array.isArray(entries)) throw new Error("expected a JSON array of characters");
        for (const entry of entries) {
          const character = normalize(entry, path.dirname(filePath), builtIn);
          if (!character) {
            console.warn(`characters.json: skipped an entry without a valid id, name and persona`);
            continue;
          }
          const at = characters.findIndex((c) => c.id === character.id);
          if (at >= 0) characters[at] = character;
          else characters.push(character);
        }
      } catch (e) {
        console.warn(`characters.json not loaded (${e.message}); using the built-in characters`);
      }
    }
    cache = { mtimeMs, characters };
    return characters;
  }

  const get = (id) => list().find((c) => c.id === id) || null;

  // Falls back to Mana if the active one was removed from the file.
  const active = () => get(activeId) || get(DEFAULT_ID);

  // Null for an unknown id. Switching to the active character is a no-op
  // (no onSwitch).
  function setActive(id) {
    const character = get(String(id || "").trim().toLowerCase());
    if (!character) return null;
    const previous = active();
    activeId = character.id;
    if (character.id !== previous.id) {
      // Switching to the partner keeps the duo: the previous one takes her place.
      if (group.partner === character.id) group.partner = previous.id;
      if (activeFilePath) {
        try {
          fs.mkdirSync(path.dirname(activeFilePath), { recursive: true });
          fs.writeFileSync(activeFilePath, JSON.stringify({ id: activeId }), "utf8");
        } catch (e) {
          console.warn(`couldn't save the active character (${e.message})`);
        }
      }
      onSwitch(character, previous);
      reportGroup();
    }
    return { character, previous };
  }

  // Group mode: a partner replies alongside the active character. Off by
  // default and not saved. Paused while a game is played, unless it was
  // turned on during that game -- then it stays on until the game ends.
  let group = { on: false, partner: null, duringGame: false };
  let reportedPartner = null;

  // The character replying alongside the active one right now, or null.
  function groupPartner() {
    if (!group.on || (isGaming() && !group.duringGame)) return null;
    const partner = get(group.partner);
    return partner && partner.id !== active().id ? partner : null;
  }

  function reportGroup() {
    const partner = groupPartner();
    if ((partner?.id ?? null) === reportedPartner) return;
    reportedPartner = partner?.id ?? null;
    onGroupChange(partner);
  }

  // paused: on, but held off by a game.
  const groupState = () => ({
    on: group.on,
    partner: group.partner,
    paused: group.on && isGaming() && !group.duringGame,
  });

  // on with a partner id, or without one for the last partner (else the
  // first character who isn't active). Null for an unknown partner or the
  // active one herself.
  function setGroup(on, partnerId) {
    if (on) {
      const partner = partnerId
        ? get(String(partnerId).trim().toLowerCase())
        : get(group.partner) || list().find((c) => c.id !== active().id);
      if (!partner || partner.id === active().id) return null;
      group = { on: true, partner: partner.id, duringGame: isGaming() };
    } else {
      group = { ...group, on: false, duringGame: false };
    }
    reportGroup();
    return groupState();
  }

  // server.js calls this when a game starts or ends.
  function gameChanged() {
    if (!isGaming()) group.duringGame = false;
    reportGroup();
  }

  // The characters a line names, longest names first so "Evil Mana"
  // doesn't also count as "Mana".
  function mentioned(message) {
    let line = String(message || "").toLowerCase();
    const found = [];
    for (const c of [...list()].sort((a, b) => b.name.length - a.name.length)) {
      const pattern = new RegExp(`(?<![\\w'])${nameRegex(c.name)}(?![\\w'])`, "g");
      if (pattern.test(line)) {
        found.push(c);
        line = line.replace(pattern, " ");
      }
    }
    return found;
  }

  // "group mode on", "start group chat with Evil Mana", "let Evil Mana
  // join", "turn off group mode": { on, partner (id or null) }, or null.
  function findGroupRequest(message) {
    const line = String(message || "").trim().toLowerCase();
    if (!line || line.length > MAX_SWITCH_REQUEST_CHARS) return null;
    const named = mentioned(line).find((c) => c.id !== active().id) || null;
    if (/\b(?:(?:turn|switch)\s+off|stop|end|disable)\s+(?:the\s+)?group\s+(?:mode|chat)\b|\bgroup\s+(?:mode|chat)\s+off\b/.test(line)) {
      return { on: false, partner: null };
    }
    const asksOn =
      /\b(?:(?:turn|switch)\s+on|start|enable)\s+(?:a\s+|the\s+)?group\s+(?:mode|chat)\b|\bgroup\s+(?:mode|chat)\s+on\b/.test(line) ||
      (named && new RegExp(`\\b(?:let|have)\\s+${nameRegex(named.name)}\\s+join\\b`).test(line));
    return asksOn ? { on: true, partner: named?.id ?? null } : null;
  }

  // The character a chat line asks to switch to ("let Evil Mana talk",
  // "switch to Mana", "bring back Mana"), or null. Never the active one.
  function findSwitchRequest(message) {
    const line = String(message || "").trim().toLowerCase();
    if (!line || line.length > MAX_SWITCH_REQUEST_CHARS) return null;
    const current = active().id;
    return (
      list().find((c) => {
        if (c.id === current) return false;
        const name = nameRegex(c.name);
        return [
          `\\b(?:let|have|get|make)\\s+${name}\\s+(?:talk|speak|take over|answer|come out)`,
          `\\b(?:switch|swap|change|go)\\s+(?:back\\s+)?(?:over\\s+)?to\\s+${name}(?![\\w'])`,
          `\\b(?:bring|call)\\s+(?:back|out|in)\\s+${name}(?![\\w'])`,
          `\\bbring\\s+${name}\\s+(?:back|out|in)\\b`,
          `\\b(?:can|could|may)\\s+i\\s+(?:talk|speak)\\s+(?:to|with)\\s+${name}(?![\\w'])`,
        ].some((pattern) => new RegExp(pattern).test(line));
      }) || null
    );
  }

  return {
    list,
    get,
    active,
    setActive,
    findSwitchRequest,
    groupPartner,
    groupState,
    setGroup,
    gameChanged,
    mentioned,
    findGroupRequest,
  };
}

// A name as regex source, any whitespace between its words.
const nameRegex = (name) =>
  name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

function handoffLine(character, previous) {
  const line = character.handoff || `${character.name} here.`;
  return line.replaceAll("{previous}", previous ? previous.name : "Mana");
}

// The prompt core for a character. Other system text (tool descriptions,
// memory blocks) says "Mana"; for anyone else that means her.
function personaOf(character) {
  if (character.id === DEFAULT_ID) return character.persona;
  return `${character.persona}\n\nOther instructions here may call you Mana; they mean you, ${character.name}.`;
}

// persona.js's DEFAULT_SYSTEM_PROMPT for a character: the prompt of every
// model call that doesn't build its own (proactive lines like the daily
// briefing and screen remarks, fallbacks), so those speak as her too.
const defaultPromptOf = (character) => `${personaOf(character)} ${SPOKEN_STYLE}`;

// A store with the same methods whose calls go to the active character's
// own instance, made by create(id) on first use -- so every existing caller
// of the mood/personality store gets the active character's without change.
function perCharacter(characters, create, methods) {
  const stores = new Map();
  const current = () => {
    const { id } = characters.active();
    if (!stores.has(id)) stores.set(id, create(id));
    return stores.get(id);
  };
  return Object.fromEntries(methods.map((m) => [m, (...args) => current()[m](...args)]));
}

// Mana keeps the existing file; anyone else gets name.<id>.json beside it
// (ids are [a-z0-9-], so this can't leave the folder).
function characterFilePath(filePath, id) {
  if (!filePath || id === DEFAULT_ID) return filePath;
  return filePath.replace(/(\.json)?$/, `.${id}.json`);
}

module.exports = {
  DEFAULT_ID,
  DEFAULT_FILE_PATH,
  characterFilePath,
  createCharacterStore,
  defaultPromptOf,
  handoffLine,
  perCharacter,
  personaOf,
};

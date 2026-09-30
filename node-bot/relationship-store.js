// Issue #914: each character's own notes about her relationship with the
// user -- a running joke, what they like from her, a promise she made -- and
// milestones: dated moments she remembers (our first chat, memorable
// events), brought up only now and then, and on their anniversaries. Facts
// about the user stay shared (acp-memory-store); these are hers alone, so
// server.js keeps one store per character (perCharacter, like mood and
// personality). She writes them with the relationship__note and
// relationship__milestone tools, which need no approval: each new one shows
// as a chat line instead, and I can forget it from chat ("forget that") or
// edit/remove it in Settings. The newest MAX_NOTES notes reach her prompt.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_NOTES = 20;
const MAX_MILESTONES = 30;
const MAX_NOTE_CHARS = 200;
const NOTE_TOOL = "relationship__note";
const MILESTONE_TOOL = "relationship__milestone";
const FORGET_THAT_MS = 30 * 60 * 1000;
// A milestone comes up at most once a day, and apart from an anniversary
// only if none has for this many days.
const MENTION_EVERY_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const stableId = (seed) => crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
const newId = () => crypto.randomBytes(4).toString("hex");
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
const pad = (n) => String(n).padStart(2, "0");
const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// "YYYY-MM-DD" that is a real date, or null.
const validDate = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && localDate(Date.parse(`${value}T12:00:00`)) === value
    ? value
    : null;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / DAY_MS);

// options.filePath: where the notes persist; omit it for an in-memory store
// (tests, and server.js under NODE_ENV=test).
// options.now: injectable clock (ISO string).
function createRelationshipStore(options = {}) {
  const filePath = options.filePath || null;
  const now = options.now || (() => new Date().toISOString());
  const today = () => localDate(Date.parse(now()));
  let memoryState = { notes: [], milestones: [] };

  function read() {
    if (!filePath) return memoryState;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      // A note saved before notes had ids gets a stable one from its content.
      const notes = Array.isArray(parsed?.notes)
        ? parsed.notes
            .filter((n) => typeof n?.text === "string" && n.text)
            .map((n) => (typeof n.id === "string" ? n : { ...n, id: stableId(`${n.text}|${n.at}`) }))
        : [];
      const milestones = Array.isArray(parsed?.milestones)
        ? parsed.milestones.filter((m) => typeof m?.text === "string" && m.text && typeof m.id === "string" && validDate(m.date))
        : [];
      return { ...parsed, notes, milestones };
    } catch (e) {
      return { notes: [], milestones: [] }; // none yet, or unreadable
    }
  }

  // A failed write throws: the tool call or route reports it.
  function write(state) {
    if (!filePath) {
      memoryState = state;
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  const list = () => read().notes;
  const milestones = () => read().milestones;

  // The note as saved, or null for an empty one. The same text again only
  // moves it to the newest; past MAX_NOTES the oldest go.
  function add(text) {
    const note = clean(text);
    if (!note) return null;
    const state = read();
    const saved = { id: newId(), text: note, at: now() };
    const notes = [...state.notes.filter((n) => n.text.toLowerCase() !== note.toLowerCase()), saved].slice(-MAX_NOTES);
    write({ ...state, notes });
    return saved;
  }

  // The edited note, or null for an unknown id or empty text.
  function update(id, text) {
    const note = clean(text);
    const state = read();
    const existing = state.notes.find((n) => n.id === id);
    if (!note || !existing) return null;
    const updated = { ...existing, text: note };
    write({ ...state, notes: state.notes.map((n) => (n.id === id ? updated : n)) });
    return updated;
  }

  // The removed note, or null for an unknown id.
  function remove(id) {
    const state = read();
    const removed = state.notes.find((n) => n.id === id) || null;
    if (removed) write({ ...state, notes: state.notes.filter((n) => n !== removed) });
    return removed;
  }

  // A milestone on date ("YYYY-MM-DD", default today), or null for empty
  // text. The same moment again isn't added twice; past MAX_MILESTONES the
  // oldest-noted go, never the first chat.
  function addMilestone(text, date, extra = {}) {
    const moment = clean(text);
    if (!moment) return null;
    const state = read();
    const on = validDate(date) || today();
    const same = state.milestones.find((m) => m.date === on && m.text.toLowerCase() === moment.toLowerCase());
    if (same) return same;
    const saved = { id: newId(), text: moment, date: on, at: now(), ...extra };
    let all = [...state.milestones, saved];
    while (all.length > MAX_MILESTONES) all.splice(all.findIndex((m) => !m.first), 1);
    write({ ...state, milestones: all });
    return saved;
  }

  // changes: { text?, date? }. The edited milestone, or null for an unknown
  // id, empty text or a bad date.
  function updateMilestone(id, changes = {}) {
    const state = read();
    const existing = state.milestones.find((m) => m.id === id);
    const text = changes.text === undefined ? existing?.text : clean(changes.text);
    const date = changes.date === undefined ? existing?.date : validDate(changes.date);
    if (!existing || !text || !date) return null;
    const updated = { ...existing, text, date };
    write({ ...state, milestones: state.milestones.map((m) => (m.id === id ? updated : m)) });
    return updated;
  }

  function removeMilestone(id) {
    const state = read();
    const removed = state.milestones.find((m) => m.id === id) || null;
    if (removed) write({ ...state, milestones: state.milestones.filter((m) => m !== removed) });
    return removed;
  }

  // Our first chat, once: dateOf() is when it was (an ISO time, e.g. the
  // oldest session's), or today when it returns nothing.
  function ensureFirstChat(dateOf) {
    if (read().milestones.some((m) => m.first)) return null;
    const when = dateOf?.();
    return addMilestone("The first time we talked", when ? localDate(Date.parse(when)) : today(), { first: true });
  }

  // The milestone to bring up this turn, as a prompt line, or null. An
  // anniversary today first; otherwise, every MENTION_EVERY_DAYS days, the
  // one least recently brought up (never one from today). At most one a
  // day, not on coding turns. Choosing one counts as bringing it up.
  function milestoneToMention(mode) {
    if (mode === "coding" || mode === "developer") return null;
    const state = read();
    const day = today();
    if (state.mentionedDay === day || !state.milestones.length) return null;
    const anniversary = state.milestones.find((m) => m.date.slice(5) === day.slice(5) && m.date < day);
    let line = null;
    let chosen = anniversary;
    if (anniversary) {
      const years = Number(day.slice(0, 4)) - Number(anniversary.date.slice(0, 4));
      line = `Today is ${years} year${years === 1 ? "" : "s"} since a moment you remember with the user: ${anniversary.text} (${anniversary.date}). If it fits, mention it once, naturally.`;
    } else if (!state.mentionedDay || daysBetween(state.mentionedDay, day) >= MENTION_EVERY_DAYS) {
      chosen = state.milestones
        .filter((m) => m.date < day)
        .sort((a, b) => String(a.mentionedAt || "").localeCompare(String(b.mentionedAt || "")))[0];
      if (chosen) {
        line = `A moment you remember with the user: ${chosen.text} (${chosen.date}). Bring it up only if it fits naturally; don't force it.`;
      }
    }
    if (!chosen) return null;
    const at = now();
    write({ ...state, mentionedDay: day, milestones: state.milestones.map((m) => (m === chosen ? { ...m, mentionedAt: at } : m)) });
    return line;
  }

  // "forget that": the newest note or milestone, if she made it in the
  // last FORGET_THAT_MS (so it undoes the one just shown, not an old one).
  // Otherwise the notes and milestones about query -- every word of it in
  // the text. The removed ones (maybe none).
  function forget(query) {
    const words = String(query || "").toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    const state = read();
    const matches = (item) => words.every((w) => item.text.toLowerCase().includes(w));
    let removed;
    if (words.length) {
      removed = [...state.notes.filter(matches), ...state.milestones.filter(matches)];
    } else {
      const newest = [...state.notes, ...state.milestones].sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1);
      removed = newest && Date.parse(now()) - Date.parse(newest.at) <= FORGET_THAT_MS ? [newest] : [];
    }
    if (removed.length) {
      write({
        ...state,
        notes: state.notes.filter((n) => !removed.includes(n)),
        milestones: state.milestones.filter((m) => !removed.includes(m)),
      });
    }
    return removed;
  }

  return {
    list,
    add,
    update,
    remove,
    milestones,
    addMilestone,
    updateMilestone,
    removeMilestone,
    ensureFirstChat,
    milestoneToMention,
    forget,
  };
}

// Her notes as a prompt block, or null when she has none (or it's a coding
// turn, which mood leaves alone too).
function relationshipPromptBlock(notes, mode) {
  if (!notes?.length || mode === "coding" || mode === "developer") return null;
  return `Your own notes on how you and the user get along (other characters don't share these):\n${notes.map((n) => `- ${n.text}`).join("\n")}`;
}

// "forget that" / "forget the note about X" / "forget the milestone about
// X" -- my own chat message, whole. { query } ("" for the newest), or null.
function findForgetRequest(message) {
  const line = String(message || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (line.length > 160) return null;
  if (/^(?:please\s+)?forget\s+(?:that|it|this)(?:\s+(?:note|milestone|moment))?(?:,?\s+please)?$/.test(line)) return { query: "" };
  const about = line.match(/^(?:please\s+)?forget\s+(?:the|your|that)\s+(?:note|milestone|moment)\s+(?:about|on|of)\s+(.+)$/);
  return about ? { query: about[1] } : null;
}

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: NOTE_TOOL,
      description:
        "Remember something about your own relationship with the user: a running joke between you, what they like or dislike from you, a promise you made, how they treat you. Only yours; other characters don't see it. Plain facts about the user belong in memory, not here.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "The note, one short sentence, e.g. \"They love it when I call them a gremlin.\"" },
        },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: MILESTONE_TOOL,
      description:
        "Remember a moment in your relationship with the user worth looking back on: something memorable you did together, a first, a big day for them you were part of. Dated; you'll be reminded of it now and then, and on its anniversary. Only yours. Not for ordinary chat.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The moment, one short sentence, e.g. \"We cleared the raid together after 40 wipes.\"" },
          date: { type: "string", description: "When, as YYYY-MM-DD. Leave it out for today." },
        },
        required: ["text"],
      },
    },
  },
];

// onNoted({kind: "note" | "milestone", ...item}): each new one, for the
// chat line that shows it.
function createRelationshipToolSource({ store, onNoted = () => {} }) {
  return {
    listToolSchemas: () => TOOL_SCHEMAS,
    isKnownToolName: (name) => name === NOTE_TOOL || name === MILESTONE_TOOL,
    async executeTool(name, args) {
      if (name === NOTE_TOOL) {
        const saved = store.add(args?.note);
        if (!saved) throw new Error("note is required");
        onNoted({ kind: "note", ...saved });
        return JSON.stringify({ ok: true, note: saved.text });
      }
      if (name === MILESTONE_TOOL) {
        const saved = store.addMilestone(args?.text, args?.date);
        if (!saved) throw new Error("text is required");
        onNoted({ kind: "milestone", ...saved });
        return JSON.stringify({ ok: true, milestone: saved.text, date: saved.date });
      }
      throw new Error(`unknown relationship tool: ${name}`);
    },
  };
}

module.exports = {
  MAX_MILESTONES,
  MAX_NOTES,
  createRelationshipStore,
  createRelationshipToolSource,
  findForgetRequest,
  relationshipPromptBlock,
};

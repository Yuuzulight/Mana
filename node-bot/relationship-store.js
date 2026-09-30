// Issue #914: each character's own notes about her relationship with the
// user -- a running joke, what they like from her, a promise she made. Facts
// about the user stay shared (acp-memory-store); these are hers alone, so
// server.js keeps one store per character (perCharacter, like mood and
// personality). She writes them with the relationship__note tool, which
// needs no approval: each new note shows as a chat line instead, and I can
// forget it from chat ("forget that") or edit/remove it in Settings. The
// newest MAX_NOTES reach her prompt.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 200;
const TOOL_NAME = "relationship__note";
const FORGET_THAT_MS = 30 * 60 * 1000;

const stableId = (seed) => crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);

// options.filePath: where the notes persist; omit it for an in-memory store
// (tests, and server.js under NODE_ENV=test).
// options.now: injectable clock (ISO string).
function createRelationshipStore(options = {}) {
  const filePath = options.filePath || null;
  const now = options.now || (() => new Date().toISOString());
  let memoryState = { notes: [] };

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
      return { ...parsed, notes };
    } catch (e) {
      return { notes: [] }; // none yet, or unreadable
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

  // The note as saved, or null for an empty one. The same text again only
  // moves it to the newest; past MAX_NOTES the oldest go.
  function add(text) {
    const note = clean(text);
    if (!note) return null;
    const state = read();
    const saved = { id: crypto.randomBytes(4).toString("hex"), text: note, at: now() };
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

  // "forget that": the newest note, if she made it in the last
  // FORGET_THAT_MS (so it undoes the note just shown, not an old one).
  // Otherwise the notes about query -- every word of it in the note. The
  // removed ones (maybe none).
  function forget(query) {
    const words = String(query || "").toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    const state = read();
    const newest = state.notes.at(-1);
    const removed = !words.length
      ? newest && Date.parse(now()) - Date.parse(newest.at) <= FORGET_THAT_MS ? [newest] : []
      : state.notes.filter((n) => words.every((w) => n.text.toLowerCase().includes(w)));
    if (removed.length) write({ ...state, notes: state.notes.filter((n) => !removed.includes(n)) });
    return removed;
  }

  return { list, add, update, remove, forget };
}

// Her notes as a prompt block, or null when she has none (or it's a coding
// turn, which mood leaves alone too).
function relationshipPromptBlock(notes, mode) {
  if (!notes?.length || mode === "coding" || mode === "developer") return null;
  return `Your own notes on how you and the user get along (other characters don't share these):\n${notes.map((n) => `- ${n.text}`).join("\n")}`;
}

// "forget that" / "forget the note about X" -- my own chat message, whole.
// { query } ("" for the newest), or null.
function findForgetRequest(message) {
  const line = String(message || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (line.length > 160) return null;
  if (/^(?:please\s+)?forget\s+(?:that|it|this)(?:\s+note)?(?:,?\s+please)?$/.test(line)) return { query: "" };
  const about = line.match(/^(?:please\s+)?forget\s+(?:the|your|that)\s+note\s+(?:about|on)\s+(.+)$/);
  return about ? { query: about[1] } : null;
}

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: TOOL_NAME,
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
];

// onNoted(note): each new note, for the chat line that shows it.
function createRelationshipToolSource({ store, onNoted = () => {} }) {
  return {
    listToolSchemas: () => TOOL_SCHEMAS,
    isKnownToolName: (name) => name === TOOL_NAME,
    async executeTool(name, args) {
      if (name !== TOOL_NAME) throw new Error(`unknown relationship tool: ${name}`);
      const saved = store.add(args?.note);
      if (!saved) throw new Error("note is required");
      onNoted(saved);
      return JSON.stringify({ ok: true, note: saved.text });
    },
  };
}

module.exports = {
  MAX_NOTES,
  createRelationshipStore,
  createRelationshipToolSource,
  findForgetRequest,
  relationshipPromptBlock,
};

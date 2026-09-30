// Issue #914: each character's own notes about her relationship with the
// user -- a running joke, what they like from her, a promise she made. Facts
// about the user stay shared (acp-memory-store); these are hers alone, so
// server.js keeps one store per character (perCharacter, like mood and
// personality). She writes them with the relationship__note tool; the
// newest MAX_NOTES reach her prompt. Edit or delete by hand in the JSON file.
const fs = require("node:fs");
const path = require("node:path");

const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 200;
const TOOL_NAME = "relationship__note";

// options.filePath: where the notes persist; omit it for an in-memory store
// (tests, and server.js under NODE_ENV=test).
// options.now: injectable clock (ISO string).
function createRelationshipStore(options = {}) {
  const filePath = options.filePath || null;
  const now = options.now || (() => new Date().toISOString());
  let memoryNotes = [];

  function list() {
    if (!filePath) return memoryNotes;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(parsed?.notes) ? parsed.notes.filter((n) => typeof n?.text === "string" && n.text) : [];
    } catch (e) {
      return []; // none yet, or unreadable
    }
  }

  // The note as saved, or null for an empty one. The same text again only
  // moves it to the newest; past MAX_NOTES the oldest go.
  function add(text) {
    const note = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
    if (!note) return null;
    const saved = { text: note, at: now() };
    const notes = [...list().filter((n) => n.text.toLowerCase() !== note.toLowerCase()), saved].slice(-MAX_NOTES);
    if (!filePath) {
      memoryNotes = notes;
      return saved;
    }
    // A failed write throws: the tool call reports it to her.
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ notes }, null, 2), "utf8");
    return saved;
  }

  return { list, add };
}

// Her notes as a prompt block, or null when she has none (or it's a coding
// turn, which mood leaves alone too).
function relationshipPromptBlock(notes, mode) {
  if (!notes?.length || mode === "coding" || mode === "developer") return null;
  return `Your own notes on how you and the user get along (other characters don't share these):\n${notes.map((n) => `- ${n.text}`).join("\n")}`;
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

function createRelationshipToolSource({ store }) {
  return {
    listToolSchemas: () => TOOL_SCHEMAS,
    isKnownToolName: (name) => name === TOOL_NAME,
    async executeTool(name, args) {
      if (name !== TOOL_NAME) throw new Error(`unknown relationship tool: ${name}`);
      const saved = store.add(args?.note);
      if (!saved) throw new Error("note is required");
      return JSON.stringify({ ok: true, note: saved.text });
    },
  };
}

module.exports = {
  MAX_NOTES,
  createRelationshipStore,
  createRelationshipToolSource,
  relationshipPromptBlock,
};

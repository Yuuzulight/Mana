// #923/#925: lets me fix Mana's hearing by asking her ("add Gigi Murin to
// your speech words", "I said Gigi Murin, not GG Moon"). My request is the
// approval, like reminders: "read" tier in ai/tool-risk.js, since it only
// changes Mana's own speech list (speech-vocabulary.js). The guard is that a
// word or mishearing has to be in my own message this turn (userMessage,
// the raw turn as for memory__remember), so nothing Mana read elsewhere can
// put words in her ears. confirm (a single ordinary word as heard_as) also
// needs my own yes this turn, as memory__remember's "confirm" does.
const { saysPhrase } = require("../speech-vocabulary");
const { USER_SAID_YES } = require("./memory-tool-source");
const { cleanTerm } = require("../whisper-prompt");

const SPEECH_TOOL_PREFIX = "speech__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${SPEECH_TOOL_PREFIX}add_word`,
      description:
        "Teach your speech recognition a word or name the user says, when they ask you to (\"add Gigi Murin to your words\"), or fix a repeat mishearing when they correct you (\"I said Gigi Murin, not GG Moon\": word \"Gigi Murin\", heard_as \"GG Moon\"). Both must be in the user's own message, spelled as they wrote it.",
      parameters: {
        type: "object",
        properties: {
          word: { type: "string", description: "The word or name, as the user spelled it." },
          heard_as: {
            type: "string",
            description: "Optional: what speech recognition wrote instead. From then on it's replaced with word in everything you hear.",
          },
          confirm: {
            type: "boolean",
            description: "Only after the user says yes: allow heard_as to be a single ordinary word.",
          },
        },
        required: ["word"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${SPEECH_TOOL_PREFIX}remove_word`,
      description: "Forget a speech word, and any mishearing fix from or to it, when the user asks.",
      parameters: {
        type: "object",
        properties: { word: { type: "string", description: "The word, or the misheard phrase." } },
        required: ["word"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${SPEECH_TOOL_PREFIX}list_words`,
      description: "List your saved speech words and mishearing fixes.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function isSpeechToolName(name) {
  return typeof name === "string" && name.startsWith(SPEECH_TOOL_PREFIX);
}

function createSpeechToolSource({ speechVocabulary, userMessage }) {
  function addWord(args) {
    // Checked as they'll be saved.
    const word = cleanTerm(args?.word);
    const heard = cleanTerm(args?.heard_as);
    for (const phrase of [word, heard].filter(Boolean)) {
      if (!saysPhrase(userMessage, phrase)) {
        return { ok: false, error: `"${phrase}" isn't in the user's message; ask them to say or type it` };
      }
    }
    try {
      const confirm = args?.confirm === true && USER_SAID_YES.test(userMessage || "");
      const fix = heard ? speechVocabulary.addCorrection(heard, word, { confirm }) : null;
      return { ok: true, word: speechVocabulary.addWord(word), ...(fix && { heard_as: fix.heard }) };
    } catch (e) {
      if (!e.needsConfirm) throw e;
      return {
        ok: false,
        needsConfirm: true,
        error: `${e.message}. Ask the user; only once they say yes, call again with confirm: true.`,
      };
    }
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(SPEECH_TOOL_PREFIX.length);
    if (action === "add_word") return JSON.stringify(addWord(args));
    if (action === "remove_word") return JSON.stringify({ ok: true, removed: speechVocabulary.removeWord(String(args?.word || "")) });
    if (action === "list_words") {
      const { words, corrections } = speechVocabulary.state();
      return JSON.stringify({ words, corrections });
    }
    throw new Error(`unknown speech tool: ${qualifiedName}`);
  }

  return { listToolSchemas: () => TOOL_SCHEMAS, executeTool, isKnownToolName: isSpeechToolName };
}

module.exports = { createSpeechToolSource };

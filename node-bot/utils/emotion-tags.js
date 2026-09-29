// Issue #623: Mana labels each sentence with the face she makes saying it,
// as a bracketed tag ("[happy] Welcome back!"). The tags drive the avatar's
// expression per sentence and must never be spoken, shown or stored, so
// buildAssistantReply strips them here before the text goes anywhere.
//
// Only known tags (and a few likely paraphrases of them) are stripped: an
// unrecognised "[word]" may be real content (a code snippet, a "[TODO]") and
// is left alone. Clients map a tag to the avatar's own expressions through
// mana-avatar.json, so this list is the whole vocabulary a model config has
// to cover.
const EMOTION_TAGS = [
  "neutral",
  "happy",
  "excited",
  "surprised",
  "sad",
  "disappointed",
  "angry",
  "disgusted",
  "embarrassed",
  "thinking",
  "questioning",
  "wink",
];

const ALIASES = {
  joy: "happy",
  smile: "happy",
  surprise: "surprised",
  confused: "questioning",
  curious: "questioning",
  shy: "embarrassed",
  mad: "angry",
  disgust: "disgusted",
};

const EMOTION_TAG_PROMPT = `Before each sentence, write one emotion tag for the face you make while saying it, chosen from: ${EMOTION_TAGS.map((tag) => `[${tag}]`).join(" ")}. The tags are hidden, never spoken or shown, so never mention them. Example: [happy] Welcome back! [questioning] Did the raid go well?`;

function canonicalTag(word) {
  const lower = word.toLowerCase();
  if (EMOTION_TAGS.includes(lower)) return lower;
  return Object.prototype.hasOwnProperty.call(ALIASES, lower) ? ALIASES[lower] : null;
}

// Returns the text without its emotion tags, and the tags found, in order.
// A tag's surrounding spaces collapse to one between words and to none next
// to punctuation or a line edge, so "Hi! [happy] Yes." -> "Hi! Yes." and
// "great [happy]." -> "great.". Newlines are never touched.
function stripEmotionTags(text) {
  const emotions = [];
  const stripped = String(text ?? "").replace(
    /([ \t]*)\[\s*([A-Za-z]+)\s*\]([ \t]*)/g,
    (match, before, word, after, offset, whole) => {
      const tag = canonicalTag(word);
      if (!tag) return match;
      emotions.push(tag);
      const next = whole[offset + match.length];
      const joinsWords = before && after && offset > 0 && next !== undefined && next !== "\n";
      return joinsWords ? " " : "";
    },
  );
  return { text: stripped.trim(), emotions };
}

// The face for a reply spoken as one clip: its first non-neutral tag, else
// "neutral" if it had tags at all, else null (untagged -- the client falls
// back to its own detection).
function replyEmotion(emotions) {
  return emotions.find((tag) => tag !== "neutral") || emotions[0] || null;
}

module.exports = { EMOTION_TAGS, EMOTION_TAG_PROMPT, stripEmotionTags, replyEmotion };

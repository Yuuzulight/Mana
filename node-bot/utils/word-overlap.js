// Extracted from three near-identical copies (capabilities/skills-capability.js,
// acp-memory-store.js, plugins/screen-sensing/screen-sensing.js) -- same
// tokenizer, same >3-char significance filter, same dedup, each just used
// it for a different comparison. Kept deliberately minimal: only the
// tokenizer and the "how many words do these two lists share" count are
// shared -- each caller keeps its own threshold logic (an absolute count
// vs. a overlap ratio), since those are genuinely different decisions, not
// duplicated code.
function significantWords(text) {
  return [
    ...new Set(
      String(text || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    ),
  ];
}

function sharedWordCount(wordsA, wordsB) {
  return wordsA.filter((w) => wordsB.includes(w)).length;
}

module.exports = { significantWords, sharedWordCount };

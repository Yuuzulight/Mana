// Issue #331: today the whole reply is generated, then the whole reply is
// synthesized, then it plays. Perceived latency is full generation time
// plus full synthesis time, back to back. Streaming means cutting the
// growing text into sentences and handing each one to TTS while the model
// keeps writing the next.
//
// This is the cutting half, kept as a pure function of the text stream so
// it can be tested without a model or a TTS service, and so the scheduling
// half can be built and reasoned about separately.
//
// Deliberately not a real sentence tokenizer. The job is "is this safe to
// speak yet", which is a much lower bar than linguistic correctness: an
// occasional split in the wrong place costs a slightly odd pause, while a
// missed split costs latency. Guards are here only for the cases that
// actually sound wrong.

// Followed by whitespace, so a terminator arriving at the very end of a
// delta is held until the next one confirms the sentence really ended --
// "3" + "." + "14" must not become a sentence boundary.
const TERMINATORS = new Set([".", "!", "?"]);

// Common abbreviations where the period is not a sentence end. Short list
// on purpose: each entry is a real pause the user would hear as wrong, and
// a missing entry costs one odd break rather than a bug.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st",
  "e.g", "i.e", "etc", "vs", "approx", "no",
]);

function endsWithAbbreviation(text) {
  const match = text.match(/([A-Za-z.]+)\.$/);
  if (!match) return false;
  return ABBREVIATIONS.has(match[1].toLowerCase());
}

// options.maxChars: run-on fallback. A model that never emits a terminator
// -- a list, a code block, a language without western punctuation -- must
// not hold the whole reply hostage waiting for one.
function createSentenceChunker(options = {}) {
  const maxChars = Math.max(20, Number(options.maxChars) || 240);
  let buffer = "";

  function takeSentences() {
    const out = [];
    let index = 0;

    while (index < buffer.length) {
      const char = buffer[index];

      if (TERMINATORS.has(char)) {
        // Run the terminator out, so "..." and "?!" stay together instead
        // of producing empty fragments.
        let end = index;
        while (end + 1 < buffer.length && TERMINATORS.has(buffer[end + 1])) end += 1;

        const next = buffer[end + 1];
        // No following character yet: the delta ended exactly on the
        // terminator and we cannot tell a sentence end from a decimal or an
        // abbreviation. Wait for more.
        if (next === undefined) break;

        const candidate = buffer.slice(0, end + 1);
        const isDecimal = char === "." && /\d$/.test(candidate.slice(0, -1)) && /\d/.test(next);

        if (/\s/.test(next) && !isDecimal && !endsWithAbbreviation(candidate)) {
          const sentence = candidate.trim();
          if (sentence) out.push(sentence);
          buffer = buffer.slice(end + 1).replace(/^\s+/, "");
          index = 0;
          continue;
        }
        index = end + 1;
        continue;
      }

      index += 1;
    }

    // Run-on fallback: break at the last space before the cap so a word is
    // never split down the middle, since half a word is audibly wrong in a
    // way a slightly early break is not.
    while (buffer.length > maxChars) {
      const window = buffer.slice(0, maxChars);
      const breakAt = window.lastIndexOf(" ");
      const cut = breakAt > 0 ? breakAt : maxChars;
      const sentence = buffer.slice(0, cut).trim();
      if (sentence) out.push(sentence);
      buffer = buffer.slice(cut).replace(/^\s+/, "");
    }

    return out;
  }

  return {
    // Feed a token/delta. Returns sentences that are now complete -- never
    // a partial one, because a half-sentence sent to TTS is audibly wrong
    // and cannot be taken back once it is playing.
    push(delta) {
      buffer += String(delta ?? "");
      return takeSentences();
    },
    // End of stream: whatever is left is a sentence whether or not it was
    // punctuated.
    flush() {
      const rest = buffer.trim();
      buffer = "";
      return rest ? [rest] : [];
    },
    pending() {
      return buffer;
    },
  };
}

module.exports = { createSentenceChunker };

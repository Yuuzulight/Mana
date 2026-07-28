// Pure helpers for filtering Whisper transcription output. Kept DOM-free
// so the launcher tests can cover them directly -- same pattern as
// avatar/live2d-logic.js.

// Whisper is known to hallucinate short "phantom" phrases on silence or
// faint background noise -- YouTube-outro-style artifacts from its
// training data ("Thank you.", "Please subscribe.") rather than an honest
// description of non-speech audio. Only filtered when the recorded audio
// was very short: a real "thank you" spoken normally takes longer than
// this to say, so a longer clip with the same wording is trusted and
// passed through.
const MAX_HALLUCINATION_AUDIO_SECONDS = 2.5;
const WHISPER_HALLUCINATION_PHRASES = [
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "like and subscribe",
  "subscribe to my channel",
  "subtitles by",
  "the end",
  "bye bye",
];

// normalizedTranscript: already run through the caller's own
// cleanTranscriptText().toLowerCase() -- kept out of this module so it
// doesn't duplicate renderer.js's own normalization logic.
function isLikelyWhisperHallucination(normalizedTranscript, durationSeconds) {
  if (typeof durationSeconds !== "number" || durationSeconds > MAX_HALLUCINATION_AUDIO_SECONDS) {
    return false;
  }
  return WHISPER_HALLUCINATION_PHRASES.includes(normalizedTranscript);
}

// Issue #4: catches common Whisper mis-transcriptions of "Mana" that the
// exact WAKE_WORDS list in renderer.js doesn't enumerate (e.g. "mama",
// "mona", "manaa") without needing to keep growing that list by hand.
// Classic iterative Levenshtein distance -- no dependency needed for a
// ~15-line, well-understood algorithm on short strings (wake words are a
// handful of characters, this runs in microseconds).
function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, (_, i) => [i, ...new Array(cols - 1).fill(0)]);
  for (let j = 1; j < cols; j++) dist[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1, // deletion
        dist[i][j - 1] + 1, // insertion
        dist[i - 1][j - 1] + cost, // substitution
      );
    }
  }
  return dist[rows - 1][cols - 1];
}

// Only ever called on a candidate word that already failed the exact
// WAKE_WORDS match -- a tight maxDistance (default 1) keeps this from
// firing on unrelated short words while still catching a single dropped,
// swapped, or misheard letter.
function fuzzyMatchesWakeWord(candidateWord, wakeWords, maxDistance = 1) {
  const normalized = String(candidateWord || "").toLowerCase().trim();
  if (!normalized) return false;
  return wakeWords.some((word) => {
    // Multi-word wake phrases ("wake up") aren't fuzzy-matched word-by-word
    // here -- the exact-match regex in renderer.js already handles those;
    // fuzzy matching is specifically for single mis-transcribed name variants.
    if (word.includes(" ")) return false;
    return levenshteinDistance(normalized, word) <= maxDistance;
  });
}

// Issue #4: how much to boost a quiet clip so both the reject-threshold
// check and Whisper itself see a stronger signal, without amplifying an
// already-loud clip (which would just clip/distort it) or over-boosting
// near-silent noise into false "speech". Returns a multiplier, not the
// boosted samples themselves -- applying it to a Float32Array/AudioBuffer
// is DOM/Web-Audio-API territory that belongs in renderer.js.
function computeGainFactor(peak, targetPeak, maxBoost) {
  if (!targetPeak || peak <= 0 || peak >= targetPeak) return 1;
  return Math.min(targetPeak / peak, maxBoost);
}

// Issue #4: extracted out of renderer.js so it's covered by the same
// synthetic-signal test harness as everything else here (real recorded
// WAV fixtures aren't available in this environment, but rms/peak/
// zeroCrossingRate stats from a synthesized signal exercise the exact
// same decision logic). thresholds mirrors renderer.js's own
// MIN_SPEECH_RMS/MIN_SPEECH_PEAK/MAX_CLICKY_ZERO_CROSSING_RATE constants,
// passed in rather than imported so this stays a pure function.
function getSpeechRejectReason(stats, thresholds) {
  if (stats.rms < thresholds.minRms || stats.peak < thresholds.minPeak) {
    return "quiet";
  }
  if (stats.zeroCrossingRate > thresholds.maxClickyZcr) {
    return "clicky";
  }
  return null;
}

module.exports = {
  MAX_HALLUCINATION_AUDIO_SECONDS,
  WHISPER_HALLUCINATION_PHRASES,
  isLikelyWhisperHallucination,
  levenshteinDistance,
  fuzzyMatchesWakeWord,
  computeGainFactor,
  getSpeechRejectReason,
};

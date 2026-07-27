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

module.exports = {
  MAX_HALLUCINATION_AUDIO_SECONDS,
  WHISPER_HALLUCINATION_PHRASES,
  isLikelyWhisperHallucination,
};

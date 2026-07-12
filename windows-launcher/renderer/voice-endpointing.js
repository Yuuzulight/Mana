// Decides when a voice recording should stop, based on live RMS readings
// rather than a fixed duration — so a long sentence isn't cut off mid-way,
// and Mana only treats speech as "done" once the user has actually paused.

const DEFAULT_SILENCE_BUFFER_MS = 2200;
const DEFAULT_MAX_WAIT_FOR_SPEECH_MS = 6000;
const DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS = 8000;
const DEFAULT_MAX_UTTERANCE_MS = 20000;

// Returns a stop reason string once recording should end, or null to keep
// recording. `msSinceLastSpeech` is only meaningful once hasHeardSpeech is
// true; callers should pass 0 (or anything) beforehand.
function shouldStopRecording({
  hasHeardSpeech,
  elapsedMs,
  msSinceLastSpeech,
  maxWaitForSpeechMs = DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  silenceBufferMs = DEFAULT_SILENCE_BUFFER_MS,
  maxDurationMs = DEFAULT_MAX_UTTERANCE_MS,
}) {
  if (elapsedMs >= maxDurationMs) {
    return "max-duration";
  }
  if (hasHeardSpeech && msSinceLastSpeech >= silenceBufferMs) {
    return "silence-after-speech";
  }
  if (!hasHeardSpeech && elapsedMs >= maxWaitForSpeechMs) {
    return "no-speech-timeout";
  }
  return null;
}

module.exports = {
  DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
  shouldStopRecording,
};

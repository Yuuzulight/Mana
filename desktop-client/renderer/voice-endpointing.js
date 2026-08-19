// Decides when a voice recording should stop, based on live RMS readings
// rather than a fixed duration — so a long sentence isn't cut off mid-way,
// and Mana only treats speech as "done" once the user has actually paused.
//
// Unlike windows-launcher (nodeIntegration:true, so its renderer.js can
// require() this directly), desktop-client's renderer runs with
// nodeIntegration:false/contextIsolation:true (see main.js), so this file
// is also loaded as a classic <script> tag and needs to attach itself to
// `window` -- same dual module.exports/window pattern already used by
// streaming-chunk-queue.js in this directory. Wrapped in an IIFE so the
// top-level consts below don't leak into the shared global scope.
(function () {

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

// Issue #219 phase 2: pure hold-time decision for the "Mana is speaking, did
// the user just start talking over her" monitor -- split out from the
// mic/VAD/AudioContext plumbing so the hold-time gating (which is what
// keeps a single echo/pop blip from triggering an interrupt) is unit
// testable on its own. Callers track `speechStartedAt` across calls the
// same way `hasHeardSpeech`/`msSinceLastSpeech` are tracked above.
const DEFAULT_BARGE_IN_HOLD_MS = 350;

function nextBargeInState({ isSpeech, speechStartedAt, now, holdMs = DEFAULT_BARGE_IN_HOLD_MS }) {
  if (!isSpeech) {
    return { speechStartedAt: null, triggered: false };
  }
  const startedAt = speechStartedAt === null ? now : speechStartedAt;
  return { speechStartedAt: startedAt, triggered: now - startedAt >= holdMs };
}

const exportsObj = {
  DEFAULT_BARGE_IN_HOLD_MS,
  DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
  nextBargeInState,
  shouldStopRecording,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = exportsObj;
}
if (typeof window !== "undefined") {
  window.ManaVoiceEndpointing = exportsObj;
}

})();

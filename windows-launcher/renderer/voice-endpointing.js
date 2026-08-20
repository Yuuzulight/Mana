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

// Issue #219 phase 2: pure hold-time decision for the "Mana is speaking, did
// the user just start talking over her" monitor -- split out from the
// mic/VAD/AudioContext plumbing so the hold-time gating (which is what
// keeps a single echo/pop blip from triggering an interrupt) is unit
// testable on its own. Callers track `speechStartedAt` across calls the
// same way `hasHeardSpeech`/`msSinceLastSpeech` are tracked above.
const DEFAULT_BARGE_IN_HOLD_MS = 350;

// #340: below this loudness, a frame doesn't count toward the barge-in hold
// timer even if VAD says it's speech -- filters out quiet room noise/breath
// that Silero VAD sometimes false-positives on. -45 dBFS sits above typical
// mic room-noise floor (-50 to -60 dBFS) and below normal speech level (-20
// to -30 dBFS); tunable via this exported constant without redeploying.
const DEFAULT_BARGE_IN_MIN_DBFS = -45;

function nextBargeInState({
  isSpeech,
  speechStartedAt,
  now,
  holdMs = DEFAULT_BARGE_IN_HOLD_MS,
  isLoudEnough = true,
}) {
  if (!isSpeech || !isLoudEnough) {
    return { speechStartedAt: null, triggered: false };
  }
  const startedAt = speechStartedAt === null ? now : speechStartedAt;
  return { speechStartedAt: startedAt, triggered: now - startedAt >= holdMs };
}

// #340: converts a Float32Array time-domain buffer (the same kind
// analyser.getFloatTimeDomainData already fills for the VAD frame) into a
// loudness reading in dBFS -- 0 is full scale, more negative is quieter.
// Same RMS computation recordUntilSilence's currentRms() already does,
// just expressed logarithmically so it can be compared against
// DEFAULT_BARGE_IN_MIN_DBFS.
function dbfsFromSamples(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  return 20 * Math.log10(rms);
}

module.exports = {
  DEFAULT_BARGE_IN_HOLD_MS,
  DEFAULT_BARGE_IN_MIN_DBFS,
  DEFAULT_GAMING_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_MAX_UTTERANCE_MS,
  DEFAULT_MAX_WAIT_FOR_SPEECH_MS,
  DEFAULT_SILENCE_BUFFER_MS,
  dbfsFromSamples,
  nextBargeInState,
  shouldStopRecording,
};

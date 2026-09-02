namespace Mana.NativeLauncher;

// #479 sub-project 3: pure hold-time + loudness decision for "the user just
// started talking over Mana" -- ported from windows-launcher's
// voice-endpointing.js (nextBargeInState/dbfsFromSamples), which already
// tuned these thresholds against real usage. Split out from VoiceLoop's
// audio/VAD plumbing the same way RecordingSegmenter's stop-recording logic
// is, so the actual decision is unit testable on its own.
//
// Unlike the JS version (which polls a live buffer against wall-clock
// timestamps via performance.now()), this tracks held duration directly in
// frame-derived milliseconds, matching how VoiceLoop already tracks
// segmentElapsedMs/msSinceLastSpeech -- a fixed property of the frame size,
// not something to measure via wall-clock deltas between frame-processing
// calls (those calls aren't evenly spaced).
internal static class BargeInGate
{
    // #219 phase 2: below this loudness, a frame doesn't count toward the
    // hold timer even if VAD says it's speech -- filters out quiet room
    // noise/breath that Silero VAD sometimes false-positives on. Requiring
    // BargeInHoldMs of continuous qualifying speech (not just one positive
    // frame) is what keeps a single echo/pop blip from triggering an
    // interruption.
    public const long DefaultHoldMs = 350;
    public const double DefaultMinDbfs = -45.0;

    // previousHeldMs: the running duration returned by the previous call
    // (0 if this is the first frame, or the frame broke the streak).
    // frameMs: how much audio this one frame represents.
    // Triggered is true only on the frame that crosses holdMs (edge, not
    // level) -- fires exactly once per continuous qualifying run, not on
    // every frame after crossing, so a caller reacting to it (stopping
    // playback) does so exactly once.
    public static (long HeldMs, bool Triggered) Next(
        bool isSpeech,
        bool isLoudEnough,
        long previousHeldMs,
        long frameMs,
        long holdMs = DefaultHoldMs)
    {
        if (!isSpeech || !isLoudEnough)
        {
            return (0, false);
        }

        var heldMs = previousHeldMs + frameMs;
        var triggered = previousHeldMs < holdMs && heldMs >= holdMs;
        return (heldMs, triggered);
    }

    // Same RMS -> dBFS formula as dbfsFromSamples in voice-endpointing.js.
    public static double DbfsFromSamples(IReadOnlyList<float> samples)
    {
        if (samples.Count == 0)
        {
            return double.NegativeInfinity;
        }

        double sumSquares = 0;
        foreach (var sample in samples)
        {
            sumSquares += (double)sample * sample;
        }
        var rms = Math.Sqrt(sumSquares / samples.Count);
        return 20 * Math.Log10(rms);
    }
}

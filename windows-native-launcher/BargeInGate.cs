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

    // #682: the Electron launcher's env overrides (renderer.js). Voice
    // barge-in is on unless MANA_BARGE_IN_VOICE is "0" (hotkey-only);
    // unparseable hold/dBFS values fall back to the defaults.
    public static bool VoiceEnabled(string? env) => env?.Trim() != "0";

    public static long ResolveHoldMs(string? env) =>
        long.TryParse(env, out var ms) && ms >= 0 ? ms : DefaultHoldMs;

    public static double ResolveMinDbfs(string? env) =>
        double.TryParse(env, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var dbfs)
            && double.IsFinite(dbfs) ? dbfs : DefaultMinDbfs;

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

// #665: what talking over Mana does. MinWords(2) is the default: the gate
// still fires on sustained loud speech, but instead of stopping her it
// lowers her volume while what I said is transcribed; only an interruption
// with at least that many words stops her -- a cough, "mm" or "yeah" and
// she carries on at full volume, mid-sentence.
// NotWhileSpeaking never interrupts; what I say while she talks is answered
// once she finishes. Always is the old behaviour (any sustained speech).
internal enum BargeInMode
{
    MinWords,
    Always,
    NotWhileSpeaking,
}

internal static class BargeInPolicy
{
    public const int DefaultMinWords = 2;

    // How loud she stays while an interruption is being decided.
    public const float DuckVolume = 0.3f;

    // Whether a ducked interruption turned out real: transcribed, not
    // dropped as noise or a hallucination, and at least minWords words.
    public static bool IsRealInterruption(bool transcribed, bool dropped, string transcript, int minWords) =>
        transcribed && !dropped && WordCount(transcript) >= minWords;

    // The env var (MANA_BARGE_IN_MODE) wins over the saved setting, like
    // the other voice tunables; unknown or missing text means the default.
    public static BargeInMode Resolve(string? env, string? saved) => Parse(env) ?? Parse(saved) ?? BargeInMode.MinWords;

    public static BargeInMode? Parse(string? text) => text?.Trim().ToLowerInvariant() switch
    {
        "minwords" or "min-words" => BargeInMode.MinWords,
        "always" => BargeInMode.Always,
        "notwhilespeaking" or "not-while-speaking" => BargeInMode.NotWhileSpeaking,
        _ => null,
    };

    // MANA_BARGE_IN_MIN_WORDS, else DefaultMinWords.
    public static int MinWords(string? env) =>
        int.TryParse(env, out var n) && n >= 1 ? n : DefaultMinWords;

    // Words in a (cleaned) transcript: runs of letters/digits, so "wait,
    // stop!" is two and "mm..." is one.
    public static int WordCount(string transcript) =>
        System.Text.RegularExpressions.Regex.Matches(transcript, @"[\p{L}\p{N}]+(?:['\u2019][\p{L}]+)?").Count;
}


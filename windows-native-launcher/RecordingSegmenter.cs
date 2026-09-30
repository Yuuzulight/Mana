using System;
using System.Collections.Generic;

namespace Mana.NativeLauncher;

internal enum RecordingStopReason
{
    None,
    MaxDuration,
    SilenceAfterSpeech,
    NoSpeechTimeout,
}

// Ports windows-launcher/renderer/voice-endpointing.js's
// shouldStopRecording -- decides when a growing speech segment should
// close, based on live VAD readings rather than a fixed duration, so a
// long sentence isn't cut off mid-way and a segment is only closed once
// the user has actually paused.
internal static class RecordingSegmenter
{
    internal const long DefaultSilenceBufferMs = 2200;
    internal const long DefaultMaxWaitForSpeechMs = 6000;
    internal const long DefaultMaxUtteranceMs = 20000;

    // #858: the end-of-turn silence -- MANA_SILENCE_BUFFER_MS (Electron's
    // knob) wins over Settings > Voice, else 2.2s. Values outside
    // 300ms-10s are ignored.
    internal static long ResolveSilenceBufferMs(string? env, long? saved) =>
        long.TryParse(env, out var fromEnv) && fromEnv is >= 300 and <= 10000 ? fromEnv
        : saved is >= 300 and <= 10000 ? saved.Value
        : DefaultSilenceBufferMs;

    // msSinceLastSpeech is only meaningful once hasHeardSpeech is true;
    // callers should pass 0 (or anything) beforehand.
    internal static RecordingStopReason ShouldStopRecording(
        bool hasHeardSpeech,
        long elapsedMs,
        long msSinceLastSpeech,
        long maxWaitForSpeechMs = DefaultMaxWaitForSpeechMs,
        long silenceBufferMs = DefaultSilenceBufferMs,
        long maxDurationMs = DefaultMaxUtteranceMs)
    {
        if (elapsedMs >= maxDurationMs)
        {
            return RecordingStopReason.MaxDuration;
        }

        if (hasHeardSpeech && msSinceLastSpeech >= silenceBufferMs)
        {
            return RecordingStopReason.SilenceAfterSpeech;
        }

        if (!hasHeardSpeech && elapsedMs >= maxWaitForSpeechMs)
        {
            return RecordingStopReason.NoSpeechTimeout;
        }

        return RecordingStopReason.None;
    }

    // #619: port of voice-endpointing.js's silenceBufferMsForTranscript --
    // the live partial transcript nudges the end-of-turn silence shorter
    // ("...that's all." wraps up in under a second) or longer ("and I
    // think..." keeps listening). The shortened wait is ~0.8s rather than
    // Electron's 1.2s (#619's addendum) -- safe because VoiceLoop's merge
    // window rejoins a turn the user resumes within a second. No clear
    // signal (empty, or neither trailing nor terminal) keeps baseMs.
    internal const long CompleteSilenceBufferMs = 800;
    internal const long TrailingSilenceBufferMs = 3500;

    // Deliberately short and high-confidence, same list as Electron's: a
    // false "still composing" costs a second of waiting, a false "done"
    // costs a split turn (which the merge window then has to catch).
    private static readonly HashSet<string> TrailingIncompleteWords = new(StringComparer.Ordinal)
    {
        "and", "but", "so", "because", "or", "if", "that", "which", "um", "uh", "like", "well",
    };

    internal static (long SilenceBufferMs, string Reason) SilenceBufferMsForTranscript(string? transcript, long baseMs = DefaultSilenceBufferMs)
    {
        var trimmed = (transcript ?? "").Trim();
        if (trimmed.Length == 0)
        {
            return (baseMs, "default");
        }
        // Whisper writes a trailing-off sentence as "so..." -- an ellipsis
        // trails off even though it ends in '.' (Electron misses this one).
        if (trimmed.EndsWith(',') || trimmed.EndsWith("...") || trimmed.EndsWith('…'))
        {
            return (TrailingSilenceBufferMs, "trailing");
        }
        var words = trimmed.TrimEnd('.', ',', '!', '?').Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 0 && TrailingIncompleteWords.Contains(words[^1].ToLowerInvariant()))
        {
            return (TrailingSilenceBufferMs, "trailing");
        }
        if (trimmed[^1] is '.' or '!' or '?')
        {
            return (CompleteSilenceBufferMs, "complete");
        }
        return (baseMs, "default");
    }

    // #909: Smart Turn's P(finished) for the current pause (SmartTurnRunner)
    // refines the transcript's call above. Text and audio both saying "done"
    // ends the turn fastest; audio alone "done" gets the complete-sentence
    // wait; audio "not done" with no text signal waits like a trailing "and";
    // a disagreement falls back to the base wait. A trailing transcript
    // ("and...") always waits, and no fresh score (model off or missing, or
    // speech since) leaves the transcript's call as it was before #909.
    // So "done" never waits longer than the transcript alone would, and "not
    // done" never shorter.
    internal const long SmartTurnPauseMs = 200;
    internal const long AgreedCompleteSilenceBufferMs = 500;

    internal static (long SilenceBufferMs, string Reason) WithSmartTurn(
        (long SilenceBufferMs, string Reason) text, float? pComplete, float threshold, long baseMs = DefaultSilenceBufferMs)
    {
        if (pComplete is not { } p || text.Reason == "trailing")
        {
            return text;
        }
        var done = p >= threshold;
        return (text.Reason == "complete", done) switch
        {
            (true, true) => (Math.Min(AgreedCompleteSilenceBufferMs, baseMs), "complete+turn"),
            (true, false) => (Math.Max(CompleteSilenceBufferMs, baseMs), "complete-turn"),
            (false, true) => (Math.Min(CompleteSilenceBufferMs, baseMs), "turn"),
            (false, false) => (Math.Max(TrailingSilenceBufferMs, baseMs), "midturn"),
        };
    }

    // #619: when VoiceLoop may ask /transcribe-partial for a live transcript
    // of the segment so far. Whisper load stays bounded: never overlapping
    // (inFlight), only once there's real speech the last request didn't
    // cover (a pause after a snapshot adds nothing new), about once a second
    // while the user keeps talking -- and sooner (700ms) once they pause,
    // since that's the request the adaptive end-of-turn above is waiting on.
    internal const long PartialMinSpeechMs = 300;
    internal const long PartialPauseMs = 200;
    internal const long PartialPauseIntervalMs = 700;
    internal const long PartialSpeakingIntervalMs = 1000;

    // msSinceLastRequest counts from the segment's first speech (or the
    // last request), so the first request waits for real speech too.
    internal static bool ShouldRequestPartial(
        bool inFlight,
        long segmentSpeechMs,
        long uncoveredSpeechMs,
        long msSinceLastSpeech,
        long msSinceLastRequest)
    {
        if (inFlight || segmentSpeechMs < PartialMinSpeechMs || uncoveredSpeechMs <= 0)
        {
            return false;
        }
        var interval = msSinceLastSpeech >= PartialPauseMs ? PartialPauseIntervalMs : PartialSpeakingIntervalMs;
        return msSinceLastRequest >= interval;
    }
}

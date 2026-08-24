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
}

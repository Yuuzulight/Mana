using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class RecordingSegmenterTests
{
    [Fact]
    public void KeepsRecordingWhileStillTalking()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: 5000,
            msSinceLastSpeech: 300);

        Assert.Equal(RecordingStopReason.None, reason);
    }

    [Fact]
    public void StopsOnceSilenceHasLastedTheFullBuffer()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: 6000,
            msSinceLastSpeech: RecordingSegmenter.DefaultSilenceBufferMs);

        Assert.Equal(RecordingStopReason.SilenceAfterSpeech, reason);
    }

    [Fact]
    public void DoesNotStopOneTickBeforeSilenceBufferElapses()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: 6000,
            msSinceLastSpeech: RecordingSegmenter.DefaultSilenceBufferMs - 1);

        Assert.Equal(RecordingStopReason.None, reason);
    }

    [Fact]
    public void GivesUpIfNoSpeechIsEverDetected()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: false,
            elapsedMs: RecordingSegmenter.DefaultMaxWaitForSpeechMs,
            msSinceLastSpeech: 0);

        Assert.Equal(RecordingStopReason.NoSpeechTimeout, reason);
    }

    [Fact]
    public void MaxDurationSafetyCapWinsEvenIfStillSpeaking()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: RecordingSegmenter.DefaultMaxUtteranceMs,
            msSinceLastSpeech: 50);

        Assert.Equal(RecordingStopReason.MaxDuration, reason);
    }

    [Fact]
    public void RespectsCustomSilenceBufferAndTimeouts()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: 1000,
            msSinceLastSpeech: 500,
            silenceBufferMs: 500);

        Assert.Equal(RecordingStopReason.SilenceAfterSpeech, reason);
    }
}

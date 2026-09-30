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

    // #619: port of voice-endpointing.js's silenceBufferMsForTranscript
    // (same cases as windows-launcher/test/voice-endpointing.test.js).
    [Theory]
    [InlineData("", 2200, "default")]
    [InlineData("   ", 2200, "default")]
    [InlineData(null, 2200, "default")]
    [InlineData("check the weather", 2200, "default")]
    [InlineData("check the weather and traffic", 2200, "default")]
    [InlineData("What's the weather today?", 800, "complete")]
    [InlineData("Close the window.", 800, "complete")]
    [InlineData("That's amazing!", 800, "complete")]
    [InlineData("I think it's because", 3500, "trailing")]
    [InlineData("so I was thinking and", 3500, "trailing")]
    [InlineData("well, um", 3500, "trailing")]
    [InlineData("Turn on the lights and.", 3500, "trailing")]
    [InlineData("first check the weather,", 3500, "trailing")]
    [InlineData("So I was thinking...", 3500, "trailing")]
    [InlineData("So I was thinking…", 3500, "trailing")]
    [InlineData("And SO", 3500, "trailing")]
    public void SilenceBufferMsForTranscript_FollowsTheTranscriptsEnding(string? transcript, long expectedMs, string expectedReason)
    {
        var (ms, reason) = RecordingSegmenter.SilenceBufferMsForTranscript(transcript);

        Assert.Equal(expectedMs, ms);
        Assert.Equal(expectedReason, reason);
    }

    [Fact]
    public void SilenceBufferMsForTranscript_KeepsACustomBaseWithNoSignal()
    {
        Assert.Equal(1800, RecordingSegmenter.SilenceBufferMsForTranscript("no clear signal here", 1800).SilenceBufferMs);
    }

    [Fact]
    public void ShouldRequestPartial_NeverOverlapsARequestInFlight()
    {
        Assert.False(RecordingSegmenter.ShouldRequestPartial(inFlight: true, segmentSpeechMs: 5000, uncoveredSpeechMs: 2000, msSinceLastSpeech: 500, msSinceLastRequest: 5000));
    }

    [Fact]
    public void ShouldRequestPartial_WaitsForRealSpeech()
    {
        Assert.False(RecordingSegmenter.ShouldRequestPartial(false, segmentSpeechMs: RecordingSegmenter.PartialMinSpeechMs - 1, uncoveredSpeechMs: 200, msSinceLastSpeech: 500, msSinceLastRequest: 5000));
    }

    [Fact]
    public void ShouldRequestPartial_SkipsWhenNothingNewWasSaid()
    {
        // A pause after the last snapshot: re-transcribing it adds nothing.
        Assert.False(RecordingSegmenter.ShouldRequestPartial(false, segmentSpeechMs: 3000, uncoveredSpeechMs: 0, msSinceLastSpeech: 1500, msSinceLastRequest: 5000));
    }

    [Theory]
    [InlineData(0, 999, false)] // still talking: about once a second
    [InlineData(0, 1000, true)]
    [InlineData(199, 999, false)]
    [InlineData(200, 699, false)] // just paused: sooner, but never under 700ms apart
    [InlineData(200, 700, true)]
    public void ShouldRequestPartial_PollsFasterOnceTheUserPauses(long msSinceLastSpeech, long msSinceLastRequest, bool expected)
    {
        Assert.Equal(expected, RecordingSegmenter.ShouldRequestPartial(false, segmentSpeechMs: 2000, uncoveredSpeechMs: 400, msSinceLastSpeech, msSinceLastRequest));
    }

    // #909: text x audio -> wait. No score, or a trailing transcript, keeps
    // the pre-#909 call; the rest never ends sooner on "not done" or later
    // on "done" than the transcript alone would.
    [Theory]
    [InlineData(800, "complete", null, 800, "complete")]
    [InlineData(3500, "trailing", 0.99f, 3500, "trailing")]
    [InlineData(800, "complete", 0.9f, 500, "complete+turn")]
    [InlineData(800, "complete", 0.1f, 2200, "complete-turn")]
    [InlineData(2200, "stale", 0.9f, 800, "turn")]
    [InlineData(2200, "nopartial", 0.1f, 3500, "midturn")]
    [InlineData(2200, "off", 0.5f, 800, "turn")]
    public void WithSmartTurn_CombinesTranscriptAndAudio(long textMs, string textReason, float? p, long expectedMs, string expectedReason)
    {
        var (ms, reason) = RecordingSegmenter.WithSmartTurn((textMs, textReason), p, threshold: 0.5f);

        Assert.Equal(expectedMs, ms);
        Assert.Equal(expectedReason, reason);
    }

    [Fact]
    public void WithSmartTurn_RespectsACustomBase()
    {
        Assert.Equal(400, RecordingSegmenter.WithSmartTurn((400, "default"), 0.9f, 0.5f, baseMs: 400).SilenceBufferMs);
        Assert.Equal(800, RecordingSegmenter.WithSmartTurn((800, "complete"), 0.1f, 0.5f, baseMs: 400).SilenceBufferMs);
        Assert.Equal(6000, RecordingSegmenter.WithSmartTurn((6000, "default"), 0.1f, 0.5f, baseMs: 6000).SilenceBufferMs);
    }
}

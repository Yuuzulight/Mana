using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class BargeInGateTests
{
    [Fact]
    public void Next_DoesNotTriggerBeforeHoldMsOfContinuousSpeechAccumulates()
    {
        long heldMs = 0;
        bool triggered;
        (heldMs, triggered) = BargeInGate.Next(isSpeech: true, isLoudEnough: true, heldMs, frameMs: 32, holdMs: 350);
        Assert.False(triggered);
        Assert.Equal(32, heldMs);

        (heldMs, triggered) = BargeInGate.Next(isSpeech: true, isLoudEnough: true, heldMs, frameMs: 32, holdMs: 350);
        Assert.False(triggered);
        Assert.Equal(64, heldMs);
    }

    [Fact]
    public void Next_TriggersExactlyOnceOnTheFrameThatCrossesHoldMs()
    {
        long heldMs = 320; // one 32ms frame short of 350ms
        var (afterFirst, triggeredFirst) = BargeInGate.Next(true, true, heldMs, frameMs: 32, holdMs: 350);
        Assert.True(triggeredFirst);
        Assert.Equal(352, afterFirst);

        // The next frame is still above holdMs, but this isn't the frame
        // that crossed it -- must not re-trigger.
        var (afterSecond, triggeredSecond) = BargeInGate.Next(true, true, afterFirst, frameMs: 32, holdMs: 350);
        Assert.False(triggeredSecond);
        Assert.Equal(384, afterSecond);
    }

    [Fact]
    public void Next_ResetsTheHeldDurationWhenSpeechStops()
    {
        var (heldMs, _) = BargeInGate.Next(true, true, previousHeldMs: 300, frameMs: 32, holdMs: 350);
        Assert.Equal(332, heldMs);

        var (afterSilence, triggered) = BargeInGate.Next(false, true, heldMs, frameMs: 32, holdMs: 350);
        Assert.Equal(0, afterSilence);
        Assert.False(triggered);
    }

    [Fact]
    public void Next_DoesNotCountAQuietFrameEvenIfVadSaysItIsSpeech()
    {
        // A frame VAD calls speech but that's below the loudness floor
        // doesn't advance the hold timer at all -- filters residual echo
        // and room noise that Silero VAD sometimes false-positives on.
        var (heldMs, triggered) = BargeInGate.Next(isSpeech: true, isLoudEnough: false, previousHeldMs: 300, frameMs: 32, holdMs: 350);
        Assert.Equal(0, heldMs);
        Assert.False(triggered);
    }

    [Fact]
    public void Next_TriggersImmediatelyIfASingleFrameAlreadyMeetsOrExceedsHoldMs()
    {
        // Guards the edge case: previousHeldMs (0) < holdMs and
        // heldMs (>= holdMs) both hold on the very first qualifying frame
        // when holdMs is small enough for one frame to satisfy it.
        var (heldMs, triggered) = BargeInGate.Next(true, true, previousHeldMs: 0, frameMs: 32, holdMs: 32);
        Assert.Equal(32, heldMs);
        Assert.True(triggered);
    }

    [Fact]
    public void DbfsFromSamples_IsLouderForHigherAmplitudeSamples()
    {
        var quiet = new float[] { 0.001f, -0.001f, 0.001f, -0.001f };
        var loud = new float[] { 0.5f, -0.5f, 0.5f, -0.5f };

        var quietDbfs = BargeInGate.DbfsFromSamples(quiet);
        var loudDbfs = BargeInGate.DbfsFromSamples(loud);

        Assert.True(loudDbfs > quietDbfs);
        // 0.5 amplitude sine-like values should sit well above the
        // -45 dBFS default barge-in floor -- a sanity check on the actual
        // formula, not just relative ordering.
        Assert.True(loudDbfs > BargeInGate.DefaultMinDbfs);
        Assert.True(quietDbfs < BargeInGate.DefaultMinDbfs);
    }

    [Fact]
    public void DbfsFromSamples_SilenceIsNegativeInfinity()
    {
        var silence = new float[] { 0f, 0f, 0f, 0f };
        Assert.Equal(double.NegativeInfinity, BargeInGate.DbfsFromSamples(silence));
    }

    // #665: barge-in modes.
    [Theory]
    [InlineData(null, null, (int)BargeInMode.MinWords)]
    [InlineData(null, "always", (int)BargeInMode.Always)]
    [InlineData("notWhileSpeaking", "always", (int)BargeInMode.NotWhileSpeaking)]
    [InlineData("nonsense", "notWhileSpeaking", (int)BargeInMode.NotWhileSpeaking)]
    [InlineData(" Min-Words ", null, (int)BargeInMode.MinWords)]
    public void Resolve_EnvBeatsSettingAndDefaultsToMinWords(string? env, string? saved, int expected) =>
        Assert.Equal((BargeInMode)expected, BargeInPolicy.Resolve(env, saved));

    [Theory]
    [InlineData("", 0)]
    [InlineData("mm...", 1)]
    [InlineData("Yeah.", 1)]
    [InlineData("wait, stop!", 2)]
    [InlineData("don't go", 2)]
    [InlineData("hold on a sec", 4)]
    public void WordCount_CountsRealWords(string transcript, int expected) =>
        Assert.Equal(expected, BargeInPolicy.WordCount(transcript));

    [Fact]
    public void MinWords_DefaultsToTwo()
    {
        Assert.Equal(2, BargeInPolicy.MinWords(null));
        Assert.Equal(2, BargeInPolicy.MinWords("0"));
        Assert.Equal(3, BargeInPolicy.MinWords("3"));
    }

    // #665: a ducked interruption stops her only when it's real.
    [Theory]
    [InlineData(true, false, "wait, stop", true)]
    [InlineData(true, false, "yeah", false)]
    [InlineData(true, false, "", false)]
    [InlineData(true, true, "thank you for watching", false)] // dropped as a hallucination
    [InlineData(false, false, "wait, stop", false)]            // transcription failed
    public void IsRealInterruption_NeedsATranscriptWithEnoughWords(bool transcribed, bool dropped, string transcript, bool expected) =>
        Assert.Equal(expected, BargeInPolicy.IsRealInterruption(transcribed, dropped, transcript, BargeInPolicy.DefaultMinWords));

    [Fact]
    public void AudioPlayerVolume_IsClampedAndKept()
    {
        using var player = new AudioPlayer();
        player.Volume = BargeInPolicy.DuckVolume;
        Assert.Equal(0.3f, player.Volume);
        player.Volume = 2f;
        Assert.Equal(1f, player.Volume);
    }
}

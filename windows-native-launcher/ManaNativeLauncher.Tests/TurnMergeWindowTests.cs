using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #619 addendum: the merge window's state machine.
public class TurnMergeWindowTests
{
    private const long FrameMs = 32;

    private static readonly short[] ClosedAudio = { 1, 2, 3 };

    private static bool Speak(TurnMergeWindow window, long ms)
    {
        var merged = false;
        for (long t = 0; t < ms; t += FrameMs)
        {
            merged |= window.OnFrame(isSpeech: true, FrameMs);
        }
        return merged;
    }

    private static void Silence(TurnMergeWindow window, long ms)
    {
        for (long t = 0; t < ms; t += FrameMs)
        {
            Assert.False(window.OnFrame(isSpeech: false, FrameMs));
        }
    }

    [Fact]
    public void NoResumedSpeech_TheTurnClaimsNormally()
    {
        var window = new TurnMergeWindow();
        var id = window.Open(ClosedAudio, speechMs: 900, wasInterruption: false, nowMs: 0);

        Silence(window, 500);

        Assert.True(window.IsOpen);
        Assert.True(window.Claim(id));
        Assert.False(window.IsOpen);
        Assert.False(Speak(window, 500)); // too late once claimed
    }

    [Fact]
    public void ResumedSpeechInsideTheWindow_MergesAndSupersedesTheTurn()
    {
        var window = new TurnMergeWindow();
        var id = window.Open(ClosedAudio, speechMs: 900, wasInterruption: true, nowMs: 0);

        Silence(window, 400);
        Assert.True(Speak(window, TurnMergeWindow.MergeHoldMs + FrameMs));

        Assert.False(window.IsOpen);
        Assert.Equal(ClosedAudio, window.ClosedSamples);
        Assert.Equal(900, window.ClosedSpeechMs);
        Assert.True(window.ClosedWasInterruption);
        Assert.False(window.Claim(id)); // the turn task drops its result
    }

    [Fact]
    public void SpeechShorterThanTheHold_DoesNotMerge()
    {
        var window = new TurnMergeWindow();
        var id = window.Open(ClosedAudio, 900, false, 0);

        // A click/breath: one short blip, then silence resets the streak.
        Assert.False(window.OnFrame(true, FrameMs));
        Assert.False(window.OnFrame(true, FrameMs));
        Silence(window, 100);
        Assert.False(window.OnFrame(true, FrameMs));

        Assert.True(window.Claim(id));
    }

    [Fact]
    public void SpeechStartingAfterTheWindow_DoesNotMerge()
    {
        var window = new TurnMergeWindow();
        var id = window.Open(ClosedAudio, 900, false, 0);

        Silence(window, TurnMergeWindow.MergeWindowMs);

        Assert.False(window.IsOpen);
        Assert.False(Speak(window, 500));
        Assert.True(window.Claim(id));
    }

    [Fact]
    public void AStreakStartedInsideTheWindow_MayFinishItsHold()
    {
        var window = new TurnMergeWindow();
        window.Open(ClosedAudio, 900, false, 0);

        Silence(window, TurnMergeWindow.MergeWindowMs - 2 * FrameMs);

        Assert.True(Speak(window, TurnMergeWindow.MergeHoldMs + FrameMs));
    }

    [Fact]
    public void ClosingWithoutAMerge_StillLetsTheTurnClaim()
    {
        // Stop listening mid-window: no more merging, the turn carries on.
        var window = new TurnMergeWindow();
        var id = window.Open(ClosedAudio, 900, false, 0);

        window.Close();

        Assert.False(Speak(window, 500));
        Assert.True(window.Claim(id));
    }

    [Fact]
    public void ANewerTurn_InvalidatesAnOlderId()
    {
        var window = new TurnMergeWindow();
        var first = window.Open(ClosedAudio, 900, false, 0);
        Speak(window, 500); // merged
        var second = window.Open(ClosedAudio, 1800, false, 5000);

        Assert.False(window.Claim(first));
        Assert.True(window.Claim(second));
    }

    [Theory]
    [InlineData(0, 1000)]
    [InlineData(400, 600)]
    [InlineData(1000, 0)]
    [InlineData(3000, 0)]
    public void RemainingMs_CountsDownFromTheClose(long elapsed, long expected)
    {
        var window = new TurnMergeWindow();
        window.Open(ClosedAudio, 900, false, nowMs: 10_000);

        Assert.Equal(expected, window.RemainingMs(10_000 + elapsed));
    }
}

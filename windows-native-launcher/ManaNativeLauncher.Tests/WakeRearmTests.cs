using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #678: the wake word re-arms after a quiet period with no turn.
public class WakeRearmTests
{
    [Theory]
    [InlineData(true, false, 0, 60000, 60000, true)]    // quiet period over
    [InlineData(true, false, 0, 59999, 60000, false)]   // not yet
    [InlineData(true, true, 0, 90000, 60000, false)]    // mid-segment: let the command finish
    [InlineData(false, false, 0, 90000, 60000, false)]  // already asleep
    [InlineData(true, false, 0, 999999, 0, false)]      // 0 = never re-arm
    public void ShouldRearm(bool awake, bool midSegment, long lastTurnAtMs, long nowMs, long rearmMs, bool expected)
    {
        Assert.Equal(expected, VoiceLoop.ShouldRearm(awake, midSegment, lastTurnAtMs, nowMs, rearmMs));
    }

    [Theory]
    [InlineData(null, 60000)]
    [InlineData("30000", 30000)]
    [InlineData("0", 0)]
    [InlineData("-5", 60000)]
    [InlineData("abc", 60000)]
    public void ResolveWakeRearmMs(string? env, long expected)
    {
        Assert.Equal(expected, VoiceLoop.ResolveWakeRearmMs(env));
    }
}

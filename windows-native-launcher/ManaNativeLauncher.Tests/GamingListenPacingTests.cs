using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #859: Electron's gaming-mode listen pacing.
public class GamingListenPacingTests
{
    [Theory]
    [InlineData(false, false, false, 0)]     // not gaming: no pause
    [InlineData(true, true, false, 1800)]    // gaming, awake: GAMING_IDLE_PAUSE_MS
    [InlineData(true, false, false, 3200)]   // gaming, asleep: GAMING_DEEP_IDLE_PAUSE_MS
    [InlineData(true, true, true, 0)]        // a barge-in's segment: a reply is waiting to resume
    public void PauseAfterASegmentThatLedNowhere(bool gaming, bool awake, bool wasInterruption, long expectedMs)
    {
        Assert.Equal(expectedMs, VoiceLoop.GamingListenPauseMs(gaming, awake, wasInterruption));
    }
}

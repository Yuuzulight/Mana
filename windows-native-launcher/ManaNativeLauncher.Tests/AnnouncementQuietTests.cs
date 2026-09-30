using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1148: an announcement (a reminder, the briefing, a check-in) waits while
// she's busy with a turn or I'm in the middle of saying something.
public class AnnouncementQuietTests
{
    [Theory]
    [InlineData("Idle", false, true)]
    [InlineData("Idle", true, false)] // I'm mid-sentence
    [InlineData("Processing", false, false)]
    [InlineData("Speaking", false, false)]
    [InlineData("CapturingInterruption", false, false)]
    public void IsQuietForAnnouncement_OnlyWhenIdleAndNotHearingMe(string mode, bool heardSpeech, bool expected)
    {
        Assert.Equal(expected, VoiceLoop.IsQuietForAnnouncement(System.Enum.Parse<ListenMode>(mode), heardSpeech));
    }
}

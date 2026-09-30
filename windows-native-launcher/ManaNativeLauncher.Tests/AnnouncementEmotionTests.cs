using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1024: how each announcement is said on Qwen3-TTS.
public class AnnouncementEmotionTests
{
    [Theory]
    [InlineData(null, "reminder", null)]
    [InlineData(null, "reminder-late", "surprised")]
    [InlineData(null, "briefing", "happy")]
    [InlineData(null, "handoff", "excited")]
    [InlineData(null, "self-work", "happy")]
    [InlineData(null, "failed", "sad")]
    [InlineData(null, "cron", null)] // an unknown kind is neutral
    [InlineData(null, null, null)]
    [InlineData("Sad", "briefing", "sad")] // the payload's own emotion wins
    [InlineData("wink", "briefing", null)] // one Qwen3-TTS doesn't pace is neutral
    [InlineData("neutral", "handoff", null)]
    public void For_UsesThePayloadsEmotionElseTheKinds(string? emotion, string? kind, string? expected)
    {
        Assert.Equal(expected, AnnouncementEmotion.For(emotion, kind));
    }
}

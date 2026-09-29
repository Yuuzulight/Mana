using System;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #688: Settings search boxes and the gaming-mode status line.
public class SettingsSearchTests
{
    [Theory]
    [InlineData("", true)]
    [InlineData("  weather ", true)]
    [InlineData("FORECAST", true)]
    [InlineData("calendar", false)]
    public void MatchesSearch_AnyFieldCaseInsensitive(string query, bool expected)
    {
        Assert.Equal(expected, SettingsPanel.MatchesSearch(query, "Weather", null, "Daily forecast"));
    }

    [Fact]
    public void GamingStatusText_ListsTheMatchedGames()
    {
        Assert.Equal("Off", SettingsPanel.GamingStatusText(false, true, new[] { "ffxiv_dx11.exe" }));
        Assert.Equal("Active: ffxiv_dx11.exe, eldenring.exe", SettingsPanel.GamingStatusText(true, true, new[] { "ffxiv_dx11.exe", "eldenring.exe" }));
        Assert.Equal("No watched game running", SettingsPanel.GamingStatusText(true, false, Array.Empty<string>()));
    }
}

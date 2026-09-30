using System;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #911: the pure parts of the desktop actions -- nothing here touches the
// real volume, windows or Start menu.
public class DesktopActionsTests
{
    [Fact]
    public void NewLevel_TakesALevelOrAChangeAndClamps()
    {
        Assert.Equal(0.3f, DesktopActions.NewLevel(0.8f, 30, null), 3);
        Assert.Equal(0.7f, DesktopActions.NewLevel(0.8f, null, -10), 3);
        Assert.Equal(1f, DesktopActions.NewLevel(0.95f, null, 20));
        Assert.Equal(0f, DesktopActions.NewLevel(0.1f, -5, null));
        Assert.Throws<ArgumentException>(() => DesktopActions.NewLevel(0.5f, null, null));
        Assert.Throws<ArgumentException>(() => DesktopActions.NewLevel(0.5f, 10, 10));
    }

    [Fact]
    public void FindShortcut_PrefersAnExactNameAndNeverAnUninstaller()
    {
        var shortcuts = new[]
        {
            @"C:\Start\Discord Inc\Discord.lnk",
            @"C:\Start\Discord Inc\Uninstall Discord.lnk",
            @"C:\Start\Discord PTB.lnk",
            @"C:\Start\Spotify.lnk",
        };
        Assert.Equal(shortcuts[0], DesktopActions.FindShortcut(shortcuts, "discord"));
        Assert.Equal(shortcuts[3], DesktopActions.FindShortcut(shortcuts, "spot"));
        Assert.Contains("Discord PTB", Assert.Throws<InvalidOperationException>(() => DesktopActions.FindShortcut(shortcuts, "disc")).Message);
        Assert.Throws<InvalidOperationException>(() => DesktopActions.FindShortcut(shortcuts, "uninstall discord"));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.FindShortcut(shortcuts, "notepad"));
    }

    [Fact]
    public void PickWindow_PrefersTheProcessNameOverATitleMatch()
    {
        var windows = new[]
        {
            ((IntPtr)1, "chrome", "Discord - Wikipedia"),
            ((IntPtr)2, "Discord", "#general | My Server"),
        };
        Assert.Equal((IntPtr)2, DesktopActions.PickWindow(windows, "Discord", byTitle: true));
        Assert.Equal((IntPtr)1, DesktopActions.PickWindow(windows, "wikipedia", byTitle: true));
        Assert.Null(DesktopActions.PickWindow(windows, "wikipedia", byTitle: false));
        Assert.Null(DesktopActions.PickWindow(windows, "Spotify", byTitle: true));
    }

    // #893: Mana's own playback is never a volume target.
    [Fact]
    public void IsMana_CoversHerOwnProcess()
    {
        Assert.True(DesktopActions.IsMana("Mana"));
        Assert.True(DesktopActions.IsMana("ManaNativeLauncher"));
        Assert.False(DesktopActions.IsMana("Spotify"));
        Assert.True(DesktopActions.NameMatches("visual studio code", "VisualStudioCode"));
        Assert.False(DesktopActions.NameMatches("", ""));
    }
}

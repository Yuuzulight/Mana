using System;
using System.Collections.Generic;
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
    public void FindApp_PrefersAnExactNameAndNeverAnUninstaller()
    {
        var shortcuts = new[]
        {
            @"C:\Start\Discord Inc\Discord.lnk",
            @"C:\Start\Discord Inc\Uninstall Discord.lnk",
            @"C:\Start\Discord PTB.lnk",
            @"C:\Start\Spotify.lnk",
        };
        Assert.Equal(("Discord", shortcuts[0]), DesktopActions.FindApp(shortcuts, NoStoreApps, "discord"));
        Assert.Equal(("Spotify", shortcuts[3]), DesktopActions.FindApp(shortcuts, NoStoreApps, "spot"));
        Assert.Contains("Discord PTB", Assert.Throws<InvalidOperationException>(() => DesktopActions.FindApp(shortcuts, NoStoreApps, "disc")).Message);
        Assert.Throws<InvalidOperationException>(() => DesktopActions.FindApp(shortcuts, NoStoreApps, "uninstall discord"));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.FindApp(shortcuts, NoStoreApps, "notepad"));
    }

    private static IEnumerable<(string, string)> NoStoreApps() => [];

    // Store apps have no .lnk: they start through shell:AppsFolder, and are
    // only looked up when no shortcut matches.
    [Fact]
    public void FindApp_FallsBackToStoreApps()
    {
        var shortcuts = new[] { @"C:\Start\Spotify.lnk" };
        var looked = 0;
        IEnumerable<(string, string)> Store()
        {
            looked++;
            return [("Calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), ("Spotify", "SpotifyAB.Spotify_zpdnekdrzrea0!Spotify")];
        }

        Assert.Equal(("Spotify", shortcuts[0]), DesktopActions.FindApp(shortcuts, Store, "spotify"));
        Assert.Equal(0, looked);
        Assert.Equal(("Calculator", @"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), DesktopActions.FindApp(shortcuts, Store, "calculator"));
        Assert.Equal(1, looked);
    }

    [Fact]
    public void PickByName_MatchesAnAudioOutputByAnyUniquePart()
    {
        var outputs = new[] { "Speakers (Realtek(R) Audio)", "Headphones (Arctis Nova 7)", "Headset Earphone (Arctis Nova 7 Chat)" };
        Assert.Equal(outputs[0], DesktopActions.PickByName(outputs, "speakers", "audio output"));
        Assert.Equal(outputs[1], DesktopActions.PickByName(outputs, "headphones", "audio output"));
        Assert.Contains("Headset Earphone", Assert.Throws<InvalidOperationException>(() => DesktopActions.PickByName(outputs, "arctis", "audio output")).Message);
        Assert.Throws<InvalidOperationException>(() => DesktopActions.PickByName(outputs, "hdmi", "audio output"));
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

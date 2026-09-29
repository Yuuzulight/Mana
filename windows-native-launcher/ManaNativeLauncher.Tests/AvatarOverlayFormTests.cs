using System.Drawing;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class AvatarOverlayFormTests
{
    private static readonly Size Avatar = new(234, 288);
    private static readonly Rectangle[] Screens = [new(0, 0, 1920, 1040), new(1920, 0, 2560, 1400)];

    [Fact]
    public void SavedLocation_UsesWhereSheWasDragged() =>
        Assert.Equal(new Point(2500, 600), AvatarOverlayForm.SavedLocation(2500, 600, Avatar, Screens));

    [Fact]
    public void SavedLocation_AllowsHangingPartlyOffScreen() =>
        Assert.Equal(new Point(-100, 700), AvatarOverlayForm.SavedLocation(-100, 700, Avatar, Screens));

    [Theory]
    [InlineData(null, null)]  // never dragged
    [InlineData(5000, 600)]   // that monitor is gone
    [InlineData(-200, 600)]   // her centre is off every screen
    public void SavedLocation_FallsBackToTheDefaultSpot(int? left, int? top) =>
        Assert.Null(AvatarOverlayForm.SavedLocation(left, top, Avatar, Screens));

    [Theory]
    [InlineData(false, false, false)] // clickable
    [InlineData(false, true, true)]   // a watched game is running
    [InlineData(true, false, true)]   // the tray's manual setting
    [InlineData(true, true, true)]
    public void IsClickThrough_WhileGamingOrWhenSetInTheTray(bool manual, bool gameRunning, bool expected) =>
        Assert.Equal(expected, AvatarOverlayForm.IsClickThrough(manual, gameRunning));
}

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

    // #684: after a display change she's pulled fully back onto the screen.
    [Theory]
    [InlineData(1700, 900, 1686, 792)]  // hanging off the bottom-right
    [InlineData(-50, -20, 0, 0)]        // off the top-left
    [InlineData(400, 300, 400, 300)]    // already inside
    public void KeepInside_MovesTheLeastNeeded(int x, int y, int expectedX, int expectedY) =>
        Assert.Equal(new Point(expectedX, expectedY),
            AvatarOverlayForm.KeepInside(new Rectangle(x, y, 234, 288), new Rectangle(0, 0, 1920, 1080)));

    // #684: "minimized Mana" -- she shows while the chat window is closed or minimized.
    [Theory]
    [InlineData(false, System.Windows.Forms.FormWindowState.Normal, true)]
    [InlineData(true, System.Windows.Forms.FormWindowState.Minimized, true)]
    [InlineData(true, System.Windows.Forms.FormWindowState.Normal, false)]
    [InlineData(true, System.Windows.Forms.FormWindowState.Maximized, false)]
    public void AvatarShowsBesideChat_OnlyWhileChatIsAway(bool chatVisible, System.Windows.Forms.FormWindowState state, bool expected) =>
        Assert.Equal(expected, ManaApplicationContext.AvatarShowsBesideChat(chatVisible, state));
}

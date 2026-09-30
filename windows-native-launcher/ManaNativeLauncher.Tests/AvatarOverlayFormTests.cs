using System.Drawing;
using Mana.NativeLauncher;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class AvatarOverlayFormTests
{
    private static readonly Size Avatar = new(234, 288);
    private static readonly Rectangle[] Screens = [new(0, 0, 1920, 1040), new(1920, 0, 2560, 1400)];

    [Fact]
    public void SavedLocation_UsesWhereSheWasDragged() =>
        Assert.Equal(new Point(2500, 600), AvatarOverlayForm.SavedLocation(2500, 600, Avatar, Screens));

    // #899: pulled fully back on (it used to be left hanging off).
    [Fact]
    public void SavedLocation_IsPulledBackOnScreen() =>
        Assert.Equal(new Point(0, 700), AvatarOverlayForm.SavedLocation(-100, 700, Avatar, Screens));

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

    // The tray's Show avatar off wins over everything; on, #684 decides.
    [Theory]
    [InlineData(false, false, false, false)]
    [InlineData(false, true, false, false)]
    [InlineData(true, false, true, true)]   // not hiding with chat: always there
    [InlineData(true, true, true, false)]   // chat open: steps aside
    [InlineData(true, true, false, true)]
    public void AvatarVisible_FollowsShowAvatarThenTheChatWindow(bool showAvatar, bool hidesWithChat, bool chatVisible, bool expected) =>
        Assert.Equal(expected, ManaApplicationContext.AvatarVisible(showAvatar, hidesWithChat, chatVisible, System.Windows.Forms.FormWindowState.Normal));

    // #684: "minimized Mana" -- she shows while the chat window is closed or minimized.
    [Theory]
    [InlineData(false, System.Windows.Forms.FormWindowState.Normal, true)]
    [InlineData(true, System.Windows.Forms.FormWindowState.Minimized, true)]
    [InlineData(true, System.Windows.Forms.FormWindowState.Normal, false)]
    [InlineData(true, System.Windows.Forms.FormWindowState.Maximized, false)]
    public void AvatarShowsBesideChat_OnlyWhileChatIsAway(bool chatVisible, System.Windows.Forms.FormWindowState state, bool expected) =>
        Assert.Equal(expected, ManaApplicationContext.AvatarShowsBesideChat(chatVisible, state));

    // #899: a tall model canvas, which fits the 234x288 base window by height.
    private static readonly SizeF Canvas = new(1000, 2000);
    private static readonly Rectangle WorkArea = new(0, 0, 1920, 1040);

    [Theory]
    [InlineData("full", 1f, 234, 288)]
    [InlineData("full", 1.5f, 351, 432)]
    [InlineData("upperHalf", 2f, 468, 330)]
    [InlineData("bust", 2f, 468, 168)]
    public void OverlaySize_IsTheBaseWidthScaledAndTallEnoughForTheFraming(string framing, float scale, int width, int height) =>
        Assert.Equal(new Size(width, height),
            AvatarOverlayForm.OverlaySize(Avatar, Canvas, LiveAvatarPanel.FramingFraction(framing), scale));

    // The framed window draws her at scale x the 1x full-body size, placed
    // the same across (only the bottom is cut off), under Fit's top margin.
    [Fact]
    public void OverlaySize_UpperHalfDrawsHerAtTheChosenScale()
    {
        var baseFit = CubismRenderer.Fit(Canvas.Width, Canvas.Height, Avatar.Width, Avatar.Height, 1f);
        var size = AvatarOverlayForm.OverlaySize(Avatar, Canvas, LiveAvatarPanel.FramingFraction("upperHalf"), 2f);
        var (scale, x, y) = CubismRenderer.Fit(Canvas.Width, Canvas.Height, size.Width, size.Height, LiveAvatarPanel.FramingFraction("upperHalf"));
        Assert.Equal(2 * baseFit.Scale, scale, 3);
        Assert.Equal(2 * baseFit.OffsetX, x, 3);
        Assert.Equal(size.Height * CubismRenderer.TopMargin, y, 3);
    }

    [Theory]
    [InlineData(null, 0, 1569, 792)]  // the bottom-right corner, flush
    [InlineData(782, 0, 782, 792)]    // MANA_AVATAR_LEFT
    [InlineData(null, 10, 1569, 782)] // MANA_AVATAR_BOTTOM
    public void DefaultLocation_SitsOnTheBottomEdge(int? left, int bottom, int x, int y) =>
        Assert.Equal(new Point(x, y), AvatarOverlayForm.DefaultLocation(new Size(351, 248), WorkArea, left, bottom));

    // A spot saved for the old 1x window, flush in the bottom-right corner:
    // moved about its bottom centre, then clamped -- still flush, no gap.
    [Fact]
    public void OldSavedSpot_StaysFlushWhenTheWindowChanges()
    {
        var framed = new Size(351, 248);
        var moved = AvatarOverlayForm.Resized(new Rectangle(1686, 752, 234, 288), framed);
        Assert.Equal(new Point(1569, 792), AvatarOverlayForm.SavedLocation(moved.Left, moved.Top, framed, Screens));
    }

    [Fact]
    public void Resized_KeepsTheBottomCentre()
    {
        var resized = AvatarOverlayForm.Resized(new Rectangle(100, 500, 234, 288), new Size(468, 330));
        Assert.Equal(new Rectangle(-17, 458, 468, 330), resized);
        Assert.Equal(new Point(0, 458), AvatarOverlayForm.KeepInside(resized, WorkArea));
    }

    [Fact]
    public void FirstOpaqueRow_SkipsEmptyRowsAndFaintEdges()
    {
        var pixels = new byte[3 * 4 * 4]; // 3 wide, 4 tall
        pixels[(1 * 12) + 4 + 3] = 20;    // row 1: a faint edge
        pixels[(2 * 12) + 8 + 3] = 255;   // row 2: her
        Assert.Equal(2, AvatarOverlayForm.FirstOpaqueRow(pixels, 3, 4));
        Assert.Equal(4, AvatarOverlayForm.FirstOpaqueRow(new byte[3 * 4 * 4], 3, 4));
    }

    // Standing on the bottom edge, the caption goes just above her head,
    // not above the empty top of her window.
    [Fact]
    public void Caption_SitsAboveHerVisibleTop()
    {
        var anchor = AvatarOverlayForm.VisiblePart(new Rectangle(1569, 792, 351, 248), 60);
        Assert.Equal(new Rectangle(1569, 852, 351, 188), anchor);
        Assert.Equal(852 - 50 - 8, CaptionOverlayForm.Place(new Size(300, 50), anchor, WorkArea).Y);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(248)] // nothing drawn (yet)
    public void VisiblePart_IsTheWholeWindowWithoutAVisibleTop(int top) =>
        Assert.Equal(new Rectangle(1569, 792, 351, 248), AvatarOverlayForm.VisiblePart(new Rectangle(1569, 792, 351, 248), top));

    // #914: a character's model swaps in place -- here one that can't render
    // (no Cubism Core in a bare checkout), so she stays the static avatar and
    // says why; null goes back to the default (none here). STA, never shown.
    [Fact]
    public void LoadModel_SwapsTheModelInPlace()
    {
        var root = Directory.CreateTempSubdirectory("mana-overlay-").FullName;
        var evil = Path.Combine(root, "evil.model3.json");
        File.WriteAllText(evil, "{}");
        System.Runtime.ExceptionServices.ExceptionDispatchInfo? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                using var overlay = new AvatarOverlayForm(root);
                Assert.Null(overlay.ModelPath);

                overlay.LoadModel(evil);
                Assert.Equal(evil, overlay.ModelPath);
                Assert.NotNull(overlay.ModelLoadProblem);
                Assert.False(overlay.HasLiveModel);

                overlay.LoadModel(null);
                Assert.Null(overlay.ModelPath);
            }
            catch (Exception ex)
            {
                failure = System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex);
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        failure?.Throw();
    }
}

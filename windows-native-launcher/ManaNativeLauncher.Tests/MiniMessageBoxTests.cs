using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #844: mini message box under Mana when bubbles are on.
[Collection("DarkTheme palette")]
public class MiniMessageBoxTests
{
    private static readonly Rectangle WorkArea = new(0, 0, 1920, 1080);
    private static readonly Size BoxSize = new(MiniMessageBoxForm.BoxWidth, MiniMessageBoxForm.BoxHeight);

    [Fact]
    public void Place_CentresUnderAvatarWhenRoomBelow()
    {
        var avatar = new Rectangle(800, 400, 234, 288);
        var pt = MiniMessageBoxForm.Place(BoxSize, avatar, WorkArea);

        // Centred horizontally with avatar: 800 + (234 - 320) / 2 = 757
        Assert.Equal(757, pt.X);
        // Sits below avatar: 400 + 288 + 6 = 694
        Assert.Equal(694, pt.Y);
    }

    [Fact]
    public void Place_FlipsAboveAvatarWhenNoRoomBelow()
    {
        // Avatar near the bottom of screen (bottom at 1060, only 20px left, BoxHeight is 40)
        var avatar = new Rectangle(800, 772, 234, 288);
        var pt = MiniMessageBoxForm.Place(BoxSize, avatar, WorkArea);

        Assert.Equal(757, pt.X);
        // Flips above: 772 - 40 - 6 = 726
        Assert.Equal(726, pt.Y);
    }

    [Fact]
    public void Place_ClampsHorizontallyToWorkArea()
    {
        // Avatar at far left
        var leftAvatar = new Rectangle(0, 400, 234, 288);
        var leftPt = MiniMessageBoxForm.Place(BoxSize, leftAvatar, WorkArea);
        Assert.Equal(8, leftPt.X);

        // Avatar at far right
        var rightAvatar = new Rectangle(1800, 400, 234, 288);
        var rightPt = MiniMessageBoxForm.Place(BoxSize, rightAvatar, WorkArea);
        Assert.Equal(1920 - BoxSize.Width - 8, rightPt.X);
    }

    [Fact]
    public void Place_FallsBackToBottomCenterWhenAvatarHidden()
    {
        var pt = MiniMessageBoxForm.Place(BoxSize, null, WorkArea);
        Assert.Equal((1920 - BoxSize.Width) / 2, pt.X);
        Assert.Equal(1080 - BoxSize.Height - 8, pt.Y);
    }

    [Fact]
    public void EnterKey_SubmitsAndHides()
    {
        string? submitted = null;
        using var form = new MiniMessageBoxForm(
            text =>
            {
                submitted = text;
                return Task.CompletedTask;
            },
            () => new Rectangle(800, 400, 234, 288));

        form.Open();
        Assert.True(form.Visible);

        form.InputBox.Text = "Hello Mana!";
        var args = new KeyEventArgs(Keys.Enter);
        // Reflection or invoking OnKeyDown
        var onKeyDown = typeof(Control).GetMethod("OnKeyDown", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
        onKeyDown?.Invoke(form.InputBox, new object[] { args });

        Assert.Equal("Hello Mana!", submitted);
        Assert.False(form.Visible);
        Assert.Equal(string.Empty, form.InputBox.Text);
    }

    [Fact]
    public void EscapeKey_DismissesWithoutSubmitting()
    {
        string? submitted = null;
        using var form = new MiniMessageBoxForm(
            text =>
            {
                submitted = text;
                return Task.CompletedTask;
            },
            () => new Rectangle(800, 400, 234, 288));

        form.Open();
        Assert.True(form.Visible);

        form.InputBox.Text = "Never mind";
        var args = new KeyEventArgs(Keys.Escape);
        var onKeyDown = typeof(Control).GetMethod("OnKeyDown", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
        onKeyDown?.Invoke(form.InputBox, new object[] { args });

        Assert.Null(submitted);
        Assert.False(form.Visible);
        Assert.Equal(string.Empty, form.InputBox.Text);
    }
}

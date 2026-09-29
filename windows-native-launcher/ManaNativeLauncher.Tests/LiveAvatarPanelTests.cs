using System.Drawing;
using Mana.NativeLauncher;
using Mana.NativeLauncher.Live2D;
using SkiaSharp;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #685: the chat window's live avatar and its full / waist / bust framing.
public class LiveAvatarPanelTests
{
    [Theory]
    [InlineData(null, "waist")]
    [InlineData("full", "waist")]
    [InlineData("waist", "bust")]
    [InlineData("bust", "full")]
    [InlineData("nonsense", "waist")]
    public void NextFraming_CyclesFullWaistBust(string? current, string expected)
    {
        Assert.Equal(expected, LiveAvatarPanel.NextFraming(current));
    }

    [Fact]
    public void Framing_UnknownOrMissingSavedValueIsFull()
    {
        using var panel = new LiveAvatarPanel { Framing = "bust" };
        Assert.Equal("bust", panel.Framing);
        panel.Framing = null;
        Assert.Equal("full", panel.Framing);
        panel.Framing = "zoomed";
        Assert.Equal("full", panel.Framing);
    }

    [Fact]
    public void Fit_WholeModelIsCentredAndFitsBothAxes()
    {
        var (scale, x, y) = CubismRenderer.Fit(1000, 2000, 200, 200, 1f);
        Assert.Equal(0.1f, scale, 4);
        Assert.Equal(50f, x, 3);
        Assert.Equal(0f, y, 3);
    }

    [Fact]
    public void Fit_BustShowsTheTopOfTheModelUnderAMargin()
    {
        var (scale, x, y) = CubismRenderer.Fit(1000, 2000, 200, 200, LiveAvatarPanel.FramingFraction("bust"));
        // The top 28% of 2000 (560) fills the 96% of 200 below the margin.
        Assert.Equal(192f / 560f, scale, 4);
        Assert.Equal(8f, y, 3);
        Assert.Equal((200 - 1000 * scale) / 2f, x, 3);
        Assert.True(scale > CubismRenderer.Fit(1000, 2000, 200, 200, LiveAvatarPanel.FramingFraction("waist")).Scale);
    }

    [Fact]
    public void ShowFrame_CopiesThePixelsAndClearFrameDropsThem()
    {
        using var panel = new LiveAvatarPanel { Size = new Size(4, 3) };
        using var source = new SKBitmap(new SKImageInfo(4, 3, SKColorType.Bgra8888, SKAlphaType.Premul));
        source.Erase(new SKColor(10, 200, 30, 255));

        panel.ShowFrame(source);
        Assert.True(panel.HasFrame);
        using (var copy = new Bitmap(4, 3))
        {
            panel.DrawToBitmap(copy, new Rectangle(0, 0, 4, 3));
            Assert.Equal(Color.FromArgb(255, 10, 200, 30), copy.GetPixel(2, 1));
        }

        panel.ClearFrame();
        Assert.False(panel.HasFrame);
    }
}

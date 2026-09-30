using System.Drawing;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// Mutates DarkTheme's shared static palette, like DarkThemeTests.
[Collection("DarkTheme palette")] // shared static palette: never run these in parallel
public class GlassSurfaceTests
{
    [Fact]
    public void OnlyTheManaPresetIsGlass()
    {
        DarkTheme.ApplyPreset("light", null);
        Assert.False(DarkTheme.IsGlass);
        DarkTheme.ApplyPreset("mana", null);
        Assert.True(DarkTheme.IsGlass);
        DarkTheme.ApplyPreset("not-a-real-preset", null); // falls back to the Mana default, glass included
        Assert.True(DarkTheme.IsGlass);
    }

    [Fact]
    public void RenderGlow_IsLavenderTopLeftAndSkyBlueBottomRight()
    {
        DarkTheme.ApplyPreset("mana", null);
        using var glow = GlassSurface.RenderGlow(new Size(400, 300), Point.Empty, new Size(400, 300));

        var topLeft = glow.GetPixel(10, 10);
        var bottomRight = glow.GetPixel(390, 290);
        Assert.True(topLeft.R > topLeft.G, $"top left should lean lavender, got {topLeft}");
        Assert.True(bottomRight.B > bottomRight.R, $"bottom right should lean sky blue, got {bottomRight}");
    }

    [Fact]
    public void RenderGlow_ASliceMatchesTheSameSpotOfTheWholeWindow()
    {
        DarkTheme.ApplyPreset("mana", null);
        var window = new Size(400, 300);
        using var whole = GlassSurface.RenderGlow(window, Point.Empty, window);
        using var slice = GlassSurface.RenderGlow(new Size(100, 100), new Point(250, 150), window);

        var a = whole.GetPixel(300, 200);
        var b = slice.GetPixel(50, 50);
        Assert.InRange(a.R - b.R, -3, 3);
        Assert.InRange(a.B - b.B, -3, 3);
    }

    [Fact]
    public void Style_BackgroundPanelsTurnSeeThroughAndPanelColouredOnesTurnGlass()
    {
        DarkTheme.ApplyPreset("mana", null);
        using var plain = new Panel { BackColor = DarkTheme.Background };
        using var card = new Panel { BackColor = DarkTheme.Panel };
        using var button = new Button { BackColor = DarkTheme.Panel2, FlatStyle = FlatStyle.Flat };

        GlassSurface.Style(plain, null);
        GlassSurface.Style(card, null);
        GlassSurface.Style(button, null);

        Assert.Equal(Color.Transparent, plain.BackColor);
        Assert.Equal(GlassSurface.GlassFill, card.BackColor);
        Assert.Equal(Color.Transparent, button.BackColor);
    }

    // The #652 mockup's timing: a 9s cycle per surface, its delay apart, the
    // band crossing in the last 30% (2.7s).
    [Theory]
    [InlineData(1000, 2200, null)]    // before its delay
    [InlineData(2200 + 6299, 2200, null)] // still resting
    [InlineData(2200 + 6300, 2200, 0f)]
    [InlineData(2200 + 7650, 2200, 0.5f)] // halfway, eased
    [InlineData(2200 + 9000 + 6300, 2200, 0f)] // and again next cycle
    public void SheenAt_FollowsTheMockupsCycle(long elapsedMs, int delayMs, float? expected)
    {
        var progress = GlassShimmer.SheenAt(elapsedMs, delayMs);
        Assert.Equal(expected is null, progress is null);
        if (expected is float value)
        {
            Assert.Equal(value, progress!.Value, 3);
        }
    }
}

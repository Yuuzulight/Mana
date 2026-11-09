using System.Drawing;
using System.Drawing.Imaging;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class WallpaperBackdropTests
{
    private static readonly Rectangle Screen = new(0, 0, 1920, 1080);

    // Fill covers the monitor and crops the overhang equally; Fit shows all of it, centred, bars on the short side.
    [Theory]
    [InlineData((int)WallpaperPosition.Fill, 3840, 1600, -336, 0, 2592, 1080)]
    [InlineData((int)WallpaperPosition.Fit, 3840, 1600, 0, 140, 1920, 800)]
    [InlineData((int)WallpaperPosition.Stretch, 3840, 1600, 0, 0, 1920, 1080)]
    [InlineData((int)WallpaperPosition.Center, 1000, 500, 460, 290, 1000, 500)]
    public void PlacesTheWallpaperTheWayWindowsDoes(int position, int w, int h, float x, float y, float width, float height)
    {
        var placed = WallpaperBackdrop.Placement(new Size(w, h), Screen, (WallpaperPosition)position);

        Assert.Equal(new RectangleF(x, y, width, height), placed);
    }

    // The blur keeps a flat colour flat (no dark edges) and softens a hard edge into a ramp.
    [Fact]
    public void BlurKeepsFlatColourAndSoftensEdges()
    {
        using var flat = new Bitmap(40, 20, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(flat))
        {
            g.Clear(Color.FromArgb(255, 120, 90, 200));
        }
        WallpaperBackdrop.BoxBlur(flat, 5, 3);
        Assert.Equal(Color.FromArgb(255, 120, 90, 200).ToArgb(), flat.GetPixel(0, 0).ToArgb());
        Assert.Equal(Color.FromArgb(255, 120, 90, 200).ToArgb(), flat.GetPixel(39, 19).ToArgb());

        using var edge = new Bitmap(40, 4, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(edge))
        {
            g.Clear(Color.Black);
            g.FillRectangle(Brushes.White, 20, 0, 20, 4);
        }
        WallpaperBackdrop.BoxBlur(edge, 5, 3);
        var left = edge.GetPixel(17, 2).R;
        var right = edge.GetPixel(22, 2).R;
        Assert.InRange(left, 1, 254);
        Assert.InRange(right, 1, 254);
        Assert.True(left < right);
    }
}

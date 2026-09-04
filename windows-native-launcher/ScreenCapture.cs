using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #523: full-primary-screen JPEG capture, for the vision hotkey's
// screenshot. Deliberately not shared with #522's ScreenContextReader (a
// separate, independently-developed PR touching the same concern) -- a
// small, easily-consolidated duplication rather than a cross-branch
// dependency; worth merging into one shared helper once both land.
internal static class ScreenCapture
{
    public static string CaptureAsJpegDataUrl()
    {
        var bounds = Screen.PrimaryScreen!.Bounds;
        using var bitmap = new Bitmap(bounds.Width, bounds.Height);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
        }
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Jpeg);
        return $"data:image/jpeg;base64,{Convert.ToBase64String(stream.ToArray())}";
    }
}

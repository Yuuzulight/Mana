using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #523: full-primary-screen JPEG capture, for the vision hotkey's
// screenshot. #671: Capture/ToJpegDataUrl are shared with
// ScreenContextReader (which used to carry its own copy of this), so it
// can crop to the foreground window and hash the capture before OCR.
internal static class ScreenCapture
{
    public static string CaptureAsJpegDataUrl()
    {
        using var bitmap = Capture(Screen.PrimaryScreen!.Bounds);
        return ToJpegDataUrl(bitmap);
    }

    public static Bitmap Capture(Rectangle bounds)
    {
        var bitmap = new Bitmap(bounds.Width, bounds.Height);
        try
        {
            using var g = Graphics.FromImage(bitmap);
            g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            return bitmap;
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    public static string ToJpegDataUrl(Bitmap bitmap)
    {
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Jpeg);
        return $"data:image/jpeg;base64,{Convert.ToBase64String(stream.ToArray())}";
    }
}

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #523: full-primary-screen JPEG capture, for the vision hotkey's
// screenshot. #671: Capture/ToJpegDataUrl are shared with
// ScreenContextReader (which used to carry its own copy of this), so it
// can crop to the foreground window and hash the capture before OCR.
internal static class ScreenCapture
{
    // #679: longest side of an image sent to the vision model. A 4K
    // screenshot would otherwise send megabytes and blow up its token count.
    public const int MaxVisionSide = 1280;

    public static string CaptureAsJpegDataUrl()
    {
        using var bitmap = Capture(Screen.PrimaryScreen!.Bounds);
        return ToVisionDataUrl(bitmap);
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

    // Full size at the encoder's default quality: OCR (ScreenContextReader)
    // needs every pixel of small text.
    public static string ToJpegDataUrl(Bitmap bitmap, long? quality = null)
    {
        using var stream = new MemoryStream();
        if (quality is long q)
        {
            var jpeg = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
            using var parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(Encoder.Quality, q);
            bitmap.Save(stream, jpeg, parameters);
        }
        else
        {
            bitmap.Save(stream, ImageFormat.Jpeg);
        }
        return $"data:image/jpeg;base64,{Convert.ToBase64String(stream.ToArray())}";
    }

    // #679: what the vision model gets -- scaled down to MaxVisionSide and
    // re-encoded as JPEG 85. Drawn over white, so a transparent PNG doesn't
    // turn black.
    public static string ToVisionDataUrl(Image image)
    {
        var size = FitWithin(image.Size, MaxVisionSide);
        using var scaled = new Bitmap(size.Width, size.Height);
        using (var g = Graphics.FromImage(scaled))
        {
            g.Clear(Color.White);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.DrawImage(image, 0, 0, size.Width, size.Height);
        }
        return ToJpegDataUrl(scaled, 85);
    }

    // `size` scaled down (never up) so its longest side is at most maxSide.
    internal static Size FitWithin(Size size, int maxSide)
    {
        var longest = Math.Max(size.Width, size.Height);
        if (longest <= maxSide)
        {
            return size;
        }
        var scale = (double)maxSide / longest;
        return new Size(Math.Max(1, (int)Math.Round(size.Width * scale)), Math.Max(1, (int)Math.Round(size.Height * scale)));
    }
}

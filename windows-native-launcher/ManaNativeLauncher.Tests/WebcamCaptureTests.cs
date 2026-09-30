using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Windows.Graphics.Imaging;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #912: the camera failures that get a plain answer, and what a snapshot
// keeps (never opens a camera).
public class WebcamCaptureTests
{
    [Fact]
    public void Describe_NamesTheCommonCameraFailures()
    {
        Assert.Equal(WebcamCapture.BlockedMessage, WebcamCapture.Describe(new UnauthorizedAccessException()));
        Assert.Equal(WebcamCapture.NoCameraMessage, WebcamCapture.Describe(new COMException("", unchecked((int)0xC00DABE0))));
        Assert.Equal(WebcamCapture.InUseMessage, WebcamCapture.Describe(new COMException("", unchecked((int)0xC00D3704))));
        Assert.Null(WebcamCapture.Describe(new InvalidOperationException("The camera sent no picture.")));
    }

    // #962: the vision model gets the scaled copy, but the JPEG that "save
    // that" keeps is the camera's full frame.
    [Fact]
    public async Task EncodeAsync_KeepsTheFullFrameForSaving()
    {
        using var frame = new SoftwareBitmap(BitmapPixelFormat.Bgra8, 1920, 1080, BitmapAlphaMode.Ignore);

        var snapshot = await WebcamCapture.EncodeAsync(frame);

        using (var full = Image.FromStream(new MemoryStream(snapshot.Jpeg)))
        {
            Assert.Equal(new Size(1920, 1080), full.Size);
        }
        var vision = Convert.FromBase64String(snapshot.VisionDataUrl["data:image/jpeg;base64,".Length..]);
        using var scaled = Image.FromStream(new MemoryStream(vision));
        Assert.Equal(ScreenCapture.MaxVisionSide, scaled.Width);
    }

    // #962: "save that" writes the snapshot's JPEG bytes, never over an
    // earlier one, and says so when there's nothing to save.
    [Fact]
    public void SaveSnapshot_WritesTheJpegWithoutOverwriting()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-snapshot-" + Guid.NewGuid());
        var at = new DateTime(2026, 9, 30, 12, 0, 5);
        var jpeg = new byte[] { 0xFF, 0xD8, 0xFF };
        try
        {
            var first = WebcamCapture.SaveSnapshot(jpeg, dir, at);
            var second = WebcamCapture.SaveSnapshot(jpeg, dir, at);

            Assert.Equal(Path.Combine(dir, "Mana 2026-09-30 12-00-05.jpg"), first);
            Assert.Equal(Path.Combine(dir, "Mana 2026-09-30 12-00-05 (2).jpg"), second);
            Assert.Equal(new byte[] { 0xFF, 0xD8, 0xFF }, File.ReadAllBytes(first));
            Assert.Equal(WebcamCapture.NothingToSaveMessage, Assert.Throws<InvalidOperationException>(() => WebcamCapture.SaveSnapshot(null, dir, at)).Message);
            Assert.Throws<InvalidOperationException>(() => WebcamCapture.SaveSnapshot(jpeg, "relative", at));
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }
}

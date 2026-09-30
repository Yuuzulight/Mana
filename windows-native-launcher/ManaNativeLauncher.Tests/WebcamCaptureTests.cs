using System;
using System.IO;
using System.Runtime.InteropServices;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #912: the camera failures that get a plain answer (never opens a camera).
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

    // #962: "save that" writes the snapshot's JPEG bytes, never over an
    // earlier one, and says so when there's nothing to save.
    [Fact]
    public void SaveSnapshot_WritesTheJpegWithoutOverwriting()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-snapshot-" + Guid.NewGuid());
        var at = new DateTime(2026, 9, 30, 12, 0, 5);
        var dataUrl = "data:image/jpeg;base64," + Convert.ToBase64String(new byte[] { 0xFF, 0xD8, 0xFF });
        try
        {
            var first = WebcamCapture.SaveSnapshot(dataUrl, dir, at);
            var second = WebcamCapture.SaveSnapshot(dataUrl, dir, at);

            Assert.Equal(Path.Combine(dir, "Mana 2026-09-30 12-00-05.jpg"), first);
            Assert.Equal(Path.Combine(dir, "Mana 2026-09-30 12-00-05 (2).jpg"), second);
            Assert.Equal(new byte[] { 0xFF, 0xD8, 0xFF }, File.ReadAllBytes(first));
            Assert.Equal(WebcamCapture.NothingToSaveMessage, Assert.Throws<InvalidOperationException>(() => WebcamCapture.SaveSnapshot(null, dir, at)).Message);
            Assert.Throws<InvalidOperationException>(() => WebcamCapture.SaveSnapshot(dataUrl, "relative", at));
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

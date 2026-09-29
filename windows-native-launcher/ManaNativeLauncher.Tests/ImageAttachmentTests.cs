using System;
using System.Drawing;
using System.IO;
using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #679: pasted/dropped chat images -- downscaled before upload, at most
// four per message, and shown as thumbnails in the user's bubble.
[Collection("DarkTheme palette")]
public class ImageAttachmentTests
{
    private static Size DecodedSize(string dataUrl)
    {
        using var stream = new MemoryStream(Convert.FromBase64String(dataUrl[(dataUrl.IndexOf(',') + 1)..]));
        using var image = Image.FromStream(stream);
        return image.Size;
    }

    [Theory]
    [InlineData(3840, 2160, 1280, 720)]
    [InlineData(1080, 2400, 576, 1280)]
    [InlineData(800, 600, 800, 600)] // never scaled up
    [InlineData(5000, 1, 1280, 1)]
    public void FitWithin_CapsTheLongestSide(int w, int h, int expectedW, int expectedH)
    {
        Assert.Equal(new Size(expectedW, expectedH), ScreenCapture.FitWithin(new Size(w, h), 1280));
    }

    [Fact]
    public void ToVisionDataUrl_Downscales4KToJpeg()
    {
        using var bitmap = new Bitmap(3840, 2160);
        var url = ScreenCapture.ToVisionDataUrl(bitmap);

        Assert.StartsWith("data:image/jpeg;base64,", url);
        Assert.Equal(new Size(1280, 720), DecodedSize(url));
    }

    [Fact]
    public void Strip_TakesAtMostFourImages()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var strip = new ImageAttachmentStrip();
        using var bitmap = new Bitmap(2000, 1000);
        for (var i = 0; i < ImageAttachmentStrip.MaxImages; i++)
        {
            Assert.True(strip.Add(bitmap));
        }
        Assert.False(strip.Add(bitmap));
        Assert.Equal(4, strip.Images.Count);
        Assert.Equal(new Size(1280, 640), DecodedSize(strip.Images[0]));

        strip.Clear();
        Assert.Equal(0, strip.Count);
        Assert.False(strip.Visible);
    }

    // A sideways phone photo: 200x100 pixels tagged "rotate 90 clockwise".
    private static Bitmap SidewaysPhoto()
    {
        var bitmap = new Bitmap(200, 100);
        var tag = (System.Drawing.Imaging.PropertyItem)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(System.Drawing.Imaging.PropertyItem));
        tag.Id = 0x0112;
        tag.Type = 3; // SHORT
        tag.Len = 2;
        tag.Value = BitConverter.GetBytes((ushort)6);
        bitmap.SetPropertyItem(tag);
        return bitmap;
    }

    [Fact]
    public void Strip_TurnsExifRotatedPhotosUpright()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var strip = new ImageAttachmentStrip();
        using var photo = SidewaysPhoto();

        strip.Add(photo);

        Assert.Equal(new Size(100, 200), DecodedSize(strip.Images[0]));
    }

    [Theory]
    [InlineData(1, null)]
    [InlineData(3, System.Drawing.RotateFlipType.Rotate180FlipNone)]
    [InlineData(6, System.Drawing.RotateFlipType.Rotate90FlipNone)]
    [InlineData(8, System.Drawing.RotateFlipType.Rotate270FlipNone)]
    [InlineData(9, null)]
    public void OrientationFix_UndoesTheExifTag(int orientation, System.Drawing.RotateFlipType? expected)
    {
        Assert.Equal(expected, ScreenCapture.OrientationFix(orientation));
    }

    [Fact]
    public void Strip_OnlyTakesImageFiles()
    {
        Assert.True(ImageAttachmentStrip.IsImageFile(@"C:\shots\Error.PNG"));
        Assert.True(ImageAttachmentStrip.IsImageFile("photo.webp"));
        Assert.False(ImageAttachmentStrip.IsImageFile("notes.txt"));
    }

    [Fact]
    public void ImageOnlyMessage_ShowsThumbnailsAndNoTextLine()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var view = new ChatView { Dock = System.Windows.Forms.DockStyle.None, Size = new Size(700, 500) };
        view.CreateControl();
        using var bitmap = new Bitmap(1280, 720);
        var url = ScreenCapture.ToVisionDataUrl(bitmap);

        view.AppendUserMessage("", new[] { url, url });

        var message = view.Messages.Single();
        Assert.Empty(message.Blocks);
        Assert.Equal(2, message.Images.Count);
        Assert.Equal(new Size(160, 90), message.Images[0].Size);
        Assert.Equal("[2 images]", message.PlainText);
        Assert.True(message.Bounds.Height > 90);
    }
}

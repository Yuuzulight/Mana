using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using SkiaSharp;

namespace Mana.NativeLauncher;

// #685: the chat window's live avatar. AvatarOverlayForm renders the same
// model it shows in the overlay into this panel each frame (ShowFrame) while
// the panel is attached -- SessionListForm attaches it only while the chat
// window is on screen, so a hidden or minimized window renders nothing.
// Whatever the Paint handlers draw (the card's gradient) sits behind the
// frame, which has a transparent background.
internal sealed class LiveAvatarPanel : Panel
{
    private Bitmap? frame;

    public LiveAvatarPanel()
    {
        DoubleBuffered = true; // repainted ~60 times a second
        ResizeRedraw = true;
    }

    // Electron's framing presets (live2d-logic.js DEFAULT_ZOOM_FRACTIONS):
    // how much of her height shows, from the top.
    public static readonly string[] Framings = ["full", "waist", "bust"];

    public static float FramingFraction(string? framing) => framing switch
    {
        "waist" or "upperHalf" => 0.55f, // #899: the overlay's name for waist-up
        "bust" => 0.28f,
        _ => 1f,
    };

    // Unknown/missing counts as "full".
    public static string NextFraming(string? framing) =>
        Framings[(Math.Max(0, Array.IndexOf(Framings, framing)) + 1) % Framings.Length];

    // Electron's zoom button titles (renderer.js ZOOM_BUTTON_TITLES).
    public static string FramingTitle(string? framing) => framing switch
    {
        "waist" => "Waist-up — click to zoom to bust-up",
        "bust" => "Bust-up — click to zoom to whole body",
        _ => "Whole body — click to zoom to waist-up",
    };

    // One of Framings; anything else (e.g. a missing saved value) is "full".
    private string framing = "full";
    public string? Framing
    {
        get => framing;
        set => framing = Array.IndexOf(Framings, value) >= 0 ? value! : "full";
    }

    public bool HasFrame => frame is not null;

    // Copies the rendered frame (any size; normally ClientSize) into a GDI
    // bitmap reused across frames and repaints. UI thread only.
    public void ShowFrame(SKBitmap source)
    {
        if (frame is null || frame.Width != source.Width || frame.Height != source.Height)
        {
            frame?.Dispose();
            frame = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppPArgb);
        }
        var data = frame.LockBits(new Rectangle(0, 0, frame.Width, frame.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        try
        {
            using var pixmap = source.PeekPixels();
            pixmap.ReadPixels(new SKImageInfo(frame.Width, frame.Height, SKColorType.Bgra8888, SKAlphaType.Premul), data.Scan0, data.Stride);
        }
        finally
        {
            frame.UnlockBits(data);
        }
        Invalidate();
    }

    // Back to the placeholder (e.g. when detached).
    public void ClearFrame()
    {
        frame?.Dispose();
        frame = null;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (frame is not null)
        {
            e.Graphics.DrawImageUnscaled(frame, 0, 0);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            frame?.Dispose();
            frame = null;
        }
        base.Dispose(disposing);
    }
}

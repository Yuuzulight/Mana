using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #571: on-screen equivalent of spoken output -- a borderless, always-on-top,
// bottom-center bar. It shows only the sentence Mana is saying right now,
// moving on as each next sentence starts playing, and after she stops it
// lingers for reading time (#701's timing: ~1s per 3 words, 4-20s) and
// hides. Driven by VoiceLoop's own playback, not the backend's caption
// feed, which fires at synthesis time -- a sentence ahead of the audio.
//
// Clear glass, as a per-pixel-alpha layered window like AvatarOverlayForm:
// the desktop shows straight through under a faint wash of the panel colour,
// a bright rim and a top sheen, with a soft halo keeping the text readable.
// Kept out of the way:
// - click-through: clicks land on whatever is underneath;
// - the wash adapts to what's behind the bar (stronger over a busy game,
//   nearly clear over a calm desktop), sampled from a ring just outside it;
// - it almost disappears while the mouse is over it;
// - each new sentence fades in and rises 4px over 150ms.
internal sealed class CaptionOverlayForm : Form
{
    private const int MaxWidth = 640;
    private const int PadX = 18;
    private const int PadY = 12;
    private const int Radius = 8;
    private const int EntranceMs = 150;
    private const int EntranceRisePx = 4;
    private const byte HoverAlpha = 30;
    private const int SampleRingPx = 24;

    private static readonly StringFormat Centered = new() { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
    private static readonly Regex SentenceEnd = new(@"(?<=[.!?。！？…])\s+|\n+", RegexOptions.Compiled);
    private static readonly (int X, int Y)[] HaloOffsets = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)];

    private readonly Font captionFont = new("Segoe UI", 12F);
    // Steps through a single-clip reply's sentences, then (queue empty)
    // lingers before hiding.
    private readonly System.Windows.Forms.Timer timer = new();
    // Entrance animation and hover fade; runs only while one is in motion,
    // plus a slow hover poll while visible (a click-through window gets no
    // mouse events of its own).
    private readonly System.Windows.Forms.Timer frameTimer = new() { Interval = 16 };
    private readonly Queue<(string Text, int Ms)> upcoming = new();
    private string caption = "";
    private bool lingering;
    private byte washAlpha;
    private long entranceStart = long.MinValue;
    private double windowAlpha = 255;

    public CaptionOverlayForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Visible = false;
        washAlpha = DefaultWashAlpha;
        timer.Tick += (_, _) => OnTimer();
        frameTimer.Tick += (_, _) => OnFrame();

        // Forces the handle to exist immediately -- the Show* methods are
        // called from VoiceLoop's thread-pool continuations before this form
        // is ever shown, same reasoning as StartupOverlayForm's own
        // constructor-time `_ = Handle;`.
        _ = Handle;
    }

    // A caption must never take focus from whatever the user is doing.
    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExTransparent = 0x20;
            const int wsExToolWindow = 0x80;
            const int wsExLayered = 0x80000;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExTransparent | wsExToolWindow | wsExLayered | wsExNoActivate;
            return cp;
        }
    }

    // The sentence that just started playing.
    public void ShowSentence(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ShowSentence(text));
            return;
        }
        upcoming.Clear();
        timer.Stop();
        Render(text);
    }

    // A whole reply spoken as one clip (the tool-calling path never streams
    // sentences): steps through its sentences, each on screen for its share
    // of the clip by length. An estimate -- the clip has no per-sentence
    // timings -- but it moves roughly with her voice.
    public void ShowSpokenText(string text, TimeSpan duration)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ShowSpokenText(text, duration));
            return;
        }
        upcoming.Clear();
        timer.Stop();
        if (duration <= TimeSpan.Zero)
        {
            Render(text); // unreadable clip length: no timing to step by
            return;
        }
        foreach (var step in Steps(text, duration))
        {
            upcoming.Enqueue(step);
        }
        if (upcoming.Count == 0)
        {
            return;
        }
        var (first, ms) = upcoming.Dequeue();
        Render(first);
        if (upcoming.Count > 0)
        {
            timer.Interval = ms;
            timer.Start();
        }
    }

    // She stopped talking (finished or interrupted): leave the last sentence
    // up long enough to read, then hide.
    public void SpeechEnded()
    {
        if (InvokeRequired)
        {
            BeginInvoke(SpeechEnded);
            return;
        }
        upcoming.Clear();
        timer.Stop();
        if (!Visible)
        {
            return;
        }
        lingering = true;
        timer.Interval = LingerMs(caption);
        timer.Start();
    }

    // #701: about 1s per 3 words, at least 4s, at most 20s.
    internal static int LingerMs(string text)
    {
        var words = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;
        return Math.Clamp(words * 1000 / 3, 4000, 20000);
    }

    internal static IReadOnlyList<(string Text, int Ms)> Steps(string text, TimeSpan duration)
    {
        var sentences = SentenceEnd.Split(text).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
        var total = Math.Max(1, sentences.Sum(s => s.Length));
        return sentences.Select(s => (s, Math.Max(1, (int)(duration.TotalMilliseconds * s.Length / total)))).ToList();
    }

    private static byte DefaultWashAlpha => DarkTheme.IsLight ? (byte)45 : (byte)70;

    // How strong the wash should be for a backdrop whose luminance has this
    // standard deviation (0-255): ~10% over a flat background, up to ~55%
    // over a busy, high-contrast one.
    internal static byte WashAlphaFor(double luminanceStdDev)
    {
        var busy = Math.Clamp(luminanceStdDev / 70.0, 0, 1);
        return (byte)Math.Round(26 + busy * 114);
    }

    private void OnTimer()
    {
        timer.Stop();
        if (lingering)
        {
            lingering = false;
            Visible = false;
            frameTimer.Stop();
            return;
        }
        if (upcoming.Count == 0)
        {
            return; // the clip's last sentence stays until SpeechEnded
        }
        var (text, ms) = upcoming.Dequeue();
        Render(text);
        if (upcoming.Count > 0)
        {
            timer.Interval = ms;
            timer.Start();
        }
    }

    private void Render(string text)
    {
        lingering = false;
        caption = text;
        using (var g = CreateGraphics())
        {
            var textSize = Size.Ceiling(g.MeasureString(text, captionFont, MaxWidth - PadX * 2, Centered));
            var size = new Size(Math.Min(MaxWidth, textSize.Width + PadX * 2), textSize.Height + PadY * 2);
            var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
            Bounds = new Rectangle(new Point(area.Left + (area.Width - size.Width) / 2, area.Bottom - size.Height - 48), size);
        }
        washAlpha = SampleWashAlpha(Bounds) ?? DefaultWashAlpha;
        entranceStart = Environment.TickCount64;
        if (!Visible)
        {
            windowAlpha = 255;
            Visible = true;
        }
        Present();
        frameTimer.Start();
    }

    // Entrance animation, hover fade, and the hover poll. Stops itself once
    // nothing is moving except the poll, which drops to a slow rate.
    private void OnFrame()
    {
        if (!Visible)
        {
            frameTimer.Stop();
            return;
        }
        var target = Bounds.Contains(Cursor.Position) ? HoverAlpha : 255;
        var fading = Math.Abs(windowAlpha - target) > 1;
        windowAlpha = fading ? windowAlpha + (target - windowAlpha) * 0.35 : target;
        var entering = Environment.TickCount64 - entranceStart < EntranceMs + frameTimer.Interval;
        if (entering || fading)
        {
            Present();
        }
        frameTimer.Interval = entering || fading ? 16 : 100;
    }

    // Luminance spread of the screen in a ring around the bar (never the bar
    // itself, which would be measuring its own glass). Null if the screen
    // can't be read (e.g. a secure desktop).
    private static byte? SampleWashAlpha(Rectangle bar)
    {
        var ring = Rectangle.Inflate(bar, SampleRingPx, SampleRingPx);
        try
        {
            using var shot = new Bitmap(ring.Width, ring.Height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(shot))
            {
                g.CopyFromScreen(ring.Location, Point.Empty, ring.Size);
            }
            var data = shot.LockBits(new Rectangle(Point.Empty, ring.Size), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var pixels = new byte[data.Stride * data.Height];
                Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                var inner = new Rectangle(SampleRingPx, SampleRingPx, bar.Width, bar.Height);
                double sum = 0, sumSq = 0;
                var n = 0;
                for (var y = 0; y < data.Height; y += 3)
                {
                    for (var x = 0; x < data.Width; x += 3)
                    {
                        if (inner.Contains(x, y))
                        {
                            continue;
                        }
                        var i = y * data.Stride + x * 4;
                        var l = 0.0722 * pixels[i] + 0.7152 * pixels[i + 1] + 0.2126 * pixels[i + 2];
                        sum += l;
                        sumSq += l * l;
                        n++;
                    }
                }
                if (n == 0)
                {
                    return null;
                }
                var mean = sum / n;
                return WashAlphaFor(Math.Sqrt(Math.Max(0, sumSq / n - mean * mean)));
            }
            finally
            {
                shot.UnlockBits(data);
            }
        }
        catch (Exception)
        {
            return null;
        }
    }

    private void Present()
    {
        var size = Size;
        if (size.Width <= 0 || size.Height <= 0 || !IsHandleCreated)
        {
            return;
        }
        var t = Math.Clamp((Environment.TickCount64 - entranceStart) / (double)EntranceMs, 0, 1);
        var ease = 1 - (1 - t) * (1 - t);
        var textAlpha = (int)Math.Round(255 * ease);
        var rise = (float)(EntranceRisePx * (1 - ease));

        using var bitmap = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            using var shape = RoundedRect(new RectangleF(0.5f, 0.5f, size.Width - 1, size.Height - 1), Radius);
            using (var wash = new SolidBrush(Color.FromArgb(washAlpha, DarkTheme.Panel)))
            {
                g.FillPath(wash, shape);
            }
            using (var sheen = new LinearGradientBrush(new Rectangle(0, 0, size.Width, size.Height / 2 + 1), Color.FromArgb(50, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f))
            {
                g.SetClip(shape);
                g.FillRectangle(sheen, 0, 0, size.Width, size.Height / 2);
                g.ResetClip();
            }
            using (var rim = new Pen(Color.FromArgb(DarkTheme.IsLight ? 150 : 90, 255, 255, 255), 1.5f))
            {
                g.DrawPath(rim, shape);
            }
            var rect = new RectangleF(PadX, PadY + rise, size.Width - PadX * 2, size.Height - PadY * 2);
            // Halo in the panel colour, so light text gets a dark edge and
            // dark text a light one, whatever is behind the glass.
            using (var halo = new SolidBrush(Color.FromArgb(110 * textAlpha / 255, DarkTheme.Panel)))
            {
                foreach (var (dx, dy) in HaloOffsets)
                {
                    g.DrawString(caption, captionFont, halo, rect with { X = rect.X + dx, Y = rect.Y + dy }, Centered);
                }
            }
            using var brush = new SolidBrush(Color.FromArgb(textAlpha, DarkTheme.Text));
            g.DrawString(caption, captionFont, brush, rect, Centered);
        }

        var screenDc = GetDC(0);
        var memoryDc = CreateCompatibleDC(screenDc);
        var hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
        var previous = SelectObject(memoryDc, hBitmap);
        try
        {
            var position = Location;
            var source = Point.Empty;
            var blend = new BlendFunction { BlendOp = 0, SourceConstantAlpha = (byte)Math.Clamp(windowAlpha, 0, 255), AlphaFormat = 1 };
            UpdateLayeredWindow(Handle, screenDc, ref position, ref size, memoryDc, ref source, 0, ref blend, 2);
        }
        finally
        {
            SelectObject(memoryDc, previous);
            DeleteObject(hBitmap);
            DeleteDC(memoryDc);
            ReleaseDC(0, screenDc);
        }
    }

    private static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var d = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            timer.Dispose();
            frameTimer.Dispose();
            captionFont.Dispose();
        }
        base.Dispose(disposing);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BlendFunction
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(nint hwnd, nint hdcDst, ref Point pptDst, ref Size psize, nint hdcSrc, ref Point pptSrc, int crKey, ref BlendFunction pblend, int dwFlags);

    [DllImport("user32.dll")]
    private static extern nint GetDC(nint hwnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(nint hwnd, nint hdc);

    [DllImport("gdi32.dll")]
    private static extern nint CreateCompatibleDC(nint hdc);

    [DllImport("gdi32.dll")]
    private static extern nint SelectObject(nint hdc, nint h);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(nint ho);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(nint hdc);
}

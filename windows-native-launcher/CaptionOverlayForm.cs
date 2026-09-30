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

// #571: on-screen equivalent of spoken output -- a borderless, always-on-top
// bar. Driven by VoiceLoop's own playback, not the backend's caption feed,
// which fires at synthesis time -- a sentence ahead of the audio.
// Q7/Q8 (2026-09-29):
// - words appear one by one ~150ms ahead of her voice, spread over the
//   sentence's audio by length;
// - within a reply the bar keeps the last 2 sentences (the one before, in
//   full, then the one being said); a new reply starts it fresh;
// - past 4 lines the font shrinks instead of the bar growing;
// - after she stops it stays until her next reply, at most 7s;
// - it sits centred under her avatar (kept on screen), or bottom-centre
//   while she's hidden.
//
// Clear glass, as a per-pixel-alpha layered window like AvatarOverlayForm:
// the desktop shows straight through under a faint wash of the panel colour,
// a bright rim and a top sheen, with a soft halo keeping the text readable.
// Kept out of the way:
// - click-through: clicks land on whatever is underneath;
// - the wash adapts to what's behind the bar (stronger over a busy game,
//   nearly clear over a calm desktop), sampled from a ring just outside it;
// - it almost disappears while the mouse is over it;
// - the bar fades in and rises 4px over 150ms as it appears.
internal sealed class CaptionOverlayForm : Form
{
    private const int MaxWidth = 640;
    private const float BaseFontSize = 12F;
    private const float MinFontSize = 8F;
    private const int MaxLines = 4;
    private const int LeadMs = 150;
    private const int StayMs = 7000;
    private const int BottomGap = 48;
    private const int ScreenMargin = 12;
    private const int PadX = 18;
    private const int PadY = 12;
    private const int Radius = 8;
    private const int EntranceMs = 150;
    private const int EntranceRisePx = 4;
    private const byte HoverAlpha = 30;
    private const int SampleRingPx = 24;

    // Left-aligned (the bar is sized to the whole text) so a word appearing
    // never moves the ones before it.
    private static readonly StringFormat Layout = new() { Alignment = StringAlignment.Near, LineAlignment = StringAlignment.Near };
    private static readonly Regex SentenceEnd = new(@"(?<=[.!?。！？…])\s+|\n+", RegexOptions.Compiled);
    private static readonly (int X, int Y)[] HaloOffsets = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)];

    private Font captionFont = new("Segoe UI", BaseFontSize);
    // Steps through a single-clip reply's sentences, then (queue empty)
    // stays a while before hiding.
    private readonly System.Windows.Forms.Timer timer = new();
    // Entrance animation and hover fade; runs only while one is in motion,
    // plus a slow hover poll while visible (a click-through window gets no
    // mouse events of its own).
    private readonly System.Windows.Forms.Timer frameTimer = new() { Interval = 16 };
    private readonly Queue<(string Text, int Ms)> upcoming = new();
    // Mana's avatar on screen, or null while she's hidden.
    private readonly Func<Rectangle?>? anchor;
    private string previous = ""; // the reply's sentence before this one, shown in full
    private string current = "";  // the sentence being said, words single-spaced
    private long currentStart;
    private double currentMs;     // its audio length; 0 = unknown, show it whole
    private bool replyEnded = true;
    private string drawn = "";
    private bool staying;
    private byte washAlpha;
    private long entranceStart = long.MinValue;
    private double windowAlpha = 255;

    public CaptionOverlayForm(Func<Rectangle?>? anchor = null)
    {
        this.anchor = anchor;
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

    // The sentence that just started playing, and how long its audio is
    // (zero when unknown: it shows whole).
    public void ShowSentence(string text, TimeSpan duration = default)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ShowSentence(text, duration));
            return;
        }
        upcoming.Clear();
        timer.Stop();
        StartSentence(text, duration.TotalMilliseconds);
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
        replyEnded = true; // a whole reply: starts the bar fresh
        if (duration <= TimeSpan.Zero)
        {
            StartSentence(text, 0); // unreadable clip length: no timing to step by
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
        StartSentence(first, ms);
        if (upcoming.Count > 0)
        {
            timer.Interval = ms;
            timer.Start();
        }
    }

    // #701: while chat bubbles are on they carry her words, so the bar stays
    // hidden; turning bubbles off brings it back from the next sentence.
    // UI thread only (the tray toggle).
    private bool suppressed;
    public bool Suppressed
    {
        get => suppressed;
        set
        {
            suppressed = value;
            if (value)
            {
                upcoming.Clear();
                timer.Stop();
                frameTimer.Stop();
                staying = false;
                replyEnded = true;
                Visible = false;
            }
        }
    }

    // She stopped talking (finished or interrupted): every word shows, and
    // the bar stays until her next reply, at most 7s.
    public void SpeechEnded()
    {
        if (InvokeRequired)
        {
            BeginInvoke(SpeechEnded);
            return;
        }
        upcoming.Clear();
        timer.Stop();
        replyEnded = true;
        if (!Visible)
        {
            return;
        }
        currentMs = 0;
        Present();
        staying = true;
        timer.Interval = StayMs;
        timer.Start();
    }

    // Q7: the words of `sentence` on screen elapsedMs into its audio --
    // each word's share of the audio is its share of the characters, and it
    // shows leadMs before she gets to it.
    internal static string RevealedWords(string sentence, double elapsedMs, double durationMs, double leadMs = LeadMs)
    {
        var words = sentence.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (durationMs <= 0)
        {
            return string.Join(' ', words);
        }
        var progress = (elapsedMs + leadMs) / durationMs;
        var total = (double)words.Sum(w => w.Length + 1);
        var shown = 0;
        for (var acc = 0; shown < words.Length && acc / total <= progress; shown++)
        {
            acc += words[shown].Length + 1;
        }
        return string.Join(' ', words, 0, shown);
    }

    // Q8: the largest font size (12pt down to 8pt, in half points) that
    // fits the text in 4 lines at this width.
    internal static float FitFontSize(Graphics g, string text, int width)
    {
        for (var size = BaseFontSize; ; size -= 0.5F)
        {
            using var font = new Font("Segoe UI", size);
            if (size <= MinFontSize || g.MeasureString(text, font, width, Layout).Height <= (MaxLines * font.GetHeight(g)) + 2)
            {
                return size;
            }
        }
    }

    // Q8: centred under her avatar, kept on screen (never lower than the
    // old bottom-centre spot); bottom-centre when she's hidden. With no room
    // under her (she stands at the bottom of the screen) it goes above her
    // head instead -- clamped down to the bottom spot it would sit on her
    // body, behind her window.
    internal static Point Place(Size bar, Rectangle? avatar, Rectangle workArea)
    {
        var bottom = workArea.Bottom - bar.Height - BottomGap;
        if (avatar is not Rectangle a)
        {
            return new Point(workArea.Left + ((workArea.Width - bar.Width) / 2), bottom);
        }
        var minX = workArea.Left + ScreenMargin;
        var x = Math.Clamp(a.Left + (a.Width / 2) - (bar.Width / 2), minX, Math.Max(minX, workArea.Right - bar.Width - ScreenMargin));
        var below = a.Bottom + 8;
        var above = a.Top - bar.Height - 8;
        var top = workArea.Top + ScreenMargin;
        var y = below <= bottom ? below : above >= top ? above : Math.Max(top, bottom);
        return new Point(x, y);
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
        if (staying)
        {
            staying = false;
            Visible = false;
            frameTimer.Stop();
            return;
        }
        if (upcoming.Count == 0)
        {
            return; // the clip's last sentence stays until SpeechEnded
        }
        var (text, ms) = upcoming.Dequeue();
        StartSentence(text, ms);
        if (upcoming.Count > 0)
        {
            timer.Interval = ms;
            timer.Start();
        }
    }

    // A new sentence joins the reply's previous one (a new reply starts
    // fresh); the bar is sized for both in full so it doesn't move as the
    // words come in.
    private void StartSentence(string text, double durationMs)
    {
        if (suppressed)
        {
            return;
        }
        previous = replyEnded ? "" : current;
        replyEnded = false;
        current = RevealedWords(text, 0, 0);
        currentStart = Environment.TickCount64;
        currentMs = durationMs;
        staying = false;
        var full = Joined(previous, current);
        var avatar = anchor?.Invoke();
        var area = (avatar is Rectangle a ? Screen.FromRectangle(a) : Screen.PrimaryScreen)?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        using (var g = CreateGraphics())
        {
            var size = FitFontSize(g, full, MaxWidth - (PadX * 2));
            if (captionFont.Size != size)
            {
                captionFont.Dispose();
                captionFont = new Font("Segoe UI", size);
            }
            var textSize = Size.Ceiling(g.MeasureString(full, captionFont, MaxWidth - (PadX * 2), Layout));
            var barSize = new Size(Math.Min(MaxWidth, textSize.Width + (PadX * 2)), textSize.Height + (PadY * 2));
            Bounds = new Rectangle(Place(barSize, avatar, area), barSize);
        }
        washAlpha = SampleWashAlpha(Bounds) ?? DefaultWashAlpha;
        if (!Visible)
        {
            entranceStart = Environment.TickCount64;
            windowAlpha = 255;
            Visible = true;
        }
        Present();
        frameTimer.Start();
    }

    private static string Joined(string previous, string current) => previous.Length > 0 ? $"{previous} {current}" : current;

    private string Shown() =>
        Joined(previous, RevealedWords(current, Environment.TickCount64 - currentStart, currentMs));

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
        var revealing = currentMs > 0 && Environment.TickCount64 - currentStart + LeadMs < currentMs + frameTimer.Interval;
        if (entering || fading || Shown() != drawn)
        {
            Present();
        }
        frameTimer.Interval = entering || fading ? 16 : revealing ? 33 : 100;
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
        drawn = Shown();

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
                    g.DrawString(drawn, captionFont, halo, rect with { X = rect.X + dx, Y = rect.Y + dy }, Layout);
                }
            }
            using var brush = new SolidBrush(Color.FromArgb(textAlpha, DarkTheme.Text));
            g.DrawString(drawn, captionFont, brush, rect, Layout);
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

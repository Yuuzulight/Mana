using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #701: when/how long each floating bubble shows -- no UI, so it's testable.
// Times are in milliseconds on any one clock.
internal sealed class ChatBubbleStack
{
    public const int MaxBubbles = 3;
    public const double FadeMs = 400;

    public sealed class Bubble(string text, double endsAt, double lingerMs)
    {
        public string Text { get; } = text;
        // When her voice finishes this sentence; +infinity until known.
        public double EndsAt { get; set; } = endsAt;
        public double LingerMs { get; set; } = lingerMs;
        public double FadeAt => EndsAt + LingerMs;
        public double Alpha { get; set; } = 1;
    }

    private readonly List<Bubble> bubbles = [];

    // Oldest first.
    public IReadOnlyList<Bubble> Bubbles => bubbles;

    // Reading time after the sentence ends: about 1 s per 3 words, 4-20 s.
    public static double LingerMs(string text)
    {
        var words = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;
        return Math.Clamp(words / 3.0, 4, 20) * 1000;
    }

    // A new sentence starts playing (durationMs 0 = length unknown: it ends
    // at SpeechEnded). The older bubbles' sentences are over; what's left
    // of their reading time is halved, and past the third they fade now.
    public void Add(string text, double now, double durationMs)
    {
        for (var i = 0; i < bubbles.Count; i++)
        {
            var older = bubbles[i];
            older.EndsAt = Math.Min(older.EndsAt, now);
            older.LingerMs -= Math.Max(0, older.FadeAt - now) / 2;
            if (i <= bubbles.Count - MaxBubbles)
            {
                older.LingerMs = Math.Min(older.LingerMs, now - older.EndsAt);
            }
        }
        bubbles.Add(new Bubble(text, durationMs > 0 ? now + durationMs : double.PositiveInfinity, LingerMs(text)));
    }

    // She stopped talking (finished or interrupted).
    public void SpeechEnded(double now)
    {
        foreach (var bubble in bubbles)
        {
            bubble.EndsAt = Math.Min(bubble.EndsAt, now);
        }
    }

    // Hover: the clock stops for every bubble, fading ones included.
    public void Pause(double elapsedMs)
    {
        foreach (var bubble in bubbles.Where(b => !double.IsInfinity(b.EndsAt)))
        {
            bubble.EndsAt += elapsedMs;
        }
    }

    // Updates each bubble's opacity and drops the faded ones; true if
    // anything changed.
    public bool Tick(double now)
    {
        var changed = bubbles.RemoveAll(b => now >= b.FadeAt + FadeMs) > 0;
        foreach (var bubble in bubbles)
        {
            var alpha = now < bubble.FadeAt ? 1 : 1 - ((now - bubble.FadeAt) / FadeMs);
            changed |= alpha != bubble.Alpha;
            bubble.Alpha = alpha;
        }
        return changed;
    }

    public void Clear() => bubbles.Clear();
}

// #701: Mana's spoken sentences as glass bubbles beside the avatar, for when
// the chat window isn't in view (closed, minimized or covered) -- never the
// same line in both places. Off by default (tray menu). Driven by VoiceLoop's
// playback like the captions: a bubble appears as its sentence starts,
// lingers for reading time after it ends, up to 3 stack (newest at the
// bottom) and the older ones fade faster when a new one arrives. Hovering
// pauses the fade; clicking one opens that message in the chat window.
//
// A per-pixel-alpha layered window like the avatar overlay: the empty space
// around the bubbles is fully transparent, so clicks pass straight through
// it; the bubbles themselves take clicks without taking focus.
internal sealed class ChatBubblesForm : Form
{
    private const int MaxTextWidth = 260;
    private const int PadX = 12;
    private const int PadY = 8;
    private const int Gap = 6;
    private const int AvatarGap = 8;

    private readonly ChatBubbleStack stack = new();
    private readonly Queue<(double StartsAt, string Text, int Ms)> upcoming = new();
    private readonly System.Windows.Forms.Timer frameTimer = new() { Interval = 33 };
    private readonly Font font = new("Segoe UI", 10.5F);
    private readonly Func<Rectangle?> anchor;
    private readonly Func<bool> chatWindowInView;
    private List<(Rectangle Bounds, ChatBubbleStack.Bubble Bubble)> layout = [];
    private long lastFrameMs = Environment.TickCount64;

    // anchor: Mana's avatar on screen, or null while she's hidden.
    // chatWindowInView: whether the chat window is on screen and not covered.
    public ChatBubblesForm(Func<Rectangle?> anchor, Func<bool> chatWindowInView)
    {
        this.anchor = anchor;
        this.chatWindowInView = chatWindowInView;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Visible = false;
        BubblesOn = ManaSettingsStore.Load().ChatBubbles;
        frameTimer.Tick += (_, _) => OnFrame();
        // The Show* methods are called from VoiceLoop's thread-pool
        // continuations; InvokeRequired needs the handle to exist.
        _ = Handle;
    }

    // The tray toggle. UI thread only.
    public bool BubblesOn { get; set; }

    // A bubble was clicked; its sentence, to find in the chat window.
    public event Action<string>? BubbleClicked;

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExToolWindow = 0x80;
            const int wsExLayered = 0x80000;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExToolWindow | wsExLayered | wsExNoActivate;
            return cp;
        }
    }

    // Same calls as CaptionOverlayForm's, from the same places in VoiceLoop.
    public void ShowSentence(string text, TimeSpan duration = default)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ShowSentence(text, duration));
            return;
        }
        upcoming.Clear();
        AddBubble(text, duration.TotalMilliseconds);
    }

    // A whole reply spoken as one clip: its sentences appear one by one,
    // each at its share of the clip by length (CaptionOverlayForm.Steps).
    public void ShowSpokenText(string text, TimeSpan duration)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ShowSpokenText(text, duration));
            return;
        }
        upcoming.Clear();
        if (duration <= TimeSpan.Zero)
        {
            AddBubble(text, 0);
            return;
        }
        double startsAt = Environment.TickCount64;
        foreach (var (sentence, ms) in CaptionOverlayForm.Steps(text, duration))
        {
            upcoming.Enqueue((startsAt, sentence, ms));
            startsAt += ms;
        }
        OnFrame();
    }

    public void SpeechEnded()
    {
        if (InvokeRequired)
        {
            BeginInvoke(SpeechEnded);
            return;
        }
        upcoming.Clear();
        stack.SpeechEnded(Environment.TickCount64);
    }

    private void AddBubble(string text, double durationMs)
    {
        text = text.Trim();
        if (!BubblesOn || text.Length == 0 || chatWindowInView())
        {
            return;
        }
        stack.Add(text, Environment.TickCount64, durationMs);
        stack.Tick(Environment.TickCount64);
        Render();
        if (!Visible)
        {
            Visible = true;
        }
        lastFrameMs = Environment.TickCount64;
        frameTimer.Start();
    }

    private void OnFrame()
    {
        var now = Environment.TickCount64;
        while (upcoming.Count > 0 && upcoming.Peek().StartsAt <= now)
        {
            var (_, text, ms) = upcoming.Dequeue();
            AddBubble(text, ms);
        }
        if (!BubblesOn || (stack.Bubbles.Count > 0 && chatWindowInView()))
        {
            // Turned off, or the chat window came into view: it shows
            // everything, so the bubbles go.
            stack.Clear();
            upcoming.Clear();
        }
        if (Visible && layout.Any(item => RectangleToScreen(item.Bounds).Contains(Cursor.Position)))
        {
            stack.Pause(now - lastFrameMs);
        }
        lastFrameMs = now;
        if (stack.Tick(now) || (stack.Bubbles.Count == 0 && Visible))
        {
            Render();
        }
        if (stack.Bubbles.Count == 0 && upcoming.Count == 0)
        {
            frameTimer.Stop();
            Visible = false;
        }
        else
        {
            frameTimer.Start();
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button == MouseButtons.Left && layout.FirstOrDefault(item => item.Bounds.Contains(e.Location)).Bubble is { } bubble)
        {
            BubbleClicked?.Invoke(bubble.Text);
        }
    }

    // Right of the avatar (left when there's no room), the stack's bottom
    // level with her middle, kept on screen; bottom-right of the screen
    // while she's hidden.
    internal static Point Place(Size stackSize, Rectangle? avatar, Rectangle workArea)
    {
        if (avatar is not Rectangle a)
        {
            return new Point(workArea.Right - stackSize.Width - AvatarGap, workArea.Bottom - stackSize.Height - AvatarGap);
        }
        var x = a.Right + AvatarGap + stackSize.Width <= workArea.Right
            ? a.Right + AvatarGap
            : Math.Max(workArea.Left, a.Left - AvatarGap - stackSize.Width);
        var y = Math.Clamp(a.Top + (a.Height / 2) - stackSize.Height, workArea.Top, Math.Max(workArea.Top, workArea.Bottom - stackSize.Height));
        return new Point(x, y);
    }

    private void Render()
    {
        if (stack.Bubbles.Count == 0)
        {
            layout = [];
            return;
        }
        using var measure = CreateGraphics();
        measure.TextRenderingHint = TextRenderingHint.AntiAliasGridFit; // as drawn, so the wrapping matches
        var sizes = stack.Bubbles
            .Select(b => Size.Ceiling(measure.MeasureString(b.Text, font, MaxTextWidth)) + new Size(PadX * 2, PadY * 2))
            .ToList();
        var stackSize = new Size(sizes.Max(s => s.Width), sizes.Sum(s => s.Height) + (Gap * (sizes.Count - 1)));
        var avatar = anchor();
        var area = (avatar is Rectangle r ? Screen.FromRectangle(r) : Screen.PrimaryScreen)?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        var location = Place(stackSize, avatar, area);
        var rightAligned = avatar is Rectangle av && location.X < av.Left;

        var next = new List<(Rectangle, ChatBubbleStack.Bubble)>();
        var y = 0;
        for (var i = 0; i < sizes.Count; i++)
        {
            var x = rightAligned ? stackSize.Width - sizes[i].Width : 0;
            next.Add((new Rectangle(new Point(x, y), sizes[i]), stack.Bubbles[i]));
            y += sizes[i].Height + Gap;
        }
        layout = next;
        Bounds = new Rectangle(location, stackSize);

        using var bitmap = new Bitmap(stackSize.Width, stackSize.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            foreach (var (bounds, bubble) in layout)
            {
                DrawBubble(g, bounds, bubble);
            }
        }
        Present(bitmap, new Rectangle(location, stackSize));
    }

    // The chat view's own Mana bubble (ChatView's paint: ManaBubble, glass
    // edges in the Mana preset), fading as a whole via a colour matrix.
    private void DrawBubble(Graphics g, Rectangle bounds, ChatBubbleStack.Bubble bubble)
    {
        using var single = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using (var b = Graphics.FromImage(single))
        {
            b.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            var rect = new Rectangle(Point.Empty, bounds.Size);
            using (var fill = new SolidBrush(Color.FromArgb(DarkTheme.IsGlass ? 175 : 235, DarkTheme.ManaBubble)))
            {
                b.FillRectangle(fill, rect);
            }
            if (DarkTheme.IsGlass)
            {
                GlassSurface.PaintGlassEdges(b, rect, null);
            }
            else
            {
                using var border = new Pen(DarkTheme.Border);
                b.DrawRectangle(border, 0, 0, rect.Width - 1, rect.Height - 1);
            }
            using var text = new SolidBrush(DarkTheme.Text);
            b.DrawString(bubble.Text, font, text, new RectangleF(PadX, PadY, MaxTextWidth, rect.Height - PadY * 2));
        }
        using var fade = new ImageAttributes();
        fade.SetColorMatrix(new ColorMatrix { Matrix33 = (float)Math.Clamp(bubble.Alpha, 0, 1) });
        g.DrawImage(single, bounds, 0, 0, bounds.Width, bounds.Height, GraphicsUnit.Pixel, fade);
    }

    private void Present(Bitmap bitmap, Rectangle bounds)
    {
        var screenDc = GetDC(0);
        var memoryDc = CreateCompatibleDC(screenDc);
        var hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
        var previous = SelectObject(memoryDc, hBitmap);
        try
        {
            var position = bounds.Location;
            var size = bounds.Size;
            var source = Point.Empty;
            var blend = new BlendFunction { BlendOp = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
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

    // #701: whether `form` is on screen and not covered -- visible, not
    // minimized, and itself the top window at one of five points across it.
    // ponytail: sampled, so a window covered except for a sliver may count
    // as covered; a region test (GetWindowRgn/DWM) if that ever misfires.
    internal static bool InView(Form form)
    {
        if (!form.Visible || form.WindowState == FormWindowState.Minimized || !form.IsHandleCreated)
        {
            return false;
        }
        var r = form.Bounds;
        var points = new[]
        {
            new Point(r.Left + (r.Width / 2), r.Top + (r.Height / 2)),
            new Point(r.Left + (r.Width / 4), r.Top + (r.Height / 4)),
            new Point(r.Right - (r.Width / 4), r.Top + (r.Height / 4)),
            new Point(r.Left + (r.Width / 4), r.Bottom - (r.Height / 4)),
            new Point(r.Right - (r.Width / 4), r.Bottom - (r.Height / 4)),
        };
        return points.Any(p => GetAncestor(WindowFromPoint(p), GaRoot) == form.Handle);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            frameTimer.Dispose();
            font.Dispose();
        }
        base.Dispose(disposing);
    }

    private const uint GaRoot = 2;

    [DllImport("user32.dll")]
    private static extern nint WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    private static extern nint GetAncestor(nint hwnd, uint flags);

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

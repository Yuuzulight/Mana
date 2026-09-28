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
// Clear glass: the frame is extended into the whole client area so the
// desktop shows straight through, under a faint wash of the panel colour, a
// bright rim and a top sheen; a soft halo keeps the text readable over busy
// backgrounds. GDI text has no alpha and would come out see-through, so
// everything is drawn into an ARGB bitmap and copied over as-is. If DWM
// refuses the frame extension it's the plain solid panel bar.
internal sealed class CaptionOverlayForm : Form
{
    private const int MaxWidth = 640;
    private const int PadX = 18;
    private const int PadY = 12;

    private static readonly StringFormat Centered = new() { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
    private static readonly Regex SentenceEnd = new(@"(?<=[.!?。！？…])\s+|\n+", RegexOptions.Compiled);

    private readonly Font captionFont = new("Segoe UI", 12F);
    // One timer for both jobs: stepping through a single-clip reply's
    // sentences, then (queue empty) lingering before hiding.
    private readonly System.Windows.Forms.Timer timer = new();
    private readonly Queue<(string Text, int Ms)> upcoming = new();
    private string caption = "";
    private bool lingering;
    private bool glass;

    public CaptionOverlayForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = DarkTheme.Panel;
        Visible = false;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        timer.Tick += (_, _) => OnTimer();

        // Forces the handle to exist immediately -- the Show* methods are
        // called from VoiceLoop's thread-pool continuations before this form
        // is ever shown, same reasoning as StartupOverlayForm's own
        // constructor-time `_ = Handle;`.
        _ = Handle;
    }

    // A caption must never take focus from whatever the user is doing.
    protected override bool ShowWithoutActivation => true;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int round = DwmwcpRound;
        DwmSetWindowAttribute(Handle, DwmwaWindowCornerPreference, ref round, sizeof(int));
        var margins = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 };
        glass = DwmExtendFrameIntoClientArea(Handle, ref margins) == 0;
        if (glass)
        {
            BackColor = Color.Black; // black client area = see-through
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
            lingering = false;
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

    private void OnTimer()
    {
        timer.Stop();
        if (lingering)
        {
            lingering = false;
            Visible = false;
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
        using var g = CreateGraphics();
        var textSize = Size.Ceiling(g.MeasureString(text, captionFont, MaxWidth - PadX * 2, Centered));
        Width = Math.Min(MaxWidth, textSize.Width + PadX * 2);
        Height = textSize.Height + PadY * 2;
        PositionAtBottomCenter();
        Invalidate();
        Visible = true;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var size = new Size(Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height));
        using var bitmap = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppPArgb);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            var rect = new RectangleF(PadX, PadY, size.Width - PadX * 2, size.Height - PadY * 2);
            if (glass)
            {
                g.Clear(Color.FromArgb(DarkTheme.IsLight ? 45 : 70, DarkTheme.Panel));
                using var sheen = new LinearGradientBrush(new Rectangle(0, 0, size.Width, size.Height / 2 + 1), Color.FromArgb(50, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f);
                g.FillRectangle(sheen, 0, 0, size.Width, size.Height / 2);
                using var rim = new Pen(Color.FromArgb(DarkTheme.IsLight ? 150 : 90, 255, 255, 255), 1.5f);
                g.DrawRectangle(rim, 0.75f, 0.75f, size.Width - 1.5f, size.Height - 1.5f);
                // Halo in the panel colour, so light text gets a dark edge
                // and dark text a light one, whatever is behind the glass.
                using var halo = new SolidBrush(Color.FromArgb(110, DarkTheme.Panel));
                foreach (var (dx, dy) in HaloOffsets)
                {
                    g.DrawString(caption, captionFont, halo, rect with { X = rect.X + dx, Y = rect.Y + dy }, Centered);
                }
            }
            else
            {
                g.Clear(DarkTheme.Panel);
            }
            using var brush = new SolidBrush(DarkTheme.Text);
            g.DrawString(caption, captionFont, brush, rect, Centered);
        }
        e.Graphics.CompositingMode = CompositingMode.SourceCopy;
        e.Graphics.DrawImageUnscaled(bitmap, 0, 0);
    }

    private static readonly (int X, int Y)[] HaloOffsets = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)];

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            timer.Dispose();
            captionFont.Dispose();
        }
        base.Dispose(disposing);
    }

    private void PositionAtBottomCenter()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(area.Left + (area.Width - Width) / 2, area.Bottom - Height - 48);
    }

    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwcpRound = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct Margins
    {
        public int Left, Right, Top, Bottom;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int valueSize);

    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);
}

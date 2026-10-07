using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1426: the thinking level, like Claude's effort control -- a card with a
// Faster <-> Smarter slider over five stops, Medium marked Recommended. Click
// or drag on the track, or use the arrow keys. Opened from the chat
// composer's Thinking chip.
internal sealed class ThinkingLevelPicker : Control
{
    // What the backend takes (thinkLevel) and what the card says.
    internal static readonly (string Id, string Label)[] Levels =
        [("off", "Off"), ("low", "Low"), ("medium", "Medium"), ("high", "High"), ("max", "Max")];

    internal const string Recommended = "medium";

    internal static string LabelOf(string id) => Array.Find(Levels, l => l.Id == id).Label ?? "Medium";

    internal static int IndexOf(string id) => Math.Max(0, Array.FindIndex(Levels, l => l.Id == id));

    private int index;
    private readonly Font titleFont = new("Segoe UI", 9.75f);
    private readonly Font valueFont = new("Segoe UI Semibold", 9.75f);
    private readonly Font smallFont = new("Segoe UI", 8.25f);

    public event Action<string>? LevelChanged;

    public ThinkingLevelPicker(string level)
    {
        index = IndexOf(level);
        Size = new Size(280, 124);
        DoubleBuffered = true;
        TabStop = true;
        BackColor = DarkTheme.Panel;
        AccessibleName = "Thinking level";
        AccessibleRole = AccessibleRole.Slider;
        AccessibleDescription = LabelOf(Level);
    }

    public string Level => Levels[index].Id;

    private Rectangle Track => new(16, 64, Width - 32, 22);

    private float StopX(int i) => Track.Left + 14 + (Track.Width - 28) * i / (float)(Levels.Length - 1);

    // Picks a stop; says so only when it changed.
    internal void Pick(int i)
    {
        i = Math.Clamp(i, 0, Levels.Length - 1);
        if (i == index)
        {
            return;
        }
        index = i;
        AccessibleDescription = LabelOf(Level);
        Invalidate();
        LevelChanged?.Invoke(Level);
    }

    private int NearestStop(int x)
    {
        var best = 0;
        for (var i = 1; i < Levels.Length; i++)
        {
            if (Math.Abs(StopX(i) - x) < Math.Abs(StopX(best) - x))
            {
                best = i;
            }
        }
        return best;
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        Focus();
        Pick(NearestStop(e.X));
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (e.Button == MouseButtons.Left)
        {
            Pick(NearestStop(e.X));
        }
    }

    protected override bool IsInputKey(Keys keyData) => keyData is Keys.Left or Keys.Right || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.KeyCode == Keys.Left)
        {
            Pick(index - 1);
        }
        else if (e.KeyCode == Keys.Right)
        {
            Pick(index + 1);
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var back = new SolidBrush(BackColor))
        {
            g.FillRectangle(back, ClientRectangle);
        }
        const TextFormatFlags left = TextFormatFlags.Left | TextFormatFlags.NoPrefix;
        TextRenderer.DrawText(g, "Thinking", titleFont, new Point(16, 12), DarkTheme.Muted, left);
        var titleWidth = TextRenderer.MeasureText("Thinking", titleFont).Width;
        TextRenderer.DrawText(g, LabelOf(Level), valueFont, new Point(16 + titleWidth, 12), DarkTheme.Text, left);
        TextRenderer.DrawText(g, "Faster", smallFont, new Point(16, 42), DarkTheme.Muted, left);
        var smarter = TextRenderer.MeasureText("Smarter", smallFont);
        TextRenderer.DrawText(g, "Smarter", smallFont, new Point(Width - 16 - smarter.Width, 42), DarkTheme.Muted, left);

        var track = Track;
        using (var path = Pill(track))
        using (var fill = new SolidBrush(DarkTheme.Panel2))
        using (var edge = new Pen(DarkTheme.Border))
        {
            g.FillPath(fill, path);
            g.DrawPath(edge, path);
        }
        var cy = track.Top + track.Height / 2f;
        using (var dot = new SolidBrush(DarkTheme.Muted))
        {
            for (var i = 0; i < Levels.Length; i++)
            {
                if (i != index)
                {
                    g.FillEllipse(dot, StopX(i) - 2, cy - 2, 4, 4);
                }
            }
        }
        var thumb = new RectangleF(StopX(index) - 11, cy - 11, 22, 22);
        using (var shadow = new SolidBrush(Color.FromArgb(40, 0, 0, 0)))
        {
            g.FillEllipse(shadow, thumb with { Y = thumb.Y + 1.5f });
        }
        using (var knob = new SolidBrush(DarkTheme.IsLight ? Color.White : DarkTheme.Text))
        {
            g.FillEllipse(knob, thumb);
        }
        using (var ring = new Pen(DarkTheme.Accent, 2f))
        {
            g.DrawEllipse(ring, thumb);
        }

        var recommended = TextRenderer.MeasureText("Recommended", smallFont);
        var rx = (int)StopX(IndexOf(Recommended)) - recommended.Width / 2;
        TextRenderer.DrawText(g, "Recommended", smallFont, new Point(Math.Max(4, rx), track.Bottom + 8), DarkTheme.Muted, left);
        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(track, 4, 4));
        }
    }

    private static GraphicsPath Pill(Rectangle r)
    {
        var path = new GraphicsPath();
        var d = r.Height;
        path.AddArc(r.Left, r.Top, d, d, 90, 180);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 180);
        path.CloseFigure();
        return path;
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        Invalidate();
    }

    protected override void OnLostFocus(EventArgs e)
    {
        base.OnLostFocus(e);
        Invalidate();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            titleFont.Dispose();
            valueFont.Dispose();
            smallFont.Dispose();
        }
        base.Dispose(disposing);
    }
}

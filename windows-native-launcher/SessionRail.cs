using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// The chat list folded to a strip (mockup C): when the window is narrow, or the sidebar toggle folds it. Her live
// avatar in head framing on top (the same LiveAvatarPanel, moved here while folded), New chat and Search, then each
// chat as its initials -- the open one ringed, its title as the tooltip. Clicking one opens it.
internal sealed class SessionRail : Control
{
    internal const int LogicalWidth = 56;
    internal const int FoldBelowLogicalWidth = 700;
    private const int Button = 38;
    private const int Gap = 6;

    private readonly ToolTip tips;
    private readonly Panel avatarSlot = new() { BackColor = Color.Transparent };
    private IReadOnlyList<(string Id, string Title)> chats = Array.Empty<(string, string)>();
    private string? activeId;
    private int hot = -1; // index into Slots, or -1
    private string? shownTip;
    private readonly Font initialsFont = new("Segoe UI Semibold", 9f); // cached, like ChatView's fonts

    public event Action? NewChatRequested;
    public event Action? SearchRequested;
    public event Action<string>? ChatChosen;

    public SessionRail(ToolTip tips)
    {
        this.tips = tips;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        Controls.Add(avatarSlot);
        AccessibleName = "Chats";
        AccessibleRole = AccessibleRole.ToolBar;
    }

    // Where her avatar goes while the sidebar is folded.
    public Control AvatarSlot => avatarSlot;

    public void SetChats(IReadOnlyList<(string Id, string Title)> list, string? active)
    {
        chats = list;
        activeId = active;
        Invalidate();
    }

    public void SetActive(string? active)
    {
        activeId = active;
        Invalidate();
    }

    // Fold below 700 px of window width (at the window's own DPI).
    internal static bool ShouldFold(int clientWidth, int dpi) => clientWidth < FoldBelowLogicalWidth * dpi / 96;

    // A chat's initials: the first letter or digit of its first two words ("Folio table speed" -> "FT",
    // "Bonsai 2 benchmark" -> "B2"); one word gives its first two; nothing usable gives "·".
    internal static string Initials(string title)
    {
        var words = title.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Select(w => new string(w.Where(char.IsLetterOrDigit).ToArray()))
            .Where(w => w.Length > 0).ToList();
        if (words.Count == 0)
        {
            return "·";
        }
        var text = words.Count == 1 ? words[0][..Math.Min(2, words[0].Length)] : $"{words[0][0]}{words[1][0]}";
        return text.ToUpperInvariant();
    }

    private int Scale(int logical) => LogicalToDeviceUnits(logical);

    protected override void OnLayout(LayoutEventArgs levent)
    {
        base.OnLayout(levent);
        var size = Scale(40);
        avatarSlot.Bounds = new Rectangle((Width - size) / 2, Scale(10), size, size);
        foreach (Control child in avatarSlot.Controls)
        {
            child.Bounds = avatarSlot.ClientRectangle;
            using var circle = new GraphicsPath();
            circle.AddEllipse(child.ClientRectangle);
            child.Region = new Region(circle);
        }
    }

    // The buttons top to bottom: New chat, Search, then one per chat that fits. kind: "new", "search" or a chat id.
    private List<(Rectangle Bounds, string Kind, string Tip)> Slots()
    {
        var slots = new List<(Rectangle, string, string)>();
        var size = Scale(Button);
        var x = (Width - size) / 2;
        var y = avatarSlot.Bottom + Scale(12);
        slots.Add((new Rectangle(x, y, size, size), "new", "New chat"));
        y += size + Scale(Gap);
        slots.Add((new Rectangle(x, y, size, size), "search", "Search chats"));
        y += size + Scale(Gap) + Scale(10); // room for the separator
        foreach (var (id, title) in chats)
        {
            if (y + size > Height - Scale(8))
            {
                break;
            }
            slots.Add((new Rectangle(x, y, size, size), id, title));
            y += size + Scale(Gap);
        }
        return slots;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (DarkTheme.IsGlass)
        {
            GlassSurface.PaintGlowBehind(e.Graphics, this, ClientRectangle);
            return;
        }
        using var fill = new SolidBrush(DarkTheme.Background);
        e.Graphics.FillRectangle(fill, ClientRectangle);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var slots = Slots();
        var stroke = Math.Max(1f, Scale(15) / 10f);
        for (var i = 0; i < slots.Count; i++)
        {
            var (bounds, kind, title) = slots[i];
            var radius = Scale(12);
            using var shape = SettingsRows.Rounded(new RectangleF(bounds.X + 0.5f, bounds.Y + 0.5f, bounds.Width - 1, bounds.Height - 1), radius);
            if (kind == "new")
            {
                using var accent = new SolidBrush(DarkTheme.Accent);
                g.FillPath(accent, shape);
                using var plus = new Pen(DarkTheme.OnAccent, stroke);
                var c = new PointF(bounds.X + bounds.Width / 2f, bounds.Y + bounds.Height / 2f);
                var arm = Scale(7);
                g.DrawLine(plus, c.X - arm, c.Y, c.X + arm, c.Y);
                g.DrawLine(plus, c.X, c.Y - arm, c.X, c.Y + arm);
            }
            else
            {
                var chat = kind != "search";
                if (chat || i == hot)
                {
                    using var fill = new SolidBrush(DarkTheme.IsGlass ? GlassSurface.Veil(i == hot ? 215 : 160) : i == hot ? DarkTheme.Border : DarkTheme.Panel2);
                    g.FillPath(fill, shape);
                    using var edge = new Pen(DarkTheme.IsGlass ? GlassSurface.Outline : DarkTheme.Border);
                    g.DrawPath(edge, shape);
                }
                if (chat && kind == activeId)
                {
                    using var ring = new Pen(DarkTheme.Accent, Math.Max(2f, Scale(2)));
                    using var outer = SettingsRows.Rounded(RectangleF.Inflate(bounds, Scale(2), Scale(2)), radius + Scale(2));
                    g.DrawPath(ring, outer);
                }
                if (chat)
                {
                    TextRenderer.DrawText(g, Initials(title), initialsFont, bounds, DarkTheme.Accent,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
                }
                else
                {
                    using var pen = new Pen(DarkTheme.Muted, stroke);
                    var r = Scale(6);
                    var c = new PointF(bounds.X + bounds.Width / 2f - Scale(2), bounds.Y + bounds.Height / 2f - Scale(2));
                    g.DrawEllipse(pen, c.X - r, c.Y - r, r * 2, r * 2);
                    g.DrawLine(pen, c.X + r * 0.7f, c.Y + r * 0.7f, c.X + r * 1.6f, c.Y + r * 1.6f);
                }
            }
            if (kind == "search")
            {
                using var line = new Pen(DarkTheme.IsGlass ? GlassSurface.Outline : DarkTheme.Border);
                var sy = bounds.Bottom + Scale(Gap) + Scale(5);
                g.DrawLine(line, bounds.X + Scale(8), sy, bounds.Right - Scale(8), sy);
            }
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            initialsFont.Dispose();
        }
        base.Dispose(disposing);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var slots = Slots();
        var index = slots.FindIndex(s => s.Bounds.Contains(e.Location));
        Cursor = index >= 0 ? Cursors.Hand : Cursors.Default;
        if (index != hot)
        {
            hot = index;
            Invalidate();
        }
        var tip = index >= 0 ? slots[index].Tip : null;
        if (tip != shownTip)
        {
            shownTip = tip;
            tips.SetToolTip(this, tip);
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        hot = -1;
        shownTip = null;
        tips.SetToolTip(this, null);
        Invalidate();
    }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        base.OnMouseClick(e);
        if (e.Button != MouseButtons.Left)
        {
            return;
        }
        var slot = Slots().FirstOrDefault(s => s.Bounds.Contains(e.Location));
        switch (slot.Kind)
        {
            case null:
                break;
            case "new":
                NewChatRequested?.Invoke();
                break;
            case "search":
                SearchRequested?.Invoke();
                break;
            default:
                ChatChosen?.Invoke(slot.Kind);
                break;
        }
    }
}

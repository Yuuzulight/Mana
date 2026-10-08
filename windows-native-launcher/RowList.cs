using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1426: the Memory page's lists, drawn like the chat sidebar's rows: one
// line per entry (its name, what it says in grey, a date or state at the
// right) under small group headers with counts, and the picked entry's
// actions as icons at its right end. Right-click, Shift+F10 or the menu key
// lists the same actions by name. Each item's Tag stays the entry's value,
// so callers read the selection as they would any ListView's.
internal sealed class RowList : ListView
{
    // Tag: a small pill before the text, like a reminder's "Fridays".
    internal sealed record Entry(object Value, string Name, string Text, string Right = "", string? Tag = null, bool Pinned = false, string Group = "");

    // Glyph: a Segoe MDL2 Assets character.
    internal sealed record RowAction(string Glyph, string Name, Func<Task> Run);

    private static readonly object Header = new();
    private readonly Dictionary<ListViewItem, Entry> entries = new();
    private readonly Dictionary<ListViewItem, int> counts = new();
    private readonly ImageList rowHeight = new();
    private readonly Font nameFont = new("Segoe UI Semibold", 9f);
    private readonly Font smallFont = new("Segoe UI", 8.25f);
    private readonly Font iconFont = new("Segoe MDL2 Assets", 9.75f);
    private readonly ToolTip tips = new();
    private int hoverIndex = -1;
    private int hoverIcon = -1;

    // The picked entry's actions; none when null.
    public Func<object, IReadOnlyList<RowAction>>? ActionsFor { get; set; }

    // Grows to fit its rows up to this many, then scrolls; 0 keeps its height.
    public int MaxVisibleRows { get; set; }

    // How wide the name column is, in logical pixels.
    public int NameWidth { get; set; } = 140;

    // The colour of an entry's Tag pill: amber by default (a warning, like Add-on).
    internal Func<Color> TagColor { get; set; } = () => DarkTheme.Warn;

    public RowList()
    {
        View = View.Details;
        HeaderStyle = ColumnHeaderStyle.None;
        FullRowSelect = true;
        HideSelection = false;
        MultiSelect = false;
        OwnerDraw = true;
        DarkTheme.ApplyListView(this); // dark scroll bars
        BorderStyle = BorderStyle.None;
        BackColor = DarkTheme.Panel;
        ForeColor = DarkTheme.Text;
        Columns.Add("", 300);
        rowHeight.ImageSize = new Size(1, 30);
        SmallImageList = rowHeight;
        ClientSizeChanged += (_, _) => Fit();
        DrawItem += (_, e) => Draw(e);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        rowHeight.ImageSize = new Size(1, LogicalToDeviceUnits(30));
        Fit();
    }

    // Sized as soon as it's placed, before anything loads into it.
    protected override void OnParentChanged(EventArgs e)
    {
        base.OnParentChanged(e);
        FitHeight();
    }

    // As tall as its rows (to MaxVisibleRows), so a short list leaves no
    // empty panel; the rounded panel it sits on grows with it.
    private void FitHeight()
    {
        if (MaxVisibleRows <= 0)
        {
            return;
        }
        // The real row height once there's a window (a little over the image's).
        var row = IsHandleCreated && Items.Count > 0 ? Items[0].Bounds.Height : LogicalToDeviceUnits(32);
        var height = (Math.Clamp(Items.Count, 1, MaxVisibleRows) * row) + 4;
        if (Parent is RoundBox box)
        {
            box.Height = height + box.Padding.Vertical;
        }
        else
        {
            Height = height;
        }
    }

    // One column as wide as the list (also once rows add the vertical scroll bar).
    private void Fit()
    {
        var width = ClientSize.Width;
        if (Columns.Count > 0 && Columns[0].Width != width)
        {
            Columns[0].Width = width;
        }
    }

    internal Entry? EntryOf(ListViewItem item) => entries.GetValueOrDefault(item);

    internal static bool IsHeader(ListViewItem item) => item.Tag == Header;

    // groups: the order headers show in, each only when it has entries;
    // null for one plain list. keep: picks an entry again after a reload.
    internal void ShowEntries(IEnumerable<Entry> shown, IReadOnlyList<(string Id, string Label)>? groups, string empty, Func<object, bool>? keep = null)
    {
        BeginUpdate();
        Items.Clear();
        entries.Clear();
        counts.Clear();
        var all = shown.ToList();
        void Add(Entry entry)
        {
            // The text a screen reader reads; the row draws from entry.
            var item = new ListViewItem(entry.Text.Length > 0 ? $"{entry.Name}: {entry.Text}" : entry.Name) { Tag = entry.Value };
            entries[item] = entry;
            Items.Add(item);
            item.Selected = keep?.Invoke(entry.Value) ?? false;
        }
        if (groups is null)
        {
            all.ForEach(Add);
        }
        else
        {
            foreach (var (id, label) in groups)
            {
                var inGroup = all.Where(e => e.Group == id || (id == groups[^1].Id && !groups.Any(g => g.Id == e.Group))).ToList();
                if (inGroup.Count == 0)
                {
                    continue;
                }
                var header = new ListViewItem(label) { Tag = Header };
                counts[header] = inGroup.Count;
                Items.Add(header);
                inGroup.ForEach(Add);
            }
        }
        if (Items.Count == 0)
        {
            Items.Add(new ListViewItem(empty) { ForeColor = DarkTheme.Muted });
        }
        EndUpdate();
        FitHeight();
        Fit();
        OnSelectedIndexChanged(EventArgs.Empty);
    }

    private IReadOnlyList<RowAction> ActionsOf(ListViewItem item) =>
        item.Tag is { } value && !IsHeader(item) && entries.ContainsKey(item) ? ActionsFor?.Invoke(value) ?? [] : [];

    private Rectangle IconRect(Rectangle row, int index, int count)
    {
        var size = LogicalToDeviceUnits(24);
        var right = row.Right - LogicalToDeviceUnits(8);
        return new Rectangle(right - ((count - index) * size), row.Y + ((row.Height - size) / 2), size, size);
    }

    private void Draw(DrawListViewItemEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var row = e.Bounds with { X = 0, Width = ClientSize.Width };
        var pad = LogicalToDeviceUnits(12);
        const TextFormatFlags line = TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
        using (var back = new SolidBrush(BackColor))
        {
            g.FillRectangle(back, row);
        }

        if (IsHeader(e.Item))
        {
            // Small grey words at the bottom of the row, the count at the right.
            var words = row with { Y = row.Bottom - smallFont.Height - LogicalToDeviceUnits(3), Height = smallFont.Height };
            TextRenderer.DrawText(g, e.Item.Text, smallFont, words with { X = pad, Width = row.Width - (pad * 2) }, DarkTheme.Muted, line);
            TextRenderer.DrawText(g, counts.GetValueOrDefault(e.Item).ToString(), smallFont, words with { X = pad, Width = row.Width - (pad * 2) }, DarkTheme.Muted, line | TextFormatFlags.Right);
            return;
        }

        if (!entries.TryGetValue(e.Item, out var entry))
        {
            // A plain line: "Nothing here", or why the list couldn't load.
            TextRenderer.DrawText(g, e.Item.Text, Font, row with { X = pad, Width = row.Width - (pad * 2) }, e.Item.ForeColor == ForeColor ? DarkTheme.Muted : e.Item.ForeColor, line);
            return;
        }

        var card = Rectangle.Inflate(row, -LogicalToDeviceUnits(4), -1);
        if (e.Item.Selected || e.ItemIndex == hoverIndex)
        {
            using var fill = new SolidBrush(e.Item.Selected ? Color.FromArgb(56, DarkTheme.Accent) : DarkTheme.Panel2);
            using var shape = SettingsRows.Rounded(card, LogicalToDeviceUnits(6));
            g.FillPath(fill, shape);
        }

        var x = pad;
        if (entry.Pinned)
        {
            TextRenderer.DrawText(g, "", iconFont, new Rectangle(x, row.Y, LogicalToDeviceUnits(16), row.Height), DarkTheme.Accent, line);
            x += LogicalToDeviceUnits(18);
        }
        var nameWidth = LogicalToDeviceUnits(NameWidth) - (x - pad);
        TextRenderer.DrawText(g, entry.Name, nameFont, new Rectangle(x, row.Y, nameWidth, row.Height), DarkTheme.Text, line);
        x = pad + LogicalToDeviceUnits(NameWidth) + LogicalToDeviceUnits(10);

        // The right end: the picked entry's icons, else its date or state.
        var actions = e.Item.Selected ? ActionsOf(e.Item) : [];
        int rightEdge;
        if (actions.Count > 0)
        {
            rightEdge = IconRect(row, 0, actions.Count).X - LogicalToDeviceUnits(6);
            for (var i = 0; i < actions.Count; i++)
            {
                var icon = IconRect(row, i, actions.Count);
                if (e.ItemIndex == hoverIndex && i == hoverIcon)
                {
                    using var hover = new SolidBrush(DarkTheme.Panel2);
                    using var shape = SettingsRows.Rounded(Rectangle.Inflate(icon, -2, -2), LogicalToDeviceUnits(5));
                    g.FillPath(hover, shape);
                }
                TextRenderer.DrawText(g, actions[i].Glyph, iconFont, icon, DarkTheme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
            }
        }
        else
        {
            var rightWidth = entry.Right.Length == 0 ? 0 : TextRenderer.MeasureText(entry.Right, smallFont).Width;
            rightEdge = row.Right - pad - rightWidth - LogicalToDeviceUnits(8);
            TextRenderer.DrawText(g, entry.Right, smallFont, new Rectangle(row.Right - pad - rightWidth, row.Y, rightWidth, row.Height), DarkTheme.Muted, line);
        }

        if (entry.Tag is { Length: > 0 } tag)
        {
            var size = TextRenderer.MeasureText(tag, smallFont);
            var pill = new Rectangle(x, row.Y + ((row.Height - size.Height - 4) / 2), size.Width + LogicalToDeviceUnits(8), size.Height + 4);
            using (var fill = new SolidBrush(Color.FromArgb(48, TagColor())))
            using (var shape = SettingsRows.Rounded(pill, pill.Height / 2f))
            {
                g.FillPath(fill, shape);
            }
            TextRenderer.DrawText(g, tag, smallFont, pill, TagColor(), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
            x = pill.Right + LogicalToDeviceUnits(6);
        }
        TextRenderer.DrawText(g, entry.Text, Font, new Rectangle(x, row.Y, Math.Max(0, rightEdge - x), row.Height), DarkTheme.Muted, line);

        if (e.Item.Focused && Focused && GlassSurface.ShowsFocusCues(this))
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(card, -2, -1));
        }
    }

    // Which row and icon the pointer is over; -1 for none.
    private (int Row, int Icon) HitIcon(Point at)
    {
        var item = GetItemAt(at.X, at.Y);
        if (item is null)
        {
            return (-1, -1);
        }
        var actions = item.Selected ? ActionsOf(item) : [];
        var row = item.Bounds with { X = 0, Width = ClientSize.Width };
        for (var i = 0; i < actions.Count; i++)
        {
            if (IconRect(row, i, actions.Count).Contains(at))
            {
                return (item.Index, i);
            }
        }
        return (item.Index, -1);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var (index, icon) = HitIcon(e.Location);
        if (index == hoverIndex && icon == hoverIcon)
        {
            return;
        }
        hoverIndex = index;
        hoverIcon = icon;
        Cursor = icon >= 0 ? Cursors.Hand : Cursors.Default;
        tips.SetToolTip(this, icon >= 0 ? ActionsOf(Items[index])[icon].Name : null);
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        hoverIndex = hoverIcon = -1;
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        var (index, icon) = HitIcon(e.Location);
        if (e.Button == MouseButtons.Left && icon >= 0)
        {
            _ = ActionsOf(Items[index])[icon].Run();
        }
        else if (e.Button == MouseButtons.Right && index >= 0 && !IsHeader(Items[index]))
        {
            Items[index].Selected = true;
            ShowActionMenu(e.Location);
        }
    }

    // Headers can't be picked: a click on one picks nothing, and the arrow
    // keys step over them.
    protected override void OnSelectedIndexChanged(EventArgs e)
    {
        if (SelectedItems.Count > 0 && IsHeader(SelectedItems[0]))
        {
            SelectedItems[0].Selected = false;
            return;
        }
        base.OnSelectedIndexChanged(e);
        Invalidate();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Up or Keys.Down)
        {
            var step = e.KeyCode == Keys.Down ? 1 : -1;
            var from = SelectedItems.Count > 0 ? SelectedItems[0].Index : (step > 0 ? -1 : Items.Count);
            for (var i = from + step; i >= 0 && i < Items.Count; i += step)
            {
                if (!IsHeader(Items[i]))
                {
                    Items[i].Selected = Items[i].Focused = true;
                    EnsureVisible(i);
                    break;
                }
            }
            e.Handled = true;
            return;
        }
        if (e.KeyCode == Keys.Apps || (e.KeyCode == Keys.F10 && e.Shift))
        {
            if (SelectedItems.Count > 0)
            {
                var bounds = SelectedItems[0].Bounds;
                ShowActionMenu(new Point(bounds.X + LogicalToDeviceUnits(20), bounds.Bottom));
            }
            e.Handled = true;
            return;
        }
        base.OnKeyDown(e);
    }

    private void ShowActionMenu(Point at)
    {
        if (SelectedItems.Count == 0 || ActionsOf(SelectedItems[0]) is not { Count: > 0 } actions)
        {
            return;
        }
        var menu = new ContextMenuStrip();
        foreach (var action in actions)
        {
            menu.Items.Add(action.Name, null, (_, _) => _ = action.Run());
        }
        menu.Closed += (_, _) => BeginInvoke(menu.Dispose);
        menu.Show(this, at);
    }

    // For a test or a keyboard user: the picked entry's actions by name.
    internal IReadOnlyList<RowAction> SelectedActions => SelectedItems.Count > 0 ? ActionsOf(SelectedItems[0]) : [];

    // Never a sideways scroll bar: the list view shows one for a column
    // exactly its width, so the style comes off each time the frame is
    // worked out.
    private const int WmNcCalcSize = 0x83;
    private const int GwlStyle = -16;
    private const int WsHScroll = 0x00100000;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hWnd, int index, int value);

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmNcCalcSize)
        {
            var style = GetWindowLong(Handle, GwlStyle);
            if ((style & WsHScroll) != 0)
            {
                SetWindowLong(Handle, GwlStyle, style & ~WsHScroll);
            }
        }
        base.WndProc(ref m);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            nameFont.Dispose();
            smallFont.Dispose();
            iconFont.Dispose();
            tips.Dispose();
            rowHeight.Dispose();
        }
        base.Dispose(disposing);
    }
}

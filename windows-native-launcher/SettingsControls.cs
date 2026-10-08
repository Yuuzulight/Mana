using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1426 polish: Settings' own controls, drawn in the chat window's language
// -- rounded, quiet until hovered, the accent only where it means something
// -- in place of the Windows ones that drew square, white-edged and blue.
internal static class SettingsPaint
{
    // What's behind a drawn control: its parent's background, through any
    // transparent containers in between.
    internal static void Behind(Control control, Graphics g)
    {
        if (control.Parent is null)
        {
            return;
        }
        var state = g.Save();
        g.TranslateTransform(-control.Left, -control.Top);
        using (var e = new PaintEventArgs(g, new Rectangle(control.Location, control.Size)))
        {
            InvokeBackground(control.Parent, e);
        }
        g.Restore(state);
    }

    // Control.InvokePaintBackground is protected; any control may call it on
    // another, so a throwaway one does.
    private static readonly Painter painter = new();

    private static void InvokeBackground(Control parent, PaintEventArgs e) => painter.PaintOn(parent, e);

    private sealed class Painter : Control
    {
        internal void PaintOn(Control parent, PaintEventArgs e) => InvokePaintBackground(parent, e);
    }

    // A rounded field: the darker fill, a hairline edge, the accent while focused.
    internal static void Field(Graphics g, RectangleF bounds, bool focused, float radius = 6)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var shape = SettingsRows.Rounded(bounds, radius);
        using var fill = new SolidBrush(DarkTheme.Panel);
        using var edge = new Pen(focused ? DarkTheme.Accent : DarkTheme.Border);
        g.FillPath(fill, shape);
        g.DrawPath(edge, shape);
    }

    // A pill that's on or off: outlined, tinted with the accent while on.
    internal static void Pill(Graphics g, Control control, bool on)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var pill = new RectangleF(0.5f, 0.5f, control.Width - 1.5f, control.Height - 1.5f);
        using var shape = SettingsRows.Rounded(pill, pill.Height / 2);
        if (on)
        {
            using var fill = new SolidBrush(Color.FromArgb(56, DarkTheme.Accent));
            g.FillPath(fill, shape);
        }
        using (var edge = new Pen(on ? DarkTheme.Accent : DarkTheme.Border))
        {
            g.DrawPath(edge, shape);
        }
        TextRenderer.DrawText(g, control.Text, control.Font, Rectangle.Round(pill), on ? DarkTheme.Accent : DarkTheme.Text,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        if (control.Focused)
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(Rectangle.Round(pill), -3, -3));
        }
    }
}

// A button: a rounded rectangle a shade darker than the row, lighter while
// hovered; the accent behind its words when it's the one to press (Primary).
// A danger button keeps its red words (ForeColor). Dashed: a place to add
// something, an outline only, the accent while hovered.
internal sealed class SettingsButton : Button
{
    private bool hovered;
    private bool pressed;
    private bool primary;

    internal bool Dashed { get; set; }

    public SettingsButton()
    {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
        ForeColor = DarkTheme.Text;
        Cursor = Cursors.Hand;
        Padding = new Padding(10, 2, 10, 2);
        UseMnemonic = false;
    }

    internal bool Primary
    {
        get => primary;
        set
        {
            primary = value;
            Invalidate();
        }
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        base.OnMouseEnter(e);
        hovered = true;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        hovered = pressed = false;
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs mevent)
    {
        base.OnMouseDown(mevent);
        pressed = true;
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs mevent)
    {
        base.OnMouseUp(mevent);
        pressed = false;
        Invalidate();
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        base.OnEnabledChanged(e);
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs pevent)
    {
        var g = pevent.Graphics;
        SettingsPaint.Behind(this, g);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var box = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
        using var shape = SettingsRows.Rounded(box, Dashed ? 8 : 7);
        if (Dashed)
        {
            using (var dash = new Pen(hovered ? DarkTheme.Accent : DarkTheme.Border, 1.5f) { DashStyle = DashStyle.Dash })
            {
                g.DrawPath(dash, shape);
            }
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, hovered ? DarkTheme.Accent : DarkTheme.Muted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
            return;
        }
        var fill = primary
            ? (pressed ? ControlPaint.Dark(DarkTheme.Accent, 0.05f) : hovered ? ControlPaint.Light(DarkTheme.Accent, 0.15f) : DarkTheme.Accent)
            : (pressed ? DarkTheme.Border : hovered ? DarkTheme.Panel2 : DarkTheme.Panel);
        using (var brush = new SolidBrush(Enabled ? fill : DarkTheme.Panel))
        {
            g.FillPath(brush, shape);
        }
        if (!primary)
        {
            using var edge = new Pen(hovered && Enabled ? DarkTheme.Muted : DarkTheme.Border);
            g.DrawPath(edge, shape);
        }
        var words = !Enabled ? DarkTheme.Muted : primary ? DarkTheme.OnAccent : ForeColor;
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, words, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(ClientRectangle, -4, -4));
        }
    }
}

// A dropdown: a rounded field with its choice and a chevron, the list in
// the theme's own colours with the picked one tinted.
internal sealed class SettingsCombo : ComboBox
{
    private const int WmPaint = 0x000F;
    private const int WmPrint = 0x0317;
    private const int WmPrintClient = 0x0318;

    public SettingsCombo()
    {
        DropDownStyle = ComboBoxStyle.DropDownList;
        FlatStyle = FlatStyle.Flat;
        DrawMode = DrawMode.OwnerDrawFixed;
        ItemHeight = 20;
        BackColor = DarkTheme.Panel;
        ForeColor = DarkTheme.Text;
        Cursor = Cursors.Hand;
    }

    protected override void OnDrawItem(DrawItemEventArgs e)
    {
        if (e.Index < 0)
        {
            return;
        }
        var picked = (e.State & DrawItemState.Selected) != 0 && (e.State & DrawItemState.ComboBoxEdit) == 0;
        using (var back = new SolidBrush(picked ? DarkTheme.Panel2 : DarkTheme.Panel))
        {
            e.Graphics.FillRectangle(back, e.Bounds);
        }
        if (picked)
        {
            using var mark = new SolidBrush(DarkTheme.Accent);
            e.Graphics.FillRectangle(mark, e.Bounds.X, e.Bounds.Y + 3, 3, e.Bounds.Height - 6);
        }
        TextRenderer.DrawText(e.Graphics, GetItemText(Items[e.Index]), Font, Rectangle.Inflate(e.Bounds, -8, 0), DarkTheme.Text,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }

    // The closed field drawn over Windows' own: rounded, the choice, a chevron.
    // Printed too (WM_PRINT), so a picture of the page shows it the same.
    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (m.Msg == WmPaint && IsHandleCreated)
        {
            using var g = Graphics.FromHwnd(Handle);
            PaintField(g);
        }
        else if (m.Msg is WmPrint or WmPrintClient && m.WParam != IntPtr.Zero)
        {
            using var g = Graphics.FromHdc(m.WParam);
            PaintField(g);
        }
    }

    private void PaintField(Graphics g)
    {
        using (var surround = new SolidBrush(DarkTheme.IsGlass ? Color.FromArgb(240, 238, 246) : DarkTheme.Panel2))
        {
            g.FillRectangle(surround, ClientRectangle);
        }
        SettingsPaint.Field(g, new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Focused || DroppedDown);
        var words = new Rectangle(8, 0, Width - 30, Height);
        TextRenderer.DrawText(g, Text, Font, words, Enabled ? DarkTheme.Text : DarkTheme.Muted,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        using var pen = new Pen(DarkTheme.Muted, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        var cx = Width - 14f;
        var cy = Height / 2f;
        g.DrawLines(pen, new[] { new PointF(cx - 4, cy - 2), new PointF(cx, cy + 2), new PointF(cx + 4, cy - 2) });
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
}

// A slider: a thin track filled with the accent up to a round thumb.
// Click or drag on it, or the arrow, Page and Home/End keys. The mouse wheel
// is left to the page, so scrolling past one never moves it.
internal sealed class SettingsSlider : Control
{
    private int value;
    private int maximum = 10;

    public event EventHandler? ValueChanged;

    public SettingsSlider()
    {
        Size = new Size(150, 26);
        TabStop = true;
        Cursor = Cursors.Hand;
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
        BackColor = Color.Transparent;
        AccessibleRole = AccessibleRole.Slider;
    }

    public int Minimum { get; set; }

    public int Maximum
    {
        get => maximum;
        set
        {
            maximum = value;
            Value = this.value;
        }
    }

    public int SmallChange { get; set; } = 1;

    public int LargeChange { get; set; } = 1;

    public int Value
    {
        get => value;
        set
        {
            var clamped = Math.Clamp(value, Minimum, Math.Max(Minimum, maximum));
            if (clamped == this.value)
            {
                return;
            }
            this.value = clamped;
            AccessibilityObject.Value = clamped.ToString(System.Globalization.CultureInfo.InvariantCulture);
            Invalidate();
            ValueChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    private float Thumb => 8 + ((Width - 16) * (maximum == Minimum ? 0 : (value - Minimum) / (float)(maximum - Minimum)));

    private int ValueAt(int x) => Minimum + (int)Math.Round((Math.Clamp(x, 8, Width - 8) - 8) / (float)Math.Max(1, Width - 16) * (maximum - Minimum));

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        Focus();
        Value = ValueAt(e.X);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (e.Button == MouseButtons.Left)
        {
            Value = ValueAt(e.X);
        }
    }

    protected override bool IsInputKey(Keys keyData) =>
        keyData is Keys.Left or Keys.Right or Keys.Up or Keys.Down or Keys.Home or Keys.End or Keys.PageUp or Keys.PageDown || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        Value = e.KeyCode switch
        {
            Keys.Left or Keys.Down => value - SmallChange,
            Keys.Right or Keys.Up => value + SmallChange,
            Keys.PageDown => value - LargeChange,
            Keys.PageUp => value + LargeChange,
            Keys.Home => Minimum,
            Keys.End => maximum,
            _ => value,
        };
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

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        SettingsPaint.Behind(this, g);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var cy = Height / 2f;
        var track = new RectangleF(8, cy - 2, Width - 16, 4);
        using (var shape = SettingsRows.Rounded(track, 2))
        using (var rail = new SolidBrush(DarkTheme.Border))
        {
            g.FillPath(rail, shape);
        }
        var thumb = Thumb;
        using (var done = SettingsRows.Rounded(new RectangleF(8, cy - 2, Math.Max(4, thumb - 8), 4), 2))
        using (var accent = new SolidBrush(DarkTheme.Accent))
        {
            g.FillPath(accent, done);
        }
        var knob = new RectangleF(thumb - 7, cy - 7, 14, 14);
        using (var white = new SolidBrush(DarkTheme.IsLight ? Color.White : DarkTheme.Text))
        {
            g.FillEllipse(white, knob);
        }
        using (var ring = new Pen(DarkTheme.Accent, 2f))
        {
            g.DrawEllipse(ring, knob);
        }
        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(Rectangle.Round(knob), 3, 3));
        }
    }
}

// A toggle pill (a check box): like the filter pills, on or off on its own.
internal sealed class SettingsTogglePill : CheckBox
{
    public SettingsTogglePill()
    {
        Appearance = Appearance.Button;
        AutoSize = false;
        Cursor = Cursors.Hand;
        UseMnemonic = false;
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
        Height = 26;
        Margin = new Padding(6, 0, 0, 0);
    }

    protected override void OnTextChanged(EventArgs e)
    {
        base.OnTextChanged(e);
        Width = TextRenderer.MeasureText(Text, Font).Width + 24;
    }

    protected override void OnPaint(PaintEventArgs pevent)
    {
        SettingsPaint.Behind(this, pevent.Graphics);
        SettingsPaint.Pill(pevent.Graphics, this, Checked);
    }

    protected override void OnCheckedChanged(EventArgs e)
    {
        base.OnCheckedChanged(e);
        Invalidate();
    }
}

// A text field: rounded, a hairline edge, the accent while typing in it.
// A borderless box with the frame drawn around it in its own non-client
// area, so it still hides, moves and sizes as one control. Framed false:
// for a box that sits in a rounded field of its own already.
internal sealed class SettingsField : TextBox
{
    private const int WmNcCalcSize = 0x0083;
    private const int WmNcPaint = 0x0085;
    private const int WmPrint = 0x0317;
    private const int PadX = 7;
    private const int PadY = 4;
    private bool framed = true;

    public SettingsField()
    {
        BorderStyle = BorderStyle.None;
        BackColor = DarkTheme.Panel;
        ForeColor = DarkTheme.Text;
        AutoSize = false;
        Height = 26;
        Margin = new Padding(3, 2, 3, 2);
    }

    internal bool Framed
    {
        get => framed;
        set
        {
            framed = value;
            RefreshFrame(SwpFrameChanged);
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Ask for the frame again, now with the padding below.
        RefreshFrame(SwpFrameChanged);
    }

    protected override void WndProc(ref Message m)
    {
        // The padding comes off first, so a multi-line box's scroll bar
        // sits inside the frame.
        if (m.Msg == WmNcCalcSize && m.WParam != IntPtr.Zero && framed)
        {
            var rect = Marshal.PtrToStructure<Rect>(m.LParam);
            rect.Left += PadX;
            rect.Right -= PadX;
            rect.Top += PadY;
            rect.Bottom -= PadY;
            Marshal.StructureToPtr(rect, m.LParam, false);
        }
        base.WndProc(ref m);
        if (!framed)
        {
            return;
        }
        if (m.Msg == WmNcPaint)
        {
            var dc = GetWindowDC(Handle);
            if (dc != IntPtr.Zero)
            {
                try
                {
                    using var g = Graphics.FromHdc(dc);
                    PaintFrame(g);
                }
                finally
                {
                    ReleaseDC(Handle, dc);
                }
            }
        }
        else if (m.Msg == WmPrint && (m.LParam.ToInt64() & 0x2) != 0) // PRF_NONCLIENT
        {
            using var g = Graphics.FromHdc(m.WParam);
            PaintFrame(g);
        }
    }

    // Only the band around the box: its typing area and scroll bar are its own.
    private void PaintFrame(Graphics g)
    {
        g.ExcludeClip(new Rectangle(PadX, PadY, Width - (2 * PadX), Height - (2 * PadY)));
        using (var surround = new SolidBrush(DarkTheme.IsGlass ? Color.FromArgb(240, 238, 246) : DarkTheme.Panel2))
        {
            g.FillRectangle(surround, 0, 0, Width, Height);
        }
        SettingsPaint.Field(g, new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Focused, Multiline ? 8 : 6);
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        RefreshFrame(0);
    }

    protected override void OnLostFocus(EventArgs e)
    {
        base.OnLostFocus(e);
        RefreshFrame(0);
    }

    private const uint SwpFrameChanged = 0x0020;

    // 0: just draw the frame again; SwpFrameChanged: measure it again too.
    private void RefreshFrame(uint flags)
    {
        if (!IsHandleCreated)
        {
            return;
        }
        if (flags != 0)
        {
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | flags);
        }
        RedrawWindow(Handle, IntPtr.Zero, IntPtr.Zero, 0x0400 | 0x0001); // RDW_FRAME | RDW_INVALIDATE
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindowDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("user32.dll")]
    private static extern bool RedrawWindow(IntPtr hWnd, IntPtr rect, IntPtr region, uint flags);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}

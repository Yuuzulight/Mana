using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1426 stage 2: the agreed Settings page -- titled sections of rows, each a
// name over a one-line explanation on the left and its control on the right.
internal static class SettingsRows
{
    // A group's one page: its sections and rows top to bottom, scrolling.
    internal static TabPage Page(string title, params Control[] parts)
    {
        var stack = new TableLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, ColumnCount = 1, Padding = new Padding(14, 2, 14, 14), BackColor = DarkTheme.Background };
        stack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (var part in parts)
        {
            part.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            stack.Controls.Add(part);
        }
        // Takes what's left, so the rows sit at the top.
        stack.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        stack.Controls.Add(new Panel { Height = 0, Margin = Padding.Empty });
        return new TabPage(title) { Controls = { stack } };
    }

    internal static Label Section(string title) =>
        new() { Text = title, AutoSize = true, ForeColor = DarkTheme.Muted, Margin = new Padding(2, 14, 2, 4), UseMnemonic = false };

    internal static Label Note(string text) =>
        new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Muted, Margin = new Padding(2, 2, 2, 4), UseMnemonic = false };

    // As wide as its longest option. into: a combo the page keeps as a field.
    internal static ComboBox Choice(string name, string[] options, int index, ComboBox? into = null)
    {
        var combo = into ?? new SettingsCombo();
        combo.AccessibleName = name;
        combo.Items.AddRange(options);
        combo.Width = Math.Max(150, options.Max(o => TextRenderer.MeasureText(o, combo.Font).Width) + 30);
        combo.SelectedIndex = Math.Clamp(index, 0, options.Length - 1);
        return combo;
    }

    internal static Button Action(string text, Action click)
    {
        var button = new SettingsButton { Text = text, AutoSize = true };
        button.Click += (_, _) => click();
        return button;
    }

    // Controls side by side, and parts stacked: for a row whose control is
    // more than one line, like a list over its box and buttons.
    internal static FlowLayoutPanel Line(params Control[] controls)
    {
        var line = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = Color.Transparent, Margin = new Padding(0, 4, 0, 0) };
        line.Controls.AddRange(controls);
        return line;
    }

    internal static FlowLayoutPanel Stack(params Control[] parts)
    {
        var stack = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Color.Transparent, Margin = Padding.Empty };
        stack.Controls.AddRange(parts);
        return stack;
    }

    internal static TextBox Box(string name, int width, string? placeholder = null) =>
        new SettingsField { Width = width, AccessibleName = name, PlaceholderText = placeholder ?? "" };

    internal static Label Words(string text) =>
        new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Muted, BackColor = Color.Transparent, Anchor = AnchorStyles.Left, UseMnemonic = false };

    // #1426: a rounded search box, as wide as given.
    internal static Control RoundField(TextBox box, int width)
    {
        box.BackColor = DarkTheme.Panel;
        box.ForeColor = DarkTheme.Text;
        var field = new RoundBox { Size = new Size(width, 26), Padding = new Padding(12, 5, 12, 0), Margin = Padding.Empty, Cursor = Cursors.IBeam, Fill = () => box.BackColor };
        box.BorderStyle = BorderStyle.None;
        field.Controls.Add(box);
        field.MouseDown += (_, _) => box.Focus();
        return field;
    }

    // #1426: a full-width rounded field with an icon at its start and a
    // round accent send button at its end, like the chat window's composer.
    // Enter sends too.
    internal static Control AskField(TextBox box, string glyph, Action send)
    {
        box.BorderStyle = BorderStyle.None;
        box.Dock = DockStyle.Fill;
        var field = new RoundBox { Height = 36, Padding = new Padding(10, 9, 4, 4), Margin = Padding.Empty, Cursor = Cursors.IBeam, Fill = () => box.BackColor };
        var icon = new Label { Text = glyph, Font = new Font("Segoe MDL2 Assets", 10f), ForeColor = DarkTheme.Muted, BackColor = Color.Transparent, Dock = DockStyle.Left, Width = 24, Padding = new Padding(0, 1, 0, 0) };
        var go = new SendButton { Dock = DockStyle.Right, AccessibleName = "Ask" };
        go.Click += (_, _) => send();
        field.Controls.Add(box);
        field.Controls.Add(icon);
        field.Controls.Add(go);
        field.MouseDown += (_, _) => box.Focus();
        icon.MouseDown += (_, _) => box.Focus();
        return field;
    }

    // #1426: a reply bubble: a small letter avatar beside a tinted rounded
    // panel holding the content.
    internal static Control Bubble(string letter, Control content)
    {
        var row = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, BackColor = Color.Transparent, Margin = new Padding(0, 8, 0, 0) };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var avatar = new Avatar { Letter = letter, Margin = new Padding(0, 2, 8, 0) };
        var bubble = new RoundBox { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(12, 10, 12, 10), Margin = Padding.Empty, Fill = () => Color.FromArgb(36, DarkTheme.Accent), Outline = false, Anchor = AnchorStyles.Left | AnchorStyles.Right };
        content.Margin = Padding.Empty;
        bubble.Controls.Add(content);
        row.Controls.Add(avatar, 0, 0);
        row.Controls.Add(bubble, 1, 0);
        return row;
    }

    // #1426: a list on a rounded panel a shade off the card, its edges kept clear.
    internal static Control RoundPanel(Control list)
    {
        var panel = new RoundBox { Height = list.Height + 8, Padding = new Padding(2, 4, 2, 4), Fill = () => DarkTheme.Panel, Outline = false };
        list.Dock = DockStyle.Fill;
        panel.Controls.Add(list);
        return panel;
    }

    // The one filled button in a group: the accent behind its words.
    internal static void MakePrimary(Button button)
    {
        if (button is SettingsButton drawn)
        {
            drawn.Primary = true;
            return;
        }
        button.BackColor = DarkTheme.Accent;
        button.ForeColor = DarkTheme.OnAccent;
        button.FlatAppearance.BorderColor = DarkTheme.Accent;
        button.FlatAppearance.MouseOverBackColor = ControlPaint.Light(DarkTheme.Accent, 0.1f);
    }

    internal static Label Status() => new() { AutoSize = true, MaximumSize = new Size(260, 0), ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left, BackColor = Color.Transparent, UseMnemonic = false };

    internal static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        var d = radius * 2;
        path.AddArc(r.Left, r.Top, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}

// One setting: its name and explanation on a rounded card, the control at
// the right. Search matches the name, explanation and keywords, and points
// at the row itself.
internal sealed class SettingsRow : TableLayoutPanel
{
    private bool highlighted;

    internal SettingsRow(string name, string? explanation, string keywords, params Control[] controls)
        : this(name, explanation, keywords, below: false, controls)
    {
    }

    // below: the controls go under the name and explanation, the row's full
    // width -- for a list or an editor too wide for the right-hand side.
    internal SettingsRow(string name, string? explanation, string keywords, bool below, params Control[] controls)
    {
        Title = name;
        SearchText = $"{name} {explanation} {keywords}";
        AccessibleName = name;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        ColumnCount = 2;
        Padding = new Padding(10, 7, 8, 7);
        Margin = new Padding(0, 0, 0, 4);
        BackColor = DarkTheme.Background;
        DoubleBuffered = true;
        ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        // The name and explanation keep to the top; a tall control's extra
        // height goes to the empty row under them.
        RowStyles.Add(new RowStyle(SizeType.AutoSize));
        RowStyles.Add(new RowStyle(SizeType.AutoSize));
        RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        Controls.Add(new Label { Text = name, AutoSize = true, Anchor = AnchorStyles.Left | AnchorStyles.Right, ForeColor = DarkTheme.Text, BackColor = Color.Transparent, Margin = new Padding(0, 1, 8, 0), UseMnemonic = false }, 0, 0);
        if (explanation is not null)
        {
            Controls.Add(Explanation = new Label { Text = explanation, AutoSize = true, Anchor = AnchorStyles.Left | AnchorStyles.Right, ForeColor = DarkTheme.Muted, BackColor = Color.Transparent, Margin = new Padding(0, 1, 8, 1), UseMnemonic = false }, 0, 1);
        }
        if (below)
        {
            foreach (Control words in Controls)
            {
                SetColumnSpan(words, 2);
            }
            var at = 2;
            foreach (var control in controls)
            {
                control.Anchor = AnchorStyles.Left | AnchorStyles.Right;
                control.Margin = new Padding(0, 6, 0, 0);
                Controls.Add(control, 0, at++);
                SetColumnSpan(control, 2);
            }
            return;
        }
        var right = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Anchor = AnchorStyles.Right, BackColor = Color.Transparent, Margin = Padding.Empty };
        foreach (var control in controls)
        {
            control.Anchor = AnchorStyles.Left;
            right.Controls.Add(control);
        }
        Controls.Add(right, 1, 0);
        SetRowSpan(right, 3);
    }

    internal string Title { get; }

    // The line under the name, for a row that reports progress in it.
    internal Label? Explanation { get; }

    internal string SearchText { get; }

    // A search result opening it: an accent ring for a moment.
    internal void Flash()
    {
        highlighted = true;
        Invalidate();
        var timer = new System.Windows.Forms.Timer { Interval = 1500 };
        timer.Tick += (_, _) =>
        {
            timer.Dispose();
            highlighted = false;
            if (!IsDisposed)
            {
                Invalidate();
            }
        };
        timer.Start();
    }

    internal bool Highlighted => highlighted; // tests

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var g = e.Graphics;
        if (DarkTheme.IsGlass)
        {
            GlassSurface.PaintGlowBehind(g, this, ClientRectangle);
        }
        else
        {
            using var back = new SolidBrush(DarkTheme.Background);
            g.FillRectangle(back, ClientRectangle);
        }
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var card = SettingsRows.Rounded(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 6);
        using (var fill = new SolidBrush(DarkTheme.IsGlass ? Color.FromArgb(150, 255, 255, 255) : DarkTheme.Panel2))
        {
            g.FillPath(fill, card);
        }
        if (highlighted)
        {
            using var ring = new Pen(DarkTheme.Accent, 2f);
            g.DrawPath(ring, card);
        }
    }

    protected override void OnResize(EventArgs eventargs)
    {
        base.OnResize(eventargs);
        Invalidate();
    }
}

// An on/off switch: a CheckBox (so Space, screen readers and tests treat it
// as one) drawn as a pill with a knob, accent while on.
internal sealed class SettingsSwitch : CheckBox
{
    public SettingsSwitch()
    {
        AutoSize = false;
        Size = new Size(36, 22);
        Cursor = Cursors.Hand;
        Margin = new Padding(6, 0, 0, 0);
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        // The card behind, through the transparent flow it sits in.
        if (Parent is not null)
        {
            var state = g.Save();
            g.TranslateTransform(-Left, -Top);
            InvokePaintBackground(Parent, new PaintEventArgs(g, new Rectangle(Location, Size)));
            g.Restore(state);
        }
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var track = new RectangleF(1, (Height - 18) / 2f, 32, 18);
        using (var path = SettingsRows.Rounded(track, 9))
        using (var fill = new SolidBrush(Checked ? DarkTheme.Accent : DarkTheme.Border))
        {
            g.FillPath(fill, path);
        }
        var knob = new RectangleF(Checked ? track.Right - 16 : track.Left + 2, track.Top + 2, 14, 14);
        using (var white = new SolidBrush(Checked ? DarkTheme.OnAccent : DarkTheme.Text))
        {
            g.FillEllipse(white, knob);
        }
        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(Rectangle.Round(track), 2, 2));
        }
    }

    protected override void OnCheckedChanged(EventArgs e)
    {
        base.OnCheckedChanged(e);
        Invalidate();
    }
}

// #1426: a filter pill (one of a group, like a radio button): outlined,
// tinted with the accent while picked.
internal sealed class SettingsPill : RadioButton
{
    public SettingsPill()
    {
        Appearance = Appearance.Button;
        AutoSize = false;
        Cursor = Cursors.Hand;
        UseMnemonic = false;
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
        Height = 26;
    }

    protected override void OnTextChanged(EventArgs e)
    {
        base.OnTextChanged(e);
        Width = TextRenderer.MeasureText(Text, Font).Width + 24;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        SettingsPaint.Behind(this, e.Graphics);
        SettingsPaint.Pill(e.Graphics, this, Checked);
    }

    protected override void OnCheckedChanged(EventArgs e)
    {
        base.OnCheckedChanged(e);
        Invalidate();
    }
}

// #1426: the vault line's dot: green while the sync works, red when it
// failed, grey when it's off.
internal sealed class VaultDot : Control
{
    private Color color = DarkTheme.Muted;

    public VaultDot()
    {
        Size = new Size(14, 20);
        Margin = new Padding(0, 1, 2, 0);
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
        AccessibleRole = AccessibleRole.Graphic;
    }

    internal Color Color
    {
        get => color;
        set
        {
            color = value;
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var fill = new SolidBrush(color);
        e.Graphics.FillEllipse(fill, 3, (Height - 8) / 2f, 8, 8);
    }
}

// A rounded panel: its fill, and an outline unless told not to.
internal sealed class RoundBox : Panel
{
    internal Func<Color> Fill { get; init; } = () => DarkTheme.Panel;
    internal bool Outline { get; init; } = true;

    public RoundBox()
    {
        DoubleBuffered = true;
        SetStyle(ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        base.OnPaintBackground(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
        using var shape = SettingsRows.Rounded(bounds, Math.Min(bounds.Height / 2, 10));
        using (var fill = new SolidBrush(Fill()))
        {
            g.FillPath(fill, shape);
        }
        if (Outline)
        {
            using var edge = new Pen(DarkTheme.Border);
            g.DrawPath(edge, shape);
        }
    }
}

// The send button inside an AskField: an up arrow on an accent circle.
internal sealed class SendButton : Button
{
    public SendButton()
    {
        Width = 28;
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        Cursor = Cursors.Hand;
        SetStyle(ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        if (Parent is not null)
        {
            var state = g.Save();
            g.TranslateTransform(-Left, -Top);
            InvokePaintBackground(Parent, new PaintEventArgs(g, new Rectangle(Location, Size)));
            g.Restore(state);
        }
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var d = Math.Min(Width, Height) - 2;
        var circle = new RectangleF((Width - d) / 2f, (Height - d) / 2f, d, d);
        using (var fill = new SolidBrush(DarkTheme.Accent))
        {
            g.FillEllipse(fill, circle);
        }
        var cx = circle.X + (circle.Width / 2);
        var cy = circle.Y + (circle.Height / 2);
        using var pen = new Pen(DarkTheme.OnAccent, 1.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        g.DrawLine(pen, cx, cy + 5, cx, cy - 5);
        g.DrawLines(pen, new[] { new PointF(cx - 4, cy - 1), new PointF(cx, cy - 5), new PointF(cx + 4, cy - 1) });
        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Round(circle));
        }
    }
}

// A small letter avatar on an accent circle.
internal sealed class Avatar : Control
{
    private readonly Font letterFont = new("Segoe UI Semibold", 9.5f);

    internal string Letter { get; init; } = "M";

    public Avatar()
    {
        Size = new Size(26, 26);
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
        AccessibleRole = AccessibleRole.Graphic;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var fill = new SolidBrush(DarkTheme.Accent);
        e.Graphics.FillEllipse(fill, 0, 0, Width - 1, Height - 1);
        TextRenderer.DrawText(e.Graphics, Letter, letterFont, ClientRectangle, DarkTheme.OnAccent, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            letterFont.Dispose();
        }
        base.Dispose(disposing);
    }
}

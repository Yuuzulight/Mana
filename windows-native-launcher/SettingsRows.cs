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
        var combo = into ?? new ComboBox();
        combo.DropDownStyle = ComboBoxStyle.DropDownList;
        combo.BackColor = DarkTheme.Panel;
        combo.ForeColor = DarkTheme.Text;
        combo.AccessibleName = name;
        combo.Items.AddRange(options);
        combo.Width = Math.Max(150, options.Max(o => TextRenderer.MeasureText(o, combo.Font).Width) + 30);
        combo.SelectedIndex = Math.Clamp(index, 0, options.Length - 1);
        return combo;
    }

    internal static Button Action(string text, Action click)
    {
        var button = new Button { Text = text, AutoSize = true, UseMnemonic = false };
        DarkTheme.ApplyButton(button);
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

    internal static FlowLayoutPanel Editor(ListBox list, params Control[] line) => Stack(list, Line(line));

    internal static ListBox List(string name, int height = 80) =>
        new() { Width = 340, Height = height, AccessibleName = name, BackColor = DarkTheme.Panel, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };

    internal static TextBox Box(string name, int width, string? placeholder = null) =>
        new() { Width = width, AccessibleName = name, PlaceholderText = placeholder ?? "", BackColor = DarkTheme.Panel, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };

    internal static Label Words(string text) =>
        new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Muted, BackColor = Color.Transparent, Anchor = AnchorStyles.Left, UseMnemonic = false };

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

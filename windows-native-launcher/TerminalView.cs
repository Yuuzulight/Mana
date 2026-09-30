using System;
using System.Drawing;
using System.Text;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1121 "My shell": draws a VtScreen and turns my keys into the VT input a
// pseudo-console expects. Mouse wheel scrolls back; a drag selects;
// Ctrl+C copies when there's a selection (otherwise it's the shell's
// Ctrl+C), Ctrl+V / Ctrl+Shift+V / a right-click paste. The owner sends
// Input to the shell and resizes it on Resized.
internal sealed class TerminalView : Control
{
    private readonly VtScreen screen;
    private Size cell;
    private int scrolledBack;
    // Selection ends as (line, column), lines counted like VtScreen.Line.
    private (int Line, int Col)? anchor;
    private (int Line, int Col) caret;

    public event Action<string>? Input;
    public event Action<int, int>? Resized;
    public event Action? SelectionChanged;

    public TerminalView(VtScreen screen)
    {
        this.screen = screen;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.Selectable, true);
        TabStop = true;
        Font = new Font("Consolas", 10F);
        BackColor = Color.FromArgb(0x0C0C0C);
        ForeColor = Color.FromArgb(0xCCCCCC);
        AccessibleName = "My shell";
        AccessibleRole = AccessibleRole.Text;
        MeasureCell();
    }

    public bool HasSelection => anchor is { } a && a != caret;

    // The selected text, lines joined with CRLF and trailing blanks trimmed.
    public string SelectedText
    {
        get
        {
            if (anchor is not { } a || a == caret)
            {
                return "";
            }
            var (start, end) = Order(a, caret);
            var text = new StringBuilder();
            for (var line = start.Line; line <= end.Line; line++)
            {
                var content = screen.LineText(line);
                var from = line == start.Line ? Math.Min(start.Col, content.Length) : 0;
                var to = line == end.Line ? Math.Min(end.Col, content.Length) : content.Length;
                text.Append(content, from, Math.Max(0, to - from));
                if (line < end.Line)
                {
                    text.Append("\r\n");
                }
            }
            return text.ToString();
        }
    }

    // New output: redraw (the scrollback may have grown under a scrolled-back view).
    public void OutputArrived()
    {
        scrolledBack = Math.Min(scrolledBack, screen.ScrollbackCount);
        Invalidate();
    }

    public void ClearSelection()
    {
        anchor = null;
        SelectionChanged?.Invoke();
        Invalidate();
    }

    protected override void OnFontChanged(EventArgs e)
    {
        base.OnFontChanged(e);
        MeasureCell();
    }

    private void MeasureCell()
    {
        var size = TextRenderer.MeasureText("W", Font, Size.Empty, TextFormatFlags.NoPadding);
        cell = new Size(Math.Max(1, size.Width), Math.Max(1, Font.Height));
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        var columns = Math.Max(1, ClientSize.Width / cell.Width);
        var rows = Math.Max(1, ClientSize.Height / cell.Height);
        if (columns != screen.Columns || rows != screen.Rows)
        {
            screen.Resize(columns, rows);
            Resized?.Invoke(columns, rows);
        }
        Invalidate();
    }

    private int FirstVisibleLine => screen.ScrollbackCount - scrolledBack;

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(BackColor);
        ((int Line, int Col)? Start, (int Line, int Col)? End) selection = (null, null);
        if (anchor is { } a && a != caret)
        {
            var (start, end) = Order(a, caret);
            selection = (start, end);
        }
        for (var row = 0; row < screen.Rows; row++)
        {
            var lineIndex = FirstVisibleLine + row;
            var line = screen.Line(lineIndex);
            var y = row * cell.Height;
            var col = 0;
            while (col < line.Length)
            {
                // A run of cells that draw alike.
                var (fore, back, bold, underline) = Colors(line[col], IsSelected(selection, lineIndex, col));
                var end = col + 1;
                while (end < line.Length && Colors(line[end], IsSelected(selection, lineIndex, end)) == (fore, back, bold, underline))
                {
                    end++;
                }
                var bounds = new Rectangle(col * cell.Width, y, (end - col) * cell.Width, cell.Height);
                if (back != BackColor)
                {
                    using var brush = new SolidBrush(back);
                    g.FillRectangle(brush, bounds);
                }
                var text = new char[end - col];
                for (var i = col; i < end; i++)
                {
                    text[i - col] = line[i].Ch == '\0' ? ' ' : line[i].Ch;
                }
                var style = (bold ? FontStyle.Bold : FontStyle.Regular) | (underline ? FontStyle.Underline : FontStyle.Regular);
                if (style == FontStyle.Regular)
                {
                    TextRenderer.DrawText(g, new string(text), Font, bounds.Location, fore, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                }
                else
                {
                    using var font = new Font(Font, style);
                    TextRenderer.DrawText(g, new string(text), font, bounds.Location, fore, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                }
                col = end;
            }
        }

        var cursorRow = screen.CursorRow + scrolledBack;
        if (screen.CursorVisible && cursorRow < screen.Rows)
        {
            var bounds = new Rectangle(screen.CursorCol * cell.Width, cursorRow * cell.Height, cell.Width, cell.Height);
            using var pen = new Pen(ForeColor);
            if (Focused)
            {
                using var brush = new SolidBrush(Color.FromArgb(160, ForeColor));
                g.FillRectangle(brush, bounds);
            }
            else
            {
                g.DrawRectangle(pen, bounds.X, bounds.Y, bounds.Width - 1, bounds.Height - 1);
            }
        }
    }

    private (Color Fore, Color Back, bool Bold, bool Underline) Colors(VtScreen.Cell c, bool selected)
    {
        var fore = c.Fg < 0 ? ForeColor : Color.FromArgb(c.Fg | unchecked((int)0xFF000000));
        var back = c.Bg < 0 ? BackColor : Color.FromArgb(c.Bg | unchecked((int)0xFF000000));
        if (c.Flags.HasFlag(VtScreen.CellFlags.Inverse) != selected)
        {
            (fore, back) = (back, fore);
        }
        return (fore, back, c.Flags.HasFlag(VtScreen.CellFlags.Bold), c.Flags.HasFlag(VtScreen.CellFlags.Underline));
    }

    private static bool IsSelected(((int Line, int Col)? Start, (int Line, int Col)? End) selection, int line, int col) =>
        selection.Start is { } s && selection.End is { } e
        && (line > s.Line || (line == s.Line && col >= s.Col))
        && (line < e.Line || (line == e.Line && col < e.Col));

    private static ((int Line, int Col), (int Line, int Col)) Order((int Line, int Col) a, (int Line, int Col) b) =>
        a.Line < b.Line || (a.Line == b.Line && a.Col <= b.Col) ? (a, b) : (b, a);

    private (int Line, int Col) HitTest(Point p) =>
        (FirstVisibleLine + Math.Clamp(p.Y / cell.Height, 0, screen.Rows - 1), Math.Clamp((p.X + cell.Width / 2) / cell.Width, 0, screen.Columns));

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        Focus();
        if (e.Button == MouseButtons.Left)
        {
            anchor = caret = HitTest(e.Location);
            Invalidate();
        }
        else if (e.Button == MouseButtons.Right)
        {
            // Like the Windows console: copy a selection, else paste.
            if (HasSelection)
            {
                Copy();
            }
            else
            {
                Paste();
            }
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (e.Button == MouseButtons.Left && anchor is not null)
        {
            caret = HitTest(e.Location);
            Invalidate();
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button == MouseButtons.Left)
        {
            SelectionChanged?.Invoke();
        }
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        scrolledBack = Math.Clamp(scrolledBack + Math.Sign(e.Delta) * 3, 0, screen.ScrollbackCount);
        Invalidate();
    }

    protected override bool IsInputKey(Keys keyData) => true;

    // Esc belongs to the shell here, not to the tool panel (which closes on
    // Esc elsewhere).
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Escape)
        {
            Send("\x1b");
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        var ctrl = e.Control;
        if (ctrl && e.KeyCode == Keys.C && (HasSelection || e.Shift))
        {
            Copy();
        }
        else if (ctrl && e.KeyCode == Keys.V)
        {
            Paste();
        }
        else if (KeySequence(e.KeyCode, ctrl, e.Shift, screen.ApplicationCursorKeys) is { } sequence)
        {
            Send(sequence);
        }
        else
        {
            return;
        }
        e.Handled = true;
        e.SuppressKeyPress = true;
    }

    protected override void OnKeyPress(KeyPressEventArgs e)
    {
        base.OnKeyPress(e);
        // Backspace is DEL to a VT shell; the rest (Ctrl+C is \x03) as typed.
        Send(e.KeyChar == '\b' ? "\x7f" : e.KeyChar.ToString());
        e.Handled = true;
    }

    // Keys that don't produce a character.
    internal static string? KeySequence(Keys key, bool ctrl, bool shift, bool applicationCursorKeys)
    {
        var modifier = ctrl && shift ? 6 : ctrl ? 5 : shift ? 2 : 1;
        string Cursor(char final) =>
            modifier > 1 ? $"\x1b[1;{modifier}{final}" : applicationCursorKeys ? $"\x1bO{final}" : $"\x1b[{final}";
        return key switch
        {
            Keys.Up => Cursor('A'),
            Keys.Down => Cursor('B'),
            Keys.Right => Cursor('C'),
            Keys.Left => Cursor('D'),
            Keys.Home => Cursor('H'),
            Keys.End => Cursor('F'),
            Keys.Insert => "\x1b[2~",
            Keys.Delete => "\x1b[3~",
            Keys.PageUp => "\x1b[5~",
            Keys.PageDown => "\x1b[6~",
            Keys.F1 => "\x1bOP",
            Keys.F2 => "\x1bOQ",
            Keys.F3 => "\x1bOR",
            Keys.F4 => "\x1bOS",
            Keys.F5 => "\x1b[15~",
            Keys.F6 => "\x1b[17~",
            Keys.F7 => "\x1b[18~",
            Keys.F8 => "\x1b[19~",
            Keys.F9 => "\x1b[20~",
            Keys.F10 => "\x1b[21~",
            Keys.F11 => "\x1b[23~",
            Keys.F12 => "\x1b[24~",
            Keys.Tab when shift => "\x1b[Z",
            _ => null,
        };
    }

    private void Send(string text)
    {
        scrolledBack = 0;
        if (anchor is not null)
        {
            ClearSelection();
        }
        Input?.Invoke(text);
    }

    private void Copy()
    {
        var text = SelectedText;
        if (text.Length > 0)
        {
            Clipboard.SetText(text);
        }
        ClearSelection();
    }

    private void Paste()
    {
        if (Clipboard.ContainsText())
        {
            // A shell takes Enter as CR.
            Send(Clipboard.GetText().Replace("\r\n", "\r").Replace('\n', '\r'));
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Font.Dispose();
        }
        base.Dispose(disposing);
    }
}

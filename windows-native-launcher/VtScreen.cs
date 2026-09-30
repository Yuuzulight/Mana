using System;
using System.Collections.Generic;
using System.Text;

namespace Mana.NativeLauncher;

// #1121 "My shell": the screen a pseudo-console's VT output draws on -- a
// grid of cells, a cursor and a scrollback. Scoped to what ConPTY and the
// usual shells send:
// - SGR: bold, underline, inverse; 16, 256 and truecolor fore/background.
// - Cursor movement (CUU/CUD/CUF/CUB/CNL/CPL/CHA/CUP/HVP/VPA), save/restore.
// - Erase in line/screen (EL/ED, ED 3 clears the scrollback), ECH, ICH,
//   DCH, IL, DL, SU, SD, the scroll region (DECSTBM), index/reverse index.
// - The alternate screen (?1049/?1047/?47), cursor visibility (?25),
//   application cursor keys (?1), and a reply to cursor-position (6n) and
//   device-attributes (c) queries.
// Not supported: wide (CJK/emoji) characters take one cell, no reflow on
// resize (ConPTY redraws the screen anyway), no mouse reporting, no
// bracketed paste, OSC titles and DCS strings are read and dropped,
// italic/dim/blink/strikethrough are ignored.
internal sealed class VtScreen
{
    public const int ScrollbackLimit = 5000;

    [Flags]
    public enum CellFlags : byte
    {
        None = 0,
        Bold = 1,
        Underline = 2,
        Inverse = 4,
    }

    // Colours are 0xRRGGBB; -1 is the default fore/background.
    public struct Cell
    {
        public char Ch;
        public int Fg;
        public int Bg;
        public CellFlags Flags;
    }

    private enum State { Ground, Escape, EscapeCharset, Csi, Osc, OscEscape, Dcs, DcsEscape }

    private readonly List<Cell[]> scrollback = new();
    private Cell[][] main;
    private Cell[][]? alt;
    private State state;
    private readonly StringBuilder csi = new();
    private int fg = -1;
    private int bg = -1;
    private CellFlags flags;
    private bool wrapPending;
    private int top;
    private int bottom;
    private (int Row, int Col, int Fg, int Bg, CellFlags Flags) saved;
    private (int Row, int Col) mainCursor;

    public VtScreen(int columns, int rows)
    {
        Columns = Math.Max(1, columns);
        Rows = Math.Max(1, rows);
        main = Blank(Rows);
        bottom = Rows - 1;
    }

    public int Columns { get; private set; }
    public int Rows { get; private set; }
    public int CursorRow { get; private set; }
    public int CursorCol { get; private set; }
    public bool CursorVisible { get; private set; } = true;
    public bool ApplicationCursorKeys { get; private set; }
    public bool AltScreen => alt is not null;
    public int ScrollbackCount => scrollback.Count;

    // Replies the shell asked for (cursor position, device attributes); the
    // owner writes them back to the pseudo-console.
    public event Action<string>? Reply;

    private Cell[][] Screen => alt ?? main;

    // A line counting from the oldest scrollback line: 0..ScrollbackCount-1
    // are scrollback, then the screen's rows.
    public Cell[] Line(int index) =>
        index < scrollback.Count ? scrollback[index] : Screen[Math.Clamp(index - scrollback.Count, 0, Rows - 1)];

    public string LineText(int index)
    {
        var line = Line(index);
        var chars = new char[line.Length];
        for (var i = 0; i < line.Length; i++)
        {
            chars[i] = line[i].Ch == '\0' ? ' ' : line[i].Ch;
        }
        return new string(chars).TrimEnd();
    }

    public void Feed(string text)
    {
        foreach (var ch in text)
        {
            Step(ch);
        }
    }

    public void Resize(int columns, int rows)
    {
        columns = Math.Max(1, columns);
        rows = Math.Max(1, rows);
        if (columns == Columns && rows == Rows)
        {
            return;
        }
        // Rows cut off the top of the main screen go to the scrollback,
        // keeping the cursor's row on screen.
        var cut = Math.Max(0, CursorRow - (rows - 1));
        for (var i = 0; i < cut && alt is null; i++)
        {
            PushScrollback(main[i]);
        }
        main = Refit(main, cut, columns, rows);
        if (alt is not null)
        {
            alt = Refit(alt, cut, columns, rows);
        }
        Columns = columns;
        Rows = rows;
        CursorRow = Math.Clamp(CursorRow - cut, 0, rows - 1);
        CursorCol = Math.Clamp(CursorCol, 0, columns - 1);
        top = 0;
        bottom = rows - 1;
        wrapPending = false;
    }

    private Cell[][] Refit(Cell[][] screen, int skip, int columns, int rows)
    {
        var next = new Cell[rows][];
        for (var r = 0; r < rows; r++)
        {
            next[r] = BlankLine(columns);
            if (r + skip < screen.Length)
            {
                Array.Copy(screen[r + skip], next[r], Math.Min(columns, screen[r + skip].Length));
            }
        }
        return next;
    }

    private void Step(char ch)
    {
        switch (state)
        {
            case State.Ground:
                if (ch == '\x1b')
                {
                    state = State.Escape;
                }
                else if (ch < ' ' || ch == '\x7f')
                {
                    Control(ch);
                }
                else
                {
                    Print(ch);
                }
                break;
            case State.Escape:
                Escape(ch);
                break;
            case State.EscapeCharset:
                state = State.Ground; // ESC ( B and the like: the charset is ignored
                break;
            case State.Csi:
                if (ch >= '@' && ch <= '~')
                {
                    state = State.Ground;
                    Csi(ch, csi.ToString());
                }
                else if (ch == '\x1b')
                {
                    state = State.Escape;
                }
                else if (csi.Length < 256)
                {
                    csi.Append(ch);
                }
                break;
            case State.Osc:
                state = ch == '\a' ? State.Ground : ch == '\x1b' ? State.OscEscape : State.Osc;
                break;
            case State.OscEscape:
            case State.DcsEscape:
                state = ch == '\\' ? State.Ground : state == State.OscEscape ? State.Osc : State.Dcs;
                break;
            case State.Dcs:
                state = ch == '\x1b' ? State.DcsEscape : State.Dcs;
                break;
        }
    }

    private void Control(char ch)
    {
        switch (ch)
        {
            case '\r':
                CursorCol = 0;
                wrapPending = false;
                break;
            case '\n':
            case '\v':
            case '\f':
                LineFeed();
                break;
            case '\b':
                CursorCol = Math.Max(0, CursorCol - 1);
                wrapPending = false;
                break;
            case '\t':
                CursorCol = Math.Min(Columns - 1, (CursorCol / 8 + 1) * 8);
                break;
        }
    }

    private void Escape(char ch)
    {
        state = State.Ground;
        switch (ch)
        {
            case '[':
                csi.Clear();
                state = State.Csi;
                break;
            case ']':
                state = State.Osc;
                break;
            case 'P':
                state = State.Dcs;
                break;
            case '(':
            case ')':
            case '*':
            case '+':
                state = State.EscapeCharset;
                break;
            case '7':
                SaveCursor();
                break;
            case '8':
                RestoreCursor();
                break;
            case 'D':
                LineFeed();
                break;
            case 'E':
                CursorCol = 0;
                LineFeed();
                break;
            case 'M':
                ReverseIndex();
                break;
            case 'c':
                Reset();
                break;
        }
    }

    private void Csi(char final, string body)
    {
        var isPrivate = body.StartsWith('?');
        var p = Params(isPrivate ? body[1..] : body);
        int P(int i, int fallback = 1) => i < p.Count && p[i] > 0 ? p[i] : fallback;
        wrapPending = false;
        switch (final)
        {
            case 'A': CursorRow = Math.Max(CursorRow < top ? 0 : top, CursorRow - P(0)); break;
            case 'B': CursorRow = Math.Min(CursorRow > bottom ? Rows - 1 : bottom, CursorRow + P(0)); break;
            case 'C': CursorCol = Math.Min(Columns - 1, CursorCol + P(0)); break;
            case 'D': CursorCol = Math.Max(0, CursorCol - P(0)); break;
            case 'E': CursorRow = Math.Min(Rows - 1, CursorRow + P(0)); CursorCol = 0; break;
            case 'F': CursorRow = Math.Max(0, CursorRow - P(0)); CursorCol = 0; break;
            case 'G': CursorCol = Math.Clamp(P(0) - 1, 0, Columns - 1); break;
            case 'd': CursorRow = Math.Clamp(P(0) - 1, 0, Rows - 1); break;
            case 'H':
            case 'f':
                CursorRow = Math.Clamp(P(0) - 1, 0, Rows - 1);
                CursorCol = Math.Clamp(P(1) - 1, 0, Columns - 1);
                break;
            case 'J': EraseDisplay(P(0, 0)); break;
            case 'K': EraseLine(P(0, 0)); break;
            case 'X': Fill(CursorRow, CursorCol, Math.Min(Columns, CursorCol + P(0))); break;
            case '@': InsertChars(P(0)); break;
            case 'P': DeleteChars(P(0)); break;
            case 'L': if (CursorRow >= top && CursorRow <= bottom) ScrollDown(CursorRow, P(0)); break;
            case 'M': if (CursorRow >= top && CursorRow <= bottom) ScrollUp(CursorRow, P(0)); break;
            case 'S': ScrollUp(top, P(0)); break;
            case 'T': ScrollDown(top, P(0)); break;
            case 'm': Sgr(p); break;
            case 'r':
                var newTop = P(0) - 1;
                var newBottom = Math.Min(Rows, P(1, Rows)) - 1;
                if (newTop < newBottom)
                {
                    top = newTop;
                    bottom = newBottom;
                    CursorRow = 0;
                    CursorCol = 0;
                }
                break;
            case 's': SaveCursor(); break;
            case 'u': RestoreCursor(); break;
            case 'n':
                if (P(0, 0) == 6)
                {
                    Reply?.Invoke($"\x1b[{CursorRow + 1};{CursorCol + 1}R");
                }
                break;
            case 'c':
                if (!isPrivate && !body.StartsWith('>'))
                {
                    Reply?.Invoke("\x1b[?1;0c");
                }
                break;
            case 'h':
            case 'l':
                if (isPrivate)
                {
                    foreach (var mode in p)
                    {
                        SetMode(mode, final == 'h');
                    }
                }
                break;
        }
    }

    private static List<int> Params(string body)
    {
        var list = new List<int>();
        foreach (var part in body.Split(';', ':'))
        {
            list.Add(int.TryParse(part, out var n) ? Math.Min(n, 9999) : 0);
        }
        return list;
    }

    private void SetMode(int mode, bool on)
    {
        switch (mode)
        {
            case 1:
                ApplicationCursorKeys = on;
                break;
            case 25:
                CursorVisible = on;
                break;
            case 47:
            case 1047:
            case 1049:
                if (on && alt is null)
                {
                    mainCursor = (CursorRow, CursorCol);
                    alt = Blank(Rows);
                }
                else if (!on && alt is not null)
                {
                    alt = null;
                    (CursorRow, CursorCol) = mainCursor;
                }
                break;
        }
    }

    private void Sgr(List<int> p)
    {
        for (var i = 0; i < p.Count; i++)
        {
            var n = p[i];
            switch (n)
            {
                case 0: fg = -1; bg = -1; flags = CellFlags.None; break;
                case 1: flags |= CellFlags.Bold; break;
                case 4: flags |= CellFlags.Underline; break;
                case 7: flags |= CellFlags.Inverse; break;
                case 22: flags &= ~CellFlags.Bold; break;
                case 24: flags &= ~CellFlags.Underline; break;
                case 27: flags &= ~CellFlags.Inverse; break;
                case >= 30 and <= 37: fg = Palette[n - 30]; break;
                case 39: fg = -1; break;
                case >= 40 and <= 47: bg = Palette[n - 40]; break;
                case 49: bg = -1; break;
                case >= 90 and <= 97: fg = Palette[n - 90 + 8]; break;
                case >= 100 and <= 107: bg = Palette[n - 100 + 8]; break;
                case 38:
                case 48:
                    var color = ExtendedColor(p, ref i);
                    if (color is int c)
                    {
                        if (n == 38) fg = c; else bg = c;
                    }
                    break;
            }
        }
    }

    // 38;5;n or 38;2;r;g;b (and the same after 48).
    private static int? ExtendedColor(List<int> p, ref int i)
    {
        if (i + 2 < p.Count && p[i + 1] == 5)
        {
            i += 2;
            return Color256(p[i]);
        }
        if (i + 4 < p.Count && p[i + 1] == 2)
        {
            var rgb = (Math.Clamp(p[i + 2], 0, 255) << 16) | (Math.Clamp(p[i + 3], 0, 255) << 8) | Math.Clamp(p[i + 4], 0, 255);
            i += 4;
            return rgb;
        }
        i = p.Count;
        return null;
    }

    // The 16 base colours (Windows Terminal's Campbell scheme).
    internal static readonly int[] Palette =
    [
        0x0C0C0C, 0xC50F1F, 0x13A10E, 0xC19C00, 0x0037DA, 0x881798, 0x3A96DD, 0xCCCCCC,
        0x767676, 0xE74856, 0x16C60C, 0xF9F1A5, 0x3B78FF, 0xB4009E, 0x61D6D6, 0xF2F2F2,
    ];

    internal static int Color256(int n)
    {
        n = Math.Clamp(n, 0, 255);
        if (n < 16)
        {
            return Palette[n];
        }
        if (n < 232)
        {
            n -= 16;
            static int Level(int v) => v == 0 ? 0 : 55 + v * 40;
            return (Level(n / 36) << 16) | (Level(n / 6 % 6) << 8) | Level(n % 6);
        }
        var gray = 8 + (n - 232) * 10;
        return (gray << 16) | (gray << 8) | gray;
    }

    private void Print(char ch)
    {
        if (wrapPending)
        {
            CursorCol = 0;
            LineFeed();
        }
        var line = Screen[CursorRow];
        line[CursorCol] = new Cell { Ch = ch, Fg = fg, Bg = bg, Flags = flags };
        if (CursorCol == Columns - 1)
        {
            wrapPending = true;
        }
        else
        {
            CursorCol++;
        }
    }

    private void LineFeed()
    {
        wrapPending = false;
        if (CursorRow == bottom)
        {
            ScrollUp(top, 1);
        }
        else if (CursorRow < Rows - 1)
        {
            CursorRow++;
        }
    }

    private void ReverseIndex()
    {
        if (CursorRow == top)
        {
            ScrollDown(top, 1);
        }
        else if (CursorRow > 0)
        {
            CursorRow--;
        }
    }

    // Lines from..bottom move up n; the top ones leave (into the scrollback
    // when the whole main screen scrolls).
    private void ScrollUp(int from, int n)
    {
        var screen = Screen;
        n = Math.Min(n, bottom - from + 1);
        for (var i = 0; i < n; i++)
        {
            if (alt is null && from == 0 && bottom == Rows - 1)
            {
                PushScrollback(screen[from]);
            }
            for (var r = from; r < bottom; r++)
            {
                screen[r] = screen[r + 1];
            }
            screen[bottom] = BlankLine(Columns, bg);
        }
    }

    private void ScrollDown(int from, int n)
    {
        var screen = Screen;
        n = Math.Min(n, bottom - from + 1);
        for (var i = 0; i < n; i++)
        {
            for (var r = bottom; r > from; r--)
            {
                screen[r] = screen[r - 1];
            }
            screen[from] = BlankLine(Columns, bg);
        }
    }

    private void PushScrollback(Cell[] line)
    {
        scrollback.Add(line);
        if (scrollback.Count > ScrollbackLimit)
        {
            scrollback.RemoveRange(0, scrollback.Count - ScrollbackLimit);
        }
    }

    private void EraseDisplay(int mode)
    {
        switch (mode)
        {
            case 0:
                EraseLine(0);
                for (var r = CursorRow + 1; r < Rows; r++) Fill(r, 0, Columns);
                break;
            case 1:
                EraseLine(1);
                for (var r = 0; r < CursorRow; r++) Fill(r, 0, Columns);
                break;
            case 2:
                for (var r = 0; r < Rows; r++) Fill(r, 0, Columns);
                break;
            case 3:
                scrollback.Clear();
                break;
        }
    }

    private void EraseLine(int mode)
    {
        switch (mode)
        {
            case 0: Fill(CursorRow, CursorCol, Columns); break;
            case 1: Fill(CursorRow, 0, CursorCol + 1); break;
            case 2: Fill(CursorRow, 0, Columns); break;
        }
    }

    private void Fill(int row, int from, int to)
    {
        var line = Screen[row];
        for (var c = Math.Max(0, from); c < Math.Min(to, line.Length); c++)
        {
            line[c] = new Cell { Ch = ' ', Fg = -1, Bg = bg };
        }
    }

    private void InsertChars(int n)
    {
        var line = Screen[CursorRow];
        n = Math.Min(n, Columns - CursorCol);
        Array.Copy(line, CursorCol, line, CursorCol + n, Columns - CursorCol - n);
        Fill(CursorRow, CursorCol, CursorCol + n);
    }

    private void DeleteChars(int n)
    {
        var line = Screen[CursorRow];
        n = Math.Min(n, Columns - CursorCol);
        Array.Copy(line, CursorCol + n, line, CursorCol, Columns - CursorCol - n);
        Fill(CursorRow, Columns - n, Columns);
    }

    private void SaveCursor() => saved = (CursorRow, CursorCol, fg, bg, flags);

    private void RestoreCursor()
    {
        (CursorRow, CursorCol, fg, bg, flags) = saved;
        CursorRow = Math.Clamp(CursorRow, 0, Rows - 1);
        CursorCol = Math.Clamp(CursorCol, 0, Columns - 1);
        wrapPending = false;
    }

    private void Reset()
    {
        alt = null;
        main = Blank(Rows);
        fg = -1;
        bg = -1;
        flags = CellFlags.None;
        CursorRow = 0;
        CursorCol = 0;
        CursorVisible = true;
        ApplicationCursorKeys = false;
        top = 0;
        bottom = Rows - 1;
        wrapPending = false;
    }

    private Cell[][] Blank(int rows)
    {
        var screen = new Cell[rows][];
        for (var r = 0; r < rows; r++)
        {
            screen[r] = BlankLine(Columns);
        }
        return screen;
    }

    private static Cell[] BlankLine(int columns, int background = -1)
    {
        var line = new Cell[columns];
        Array.Fill(line, new Cell { Ch = ' ', Fg = -1, Bg = background });
        return line;
    }
}

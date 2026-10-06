using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1406: the API Spending tab's charts. Every colour comes from the theme in
// use at the moment it paints, and both charts repaint on a live theme switch.
internal static class ChartPalette
{
    // Pro wears the theme's accent; Flash is the accent's hue turned 120°
    // back at the same lightness. Both are held to a lightness band for the
    // chart surface (dark 0.58-0.66, light 0.48-0.58, OKLCH) and chroma
    // 0.11-0.16, which keeps the pair apart for colour-blind eyes and at 3:1
    // on the surface for every preset (checked with the dataviz validator).
    public static Color Pro => FromAccent(0);
    public static Color Flash => FromAccent(-120);

    // Colour follows the model, never its rank. A model without a slot is muted.
    public static Color Model(string model) => model switch
    {
        "deepseek-v4-pro" => Pro,
        "deepseek-flash" => Flash,
        _ => DarkTheme.Muted,
    };

    // Uses: self-work wears the accent, chat and bench its hue turned 120°
    // either way (checked like the models on every preset).
    public static Color Use(string use) => use switch
    {
        "self-work" => FromAccent(0),
        "chat" => FromAccent(-120),
        "bench" => FromAccent(120),
        _ => DarkTheme.Muted,
    };

    // Token kinds, in the order a request is billed: one ramp from the chart
    // surface toward the text colour, so it never competes with the models.
    private static readonly double[] KindSteps = [0.36, 0.54, 0.72, 0.9];
    public static Color Kind(int i) => Mix(Surface, DarkTheme.Text, KindSteps[i]);

    public static Color Surface => DarkTheme.Panel2;
    public static Color Grid => Mix(Surface, DarkTheme.Text, 0.08);
    public static Color Baseline => Mix(Surface, DarkTheme.Text, 0.25);
    public static Color Hover => Mix(Surface, DarkTheme.Text, 0.06);

    private static Color FromAccent(double turnDegrees)
    {
        var (l, a, b) = ToOklab(DarkTheme.Accent);
        var light = DarkTheme.IsLight;
        l = Math.Clamp(l, light ? 0.48 : 0.58, light ? 0.58 : 0.66);
        var chroma = Math.Clamp(Math.Sqrt(a * a + b * b), 0.11, 0.16);
        var hue = Math.Atan2(b, a) + turnDegrees * Math.PI / 180;
        // Lower the chroma until it fits in sRGB.
        for (var c = chroma; c > 0; c -= 0.005)
        {
            if (TryFromOklab(l, c * Math.Cos(hue), c * Math.Sin(hue), out var color)) return color;
        }
        TryFromOklab(l, 0, 0, out var grey);
        return grey;
    }

    public static Color Mix(Color from, Color to, double t)
    {
        var (l1, a1, b1) = ToOklab(from);
        var (l2, a2, b2) = ToOklab(to);
        TryFromOklab(l1 + (l2 - l1) * t, a1 + (a2 - a1) * t, b1 + (b2 - b1) * t, out var mixed);
        return mixed;
    }

    private static double Linear(int c)
    {
        var v = c / 255.0;
        return v <= 0.04045 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4);
    }

    private static int Encode(double v)
    {
        v = Math.Clamp(v, 0, 1);
        var s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.Pow(v, 1 / 2.4) - 0.055;
        return (int)Math.Round(Math.Clamp(s, 0, 1) * 255);
    }

    internal static (double L, double A, double B) ToOklab(Color color)
    {
        double r = Linear(color.R), g = Linear(color.G), b = Linear(color.B);
        var l = Math.Cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        var m = Math.Cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        var s = Math.Cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
    }

    private static bool TryFromOklab(double lightness, double a, double b, out Color color)
    {
        var l = Math.Pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3);
        var m = Math.Pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3);
        var s = Math.Pow(lightness - 0.0894841775 * a - 1.2914855480 * b, 3);
        var r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        var bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
        color = Color.FromArgb(Encode(r), Encode(g), Encode(bl));
        const double e = 1e-4;
        return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && bl >= -e && bl <= 1 + e;
    }

    public static string Dollars(double usd) => usd > 0 && usd < 0.01 ? "< $0.01" : usd.ToString("$0.00", CultureInfo.InvariantCulture);
}

// What both charts share: their card, theme repaint, text and the tooltip.
internal abstract class SpendingChartBase : Control
{
    protected Point? Pointer;

    protected SpendingChartBase()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        DarkTheme.Changed += Invalidate;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) DarkTheme.Changed -= Invalidate;
        base.Dispose(disposing);
    }

    protected Font Small => new(Font.FontFamily, Font.Size * 0.88f);
    protected Font Bold => new(Font, FontStyle.Bold);

    protected static void DrawLabel(Graphics g, string text, Font font, Color color, Rectangle box, TextFormatFlags flags) =>
        TextRenderer.DrawText(g, text, font, box, color, flags | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);

    protected static GraphicsPath Rounded(RectangleF r, float radius, bool top = true, bool bottom = true)
    {
        var path = new GraphicsPath();
        var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        if (top && d > 0)
        {
            path.AddArc(r.Left, r.Top, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
        }
        else
        {
            path.AddLine(r.Left, r.Top, r.Right, r.Top);
        }
        if (bottom && d > 0)
        {
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
        }
        else
        {
            path.AddLine(r.Right, r.Bottom, r.Left, r.Bottom);
        }
        path.CloseFigure();
        return path;
    }

    // The card every chart sits on, and its title block.
    protected void DrawCard(Graphics g, string title, string subtitle)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = Rounded(new RectangleF(0.5f, 0.5f, Width - 1, Height - 1), 6))
        using (var fill = new SolidBrush(ChartPalette.Surface))
        using (var pen = new Pen(DarkTheme.Border))
        {
            g.FillPath(fill, path);
            g.DrawPath(pen, path);
        }
        using var bold = Bold;
        using var small = Small;
        DrawLabel(g, title, bold, DarkTheme.Text, new Rectangle(14, 12, Width - 28, 18), TextFormatFlags.Left);
        DrawLabel(g, subtitle, small, DarkTheme.Muted, new Rectangle(14, 31, Width - 28, 16), TextFormatFlags.Left);
    }

    // A small box near the pointer: a heading and label/value rows.
    protected void DrawTooltip(Graphics g, string heading, IReadOnlyList<(Color? Swatch, string Label, string Value)> rows)
    {
        if (Pointer is not Point p) return;
        using var bold = Bold;
        using var small = Small;
        var lineH = TextRenderer.MeasureText("Ag", small).Height + 3;
        var width = Math.Max(150, rows.Max(r => TextRenderer.MeasureText(r.Label + "    " + r.Value, small).Width + (r.Swatch is null ? 0 : 14)) + 20);
        width = Math.Max(width, TextRenderer.MeasureText(heading, bold).Width + 20);
        var height = 12 + lineH + rows.Count * lineH;
        var x = Math.Min(p.X + 14, Width - width - 4);
        var y = Math.Max(4, p.Y - height - 10);
        var box = new Rectangle(x, y, width, height);
        using (var path = Rounded(box, 5))
        using (var fill = new SolidBrush(DarkTheme.Background))
        using (var pen = new Pen(DarkTheme.Border))
        {
            g.FillPath(fill, path);
            g.DrawPath(pen, path);
        }
        DrawLabel(g, heading, bold, DarkTheme.Text, new Rectangle(x + 10, y + 7, width - 20, lineH), TextFormatFlags.Left);
        for (var i = 0; i < rows.Count; i++)
        {
            var row = new Rectangle(x + 10, y + 7 + lineH * (i + 1), width - 20, lineH);
            var labelX = row.X;
            if (rows[i].Swatch is Color swatch)
            {
                using var brush = new SolidBrush(swatch);
                g.FillRectangle(brush, row.X, row.Y + lineH / 2 - 5, 9, 9);
                labelX += 14;
            }
            DrawLabel(g, rows[i].Label, small, DarkTheme.Muted, new Rectangle(labelX, row.Y, row.Width, lineH), TextFormatFlags.Left);
            DrawLabel(g, rows[i].Value, small, DarkTheme.Text, row, TextFormatFlags.Right);
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        Pointer = null;
        Invalidate();
        base.OnMouseLeave(e);
    }
}

// Daily spend: a stacked bar per day for the last 7, 30 or 90 days, by model
// or by use. Hatching marks what peak hours added; the busiest day is
// labelled; hovering shows the day and clicking picks it (DayClicked).
internal sealed class DailySpendChart : SpendingChartBase
{
    private static readonly string[] ModelOrder = ["deepseek-flash", "deepseek-v4-pro"];
    private static readonly string[] UseOrder = ["self-work", "chat", "bench"];
    private static readonly Dictionary<string, string> Names = new()
    {
        ["deepseek-flash"] = "DeepSeek Flash",
        ["deepseek-v4-pro"] = "DeepSeek Pro",
        ["self-work"] = "Self-work",
        ["chat"] = "Chat",
        ["bench"] = "Bench",
    };
    private IReadOnlyList<ManaSpendingDay> allDays = [];
    private int rangeDays = 30;
    private bool byUse;
    internal int HoverIndex { get; private set; } = -1;
    internal int SelectedIndex { get; private set; } = -1;
    public event Action<ManaSpendingDay>? DayClicked;

    public DailySpendChart()
    {
        AccessibleRole = AccessibleRole.Chart;
        Cursor = Cursors.Hand;
    }

    public int RangeDays
    {
        get => rangeDays;
        set { rangeDays = value; SelectedIndex = -1; Refresh(); }
    }

    public bool ByUse
    {
        get => byUse;
        set { byUse = value; Refresh(); }
    }

    public void SetDays(IReadOnlyList<ManaSpendingDay> value)
    {
        allDays = value;
        SelectedIndex = -1;
        Refresh();
    }

    // The days in range, oldest first.
    internal IReadOnlyList<ManaSpendingDay> Days => allDays.Skip(Math.Max(0, allDays.Count - rangeDays)).ToList();

    public override void Refresh()
    {
        HoverIndex = -1;
        var days = Days;
        AccessibleName = $"Daily spend, last {rangeDays} days, by {(byUse ? "use" : "model")}";
        AccessibleDescription = string.Join(", ", Series(days).Select(k => $"{ModelName(k)} {ChartPalette.Dollars(days.Sum(d => Amount(d, k)))}"));
        base.Refresh();
    }

    private static string ModelName(string key) => Names.GetValueOrDefault(key, key);
    private double Amount(ManaSpendingDay d, string key) => (byUse ? d.ByUse : d.ByModel)?.GetValueOrDefault(key) ?? 0;
    private Color ColorOf(string key) => byUse ? ChartPalette.Use(key) : ChartPalette.Model(key);

    // Bottom to top: the known order, then anything else alphabetically.
    private IEnumerable<string> Series(IReadOnlyList<ManaSpendingDay> days)
    {
        var order = byUse ? UseOrder : ModelOrder;
        var keys = days.SelectMany(d => (byUse ? d.ByUse : d.ByModel)?.Keys ?? Enumerable.Empty<string>()).Distinct().ToList();
        return order.Where(keys.Contains).Concat(keys.Where(k => !order.Contains(k)).OrderBy(k => k, StringComparer.Ordinal));
    }

    private Rectangle Plot => new(52, 60, Math.Max(10, Width - 52 - 14), Math.Max(10, Height - 60 - 28));

    internal int IndexAt(int x)
    {
        var count = Days.Count;
        if (count == 0) return -1;
        var plot = Plot;
        var i = (int)Math.Floor((x - plot.Left) / (plot.Width / (double)count));
        return i >= 0 && i < count ? i : -1;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        Pointer = e.Location;
        HoverIndex = e.Y > Plot.Top - 20 ? IndexAt(e.X) : -1;
        Invalidate();
        base.OnMouseMove(e);
    }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        var i = IndexAt(e.X);
        if (i >= 0 && e.Y > Plot.Top - 20) PickDay(i);
        base.OnMouseClick(e);
    }

    internal void PickDay(int index)
    {
        if (index < 0 || index >= Days.Count) return;
        SelectedIndex = index;
        Invalidate();
        DayClicked?.Invoke(Days[index]);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var days = Days;
        DrawCard(g, "Daily spend", $"Last {rangeDays} days, by {(byUse ? "use" : "model")}. Click a day to see what it paid for.");
        using var small = Small;
        using var bold = Bold;
        var keys = Series(days).ToList();
        var anyPeak = days.Any(d => d.PeakExtra > 0);

        // Legend, right-aligned on the title row: swatch, name and the range's
        // total; then the peak surcharge's hatch when the range has any.
        var x = Width - 14;
        if (anyPeak)
        {
            var label = "Peak surcharge";
            var w = TextRenderer.MeasureText(label, small).Width;
            x -= w;
            DrawLabel(g, label, small, DarkTheme.Muted, new Rectangle(x, 15, w, 18), TextFormatFlags.Left);
            x -= 14;
            using (var fill = new SolidBrush(ChartPalette.Kind(1))) g.FillRectangle(fill, x, 19, 9, 9);
            using (var hatch = PeakHatch()) g.FillRectangle(hatch, x, 19, 9, 9);
            x -= 16;
        }
        foreach (var key in Enumerable.Reverse(keys))
        {
            var total = ChartPalette.Dollars(days.Sum(d => Amount(d, key)));
            var valueW = TextRenderer.MeasureText(total, bold).Width;
            var nameW = TextRenderer.MeasureText(ModelName(key), small).Width;
            x -= valueW;
            DrawLabel(g, total, bold, DarkTheme.Text, new Rectangle(x, 14, valueW, 18), TextFormatFlags.Left);
            x -= nameW + 5;
            DrawLabel(g, ModelName(key), small, DarkTheme.Muted, new Rectangle(x, 15, nameW, 18), TextFormatFlags.Left);
            x -= 14;
            using (var brush = new SolidBrush(ColorOf(key))) g.FillRectangle(brush, x, 19, 9, 9);
            x -= 16;
        }

        if (days.Count == 0 || days.All(d => d.Usd <= 0))
        {
            DrawLabel(g, "Nothing spent in this range.", small, DarkTheme.Muted, Plot, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            return;
        }
        var plot = Plot;
        var max = days.Max(d => d.Usd);
        var step = new[] { 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50 }.FirstOrDefault(s => max / s <= 4, 100);
        var top = Math.Max(step, Math.Ceiling(max / step - 1e-9) * step);
        float Y(double v) => (float)(plot.Bottom - v / top * plot.Height);

        // Recessive grid; the baseline a little stronger.
        using (var grid = new Pen(ChartPalette.Grid))
        using (var baseline = new Pen(ChartPalette.Baseline))
        {
            for (var t = 0.0; t <= top + 1e-9; t += step)
            {
                var y = Y(t);
                g.DrawLine(t == 0 ? baseline : grid, plot.Left, y, plot.Right, y);
                DrawLabel(g, ChartPalette.Dollars(t), small, DarkTheme.Muted, new Rectangle(0, (int)y - 8, plot.Left - 8, 16), TextFormatFlags.Right | TextFormatFlags.VerticalCenter);
            }
        }

        var slot = plot.Width / (float)days.Count;
        var barW = Math.Max(2, Math.Min(12, slot * 0.62f));
        var gap = slot >= 6 ? 2 : 1;
        var labelEvery = rangeDays <= 7 ? 1 : rangeDays <= 30 ? 7 : 14;
        var peak = Enumerable.Range(0, days.Count).OrderByDescending(i => days[i].Usd).First();
        using var hatchBrush = PeakHatch();
        for (var i = 0; i < days.Count; i++)
        {
            var left = plot.Left + i * slot;
            if (i == HoverIndex || i == SelectedIndex)
            {
                using var hover = new SolidBrush(i == SelectedIndex ? ChartPalette.Mix(ChartPalette.Surface, DarkTheme.Accent, 0.14) : ChartPalette.Hover);
                g.FillRectangle(hover, left, plot.Top, slot, plot.Height);
            }
            var bx = left + (slot - barW) / 2;
            var y = (float)plot.Bottom;
            var segments = keys.Select(k => (Key: k, Usd: Amount(days[i], k))).Where(s => s.Usd > 0).ToList();
            for (var s = 0; s < segments.Count; s++)
            {
                // A sliver that's still visible, a surface gap between segments,
                // and only the data end (the top) rounded.
                var h = Math.Max(2, (float)(segments[s].Usd / top * plot.Height));
                if (s > 0) y -= gap;
                var rect = new RectangleF(bx, y - h, barW, h);
                using var path = Rounded(rect, 4, top: s == segments.Count - 1, bottom: false);
                using var brush = new SolidBrush(ColorOf(segments[s].Key));
                g.FillPath(brush, path);
                y -= h;
            }
            // What peak hours added, hatched over the top of the stack.
            if (days[i].PeakExtra > 0 && segments.Count > 0)
            {
                var h = Math.Max(2, (float)(days[i].PeakExtra / top * plot.Height));
                var region = new RectangleF(bx, y, barW, Math.Min(h, plot.Bottom - y));
                using var clip = Rounded(region, 4, top: true, bottom: false);
                g.FillPath(hatchBrush, clip);
            }
            if (i == peak && days[i].Usd > 0)
                DrawLabel(g, ChartPalette.Dollars(days[i].Usd), bold, DarkTheme.Text, new Rectangle((int)(bx + barW / 2) - 40, (int)y - 20, 80, 16), TextFormatFlags.HorizontalCenter);
            // The last label sits flush with the plot's right edge, so it never spills past the card.
            if (i == days.Count - 1)
                DrawLabel(g, "Today", small, DarkTheme.Muted, new Rectangle(plot.Right - 80, plot.Bottom + 8, 80, 16), TextFormatFlags.Right);
            else if ((days.Count - 1 - i) % labelEvery == 0)
                DrawLabel(g, DayLabel(days[i].Day, rangeDays <= 7), small, DarkTheme.Muted, new Rectangle((int)(bx + barW / 2) - 40, plot.Bottom + 8, 80, 16), TextFormatFlags.HorizontalCenter);
        }

        if (HoverIndex >= 0)
        {
            var d = days[HoverIndex];
            var rows = Enumerable.Reverse(keys).Select(k => ((Color?)ColorOf(k), ModelName(k), ChartPalette.Dollars(Amount(d, k)))).ToList();
            if (d.PeakExtra > 0) rows.Add((null, "of which peak surcharge", ChartPalette.Dollars(d.PeakExtra)));
            rows.Add((null, "Total", ChartPalette.Dollars(d.Usd)));
            var issues = d.Issues?.Count ?? 0;
            if (issues > 0) rows.Add((null, issues == 1 ? "1 issue" : $"{issues} issues", "click to see"));
            DrawTooltip(g, DayLabel(d.Day, true), rows);
        }
    }

    // Diagonal lines in the surface colour: reads as "part of this bar".
    private static HatchBrush PeakHatch() => new(HatchStyle.WideUpwardDiagonal, Color.FromArgb(170, ChartPalette.Surface), Color.Transparent);

    internal static string DayLabel(string day, bool weekday = false) =>
        DateTime.TryParseExact(day, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date.ToString(weekday ? "ddd d MMM" : "d MMM", CultureInfo.InvariantCulture)
            : day;
}

// Where the money went: one bar of the period's dollars by token kind, with
// its legend underneath and a hover tooltip.
internal sealed class KindSpendBar : SpendingChartBase
{
    private ManaSpendingTotals totals = new(0, 0, 0, 0, 0, 0, 0);
    private string period = "this month";
    internal int HoverIndex { get; private set; } = -1;

    public KindSpendBar()
    {
        AccessibleName = "Where the money went, by token kind";
        AccessibleRole = AccessibleRole.Chart;
    }

    internal IReadOnlyList<(string Name, double Usd, long Tokens)> Parts =>
    [
        ("Input from cache", totals.UsdCacheHit, totals.CacheHit),
        ("Input not from cache", totals.UsdCacheMiss, totals.CacheMiss),
        ("Output", totals.UsdOutput, totals.Output - totals.Reasoning),
        ("Reasoning", totals.UsdReasoning, totals.Reasoning),
    ];

    public void SetTotals(ManaSpendingTotals value, string periodName)
    {
        totals = value;
        period = periodName;
        HoverIndex = -1;
        AccessibleDescription = string.Join(", ", Parts.Select(p => $"{p.Name} {ChartPalette.Dollars(p.Usd)}"));
        Invalidate();
    }

    private Rectangle Bar => new(14, 58, Math.Max(10, Width - 28), 20);

    // Segment bounds left to right, with 2px gaps; a part that's there is at least 3px wide.
    private List<(int Index, RectangleF Rect)> Segments()
    {
        var bar = Bar;
        var sum = Parts.Sum(p => p.Usd);
        var shown = Parts.Select((p, i) => (p, i)).Where(t => t.p.Usd > 0).ToList();
        var room = bar.Width - 2f * Math.Max(0, shown.Count - 1);
        var x = (float)bar.Left;
        var result = new List<(int, RectangleF)>();
        for (var s = 0; s < shown.Count; s++)
        {
            var w = s == shown.Count - 1 ? bar.Right - x : Math.Max(3, (float)(shown[s].p.Usd / sum * room));
            result.Add((shown[s].i, new RectangleF(x, bar.Top, w, bar.Height)));
            x += w + 2;
        }
        return result;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        Pointer = e.Location;
        HoverIndex = Segments().Where(s => s.Rect.Contains(e.Location)).Select(s => s.Index).DefaultIfEmpty(-1).First();
        Invalidate();
        base.OnMouseMove(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        DrawCard(g, "Where the money went", $"Cost by token kind, {period}. Reasoning is billed as output.");
        using var small = Small;
        using var bold = Bold;
        var bar = Bar;
        var sum = Parts.Sum(p => p.Usd);
        if (sum <= 0)
        {
            using var empty = new SolidBrush(ChartPalette.Grid);
            using var path = Rounded(bar, 4);
            g.FillPath(empty, path);
            DrawLabel(g, "Nothing spent in this period.", small, DarkTheme.Muted, new Rectangle(bar.Left, bar.Bottom + 10, bar.Width, 18), TextFormatFlags.Left);
            return;
        }
        // The whole bar is clipped to one rounded shape, so only its two ends are round.
        using (var clip = Rounded(bar, 4))
        {
            var state = g.Save();
            g.SetClip(clip);
            foreach (var (index, rect) in Segments())
            {
                using var brush = new SolidBrush(ChartPalette.Kind(index));
                g.FillRectangle(brush, rect);
            }
            g.Restore(state);
        }

        // Legend: four columns when every name fits beside its numbers, else two rows of two.
        var lineH = TextRenderer.MeasureText("Ag", small).Height + 6;
        var pctWidth = TextRenderer.MeasureText("100%", small).Width;
        var needed = Parts.Max(p => 14 + TextRenderer.MeasureText(p.Name, small).Width + 12 + TextRenderer.MeasureText(ChartPalette.Dollars(p.Usd), bold).Width + 6 + pctWidth);
        var columns = (Width - 28 - 3 * 14) / 4 >= needed ? 4 : 2;
        var cellW = (Width - 28 - (columns - 1) * 14) / columns;
        for (var i = 0; i < Parts.Count; i++)
        {
            var cx = 14 + (i % columns) * (cellW + 14);
            var cy = bar.Bottom + 12 + (i / columns) * lineH;
            using (var brush = new SolidBrush(ChartPalette.Kind(i))) g.FillRectangle(brush, cx, cy + 4, 9, 9);
            var pct = Math.Round(Parts[i].Usd / sum * 100).ToString(CultureInfo.InvariantCulture) + "%";
            var pctW = TextRenderer.MeasureText("100%", small).Width;
            DrawLabel(g, pct, small, DarkTheme.Muted, new Rectangle(cx + cellW - pctW, cy, pctW, lineH), TextFormatFlags.Right);
            var value = ChartPalette.Dollars(Parts[i].Usd);
            var valueW = TextRenderer.MeasureText(value, bold).Width;
            DrawLabel(g, value, bold, DarkTheme.Text, new Rectangle(cx + cellW - pctW - 6 - valueW, cy, valueW, lineH), TextFormatFlags.Left);
            DrawLabel(g, Parts[i].Name, small, DarkTheme.Muted, new Rectangle(cx + 14, cy, cellW - 14 - pctW - 12 - valueW, lineH), TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
        }

        if (HoverIndex >= 0)
        {
            var p = Parts[HoverIndex];
            DrawTooltip(g, p.Name,
            [
                (null, "Cost", ChartPalette.Dollars(p.Usd)),
                (null, "Share", Math.Round(p.Usd / sum * 100).ToString(CultureInfo.InvariantCulture) + "%"),
                (null, "Tokens", ApiSpendingPanel.Tokens(p.Tokens)),
            ]);
        }
    }
}

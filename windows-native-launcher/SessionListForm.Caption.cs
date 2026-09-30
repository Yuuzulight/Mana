using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// The Mana preset's title bar: a thin glass strip with her crystal and name
// (the #652 mockup), drawn in the client area. WM_NCCALCSIZE drops the system
// caption but keeps Windows' side and bottom resize borders; WM_NCHITTEST
// hands the strip back to Windows as caption, top edge and min/max/close --
// HTMAXBUTTON is what gives Windows 11's snap layouts -- so drag, double-click
// to maximise, snapping, the system menu and DPI all stay Windows' own. Other
// presets keep the normal title bar (DarkTheme.ApplyTitleBarMode re-frames
// the window on a live switch).
internal sealed partial class SessionListForm
{
    private const int CaptionLogicalHeight = 32;
    private const int CaptionButtonLogicalWidth = 46;

    private int hoveredCaptionButton;
    private int pressedCaptionButton;

    private static bool CustomCaption => DarkTheme.IsGlass;

    private int CaptionHeight => CustomCaption ? LogicalToDeviceUnits(CaptionLogicalHeight) : 0;

    // Docked children start below the strip.
    public override Rectangle DisplayRectangle
    {
        get
        {
            var rect = base.DisplayRectangle;
            var caption = CaptionHeight;
            return new Rectangle(rect.X, rect.Y + caption, rect.Width, Math.Max(0, rect.Height - caption));
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (!CustomCaption)
        {
            base.WndProc(ref m);
            return;
        }
        switch (m.Msg)
        {
            case WmNcCalcSize when m.WParam != IntPtr.Zero:
                // lParam starts with rgrc[0], the new window rect, which
                // Windows turns into the client rect.
                var windowLeft = Marshal.ReadInt32(m.LParam, 0);
                var windowTop = Marshal.ReadInt32(m.LParam, 4);
                base.WndProc(ref m);
                // Maximised, the window hangs off the screen by its frame
                // (the same thickness as the side border), so keep that much.
                var inset = IsZoomed(m.HWnd) ? Marshal.ReadInt32(m.LParam, 0) - windowLeft : 0;
                Marshal.WriteInt32(m.LParam, 4, windowTop + inset);
                return;

            case WmNcHitTest:
                base.WndProc(ref m);
                if ((int)m.Result == HtClient)
                {
                    var screen = new Point((short)((long)m.LParam & 0xFFFF), (short)(((long)m.LParam >> 16) & 0xFFFF));
                    m.Result = (IntPtr)CaptionHitTest(PointToClient(screen), ClientSize.Width, CaptionHeight,
                        LogicalToDeviceUnits(CaptionButtonLogicalWidth), LogicalToDeviceUnits(5), IsZoomed(m.HWnd));
                }
                return;

            // Windows would draw and track its own (hidden) button here.
            case WmNcLButtonDown or WmNcLButtonDblClk when IsCaptionButton(m.WParam):
                pressedCaptionButton = (int)m.WParam;
                InvalidateCaption();
                return;

            case WmNcLButtonUp when IsCaptionButton(m.WParam):
                var clicked = pressedCaptionButton == (int)m.WParam;
                pressedCaptionButton = 0;
                InvalidateCaption();
                if (clicked)
                {
                    var command = (int)m.WParam switch
                    {
                        HtMinButton => ScMinimize,
                        HtMaxButton => IsZoomed(m.HWnd) ? ScRestore : ScMaximize,
                        _ => ScClose,
                    };
                    SendMessage(m.HWnd, WmSysCommand, (IntPtr)command, IntPtr.Zero);
                }
                return;

            case WmNcMouseMove:
                SetHoveredCaptionButton(IsCaptionButton(m.WParam) ? (int)m.WParam : 0);
                var track = new TrackMouseEventInfo { Size = Marshal.SizeOf<TrackMouseEventInfo>(), Flags = TmeLeave | TmeNonClient, Window = m.HWnd };
                TrackMouseEvent(ref track);
                break;

            case WmNcMouseLeave:
                pressedCaptionButton = 0;
                SetHoveredCaptionButton(0);
                break;
        }
        base.WndProc(ref m);
    }

    // Where a point in the client area falls: the top resize edge, a caption
    // button, the caption, or the client below it.
    internal static int CaptionHitTest(Point p, int width, int captionHeight, int buttonWidth, int resizeBorder, bool maximized)
    {
        if (p.Y >= captionHeight)
        {
            return HtClient;
        }
        if (!maximized && p.Y < resizeBorder)
        {
            return p.X < resizeBorder * 2 ? HtTopLeft : p.X >= width - resizeBorder * 2 ? HtTopRight : HtTop;
        }
        var fromRight = width - p.X;
        return fromRight <= buttonWidth ? HtClose
            : fromRight <= buttonWidth * 2 ? HtMaxButton
            : fromRight <= buttonWidth * 3 ? HtMinButton
            : HtCaption;
    }

    private static bool IsCaptionButton(IntPtr hit) => (int)hit is HtMinButton or HtMaxButton or HtClose;

    private void SetHoveredCaptionButton(int hit)
    {
        if (hoveredCaptionButton != hit)
        {
            hoveredCaptionButton = hit;
            InvalidateCaption();
        }
    }

    private void InvalidateCaption() => Invalidate(new Rectangle(0, 0, ClientSize.Width, CaptionHeight), false);

    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        InvalidateCaption(); // name and glyphs dim while the window is inactive, as Windows' own do
    }

    protected override void OnDeactivate(EventArgs e)
    {
        base.OnDeactivate(e);
        InvalidateCaption();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (CustomCaption)
        {
            PaintCaption(e.Graphics);
        }
    }

    private static readonly Color CaptionTopEdge = Color.FromArgb(242, 255, 255, 255);
    private static readonly Color CaptionBottomEdge = Color.FromArgb(199, 255, 255, 255);
    private static readonly Color CaptionOutline = Color.FromArgb(18, 106, 95, 184);
    private static readonly Color CloseHover = Color.FromArgb(0xc4, 0x2b, 0x1c);

    private void PaintCaption(Graphics g)
    {
        var height = CaptionHeight;
        var width = ClientSize.Width;
        using (var glass = new SolidBrush(GlassSurface.GlassFill))
        {
            g.FillRectangle(glass, 0, 0, width, height);
        }
        using (var top = new Pen(CaptionTopEdge))
        using (var bottom = new Pen(CaptionBottomEdge))
        using (var outline = new Pen(CaptionOutline))
        {
            g.DrawLine(top, 0, 0, width, 0);
            g.DrawLine(bottom, 0, height - 2, width, height - 2);
            g.DrawLine(outline, 0, height - 1, width, height - 1);
        }

        var active = ActiveForm == this;
        var ink = active ? DarkTheme.Text : DarkTheme.Muted;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var x = LogicalToDeviceUnits(12);
        PaintCrystal(g, new RectangleF(x, (height - LogicalToDeviceUnits(18)) / 2f, LogicalToDeviceUnits(14), LogicalToDeviceUnits(18)));
        var textLeft = x + LogicalToDeviceUnits(14 + 8);
        TextRenderer.DrawText(g, Text, Font, new Rectangle(textLeft, 0, Math.Max(0, width - textLeft - LogicalToDeviceUnits(CaptionButtonLogicalWidth * 3)), height), ink,
            TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

        var buttonWidth = LogicalToDeviceUnits(CaptionButtonLogicalWidth);
        foreach (var (hit, index) in new[] { (HtClose, 1), (HtMaxButton, 2), (HtMinButton, 3) })
        {
            var bounds = new Rectangle(width - buttonWidth * index, 0, buttonWidth, height - 1);
            var glyph = ink;
            if (hoveredCaptionButton == hit || pressedCaptionButton == hit)
            {
                var pressed = pressedCaptionButton == hit;
                using var fill = new SolidBrush(hit == HtClose
                    ? Color.FromArgb(pressed ? 200 : 255, CloseHover)
                    : Color.FromArgb(pressed ? 46 : 26, DarkTheme.Accent));
                g.FillRectangle(fill, bounds);
                if (hit == HtClose)
                {
                    glyph = Color.White;
                }
            }
            PaintCaptionGlyph(g, bounds, hit, glyph);
        }
    }

    // 10px glyphs in 1px strokes, like Windows' own caption buttons.
    private void PaintCaptionGlyph(Graphics g, Rectangle bounds, int hit, Color color)
    {
        var size = LogicalToDeviceUnits(10);
        var x = bounds.X + (bounds.Width - size) / 2;
        var y = bounds.Y + (bounds.Height - size) / 2;
        using var pen = new Pen(color, Math.Max(1f, DeviceDpi / 96f));
        var smoothing = g.SmoothingMode;
        g.SmoothingMode = hit == HtClose ? SmoothingMode.AntiAlias : SmoothingMode.None;
        switch (hit)
        {
            case HtMinButton:
                g.DrawLine(pen, x, y + size / 2, x + size, y + size / 2);
                break;
            case HtMaxButton when IsZoomed(Handle):
                var step = LogicalToDeviceUnits(2);
                g.DrawRectangle(pen, x, y + step, size - step, size - step);
                g.DrawLines(pen, new[] { new Point(x + step, y + step), new Point(x + step, y), new Point(x + size, y), new Point(x + size, y + size - step), new Point(x + size - step, y + size - step) });
                break;
            case HtMaxButton:
                g.DrawRectangle(pen, x, y, size, size);
                break;
            default:
                g.DrawLine(pen, x, y, x + size, y + size);
                g.DrawLine(pen, x + size, y, x, y + size);
                break;
        }
        g.SmoothingMode = smoothing;
    }

    // Her crystal from the mockup: a lit and a shaded half, outlined.
    private static void PaintCrystal(Graphics g, RectangleF box)
    {
        // The SVG's viewBox is 14.93 x 32 around (0, -2), scaled to fit the box.
        var scale = Math.Min(box.Width / 14.93f, box.Height / 32f);
        var cx = box.X + box.Width / 2f;
        var cy = box.Y + box.Height / 2f;
        PointF P(float px, float py) => new(cx + px * scale, cy + (py + 2f) * scale);
        var top = P(0, -18);
        var left = P(-4.6f, 1);
        var right = P(4.6f, 1);
        var bottom = P(0, 14);
        using var lit = new SolidBrush(ColorTranslator.FromHtml("#dcd6fb"));
        using var shade = new SolidBrush(ColorTranslator.FromHtml("#6f7cec"));
        using var edge = new Pen(ColorTranslator.FromHtml("#6a5fb8"), Math.Max(1f, 1.2f * scale)) { LineJoin = LineJoin.Round };
        g.FillPolygon(lit, new[] { top, left, bottom });
        g.FillPolygon(shade, new[] { top, right, bottom });
        g.DrawPolygon(edge, new[] { top, left, bottom, right });
    }

    private const int WmNcCalcSize = 0x0083;
    private const int WmNcHitTest = 0x0084;
    private const int WmNcMouseMove = 0x00A0;
    private const int WmNcLButtonDown = 0x00A1;
    private const int WmNcLButtonUp = 0x00A2;
    private const int WmNcLButtonDblClk = 0x00A3;
    private const int WmNcMouseLeave = 0x02A2;
    private const int WmSysCommand = 0x0112;
    internal const int HtClient = 1;
    internal const int HtCaption = 2;
    internal const int HtMinButton = 8;
    internal const int HtMaxButton = 9;
    internal const int HtTop = 12;
    internal const int HtTopLeft = 13;
    internal const int HtTopRight = 14;
    internal const int HtClose = 20;
    private const int ScMinimize = 0xF020;
    private const int ScMaximize = 0xF030;
    private const int ScClose = 0xF060;
    private const int ScRestore = 0xF120;
    private const int TmeLeave = 0x2;
    private const int TmeNonClient = 0x10;

    [StructLayout(LayoutKind.Sequential)]
    private struct TrackMouseEventInfo
    {
        public int Size;
        public int Flags;
        public IntPtr Window;
        public int HoverTime;
    }

    [DllImport("user32.dll")]
    private static extern bool TrackMouseEvent(ref TrackMouseEventInfo info);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}

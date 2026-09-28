using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #571: on-screen equivalent of spoken output, matching windows-launcher's
// own #362 (renderer/caption-client.js + its .mana-captions CSS) -- a
// borderless, always-on-top, bottom-center bar that shows the latest
// caption text and stays hidden until the first one arrives. No auto-hide
// timer: the Electron version never clears the bar either, it just holds
// the most recent line until the next one replaces it.
//
// Glass: on Windows 11 the bar uses the system acrylic backdrop (a real blur
// of whatever is behind it) with rounded corners, tinted light or dark to
// match the theme. GDI text has no alpha, so it would come out see-through
// on the backdrop; the text is drawn into an ARGB bitmap instead and copied
// over as-is. Where the backdrop isn't available (Windows 10) it's the
// plain solid panel bar.
internal sealed class CaptionOverlayForm : Form
{
    private const int MaxWidth = 640;
    private const int PadX = 16;
    private const int PadY = 10;

    private static readonly StringFormat Centered = new() { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };

    private readonly Font captionFont = new("Segoe UI", 11F);
    private string caption = "";
    private bool glass;

    public CaptionOverlayForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = DarkTheme.Panel;
        Visible = false;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

        // Forces the handle to exist immediately -- SetCaption can be
        // called from CaptionWebSocketClient's background receive loop
        // before this form is ever shown, same reasoning as
        // StartupOverlayForm's own constructor-time `_ = Handle;`.
        _ = Handle;
    }

    // A caption must never take focus from whatever the user is doing.
    protected override bool ShowWithoutActivation => true;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int round = DwmwcpRound;
        DwmSetWindowAttribute(Handle, DwmwaWindowCornerPreference, ref round, sizeof(int));
        int dark = DarkTheme.IsLight ? 0 : 1;
        DwmSetWindowAttribute(Handle, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int));
        int backdrop = DwmsbtTransientWindow;
        var margins = new Margins { Left = -1, Right = -1, Top = -1, Bottom = -1 };
        glass = DwmSetWindowAttribute(Handle, DwmwaSystemBackdropType, ref backdrop, sizeof(int)) == 0
            && DwmExtendFrameIntoClientArea(Handle, ref margins) == 0;
        if (glass)
        {
            BackColor = Color.Black; // black client area = let the backdrop show
        }
    }

    public void SetCaption(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetCaption(text));
            return;
        }

        caption = text;
        using var g = CreateGraphics();
        var textSize = Size.Ceiling(g.MeasureString(text, captionFont, MaxWidth - PadX * 2, Centered));
        Width = Math.Min(MaxWidth, textSize.Width + PadX * 2);
        Height = textSize.Height + PadY * 2;
        PositionAtBottomCenter();
        Invalidate();
        Visible = true;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        using var bitmap = new Bitmap(Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height), PixelFormat.Format32bppPArgb);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            // Glass: a light wash of the panel colour over the blur, so the
            // text keeps its contrast whatever is behind the bar.
            g.Clear(glass ? Color.FromArgb(DarkTheme.IsLight ? 70 : 90, DarkTheme.Panel) : DarkTheme.Panel);
            using var brush = new SolidBrush(DarkTheme.Text);
            g.DrawString(caption, captionFont, brush, new RectangleF(PadX, PadY, bitmap.Width - PadX * 2, bitmap.Height - PadY * 2), Centered);
        }
        e.Graphics.CompositingMode = CompositingMode.SourceCopy;
        e.Graphics.DrawImageUnscaled(bitmap, 0, 0);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            captionFont.Dispose();
        }
        base.Dispose(disposing);
    }

    private void PositionAtBottomCenter()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(area.Left + (area.Width - Width) / 2, area.Bottom - Height - 48);
    }

    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwaSystemBackdropType = 38;
    private const int DwmwcpRound = 2;
    private const int DwmsbtTransientWindow = 3; // acrylic

    [StructLayout(LayoutKind.Sequential)]
    private struct Margins
    {
        public int Left, Right, Top, Bottom;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int valueSize);

    [DllImport("dwmapi.dll")]
    private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref Margins margins);
}

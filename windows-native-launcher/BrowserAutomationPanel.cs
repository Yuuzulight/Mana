using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using SkiaSharp;

namespace Mana.NativeLauncher;

// #578: ports windows-launcher's own ambient "what's browser automation
// doing right now" indicator (browserAutomationActivityEl/-LogEl/
// -ScreenshotEl + refreshBrowserAutomationActivity in renderer.js) -- a
// borderless, always-on-top overlay that polls GET /browser-automation/
// activity every second and shows itself only while genuinely active,
// matching that reference's own poll interval and staleness threshold
// exactly (1s poll, hides once 5s pass with no new log entry). No tray
// menu entry -- like CaptionOverlayForm, this runs ambiently for the
// whole app lifetime rather than being something the user opens.
internal sealed class BrowserAutomationPanel : Form
{
    private const int PollIntervalMs = 1000;
    private const int StaleMs = 5000;
    private const int MaxLogLines = 5;

    private readonly ManaBackendClient backendClient;
    private readonly System.Windows.Forms.Timer pollTimer;
    private readonly Label logLabel = new();
    private readonly PictureBox screenshotBox = new();

    private long lastKnownActivityAtMs;

    public BrowserAutomationPanel(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = DarkTheme.Panel;
        Width = 260;
        Height = 220;
        Visible = false;

        logLabel.Dock = DockStyle.Top;
        logLabel.AutoSize = false;
        logLabel.Height = 90;
        logLabel.ForeColor = DarkTheme.Text;
        logLabel.Font = new Font("Segoe UI", 8.5F);
        logLabel.Padding = new Padding(8);

        screenshotBox.Dock = DockStyle.Fill;
        screenshotBox.SizeMode = PictureBoxSizeMode.Zoom;
        screenshotBox.BackColor = DarkTheme.Background;
        screenshotBox.Visible = false;

        Controls.Add(screenshotBox);
        Controls.Add(logLabel);

        // Forces the handle to exist immediately -- pollTimer's Tick can
        // fire before this form is ever shown, same reasoning as
        // StartupOverlayForm's own constructor-time `_ = Handle;`.
        _ = Handle;
        PositionAtBottomRight();

        pollTimer = new System.Windows.Forms.Timer { Interval = PollIntervalMs };
        pollTimer.Tick += async (_, _) => await PollAsync();
        pollTimer.Start();
    }

    private void PositionAtBottomRight()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(area.Right - Width - 16, area.Bottom - Height - 16);
    }

    private async Task PollAsync()
    {
        ManaBrowserAutomationActivity activity;
        try
        {
            activity = await backendClient.GetBrowserAutomationActivityAsync();
        }
        catch
        {
            // Ambient, best-effort indicator -- matches windows-launcher's
            // own ignore-and-recheck-staleness behavior on a failed poll;
            // no error is ever surfaced for this panel.
            HideIfStale();
            return;
        }

        if (IsDisposed)
        {
            return;
        }

        var lastEntry = activity.Log.Count > 0 ? activity.Log[^1] : null;
        if (lastEntry is not null)
        {
            lastKnownActivityAtMs = TryParseTimestampMs(lastEntry.At);
        }

        if (lastEntry is null || NowMs() - lastKnownActivityAtMs > StaleMs)
        {
            Visible = false;
            return;
        }

        logLabel.Text = string.Join(
            Environment.NewLine,
            activity.Log.Skip(Math.Max(0, activity.Log.Count - MaxLogLines)).Select(e => e.Summary));
        UpdateScreenshot(activity.ScreenshotBase64);
        Visible = true;
    }

    private void HideIfStale()
    {
        if (!IsDisposed && NowMs() - lastKnownActivityAtMs > StaleMs)
        {
            Visible = false;
        }
    }

    private void UpdateScreenshot(string? base64)
    {
        if (string.IsNullOrEmpty(base64))
        {
            screenshotBox.Image?.Dispose();
            screenshotBox.Image = null;
            screenshotBox.Visible = false;
            return;
        }

        byte[] jpegBytes;
        try
        {
            jpegBytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return;
        }

        using var skBitmap = SKBitmap.Decode(jpegBytes);
        if (skBitmap is null)
        {
            return;
        }

        screenshotBox.Image?.Dispose();
        screenshotBox.Image = ToGdiBitmap(skBitmap);
        screenshotBox.Visible = true;
    }

    // Same SkiaSharp -> GDI round-trip AvatarOverlayForm.cs's own
    // ToGdiBitmap uses (through PNG re-encode, then a copy-constructed
    // Bitmap so the backing MemoryStream can be safely disposed) --
    // SkiaSharp and WinForms don't share a bitmap type.
    private static Bitmap ToGdiBitmap(SKBitmap skBitmap)
    {
        using var image = SKImage.FromBitmap(skBitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        using var stream = new MemoryStream(data.ToArray());
        using var lazyBitmap = new Bitmap(stream);
        return new Bitmap(lazyBitmap);
    }

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // Malformed/unparseable timestamps fall back to 0 -- always judged
    // stale, which is the safe default (hide) rather than risking a
    // frozen "still active" display off bad data.
    private static long TryParseTimestampMs(string at)
    {
        return DateTimeOffset.TryParse(at, out var parsed) ? parsed.ToUnixTimeMilliseconds() : 0;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            pollTimer.Dispose();
            screenshotBox.Image?.Dispose();
        }
        base.Dispose(disposing);
    }
}

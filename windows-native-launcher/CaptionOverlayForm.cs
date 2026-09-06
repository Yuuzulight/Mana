using System;
using System.Drawing;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #571: on-screen equivalent of spoken output, matching windows-launcher's
// own #362 (renderer/caption-client.js + its .mana-captions CSS) -- a
// borderless, always-on-top, bottom-center bar that shows the latest
// caption text and stays hidden until the first one arrives. No auto-hide
// timer: the Electron version never clears the bar either, it just holds
// the most recent line until the next one replaces it.
internal sealed class CaptionOverlayForm : Form
{
    private const int MaxWidth = 640;

    private readonly Label textLabel;

    public CaptionOverlayForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = DarkTheme.Panel;
        Visible = false;

        textLabel = new Label
        {
            Font = new Font("Segoe UI", 11F),
            ForeColor = DarkTheme.Text,
            TextAlign = ContentAlignment.MiddleCenter,
            AutoSize = false,
            MaximumSize = new Size(MaxWidth - 32, 0),
            Location = new Point(16, 10),
        };
        Controls.Add(textLabel);

        // Forces the handle to exist immediately -- SetCaption can be
        // called from CaptionWebSocketClient's background receive loop
        // before this form is ever shown, same reasoning as
        // StartupOverlayForm's own constructor-time `_ = Handle;`.
        _ = Handle;
    }

    public void SetCaption(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetCaption(text));
            return;
        }

        textLabel.Text = text;
        var textSize = TextRenderer.MeasureText(text, textLabel.Font, new Size(MaxWidth - 32, int.MaxValue));
        Width = Math.Min(MaxWidth, textSize.Width + 32);
        Height = textSize.Height + 20;
        textLabel.Size = new Size(Width - 32, textSize.Height);
        PositionAtBottomCenter();
        Visible = true;
    }

    private void PositionAtBottomCenter()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(area.Left + (area.Width - Width) / 2, area.Bottom - Height - 48);
    }
}

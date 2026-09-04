using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// Ports windows-launcher's startup/shutdown overlay (renderer/index.html's
// #startupOverlay, reused for both "Starting Mana" and "Closing Mana" by
// swapping title/subtitle/row text rather than being two separate screens)
// -- same idea here: one small always-on-top card shown while services
// start, and again while they stop on exit, so the app isn't silently
// invisible during either. Colors/text match that overlay's
// theme-tokens.css values exactly (DarkTheme already carries the same
// palette).
internal sealed class StartupOverlayForm : Form
{
    private const int CardWidth = 360;
    private const int RowHeight = 40;
    private const int BarHeight = 4;

    private readonly Label subtitleLabel;
    private readonly Dictionary<string, (Label Status, Panel BarTrack, Panel BarFill)> rows = new();

    public StartupOverlayForm(string title, string subtitle, IReadOnlyList<(string Key, string Label)> rowDefs)
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = DarkTheme.Background;
        Width = CardWidth;
        Height = 76 + rowDefs.Count * RowHeight + 20;
        CenterOnScreen();

        var titleLabel = new Label
        {
            Text = title,
            Font = new Font("Segoe UI", 13F, FontStyle.Bold),
            ForeColor = DarkTheme.Text,
            AutoSize = true,
            Location = new Point(24, 20),
        };
        Controls.Add(titleLabel);

        subtitleLabel = new Label
        {
            Text = subtitle,
            Font = new Font("Segoe UI", 9F),
            ForeColor = DarkTheme.Muted,
            AutoSize = true,
            Location = new Point(24, 46),
        };
        Controls.Add(subtitleLabel);

        var y = 76;
        foreach (var (key, label) in rowDefs)
        {
            var nameLabel = new Label
            {
                Text = label,
                Font = new Font("Segoe UI", 9F),
                ForeColor = DarkTheme.Text,
                AutoSize = true,
                Location = new Point(24, y),
            };
            Controls.Add(nameLabel);

            var statusLabel = new Label
            {
                Text = "Waiting...",
                Font = new Font("Segoe UI", 9F),
                ForeColor = DarkTheme.Muted,
                TextAlign = ContentAlignment.MiddleRight,
                // Fixed-width + right-aligned rather than AutoSize -- the
                // status word changes ("Waiting..." -> "Ready"), and an
                // AutoSize label's own width (hence its right edge)
                // shifting with the text would need repositioning on every
                // update instead of just a text swap.
                Size = new Size(160, 18),
                Location = new Point(Width - 24 - 160, y - 1),
            };
            Controls.Add(statusLabel);

            var barTrack = new Panel
            {
                BackColor = DarkTheme.Panel2,
                Size = new Size(CardWidth - 48, BarHeight),
                Location = new Point(24, y + 20),
            };
            var barFill = new Panel
            {
                BackColor = DarkTheme.Accent,
                Size = new Size((int)(barTrack.Width * 0.06), BarHeight),
                Location = Point.Empty,
            };
            barTrack.Controls.Add(barFill);
            Controls.Add(barTrack);

            rows[key] = (statusLabel, barTrack, barFill);
            y += RowHeight;
        }

        // Forces the native window handle to exist immediately, same
        // reasoning as QuickEntryForm/ArtifactViewerForm's own
        // constructor-time `_ = Handle;` -- SetRowStatus can be called
        // from a background-thread continuation before this form's first
        // Show(), and InvokeRequired reads false (not throws) with no
        // handle yet, which would silently skip the marshal it needs.
        _ = Handle;
    }

    public void SetSubtitle(string subtitle)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetSubtitle(subtitle));
            return;
        }
        subtitleLabel.Text = subtitle;
    }

    public void SetRowStatus(string key, string statusText, RowState state)
    {
        if (!rows.TryGetValue(key, out var row))
        {
            return;
        }
        if (InvokeRequired)
        {
            BeginInvoke(() => SetRowStatus(key, statusText, state));
            return;
        }

        var color = state switch
        {
            RowState.Ready => DarkTheme.Green,
            RowState.Warn => DarkTheme.Warn,
            _ => DarkTheme.Muted,
        };
        row.Status.Text = statusText;
        row.Status.ForeColor = color;
        row.BarFill.BackColor = state == RowState.Starting ? DarkTheme.Accent : color;
        row.BarFill.Width = state == RowState.Starting
            ? (int)(row.BarTrack.Width * 0.06)
            : row.BarTrack.Width;
    }

    private void CenterOnScreen()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2);
    }
}

internal enum RowState
{
    Starting,
    Ready,
    Warn,
}

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace Mana.NativeLauncher.Dictation;

// #849: a lightweight floating pill indicator shown while holding the
// dictation key, displaying live listening/transcribing status without
// taking focus from the active typing target.
public sealed class DictationIndicatorForm : Form
{
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_TOPMOST = 0x00000008;

    private readonly Label statusLabel;
    private readonly System.Windows.Forms.Timer autoHideTimer;

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
            return cp;
        }
    }

    public DictationIndicatorForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        Size = new Size(180, 42);
        BackColor = Color.FromArgb(24, 24, 28);
        DoubleBuffered = true;

        statusLabel = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(240, 240, 245),
            Text = "Listening..."
        };
        Controls.Add(statusLabel);

        autoHideTimer = new System.Windows.Forms.Timer { Interval = 2000 };
        autoHideTimer.Tick += (_, _) =>
        {
            autoHideTimer.Stop();
            Hide();
        };

        PositionNearCursor();
    }

    public void ShowListening()
    {
        autoHideTimer.Stop();
        statusLabel.Text = "🎙 Listening...";
        statusLabel.ForeColor = Color.FromArgb(130, 220, 160);
        PositionNearCursor();
        Show();
    }

    public void ShowTranscribing()
    {
        autoHideTimer.Stop();
        statusLabel.Text = "⏳ Transcribing...";
        statusLabel.ForeColor = Color.FromArgb(140, 190, 255);
        Show();
    }

    public void ShowMessage(string message, bool isWarning = false)
    {
        autoHideTimer.Stop();
        statusLabel.Text = message;
        statusLabel.ForeColor = isWarning ? Color.FromArgb(255, 160, 120) : Color.FromArgb(240, 240, 245);
        Show();
        autoHideTimer.Start();
    }

    public void HideIndicator()
    {
        autoHideTimer.Stop();
        Hide();
    }

    private void PositionNearCursor()
    {
        var cursor = Cursor.Position;
        var screen = Screen.FromPoint(cursor);
        var targetX = cursor.X + 20;
        var targetY = cursor.Y + 20;

        // Keep inside screen bounds
        if (targetX + Width > screen.WorkingArea.Right)
        {
            targetX = cursor.X - Width - 10;
        }
        if (targetY + Height > screen.WorkingArea.Bottom)
        {
            targetY = cursor.Y - Height - 10;
        }

        Location = new Point(Math.Max(screen.WorkingArea.Left, targetX), Math.Max(screen.WorkingArea.Top, targetY));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        // Draw pill border
        using var pen = new Pen(Color.FromArgb(70, 70, 85), 1.5f);
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using var path = GetRoundedRectangle(rect, 10);
        e.Graphics.DrawPath(pen, path);
    }

    private static GraphicsPath GetRoundedRectangle(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        var arc = new Rectangle(bounds.Location, new Size(diameter, diameter));

        path.AddArc(arc, 180, 90);
        arc.X = bounds.Right - diameter;
        path.AddArc(arc, 270, 90);
        arc.Y = bounds.Bottom - diameter;
        path.AddArc(arc, 0, 90);
        arc.X = bounds.Left;
        path.AddArc(arc, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            autoHideTimer.Dispose();
        }
        base.Dispose(disposing);
    }
}

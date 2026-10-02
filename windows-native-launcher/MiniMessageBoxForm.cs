using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #844: a small floating message box under Mana when chat bubbles are on,
// opened by clicking her avatar, so I can reply without opening the chat window.
// Enter sends or queues through the same path as the chat window's box (#657, #668)
// and closes the box immediately. Esc or clicking away closes the box without sending.
internal sealed class MiniMessageBoxForm : Form
{
    internal const int BoxWidth = 320;
    internal const int BoxHeight = 40;
    private const int PadX = 10;

    private readonly Func<string, Task> submitOrEnqueueAsync;
    private readonly Func<Rectangle?> anchor;
    private readonly TextBox input = new();

    public MiniMessageBoxForm(Func<string, Task> submitOrEnqueueAsync, Func<Rectangle?> anchor)
    {
        this.submitOrEnqueueAsync = submitOrEnqueueAsync;
        this.anchor = anchor;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(BoxWidth, BoxHeight);
        BackColor = DarkTheme.IsLight ? Color.White : DarkTheme.Panel2;
        DarkTheme.Track(this);

        Deactivate += (_, _) => HideAndClear();

        input.BorderStyle = BorderStyle.None;
        input.BackColor = BackColor;
        input.ForeColor = DarkTheme.Text;
        input.Font = new Font("Segoe UI", 10.5F);
        input.PlaceholderText = "Message Mana...";
        input.Location = new Point(PadX, (BoxHeight - input.PreferredHeight) / 2);
        input.Width = BoxWidth - (PadX * 2);
        input.KeyDown += OnInputKeyDown;

        Controls.Add(input);

        DarkTheme.Changed += () =>
        {
            BackColor = DarkTheme.IsLight ? Color.White : DarkTheme.Panel2;
            input.BackColor = BackColor;
            input.ForeColor = DarkTheme.Text;
            Invalidate();
        };
    }

    internal TextBox InputBox => input;

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(DarkTheme.Border);
        e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
    }

    public static Point Place(Size boxSize, Rectangle? avatar, Rectangle workArea)
    {
        if (avatar is not Rectangle a)
        {
            return new Point(workArea.Left + ((workArea.Width - boxSize.Width) / 2), workArea.Bottom - boxSize.Height - 8);
        }
        var minX = workArea.Left + 8;
        var x = Math.Clamp(a.Left + ((a.Width - boxSize.Width) / 2), minX, Math.Max(minX, workArea.Right - boxSize.Width - 8));
        var below = a.Bottom + 6;
        var above = a.Top - boxSize.Height - 6;
        var top = workArea.Top + 8;
        var bottom = workArea.Bottom - boxSize.Height - 8;
        var y = below <= bottom ? below : above >= top ? above : Math.Max(top, bottom);
        return new Point(x, y);
    }

    public void Toggle()
    {
        if (Visible)
        {
            HideAndClear();
        }
        else
        {
            Open();
        }
    }

    public void Open()
    {
        var avatar = anchor();
        var area = (avatar is Rectangle r ? Screen.FromRectangle(r) : Screen.PrimaryScreen)?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = Place(Size, avatar, area);
        input.Text = string.Empty;
        Show();
        Activate();
        input.Focus();
    }

    public void HideAndClear()
    {
        Hide();
        input.Text = string.Empty;
    }

    private async void OnInputKeyDown(object? sender, KeyEventArgs e)
    {
        switch (e.KeyCode)
        {
            case Keys.Escape:
                e.SuppressKeyPress = true;
                HideAndClear();
                break;

            case Keys.Enter when !e.Shift:
                e.SuppressKeyPress = true;
                var text = input.Text.Trim();
                HideAndClear();
                if (text.Length > 0)
                {
                    await submitOrEnqueueAsync(text);
                }
                break;
        }
    }
}

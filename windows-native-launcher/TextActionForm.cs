using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #680 part 1: select text in any app, press the text-action hotkey
// (Ctrl+Alt+Shift+T), pick an action from this small menu at the cursor; the
// result shows here with Copy and Replace. It never takes focus, so the
// app keeps its selection and Replace pastes straight back into it. The
// selection is read via UI Automation first, else a Ctrl+C with the
// clipboard put back afterwards; it's sent to the local model only
// (ManaBackendClient.RunTextActionAsync), not remembered, unless "Ask
// Mana..." turns it into a normal turn. Refuses in password fields and in
// admin windows Mana can't type into, saying why.
internal sealed class TextActionForm : Form
{
    private static TextActionForm? open;

    private readonly ManaBackendClient backendClient;
    private readonly Action<string> askMana;
    private readonly nint target;
    private readonly string selection;
    private readonly FlowLayoutPanel panel = new() { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
    private readonly System.Windows.Forms.Timer dismissTimer = new() { Interval = 100 };
    private readonly Point cursor;

    // The hotkey's handler. UI thread.
    public static async Task RunAsync(ManaBackendClient backendClient, Action<string> askMana)
    {
        open?.Close();
        var target = ForeignWindow.Foreground();
        if (target == 0 || ForeignWindow.IsOwnWindow(target))
        {
            return;
        }
        var cursor = Cursor.Position;
        var selection = "";
        string? problem = null;
        if (ForeignWindow.IsElevatedAboveUs(target))
        {
            problem = "This window runs as administrator, so Mana can't read or type in it.";
        }
        else
        {
            var (isPassword, uiaSelection) = await ForeignWindow.ReadFocusedAsync();
            if (isPassword)
            {
                problem = "Text actions are off in password fields.";
            }
            else
            {
                selection = (string.IsNullOrWhiteSpace(uiaSelection) ? await ForeignWindow.CopySelectionAsync() : uiaSelection).Trim();
                problem = selection.Length == 0 ? "Select some text first, then press the hotkey." : null;
            }
        }
        open?.Close(); // a second press while the first was still reading
        open = new TextActionForm(backendClient, askMana, target, selection, cursor, problem);
        open.Show();
    }

    private TextActionForm(ManaBackendClient backendClient, Action<string> askMana, nint target, string selection, Point cursor, string? problem)
    {
        this.backendClient = backendClient;
        this.askMana = askMana;
        this.target = target;
        this.selection = selection;
        this.cursor = cursor;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        BackColor = DarkTheme.Panel;
        ForeColor = DarkTheme.Text;
        Padding = new Padding(8);
        Controls.Add(panel);
        SizeChanged += (_, _) => KeepNearCursor();

        if (problem is not null)
        {
            panel.Controls.Add(Note(problem));
            panel.Controls.Add(MakeButton("Close", Close));
        }
        else
        {
            foreach (var action in TextAction.Load())
            {
                panel.Controls.Add(MakeButton(action.Name, () => _ = RunActionAsync(action)));
            }
            panel.Controls.Add(MakeButton("Ask Mana...", () =>
            {
                Close();
                askMana(this.selection);
            }));
        }

        // Without focus there's no Deactivate: close on a click elsewhere,
        // or once another window comes to the front.
        dismissTimer.Tick += (_, _) =>
        {
            var foreground = ForeignWindow.Foreground();
            if ((ForeignWindow.MouseButtonDown() && !Bounds.Contains(Cursor.Position))
                || (foreground != target && !ForeignWindow.IsOwnWindow(foreground)))
            {
                Close();
            }
        };
        dismissTimer.Start();
        PerformLayout();
        KeepNearCursor();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExToolWindow = 0x80;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExToolWindow | wsExNoActivate;
            return cp;
        }
    }

    private async Task RunActionAsync(TextAction action)
    {
        panel.Controls.Clear();
        panel.Controls.Add(Note($"{action.Name}..."));
        string result;
        try
        {
            result = await backendClient.RunTextActionAsync(action.Prompt, selection);
        }
        catch (Exception ex)
        {
            if (IsDisposed)
            {
                return;
            }
            panel.Controls.Clear();
            panel.Controls.Add(Note($"Mana couldn't do that: {ex.Message}"));
            panel.Controls.Add(MakeButton("Close", Close));
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        panel.Controls.Clear();
        panel.Controls.Add(new TextBox
        {
            Text = result.ReplaceLineEndings("\r\n"),
            ReadOnly = true,
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            Width = 360,
            Height = Math.Clamp(TextRenderer.MeasureText(result, Font, new Size(340, 0), TextFormatFlags.WordBreak).Height + 12, 40, 240),
            BackColor = DarkTheme.Panel2,
            ForeColor = DarkTheme.Text,
            BorderStyle = BorderStyle.None,
        });
        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
        row.Controls.Add(MakeButton("Copy", () =>
        {
            Clipboard.SetDataObject(result, copy: true, retryTimes: 5, retryDelay: 50);
            Close();
        }));
        row.Controls.Add(MakeButton("Replace", () => _ = ReplaceAsync(result)));
        row.Controls.Add(MakeButton("Close", Close));
        panel.Controls.Add(row);
    }

    private async Task ReplaceAsync(string result)
    {
        dismissTimer.Stop();
        if (ForeignWindow.Foreground() != target)
        {
            // Focus moved on: pasting now would land somewhere else.
            Clipboard.SetDataObject(result, copy: true, retryTimes: 5, retryDelay: 50);
            panel.Controls.Clear();
            panel.Controls.Add(Note("That window isn't in front any more -- the result is on the clipboard."));
            panel.Controls.Add(MakeButton("Close", Close));
            return;
        }
        Hide();
        await ForeignWindow.PasteAsync(result);
        Close();
    }

    // Beside the cursor, kept on its screen.
    private void KeepNearCursor()
    {
        var area = Screen.FromPoint(cursor).WorkingArea;
        Location = new Point(
            Math.Clamp(cursor.X + 8, area.Left, Math.Max(area.Left, area.Right - Width)),
            Math.Clamp(cursor.Y + 12, area.Top, Math.Max(area.Top, area.Bottom - Height)));
    }

    private static Label Note(string text) =>
        new() { Text = text, AutoSize = true, MaximumSize = new Size(360, 0), ForeColor = DarkTheme.Text, Margin = new Padding(3, 3, 3, 6) };

    private static Button MakeButton(string text, Action onClick)
    {
        var button = new Button { Text = text, AutoSize = true, MinimumSize = new Size(120, 0), TextAlign = ContentAlignment.MiddleLeft };
        DarkTheme.ApplyButton(button);
        button.Click += (_, _) => onClick();
        return button;
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        dismissTimer.Dispose();
        if (open == this)
        {
            open = null;
        }
        base.OnFormClosed(e);
    }
}

using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #525: a small always-on-top text-entry popup, toggled by a global
// hotkey, for typing a command instead of speaking one. Created once and
// reused (Hide, not Close/Dispose) for instant reappearance -- matches
// windows-launcher/quick-entry's own lazy-create-and-reuse behavior.
// #689: the hotkey (default Ctrl+Alt+Space, remappable or off in Settings >
// Hotkeys) lives in GlobalHotkeyListener with the others.
internal sealed class QuickEntryForm : Form
{
    private readonly Func<string, Task<bool>> submitAsync;
    private readonly TextBox input = new();

    public QuickEntryForm(Func<string, Task<bool>> submitAsync)
    {
        this.submitAsync = submitAsync;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        // Shared DarkTheme palette (see that file) instead of this form's
        // own one-off dark color -- was already dark, just a different
        // dark than every other window in the app.
        BackColor = DarkTheme.Panel;
        DarkTheme.Track(this); // #688: recoloured on a live theme switch
        Width = 480;
        Height = 40;
        Deactivate += (_, _) => HideAndClear();

        input.Dock = DockStyle.Fill;
        input.BorderStyle = BorderStyle.None;
        input.BackColor = BackColor;
        input.ForeColor = DarkTheme.Text;
        input.Font = new Font("Segoe UI", 12F);
        input.KeyDown += OnInputKeyDown;
        Controls.Add(input);
    }

    public void ToggleVisible()
    {
        if (Visible)
        {
            HideAndClear();
            return;
        }

        OpenWith(string.Empty);
    }

    // #680: also "Ask Mana..." on selected text, opened with that text
    // quoted and the cursor after it, ready for the question.
    public void OpenWith(string text)
    {
        var screen = Screen.PrimaryScreen!.WorkingArea;
        Location = new Point(screen.Left + (screen.Width - Width) / 2, screen.Top + 24);
        input.Text = text;
        Show();
        Activate();
        input.Focus();
        input.SelectionStart = text.Length;
    }

    private void HideAndClear()
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

            case Keys.Enter:
                e.SuppressKeyPress = true;
                var text = input.Text;
                // Hide immediately -- the submission itself (potentially a
                // full turn: backend calls, TTS) runs in the background,
                // same as how pressing Enter in windows-launcher's own
                // quick-entry box dismisses it right away rather than
                // waiting on the reply.
                HideAndClear();
                await submitAsync(text);
                break;
        }
    }
}

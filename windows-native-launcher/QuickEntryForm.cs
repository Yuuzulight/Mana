using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #525: a small always-on-top text-entry popup, toggled by a global
// hotkey, for typing a command instead of speaking one. Created once and
// reused (Hide, not Close/Dispose) for instant reappearance -- matches
// windows-launcher/quick-entry's own lazy-create-and-reuse behavior.
internal sealed class QuickEntryForm : Form
{
    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int WM_HOTKEY = 0x0312;
    private const int HotkeyId = 0xA525; // arbitrary, just needs to be unique within this process
    private const uint ModControl = 0x0002;
    private const uint ModAlt = 0x0001;
    private const uint VkSpace = 0x20;

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

        Hide();
        // Forces the native window handle (and OnHandleCreated's hotkey
        // registration) to exist immediately -- a hidden top-level Form
        // otherwise defers handle creation until the first real Show(),
        // which would leave the hotkey unregistered until this popup is
        // shown once by some other means.
        _ = Handle;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Ctrl+Alt+Space -- unregistered by any common app the launcher is
        // likely to run alongside. Silently no-ops if something else
        // already holds it (e.g. a second launcher instance); there's no
        // user-facing settings surface yet to pick a different one.
        RegisterHotKey(Handle, HotkeyId, ModControl | ModAlt, VkSpace);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HotkeyId)
        {
            ToggleVisible();
            return;
        }
        base.WndProc(ref m);
    }

    private void ToggleVisible()
    {
        if (Visible)
        {
            HideAndClear();
            return;
        }

        var screen = Screen.PrimaryScreen!.WorkingArea;
        Location = new Point(screen.Left + (screen.Width - Width) / 2, screen.Top + 24);
        input.Text = string.Empty;
        Show();
        Activate();
        input.Focus();
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

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            UnregisterHotKey(Handle, HotkeyId);
        }
        base.Dispose(disposing);
    }
}

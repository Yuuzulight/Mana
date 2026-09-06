using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #585: a message-only native window (no visible UI, just a handle to
// receive WM_HOTKEY) that owns the global "what just happened?" clip
// hotkey -- Ctrl+Alt+Shift+M, matching windows-launcher's own default.
// Same RegisterHotKey/WM_HOTKEY shape as VisionHotkeyListener, kept as
// its own small class rather than a shared generalization, same
// independent-PR reasoning this batch has used elsewhere (e.g. #576/#583
// over stacking on an unmerged PR).
internal sealed class ClipHotkeyListener : NativeWindow, IDisposable
{
    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int WM_HOTKEY = 0x0312;
    private const int HotkeyId = 0xA585; // arbitrary, just needs to be unique within this process
    private const uint ModControl = 0x0002;
    private const uint ModAlt = 0x0001;
    private const uint ModShift = 0x0004;
    private const uint VkM = 0x4D;

    private readonly Action onHotkey;

    public ClipHotkeyListener(Action onHotkey)
    {
        this.onHotkey = onHotkey;

        var env = Environment.GetEnvironmentVariable("MANA_CLIP_HOTKEY");
        var disabled = env == "0" || string.Equals(env, "off", StringComparison.OrdinalIgnoreCase);
        if (disabled)
        {
            return;
        }

        CreateHandle(new CreateParams());
        // Silently no-ops if something else already holds this
        // combination -- matches VisionHotkeyListener's own hotkey-
        // registration comment; no user-facing settings surface exists
        // yet to report or resolve the conflict.
        RegisterHotKey(Handle, HotkeyId, ModControl | ModAlt | ModShift, VkM);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HotkeyId)
        {
            onHotkey();
            return;
        }
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        if (Handle != IntPtr.Zero)
        {
            UnregisterHotKey(Handle, HotkeyId);
            DestroyHandle();
        }
    }
}

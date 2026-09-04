using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #523: a message-only native window (no visible UI, just a handle to
// receive WM_HOTKEY) that owns the global "look at my screen" hotkey --
// Ctrl+Alt+M, matching windows-launcher's own default. That reference
// also lets MANA_VISION_HOTKEY remap to an arbitrary accelerator string;
// this port only supports enable/disable via the same env var ("0" or
// "off"), not remapping -- parsing arbitrary hotkey strings is a
// separate feature this issue doesn't ask for.
internal sealed class VisionHotkeyListener : NativeWindow, IDisposable
{
    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int WM_HOTKEY = 0x0312;
    private const int HotkeyId = 0xA523; // arbitrary, just needs to be unique within this process
    private const uint ModControl = 0x0002;
    private const uint ModAlt = 0x0001;
    private const uint VkM = 0x4D;

    private readonly Action onHotkey;

    public VisionHotkeyListener(Action onHotkey)
    {
        this.onHotkey = onHotkey;

        var env = Environment.GetEnvironmentVariable("MANA_VISION_HOTKEY");
        var disabled = env == "0" || string.Equals(env, "off", StringComparison.OrdinalIgnoreCase);
        if (disabled)
        {
            return;
        }

        CreateHandle(new CreateParams());
        // Silently no-ops if something else already holds this
        // combination -- matches QuickEntryForm's own hotkey-registration
        // comment; no user-facing settings surface exists yet to report
        // or resolve the conflict.
        RegisterHotKey(Handle, HotkeyId, ModControl | ModAlt, VkM);
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

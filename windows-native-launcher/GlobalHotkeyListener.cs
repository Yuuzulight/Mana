using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #584: a message-only native window (no visible UI, just a handle to
// receive WM_HOTKEY) that owns the window show/hide toggle and
// manual-interrupt global hotkeys -- same RegisterHotKey/WM_HOTKEY shape
// as VisionHotkeyListener/QuickEntryForm's own hotkey registration, but
// generalized to register several at once instead of copying that same
// ~50 lines a third and fourth time for these two. Each hotkey can be
// disabled via its own env var, same "0"/"off" convention
// VisionHotkeyListener already uses -- remapping to an arbitrary
// accelerator string is still out of scope, same reasoning as that class.
internal sealed class GlobalHotkeyListener : NativeWindow, IDisposable
{
    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int WM_HOTKEY = 0x0312;

    public const uint ModControl = 0x0002;
    public const uint ModAlt = 0x0001;

    private readonly Dictionary<int, Action> handlers = new();
    private readonly List<int> registeredIds = new();

    public GlobalHotkeyListener(params (int Id, uint Modifiers, uint VirtualKey, string? DisableEnvVar, Action OnHotkey)[] hotkeys)
    {
        CreateHandle(new CreateParams());
        foreach (var (id, modifiers, virtualKey, disableEnvVar, onHotkey) in hotkeys)
        {
            var env = disableEnvVar is null ? null : Environment.GetEnvironmentVariable(disableEnvVar);
            var disabled = env == "0" || string.Equals(env, "off", StringComparison.OrdinalIgnoreCase);
            if (disabled)
            {
                continue;
            }

            handlers[id] = onHotkey;
            // Silently no-ops if something else already holds this
            // combination -- matches VisionHotkeyListener/QuickEntryForm's
            // own hotkey-registration comment; no user-facing settings
            // surface exists yet to report or resolve the conflict.
            if (RegisterHotKey(Handle, id, modifiers, virtualKey))
            {
                registeredIds.Add(id);
            }
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && handlers.TryGetValue(m.WParam.ToInt32(), out var onHotkey))
        {
            onHotkey();
            return;
        }
        base.WndProc(ref m);
    }

    public void Dispose()
    {
        foreach (var id in registeredIds)
        {
            UnregisterHotKey(Handle, id);
        }
        DestroyHandle();
    }
}

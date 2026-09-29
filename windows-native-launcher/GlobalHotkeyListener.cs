using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #584: a message-only native window (no visible UI, just a handle to
// receive WM_HOTKEY) that owns the global hotkeys. #689: now all of them
// (window toggle, quick entry, vision, clip, interrupt -- see
// HotkeyBindings), each remappable from Settings > Hotkeys and rebound
// live through Bind. A hotkey's env var set to "0"/"off" still turns it
// off for good, as before.
internal sealed class GlobalHotkeyListener : NativeWindow, IDisposable
{
    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int WM_HOTKEY = 0x0312;

    private readonly Dictionary<int, Action> handlers = new();
    private readonly Dictionary<int, string> disabledBy = new();
    private readonly HashSet<int> registered = new();

    public GlobalHotkeyListener(params (int Id, Keys? Keys, string? DisableEnvVar, Action OnHotkey)[] hotkeys)
    {
        CreateHandle(new CreateParams());
        foreach (var (id, keys, disableEnvVar, onHotkey) in hotkeys)
        {
            var env = disableEnvVar is null ? null : Environment.GetEnvironmentVariable(disableEnvVar);
            if (env == "0" || string.Equals(env, "off", StringComparison.OrdinalIgnoreCase))
            {
                disabledBy[id] = disableEnvVar!;
                continue;
            }
            handlers[id] = onHotkey;
            if (Bind(id, keys) is { } error)
            {
                Console.WriteLine($"GlobalHotkeyListener: {error}");
            }
        }
    }

    // Registers `keys` for hotkey `id` (null = off), replacing its old
    // combination. Returns why it couldn't (the hotkey is then off), or null.
    public string? Bind(int id, Keys? keys)
    {
        if (disabledBy.TryGetValue(id, out var envVar))
        {
            return keys is null ? null : $"Turned off by {envVar} in .env.";
        }
        if (registered.Remove(id))
        {
            UnregisterHotKey(Handle, id);
        }
        if (keys is not Keys k)
        {
            return null;
        }
        if (!RegisterHotKey(Handle, id, Modifiers(k), (uint)(k & Keys.KeyCode)))
        {
            return $"Another app is already using {HotkeyBindings.Format(k)}.";
        }
        registered.Add(id);
        return null;
    }

    internal static uint Modifiers(Keys keys) =>
        ((keys & Keys.Alt) != 0 ? 0x1u : 0) | ((keys & Keys.Control) != 0 ? 0x2u : 0) | ((keys & Keys.Shift) != 0 ? 0x4u : 0);

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
        foreach (var id in registered)
        {
            UnregisterHotKey(Handle, id);
        }
        registered.Clear();
        DestroyHandle();
    }
}

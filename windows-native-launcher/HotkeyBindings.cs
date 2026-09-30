using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #689: every global hotkey, its default, and what Settings > Hotkeys saved
// for it (ManaSettingsStore.Hotkeys: action key -> "Ctrl+Alt+Shift+W", "" = off).
// Defaults are the native ones (not Electron's), Ctrl+Alt+Shift+letter:
// Ctrl+Alt is AltGr, so Ctrl+Alt+letter swallowed characters on Polish and
// German keyboards (AltGr+E is € / ę, AltGr+M is µ...). The letters also
// skip Polish AltGr+Shift capitals (Ą Ć Ę Ł Ń Ó Ś Ź Ż: A C E L N O S X Z),
// hence camera on V and listening on H. A binding saved in Settings is
// kept as it is; only never-changed ones move to the new defaults.
internal sealed record HotkeyAction(string Key, string Label, Keys Default, string? DisableEnvVar)
{
    public int Id => 0xA500 + Array.IndexOf(HotkeyBindings.Actions, this); // unique within the listener's window
}

internal static class HotkeyBindings
{
    public static readonly HotkeyAction[] Actions =
    {
        new("window", "Show / hide the chat window", Keys.Control | Keys.Alt | Keys.Shift | Keys.W, "MANA_WINDOW_HOTKEY"),
        new("quickEntry", "Quick entry (type to Mana)", Keys.Control | Keys.Alt | Keys.Space, null),
        new("vision", "Look at my screen", Keys.Control | Keys.Alt | Keys.Shift | Keys.M, "MANA_VISION_HOTKEY"),
        new("clip", "What just happened? (clip)", Keys.Control | Keys.Alt | Keys.Shift | Keys.R, "MANA_CLIP_HOTKEY"),
        new("camera", "Look through my camera (snapshot)", Keys.Control | Keys.Alt | Keys.Shift | Keys.V, "MANA_CAMERA_HOTKEY"),
        new("interrupt", "Stop Mana talking", Keys.Control | Keys.Alt | Keys.Shift | Keys.I, "MANA_INTERRUPT_HOTKEY"),
        new("textAction", "Text actions on selected text", Keys.Control | Keys.Alt | Keys.Shift | Keys.T, "MANA_TEXT_ACTION_HOTKEY"),
        new("translate", "Translate my screen", Keys.Control | Keys.Alt | Keys.Shift | Keys.J, "MANA_TRANSLATE_HOTKEY"), // #910
        new("listening", "Turn listening on / off (mic)", Keys.Control | Keys.Alt | Keys.Shift | Keys.H, "MANA_LISTENING_HOTKEY"),
    };

    private static readonly KeysConverter Converter = new();

    // The action's binding: its default if never changed or unreadable, null if turned off.
    public static Keys? Resolve(IReadOnlyDictionary<string, string>? saved, HotkeyAction action)
    {
        if (saved is null || !saved.TryGetValue(action.Key, out var text))
        {
            return action.Default;
        }
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }
        try
        {
            return Converter.ConvertFromInvariantString(text) is Keys keys && IsValid(keys) ? keys : action.Default;
        }
        catch (ArgumentException)
        {
            return action.Default;
        }
    }

    public static string Format(Keys? keys) => keys is Keys k ? Converter.ConvertToInvariantString(k) ?? k.ToString() : "Off";

    // Ctrl and/or Alt plus one real key -- Shift alone (or no modifier)
    // would swallow ordinary typing everywhere.
    public static bool IsValid(Keys keys) =>
        (keys & (Keys.Control | Keys.Alt)) != 0
        && (keys & Keys.KeyCode) is not (Keys.None or Keys.ControlKey or Keys.ShiftKey or Keys.Menu or Keys.LWin or Keys.RWin);

    // The other action already using `keys`, if any.
    public static HotkeyAction? ConflictFor(IReadOnlyDictionary<string, string>? saved, HotkeyAction action, Keys keys) =>
        Actions.FirstOrDefault(other => other != action && Resolve(saved, other) == keys);
}

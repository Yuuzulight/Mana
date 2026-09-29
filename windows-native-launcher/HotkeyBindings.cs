using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #689: every global hotkey, its default, and what Settings > Hotkeys saved
// for it (ManaSettingsStore.Hotkeys: action key -> "Ctrl+Alt+W", "" = off).
// Defaults are the native ones (not Electron's): the window toggle is
// Ctrl+Alt+W because quick entry already had Ctrl+Alt+Space.
internal sealed record HotkeyAction(string Key, string Label, Keys Default, string? DisableEnvVar)
{
    public int Id => 0xA500 + Array.IndexOf(HotkeyBindings.Actions, this); // unique within the listener's window
}

internal static class HotkeyBindings
{
    public static readonly HotkeyAction[] Actions =
    {
        new("window", "Show / hide the chat window", Keys.Control | Keys.Alt | Keys.W, "MANA_WINDOW_HOTKEY"),
        new("quickEntry", "Quick entry (type to Mana)", Keys.Control | Keys.Alt | Keys.Space, null),
        new("vision", "Look at my screen", Keys.Control | Keys.Alt | Keys.M, "MANA_VISION_HOTKEY"),
        new("clip", "What just happened? (clip)", Keys.Control | Keys.Alt | Keys.Shift | Keys.M, "MANA_CLIP_HOTKEY"),
        new("camera", "Look through my camera (snapshot)", Keys.Control | Keys.Alt | Keys.C, "MANA_CAMERA_HOTKEY"),
        new("interrupt", "Stop Mana talking", Keys.Control | Keys.Alt | Keys.I, "MANA_INTERRUPT_HOTKEY"),
        new("textAction", "Text actions on selected text", Keys.Control | Keys.Alt | Keys.T, "MANA_TEXT_ACTION_HOTKEY"),
        new("translate", "Translate my screen", Keys.Control | Keys.Alt | Keys.J, "MANA_TRANSLATE_HOTKEY"), // #910
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

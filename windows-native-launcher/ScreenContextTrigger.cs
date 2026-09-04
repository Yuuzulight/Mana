using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

// #522: ports windows-launcher/renderer/screen-context-trigger.js
// verbatim -- a fixed keyword list gate for whether a turn should trigger
// a screen read at all, instead of reading on every single turn (a
// privacy/perf concern) or requiring an explicit hotkey.
internal static class ScreenContextTrigger
{
    // Ports renderer.js's cleanTranscriptText -- strips bracketed/
    // parenthesized STT artifacts (e.g. "[BLANK_AUDIO]", "(background
    // noise)") before the keyword gate runs. Without this, a keyword
    // that happens to land inside such a span (e.g. "(game audio)")
    // would trigger a screen read the reference wouldn't have -- the
    // gate must see the same text the reference gates on, not a
    // superset of it.
    public static string CleanTranscriptText(string transcript)
    {
        var text = transcript ?? "";
        text = Regex.Replace(text, @"\[[^\]]+\]", " ");
        text = Regex.Replace(text, @"\([^)]+\)", " ");
        text = Regex.Replace(text, @"[.。,…]+$", "");
        text = Regex.Replace(text, @"\s+", " ");
        return text.Trim();
    }

    private static readonly IReadOnlyList<string> Keywords = new[]
    {
        "screen", "see", "seeing", "look", "looking", "read", "icon",
        "image", "picture", "menu", "chat", "game", "ffxiv", "map",
        "quest", "window", "error",
    };

    // normalizedText is expected already-lowercased.
    public static bool ShouldReadScreenForCommand(string normalizedText, bool gamingModeActive, bool keywordGateEnabled = true)
    {
        if (!gamingModeActive && !keywordGateEnabled)
        {
            return true;
        }

        foreach (var keyword in Keywords)
        {
            if (normalizedText.Contains(keyword))
            {
                return true;
            }
        }
        return false;
    }
}

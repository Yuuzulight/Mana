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

    // #648: "this"/"here"/"that" point at something rather than naming
    // it. Not a trigger on its own (far too common a word) -- it only
    // changes *what* a keyword-gated read reads: what's under the cursor.
    private static readonly Regex Deictic = new(@"\b(this|that|these|those|here)\b");

    // normalizedText is expected already-lowercased.
    public static bool IsDeictic(string normalizedText) => Deictic.IsMatch(normalizedText);

    // Q36: a bare "what's this?" / "what does that say?" / "read this" /
    // "explain that" reads the screen on its own -- unless there's a recent
    // topic it could mean instead: the rule is that the previous voice turn
    // was under RecentTopicMs ago (null = no previous turn).
    public const long RecentTopicMs = 60_000;
    private static readonly Regex ShortDeicticQuestion = new(
        @"^(what(?:'s| is|s)? (?:this|that)|what does (?:this|that) (?:say|mean)|(?:read|explain) (?:this|that))[\s?!.]*$");

    public static bool ReadsScreenOnItsOwn(string normalizedText, long? msSincePreviousTurn) =>
        ShortDeicticQuestion.IsMatch(normalizedText) && !(msSincePreviousTurn < RecentTopicMs);

    // Q37: "here" is the cursor, except "next to you"/"behind you"/"where
    // you are" -- then it's next to Mana's avatar.
    private static readonly Regex NearAvatar = new(@"\b(next to you|beside you|behind you|where you are)\b");

    public static bool MeansNearAvatar(string normalizedText) => NearAvatar.IsMatch(normalizedText);

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

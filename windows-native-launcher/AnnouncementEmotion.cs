using System;
using System.Collections.Generic;

namespace Mana.NativeLauncher;

// #1024: the emotion an announcement (a line nobody just asked for) is said
// with, which sets Qwen3-TTS's pace. The payload's own emotion wins, else
// its kind's; null is her neutral voice.
internal static class AnnouncementEmotion
{
    // The tags tools/qwen3tts_service.py's EMOTION_RATES paces; any other
    // tag sounds neutral there, so it isn't sent.
    private static readonly HashSet<string> Paced = new(StringComparer.OrdinalIgnoreCase)
    {
        "excited", "surprised", "happy", "angry", "thinking", "disappointed", "sad",
    };

    private static readonly Dictionary<string, string?> ByKind = new(StringComparer.OrdinalIgnoreCase)
    {
        ["reminder"] = null,              // calm
        ["reminder-late"] = "surprised",  // fired well after its time: more alert
        ["briefing"] = "happy",
        ["handoff"] = "excited",
        ["self-work"] = "happy",          // a PR ready (not spoken yet)
        ["failed"] = "sad",               // apologetic
        ["check-in"] = null,              // #1148: gentle -- calm, never sad or cheerful
    };

    internal static string? For(string? emotion, string? kind)
    {
        if (!string.IsNullOrWhiteSpace(emotion))
        {
            return Paced.Contains(emotion) ? emotion.ToLowerInvariant() : null;
        }
        return kind is not null && ByKind.TryGetValue(kind, out var byKind) ? byKind : null;
    }
}

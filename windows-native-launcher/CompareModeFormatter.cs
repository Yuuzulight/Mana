using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Mana.NativeLauncher;

// #527: ports windows-launcher/renderer/compare-mode.js's pure logic
// verbatim -- pure, no WinForms dependency, so it's directly testable.
internal static class CompareModeFormatter
{
    // Preselects "default"/"quality" when both exist (a meaningful
    // contrast out of the box); otherwise the first two distinct keys,
    // or the same key twice if there's only one profile at all.
    public static (string? A, string? B) PickDefaultProfiles(IEnumerable<string> profileKeys)
    {
        var keys = profileKeys.ToList();
        if (keys.Count == 0)
        {
            return (null, null);
        }
        if (keys.Contains("default") && keys.Contains("quality"))
        {
            return ("default", "quality");
        }
        var first = keys[0];
        var second = keys.FirstOrDefault(k => k != first) ?? first;
        return (first, second);
    }

    // Labels a compare column with which GGUF a profile is actually
    // using -- profiles silently fall back to a smaller model when the
    // preferred file isn't downloaded, which would otherwise make two
    // "different" profiles compare identically with no indication why.
    public static string FormatProfileLabel(string? key, IReadOnlyDictionary<string, ManaModelProfile> profiles)
    {
        if (key is null || !profiles.TryGetValue(key, out var profile))
        {
            return key ?? "";
        }

        if (!profile.Available)
        {
            return $"{profile.Label ?? key} (unavailable)";
        }

        var modelFile = string.IsNullOrEmpty(profile.SelectedModel) ? null : Path.GetFileName(profile.SelectedModel);
        return modelFile is not null ? $"{profile.Label ?? key} ({modelFile})" : profile.Label ?? key;
    }
}

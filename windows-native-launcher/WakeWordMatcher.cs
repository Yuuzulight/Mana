using System;
using System.Linq;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

// Ports windows-launcher/renderer/speech-filters.js's fuzzyMatchesWakeWord
// and renderer.js's extractWakeCommand -- wake-word matching runs on the
// Whisper transcript text (after transcription), not real-time acoustic
// detection, matching the Electron app's actual behavior.
internal static class WakeWordMatcher
{
    internal static readonly string[] WakeWords =
    {
        "mana",
        "manah",
        "manna",
        "mannah",
        "myna",
        "ma na",
        "mah na",
        "my na",
        "wake up",
        "wake-up",
    };

    // Only ever called on a candidate word that already failed the exact
    // WakeWords match -- a tight maxDistance (default 1) keeps this from
    // firing on unrelated short words while still catching a single
    // dropped, swapped, or misheard letter.
    internal static bool FuzzyMatchesWakeWord(string candidateWord, int maxDistance = 1)
    {
        var normalized = (candidateWord ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        foreach (var word in WakeWords)
        {
            // Multi-word wake phrases ("wake up") aren't fuzzy-matched
            // word-by-word here -- the exact-match regex path in
            // ExtractWakeCommand already handles those; fuzzy matching is
            // specifically for single mis-transcribed name variants.
            if (word.Contains(' '))
            {
                continue;
            }

            if (LevenshteinDistance(normalized, word) <= maxDistance)
            {
                return true;
            }
        }

        return false;
    }

    private static int LevenshteinDistance(string a, string b)
    {
        var rows = a.Length + 1;
        var cols = b.Length + 1;
        var dist = new int[rows, cols];
        for (var i = 0; i < rows; i++)
        {
            dist[i, 0] = i;
        }

        for (var j = 0; j < cols; j++)
        {
            dist[0, j] = j;
        }

        for (var i = 1; i < rows; i++)
        {
            for (var j = 1; j < cols; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                dist[i, j] = Math.Min(
                    Math.Min(dist[i - 1, j] + 1, dist[i, j - 1] + 1),
                    dist[i - 1, j - 1] + cost);
            }
        }

        return dist[rows - 1, cols - 1];
    }

    // Tries an exact/regex wake-word match first (also correcting two
    // known Whisper mis-transcriptions of "mana"), then falls back to a
    // fuzzy check on the first 3 words. Returns null if no wake word is
    // found anywhere; otherwise the command text following the wake word,
    // or the whole normalized transcript if nothing follows it.
    internal static string? ExtractWakeCommand(string transcript)
    {
        var normalized = Regex.Replace(transcript.Trim(), @"\bminor\b", "mana", RegexOptions.IgnoreCase);
        normalized = Regex.Replace(normalized, @"\bman a\b", "mana", RegexOptions.IgnoreCase);

        var escapedWords = WakeWords.Select(word => Regex.Escape(word).Replace(@"\ ", @"\s+"));
        var wakePattern = new Regex(
            $@"\b(?:{string.Join("|", escapedWords)})\b[\s,.:;!?-]*",
            RegexOptions.IgnoreCase);

        var wakeMatch = wakePattern.Match(normalized);
        if (wakeMatch.Success)
        {
            var command = normalized[(wakeMatch.Index + wakeMatch.Length)..].Trim();
            return command.Length > 0 ? command : normalized;
        }

        var words = normalized.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        for (var i = 0; i < Math.Min(words.Length, 3); i++)
        {
            var stripped = Regex.Replace(words[i], @"[.,!?;:]+$", "");
            if (FuzzyMatchesWakeWord(stripped))
            {
                var command = string.Join(" ", words.Skip(i + 1)).Trim();
                return command.Length > 0 ? command : normalized;
            }
        }

        return null;
    }
}

using System;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher.Dictation;

// #849: cleans up raw transcripts from Whisper (removes filler words,
// fixes punctuation/capitalization, and strips stray artifacts).
public static partial class DictationCleaner
{
    // Regex matching common filler words and hesitation tokens
    [GeneratedRegex(@"\b(um|uh|erm|er|ah)\b[\s,]*", RegexOptions.IgnoreCase)]
    private static partial Regex FillerWordsRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex MultipleSpacesRegex();

    [GeneratedRegex(@"\s*([,.\?!;:])\s*")]
    private static partial Regex PunctuationSpacingRegex();

    [GeneratedRegex(@"^[,.\?!;:\s]+")]
    private static partial Regex LeadingPunctuationRegex();

    [GeneratedRegex(@"([,;:]{2,})")]
    private static partial Regex DuplicatePunctuationRegex();

    public static string Clean(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return "";
        }

        var text = raw.Trim();

        // 1. Remove filler words
        text = FillerWordsRegex().Replace(text, " ");

        // 2. Remove duplicate punctuation artifacts like ", ," or ", ."
        text = DuplicatePunctuationRegex().Replace(text, ",");

        // 3. Fix leading punctuation if a filler at the start left a comma
        text = LeadingPunctuationRegex().Replace(text, "");

        // 4. Clean up spaces around punctuation
        text = PunctuationSpacingRegex().Replace(text, "$1 ");

        // 5. Collapse multiple whitespace runs
        text = MultipleSpacesRegex().Replace(text, " ").Trim();

        if (text.Length == 0)
        {
            return "";
        }

        // 6. Ensure initial letter is capitalized if it's a letter
        if (char.IsLower(text[0]))
        {
            text = char.ToUpperInvariant(text[0]) + text[1..];
        }

        return text;
    }
}

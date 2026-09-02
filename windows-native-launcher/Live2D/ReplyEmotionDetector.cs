using System.Text.RegularExpressions;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: decides which avatar state a reply should trigger,
// ported from windows-launcher/renderer/reply-emotion.js. Mana places
// kaomojis and emoji in nearly every reply and picks them deliberately, so
// they're the clearest emotional signal she gives -- checked before
// falling back to a small set of English mood words for replies that have
// neither.
//
// Emoji are matched by Unicode code point (not by regex) -- .NET regex has
// no equivalent to JS's \u{XXXXX} brace escape for supplementary-plane
// characters, and hand-transcribing ~40 codepoints into surrogate-pair
// regex escapes is exactly the kind of thing that's easy to get subtly
// wrong without a way to test it visually. Kaomoji patterns are ordinary
// BMP characters (no \u{} escapes in the JS source either), so those port
// directly as literal regex text, same as the original.
internal static class ReplyEmotionDetector
{
    private static readonly (int[] CodePoints, string Mood)[] EmojiMoods =
    [
        (new[] { 0x1F60A, 0x1F642, 0x1F604, 0x1F600, 0x1F601, 0x263A, 0x1F638 }, "smile"),
        (new[] { 0x1F606, 0x1F923, 0x1F602 }, "haha"),
        (new[] { 0x1F609, 0x1F61C, 0x1F61D, 0x1F92A }, "wink"),
        (new[] { 0x1F605 }, "phew"),
        (new[]
        {
            0x1F970, 0x1F60D, 0x1F496, 0x1F495, 0x1F497, 0x1F493, 0x2764, 0x1F9E1,
            0x1F49B, 0x1F49A, 0x1F499, 0x1F49C, 0x1F90D, 0x1F5A4, 0x2763, 0x2665,
        }, "heart"),
        (new[] { 0x1F622, 0x1F62D, 0x1F97A, 0x1F63F }, "sniff"),
        (new[] { 0x1F620, 0x1F621, 0x1F4A2 }, "grr"),
        (new[] { 0x1F922, 0x1F92E, 0x1F612 }, "disgust"),
        (new[] { 0x1F62E, 0x1F632, 0x1F633 }, "gasp"),
        (new[] { 0x1F914 }, "hmm"),
        (new[] { 0x1F634, 0x1F4A4 }, "yawn"),
        (new[] { 0x2728, 0x1F31F, 0x2B50 }, "sparkle"),
        (new[] { 0x1F389, 0x1F38A, 0x1F973 }, "yay"),
        (new[] { 0x1F44D }, "thumbs up"),
        (new[] { 0x1F44B }, "wave"),
    ];

    // A short parenthesized cluster, optionally with "arm" characters
    // outside, e.g. (＾▽＾), (T_T), ヽ(´▽`)ノ, ¯\_(ツ)_/¯.
    private static readonly Regex KaomojiPattern = new(
        @"(?:[¯ヽ٩ᕕoO\\/]\s?[\\_]{0,2})?[（(][^（）()\s]{1,18}[)）](?:[_]{0,2}[\\/]?[¯ノ۶ᕗoO]?)?",
        RegexOptions.Compiled);

    private static readonly (Regex Pattern, string Word)[] KaomojiMoods =
    [
        (new Regex(@"[TТ╥;уД]_|_[TТ╥;]|;;|℃゜|(?:゜|｡)(?:\.|,)", RegexOptions.Compiled), "sniff"),
        (new Regex(@"[＃#╬凸]", RegexOptions.Compiled), "grr"),
        (new Regex(@"｀[^´]*´", RegexOptions.Compiled), "hmph"),
        (new Regex(@"><|>[_.]<", RegexOptions.Compiled), "ow"),
        (new Regex(@"[♡♥❤]", RegexOptions.Compiled), "heart"),
        (new Regex(@"ツ", RegexOptions.Compiled), "shrug"),
        // Flat/dead "unimpressed" eyes read as disgust, not a smile -- must
        // be checked before the smile catch-all below (shares the "-" glyph).
        (new Regex(@"-_-|-\.-|=_=|・_・", RegexOptions.Compiled), "disgust"),
        (new Regex(@"[＾^▽‿ᴗ◕●•ω≧≦￣´｀°˘‾-]", RegexOptions.Compiled), "smile"),
    ];

    // A parenthesized span only counts as a kaomoji when it contains
    // face-like symbols; "(really)" and "(see docs)" must never match.
    private static readonly Regex KaomojiFaceChars = new(
        @"[＾▽‿ᴗω◕●•｀´≧≦￣ДツТ°｡♡♥❤╥＃#╬><;~＿=]|^[（(][TtoOxXuUnNmMwWvV_.;'""~^=-]+[)）]$",
        RegexOptions.Compiled);

    // Positive/energetic moods read as "excited"; sniff/ow read as "sad";
    // grr/hmph read as "angry"; disgust is its own state. Anything
    // ambiguous (thinking, relief, a shrug) is left as plain "talking"
    // rather than guessing.
    private static readonly Dictionary<string, string> MoodState = new()
    {
        ["smile"] = "excited",
        ["haha"] = "excited",
        ["wink"] = "excited",
        ["sparkle"] = "excited",
        ["yay"] = "excited",
        ["thumbs up"] = "excited",
        ["wave"] = "excited",
        ["heart"] = "excited",
        ["gasp"] = "excited",
        ["sniff"] = "sad",
        ["ow"] = "sad",
        ["grr"] = "angry",
        ["hmph"] = "angry",
        ["disgust"] = "disgusted",
        ["hmm"] = "talking",
        ["yawn"] = "talking",
        ["shrug"] = "talking",
        ["phew"] = "talking",
    };

    private static readonly Regex ExcitedWords = new(
        @"!{2,}|\b(yay|yes|nice|great|awesome|amazing|let'?s go|finally|hehe|haha)\b",
        RegexOptions.Compiled);

    private static readonly Regex AngryWords = new(
        @"\b(angry|mad|annoyed|ugh|hmph|stupid|idiot|seriously|how dare|stop that)\b",
        RegexOptions.Compiled);

    private static readonly Regex DisgustWords = new(
        @"\b(disgusting|disgusted|gross|grossed out|yuck+y?|ew+|nasty|revolting|repulsive|eww+)\b",
        RegexOptions.Compiled);

    public static string DetectReplyEmotion(string? text)
    {
        var normalized = text ?? "";

        var moodState = MoodToState(DetectTextMood(normalized));
        if (moodState is not null)
        {
            return moodState;
        }

        var lower = normalized.ToLowerInvariant();
        if (DisgustWords.IsMatch(lower))
        {
            return "disgusted";
        }
        if (AngryWords.IsMatch(lower))
        {
            return "angry";
        }
        if (ExcitedWords.IsMatch(lower))
        {
            return "excited";
        }
        return "talking";
    }

    public static string? MoodToState(string? mood) =>
        mood is not null && MoodState.TryGetValue(mood, out var state) ? state : null;

    // Scans the text for the first kaomoji or emoji mood signal, or null.
    public static string? DetectTextMood(string? text)
    {
        var value = text ?? "";

        foreach (Match match in KaomojiPattern.Matches(value))
        {
            var mood = KaomojiMood(match.Value);
            if (mood is not null)
            {
                return mood;
            }
        }

        foreach (var (codePoints, mood) in EmojiMoods)
        {
            if (ContainsAnyCodePoint(value, codePoints))
            {
                return mood;
            }
        }

        return null;
    }

    private static string? KaomojiMood(string face)
    {
        if (!KaomojiFaceChars.IsMatch(face))
        {
            return null;
        }
        foreach (var (pattern, word) in KaomojiMoods)
        {
            if (pattern.IsMatch(face))
            {
                return word;
            }
        }
        return null;
    }

    private static bool ContainsAnyCodePoint(string text, int[] codePoints)
    {
        var index = 0;
        while (index < text.Length)
        {
            // char.ConvertToUtf32 throws on a lone/unpaired surrogate --
            // reachable in practice (a truncated reply, a malformed
            // upstream response) and, unlike a JS regex test (which
            // simply doesn't match malformed UTF-16 rather than
            // throwing), would otherwise crash this call entirely instead
            // of degrading to "no emoji match here". Check the pairing
            // explicitly and skip one code unit at a time when it's
            // unpaired, instead of assuming every surrogate is valid.
            var isPairedSurrogate = char.IsSurrogatePair(text, index);
            if (!isPairedSurrogate && char.IsSurrogate(text[index]))
            {
                index += 1;
                continue;
            }

            var codePoint = char.ConvertToUtf32(text, index);
            if (Array.IndexOf(codePoints, codePoint) >= 0)
            {
                return true;
            }
            index += isPairedSurrogate ? 2 : 1;
        }
        return false;
    }
}

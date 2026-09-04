namespace Mana.NativeLauncher;

// #522: ports windows-launcher/accessibility-tree.js almost verbatim --
// pure parsing/quality-gating for read-accessibility-tree.ps1's stdout
// (that same script, reused unmodified from windows-launcher/scripts/,
// not reimplemented here -- see ScreenContextReader's own comment on why).
internal readonly record struct AccessibilityTreeResult(int OwnerPid, string Text);

internal static class AccessibilityTreeOutputParser
{
    private const string OutputSeparator = "---";
    private const int MinUsableLines = 3;
    private const int MinUsableChars = 20;

    // Parses "PID:<n>\n---\n<extracted text>".
    public static AccessibilityTreeResult Parse(string stdout)
    {
        var raw = stdout ?? "";
        var separatorIndex = raw.IndexOf(OutputSeparator, System.StringComparison.Ordinal);
        if (separatorIndex == -1)
        {
            return new AccessibilityTreeResult(0, "");
        }

        var pidLine = raw[..separatorIndex];
        var match = System.Text.RegularExpressions.Regex.Match(pidLine, @"PID:(\d+)");
        var ownerPid = match.Success ? int.Parse(match.Groups[1].Value) : 0;
        var text = raw[(separatorIndex + OutputSeparator.Length)..].Trim();
        return new AccessibilityTreeResult(ownerPid, text);
    }

    // A token tree (one generic pane, a blank window title) technically
    // isn't a failure, but carries nothing worth using over OCR -- require
    // a few distinct non-empty lines and a minimum length before trusting
    // it over the screenshot+OCR fallback.
    public static bool IsUsable(string text)
    {
        var value = (text ?? "").Trim();
        var lineCount = 0;
        foreach (var line in value.Split('\n'))
        {
            if (line.Trim().Length > 0)
            {
                lineCount++;
            }
        }
        return lineCount >= MinUsableLines && value.Length >= MinUsableChars;
    }
}

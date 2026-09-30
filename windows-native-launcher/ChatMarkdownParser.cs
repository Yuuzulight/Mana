using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

internal enum MarkdownBlockType
{
    Paragraph,
    Header,
    BulletItem,
    NumberedItem,
    CodeBlock,
    Quote,
    Table,
}

// One inline formatted span within a block -- Code implies neither Bold
// nor Italic is meaningful (a code span keeps its own monospace font
// regardless), same as CommonMark's own code-span precedence. Link is the
// target URL of a link span (its Text is what's shown).
internal readonly record struct MarkdownRun(string Text, bool Bold, bool Italic, bool Code, bool Strike = false, string? Link = null);

// Rows is set only for a Table: row 0 is the header, each cell a run list.
// Level is a Header's 1-6 (#1127's docs view uses it; the chat doesn't).
internal readonly record struct MarkdownBlock(MarkdownBlockType Type, IReadOnlyList<MarkdownRun> Runs, IReadOnlyList<IReadOnlyList<IReadOnlyList<MarkdownRun>>>? Rows = null, int Level = 0);

// #521: a hand-built Markdown parser scoped to what a chat reply actually
// needs -- headers, bold, italic, strikethrough, inline code, links, fenced
// code blocks, bullet/numbered lists, blockquotes and (#686) GFM tables.
// No nested blocks (a list inside a quote shows its marker literally), no
// multi-line paragraph joining (each non-blank, non-special line is its
// own paragraph block), no column alignment, and no nested emphasis -- a
// flat run model, so "**bold *and* still bold**" renders as one bold run
// containing the literal characters "bold *and* still bold" rather than
// nesting italic inside bold. Not a crash, just a cosmetic limitation
// accepted for this scope. Pure: no WinForms dependency, so it's directly
// testable; ChatView lays these blocks out and draws them.
internal static class ChatMarkdownParser
{
    private static readonly Regex HeaderPattern = new(@"^(#{1,6})\s+(.*)$", RegexOptions.Compiled);
    private static readonly Regex BulletPattern = new(@"^[-*]\s+(.*)$", RegexOptions.Compiled);
    private static readonly Regex NumberedPattern = new(@"^\d+\.\s+.*$", RegexOptions.Compiled);
    private static readonly Regex QuotePattern = new(@"^\s*>\s?(.*)$", RegexOptions.Compiled);
    private static readonly Regex TableDelimiter = new(@"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$", RegexOptions.Compiled);
    private static readonly Regex CellSplit = new(@"(?<!\\)\|", RegexOptions.Compiled);
    // "\|" and "\\" in a cell are a literal | and \ (#1140: pages' tables escape both).
    private static readonly Regex CellEscape = new(@"\\([\\|])", RegexOptions.Compiled);

    // **bold**, `code`, [text](url), <url>, ~~strike~~, bare http(s) URL,
    // *italic*, _italic_ -- checked in this order per match attempt so
    // "**bold**" isn't misread as two "*"-italic spans. A bare URL may not
    // end in sentence punctuation, so "see https://x.com." links x.com.
    private static readonly Regex InlineToken = new(
        @"\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+""[^""]*"")?\s*\)|<(https?://[^\s>]+)>|~~(.+?)~~|(https?://[^\s<>]*[^\s<>.,;:!?)\]'""*_~])|\*(.+?)\*|_(.+?)_",
        RegexOptions.Compiled);

    public static IReadOnlyList<MarkdownBlock> Parse(string? markdown)
    {
        var blocks = new List<MarkdownBlock>();
        var lines = (markdown ?? "").Replace("\r\n", "\n").Split('\n');
        var i = 0;

        while (i < lines.Length)
        {
            var line = lines[i];

            if (line.TrimStart().StartsWith("```"))
            {
                var codeLines = new List<string>();
                i++;
                while (i < lines.Length && !lines[i].TrimStart().StartsWith("```"))
                {
                    codeLines.Add(lines[i]);
                    i++;
                }
                i++; // skip the closing fence, or just end of input if unterminated
                blocks.Add(new MarkdownBlock(
                    MarkdownBlockType.CodeBlock,
                    new[] { new MarkdownRun(string.Join("\n", codeLines), false, false, true) }));
                continue;
            }

            // GFM table: a header row, a |---|:--:| delimiter row with the
            // same number of columns, then every following line that still
            // has a pipe in it.
            if (line.Contains('|') && i + 1 < lines.Length && lines[i + 1].Contains('|') && TableDelimiter.IsMatch(lines[i + 1])
                && CellTexts(line).Count == CellTexts(lines[i + 1]).Count)
            {
                var header = CellTexts(line).Select(ParseInline).ToList();
                var rows = new List<IReadOnlyList<IReadOnlyList<MarkdownRun>>> { header };
                i += 2;
                while (i < lines.Length && lines[i].Contains('|'))
                {
                    var cells = CellTexts(lines[i]).Select(ParseInline).ToList();
                    // Every row gets exactly the header's column count, as in GFM.
                    rows.Add(Enumerable.Range(0, header.Count)
                        .Select(c => c < cells.Count ? cells[c] : (IReadOnlyList<MarkdownRun>)System.Array.Empty<MarkdownRun>())
                        .ToList());
                    i++;
                }
                blocks.Add(new MarkdownBlock(MarkdownBlockType.Table, System.Array.Empty<MarkdownRun>(), rows));
                continue;
            }

            var headerMatch = HeaderPattern.Match(line);
            if (headerMatch.Success)
            {
                blocks.Add(new MarkdownBlock(MarkdownBlockType.Header, ParseInline(headerMatch.Groups[2].Value), Level: headerMatch.Groups[1].Length));
                i++;
                continue;
            }

            var bulletMatch = BulletPattern.Match(line);
            if (bulletMatch.Success)
            {
                blocks.Add(new MarkdownBlock(MarkdownBlockType.BulletItem, ParseInline(bulletMatch.Groups[1].Value)));
                i++;
                continue;
            }

            if (NumberedPattern.IsMatch(line))
            {
                // The "1. " prefix stays as literal text -- the source
                // already carries correct numbering, nothing to compute.
                blocks.Add(new MarkdownBlock(MarkdownBlockType.NumberedItem, ParseInline(line)));
                i++;
                continue;
            }

            var quoteMatch = QuotePattern.Match(line);
            if (quoteMatch.Success)
            {
                if (!string.IsNullOrWhiteSpace(quoteMatch.Groups[1].Value))
                {
                    blocks.Add(new MarkdownBlock(MarkdownBlockType.Quote, ParseInline(quoteMatch.Groups[1].Value)));
                }
                i++;
                continue;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                i++;
                continue;
            }

            blocks.Add(new MarkdownBlock(MarkdownBlockType.Paragraph, ParseInline(line)));
            i++;
        }

        return blocks;
    }

    // "| a | b \| c |" -> "a", "b | c"; outer pipes are optional.
    private static List<string> CellTexts(string row)
    {
        var trimmed = row.Trim();
        if (trimmed.StartsWith('|'))
        {
            trimmed = trimmed[1..];
        }
        if (trimmed.EndsWith('|') && !trimmed.EndsWith("\\|"))
        {
            trimmed = trimmed[..^1];
        }
        return CellSplit.Split(trimmed).Select(c => CellEscape.Replace(c.Trim(), "$1")).ToList();
    }

    private static IReadOnlyList<MarkdownRun> ParseInline(string text)
    {
        var runs = new List<MarkdownRun>();
        var lastIndex = 0;

        foreach (Match match in InlineToken.Matches(text))
        {
            if (match.Index > lastIndex)
            {
                runs.Add(new MarkdownRun(text[lastIndex..match.Index], false, false, false));
            }

            var g = match.Groups;
            runs.Add(
                g[1].Success ? new MarkdownRun(g[1].Value, true, false, false)
                : g[2].Success ? new MarkdownRun(g[2].Value, false, false, true)
                : g[3].Success ? new MarkdownRun(g[3].Value, false, false, false, Link: g[4].Value)
                : g[5].Success ? new MarkdownRun(g[5].Value, false, false, false, Link: g[5].Value)
                : g[6].Success ? new MarkdownRun(g[6].Value, false, false, false, Strike: true)
                : g[7].Success ? new MarkdownRun(g[7].Value, false, false, false, Link: g[7].Value)
                : new MarkdownRun(g[8].Success ? g[8].Value : g[9].Value, false, true, false));

            lastIndex = match.Index + match.Length;
        }

        if (lastIndex < text.Length)
        {
            runs.Add(new MarkdownRun(text[lastIndex..], false, false, false));
        }

        return runs;
    }
}

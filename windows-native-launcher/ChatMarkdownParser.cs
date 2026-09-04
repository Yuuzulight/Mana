using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

internal enum MarkdownBlockType
{
    Paragraph,
    Header,
    BulletItem,
    NumberedItem,
    CodeBlock,
}

// One inline formatted span within a block -- Code implies neither Bold
// nor Italic is meaningful (a code span keeps its own monospace font
// regardless), same as CommonMark's own code-span precedence.
internal readonly record struct MarkdownRun(string Text, bool Bold, bool Italic, bool Code);

internal readonly record struct MarkdownBlock(MarkdownBlockType Type, IReadOnlyList<MarkdownRun> Runs);

// #521: a hand-built Markdown parser scoped to what a chat reply actually
// needs -- headers, bold, italic, inline code, fenced code blocks,
// bullet/numbered lists. No tables, no nested blockquotes, no multi-line
// paragraph joining (each non-blank, non-special line is its own
// paragraph block), and no nested emphasis -- a flat run model, so
// "**bold *and* still bold**" renders as one bold run containing the
// literal characters "bold *and* still bold" rather than nesting italic
// inside bold. Not a crash, just a cosmetic limitation accepted for this
// scope. Pure: no WinForms dependency, so it's directly testable;
// ChatMarkdown.Append is what actually applies these blocks to a
// RichTextBox.
internal static class ChatMarkdownParser
{
    private static readonly Regex HeaderPattern = new(@"^(#{1,6})\s+(.*)$", RegexOptions.Compiled);
    private static readonly Regex BulletPattern = new(@"^[-*]\s+(.*)$", RegexOptions.Compiled);
    private static readonly Regex NumberedPattern = new(@"^\d+\.\s+.*$", RegexOptions.Compiled);

    // **bold**, `code`, *italic*, _italic_ -- checked in this order per
    // match attempt so "**bold**" isn't misread as two "*"-italic spans.
    private static readonly Regex InlineToken = new(@"\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*|_(.+?)_", RegexOptions.Compiled);

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

            var headerMatch = HeaderPattern.Match(line);
            if (headerMatch.Success)
            {
                blocks.Add(new MarkdownBlock(MarkdownBlockType.Header, ParseInline(headerMatch.Groups[2].Value)));
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

            if (match.Groups[1].Success)
            {
                runs.Add(new MarkdownRun(match.Groups[1].Value, true, false, false));
            }
            else if (match.Groups[2].Success)
            {
                runs.Add(new MarkdownRun(match.Groups[2].Value, false, false, true));
            }
            else if (match.Groups[3].Success)
            {
                runs.Add(new MarkdownRun(match.Groups[3].Value, false, true, false));
            }
            else if (match.Groups[4].Success)
            {
                runs.Add(new MarkdownRun(match.Groups[4].Value, false, true, false));
            }

            lastIndex = match.Index + match.Length;
        }

        if (lastIndex < text.Length)
        {
            runs.Add(new MarkdownRun(text[lastIndex..], false, false, false));
        }

        return runs;
    }
}

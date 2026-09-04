using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #521: applies ChatMarkdownParser's parsed blocks to a RichTextBox --
// the WinForms-coupled half of chat markdown rendering, kept separate
// from the parser (pure, tested) since a RichTextBox needs a real window
// handle and isn't itself unit-testable in this codebase (same split as
// DoctorPanelForm/SessionListForm's own untested WinForms-application code).
internal static class ChatMarkdown
{
    // #521 review: a fresh `new Font(...)` per run (a voice reply can be
    // many runs, many times an hour) would leak GDI handles until GC
    // finalizes them -- cached instead, keyed by the small, bounded set
    // of (family, size, style) combinations this renderer actually
    // produces. Only ever touched from the UI thread (Append's only
    // caller, ChatLogPanel, already marshals there), so a plain
    // Dictionary is fine -- no concurrent access to guard against.
    private static readonly Dictionary<(string Family, float Size, FontStyle Style), Font> FontCache = new();

    private static Font GetFont(string family, float size, FontStyle style)
    {
        var key = (family, size, style);
        if (!FontCache.TryGetValue(key, out var font))
        {
            font = new Font(family, size, style);
            FontCache[key] = font;
        }
        return font;
    }

    public static void Append(RichTextBox box, string markdown)
    {
        foreach (var block in ChatMarkdownParser.Parse(markdown))
        {
            switch (block.Type)
            {
                case MarkdownBlockType.CodeBlock:
                    AppendRun(box, block.Runs[0].Text, bold: false, italic: false, code: true);
                    box.AppendText("\n");
                    break;

                case MarkdownBlockType.BulletItem:
                    box.AppendText("• ");
                    AppendRuns(box, block.Runs);
                    box.AppendText("\n");
                    break;

                case MarkdownBlockType.Header:
                    foreach (var run in block.Runs)
                    {
                        AppendRun(box, run.Text, bold: true, run.Italic, run.Code);
                    }
                    box.AppendText("\n");
                    break;

                default: // Paragraph, NumberedItem
                    AppendRuns(box, block.Runs);
                    box.AppendText("\n");
                    break;
            }
        }
    }

    private static void AppendRuns(RichTextBox box, System.Collections.Generic.IReadOnlyList<MarkdownRun> runs)
    {
        foreach (var run in runs)
        {
            AppendRun(box, run.Text, run.Bold, run.Italic, run.Code);
        }
    }

    private static void AppendRun(RichTextBox box, string text, bool bold, bool italic, bool code)
    {
        if (text.Length == 0)
        {
            return;
        }

        var start = box.TextLength;
        box.AppendText(text);
        box.Select(start, text.Length);

        var style = FontStyle.Regular;
        if (bold)
        {
            style |= FontStyle.Bold;
        }
        if (italic)
        {
            style |= FontStyle.Italic;
        }

        box.SelectionFont = GetFont(code ? "Consolas" : box.Font.FontFamily.Name, box.Font.Size, style);
        // Always set explicitly, not just for code runs -- SelectionColor
        // otherwise inherits whatever the immediately-preceding run left
        // it as, so a code span's color would bleed into the next plain
        // run if this were only set in the `code` branch.
        box.SelectionColor = code ? DarkTheme.CodeText : box.ForeColor;

        box.SelectionLength = 0;
    }
}

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Folio;
using Folio.Skia;
using Folio.Typography;
using Folio.WinForms;

namespace Mana.NativeLauncher;

// #1127: Mana's own docs (the plugin guide, setup guides) drawn by Folio,
// in the chat window's tool panel or a window of their own -- no outside
// app for Markdown. The Markdown goes through the chat's own parser
// (ChatMarkdownParser) into plain HTML (MarkdownHtml). Links to other
// docs in the repo open here (Back returns), web links in the browser,
// and repo images are inlined as data: URLs, since data: is all this
// Folio build loads.
internal sealed class DocsPanel : UserControl
{
    private readonly string root;
    private readonly FolioView view = new()
    {
        Dock = DockStyle.Fill,
        Options = new FolioOptions { Fonts = new FontSettings { Source = new SystemFontSource() }, ColorScheme = DarkTheme.IsLight ? ColorScheme.Light : ColorScheme.Dark },
        AccessibleName = "Document",
    };
    private readonly Label titleLabel = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = DarkTheme.Muted, AutoEllipsis = true };
    private readonly Button backButton = new() { Text = "<", Dock = DockStyle.Left, Width = 32, Enabled = false, AccessibleName = "Back" };
    private readonly Stack<string> back = new();

    public string? CurrentPath { get; private set; }

    // ownWindowButton: an "Open in its own window" button (not in that window itself).
    public DocsPanel(string root, bool ownWindowButton = true)
    {
        this.root = Path.GetFullPath(root);
        BackColor = DarkTheme.Background;
        DarkTheme.ApplyButton(backButton);
        backButton.Click += (_, _) =>
        {
            if (back.Count > 0)
            {
                Display(back.Pop());
            }
        };
        view.LinkActivated += (_, e) =>
        {
            e.Handled = true;
            if (HtmlArtifact.IsWebLink(e.Uri))
            {
                Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true })?.Dispose();
            }
            else if (e.Uri.IsFile && ResolveDoc(e.Uri.LocalPath) is { } doc && doc != CurrentPath)
            {
                Open(doc);
            }
        };

        var bar = new Panel { Dock = DockStyle.Top, Height = 30, Padding = new Padding(4) };
        bar.Controls.Add(titleLabel);
        if (ownWindowButton)
        {
            var ownWindow = new Button { Text = "Open in its own window", Dock = DockStyle.Right, AutoSize = true };
            DarkTheme.ApplyButton(ownWindow);
            ownWindow.Click += (_, _) =>
            {
                if (CurrentPath is { } path)
                {
                    OpenWindow(root, path);
                }
            };
            bar.Controls.Add(ownWindow);
        }
        bar.Controls.Add(backButton);
        Controls.Add(view);
        Controls.Add(bar);
    }

    public static void OpenWindow(string root, string path)
    {
        var docs = new DocsPanel(root, ownWindowButton: false) { Dock = DockStyle.Fill };
        var window = new Form { Text = "Mana docs", Width = 900, Height = 700, StartPosition = FormStartPosition.CenterScreen };
        DarkTheme.ApplyForm(window);
        window.Controls.Add(docs);
        docs.Open(path);
        window.Show();
    }

    // Opens a doc (a path under the repo), remembering the current one for Back.
    public void Open(string path)
    {
        if (CurrentPath is { } current)
        {
            back.Push(current);
        }
        Display(path);
    }

    private void Display(string path)
    {
        CurrentPath = path;
        backButton.Enabled = back.Count > 0;
        titleLabel.Text = Path.GetRelativePath(root, path);
        string markdown;
        try
        {
            markdown = File.ReadAllText(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            markdown = $"# Couldn't open {Path.GetFileName(path)}\n\n{ex.Message}";
        }
        var folder = Path.GetDirectoryName(path)!;
        view.LoadHtml(MarkdownHtml.ToHtml(markdown, src => ImageDataUrl(folder, src)), new Uri(folder + Path.DirectorySeparatorChar));
    }

    // A Markdown doc under the repo: the file, or a folder's README.md. Null
    // for anything else (including anything outside the repo).
    internal string? ResolveDoc(string localPath)
    {
        var full = Path.GetFullPath(localPath);
        if (Directory.Exists(full))
        {
            full = Path.Combine(full, "README.md");
        }
        return Inside(full) && full.EndsWith(".md", StringComparison.OrdinalIgnoreCase) && File.Exists(full) ? full : null;
    }

    private bool Inside(string full) => full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private const long MaxImageBytes = 4 * 1024 * 1024;

    // A repo image as a data: URL; null for web images, missing files or
    // anything outside the repo (its alt text shows instead).
    internal string? ImageDataUrl(string folder, string src)
    {
        if (Uri.TryCreate(src, UriKind.Absolute, out var absolute) && !absolute.IsFile)
        {
            return null;
        }
        var full = Path.GetFullPath(Path.Combine(folder, Uri.UnescapeDataString(src)));
        var mime = Path.GetExtension(full).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            _ => null,
        };
        if (mime is null || !Inside(full))
        {
            return null;
        }
        try
        {
            return new FileInfo(full).Length > MaxImageBytes ? null : $"data:{mime};base64,{Convert.ToBase64String(File.ReadAllBytes(full))}";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}

// #1127: ChatMarkdownParser's blocks as a small HTML page in the chat
// window's colours. Everything from the Markdown is escaped (raw HTML in a
// doc shows as text); soft-wrapped lines are joined first, since the
// parser makes each line its own paragraph.
internal static class MarkdownHtml
{
    private static readonly Regex BlockStart = new(@"^\s*(#{1,6}\s|[-*]\s|\d+\.\s|>|```)", RegexOptions.Compiled);
    private static readonly Regex NumberPrefix = new(@"^\s*\d+\.\s+", RegexOptions.Compiled);

    public static string ToHtml(string markdown, Func<string, string?> imageSource)
    {
        var html = new StringBuilder("<!doctype html><html><head><meta charset=\"utf-8\"><style>").Append(Style()).Append("</style></head><body>");
        string? list = null; // the open <ul>/<ol>
        foreach (var block in ChatMarkdownParser.Parse(JoinSoftWraps(markdown)))
        {
            var wanted = block.Type switch { MarkdownBlockType.BulletItem => "ul", MarkdownBlockType.NumberedItem => "ol", _ => null };
            if (wanted != list)
            {
                html.Append(list is null ? "" : $"</{list}>").Append(wanted is null ? "" : $"<{wanted}>");
                list = wanted;
            }
            switch (block.Type)
            {
                case MarkdownBlockType.Header:
                    var h = Math.Clamp(block.Level, 1, 6);
                    html.Append($"<h{h}>").Append(Inline(block.Runs, imageSource)).Append($"</h{h}>");
                    break;
                case MarkdownBlockType.BulletItem:
                    html.Append("<li>").Append(Inline(block.Runs, imageSource)).Append("</li>");
                    break;
                case MarkdownBlockType.NumberedItem:
                    var runs = block.Runs.ToList();
                    if (runs.Count > 0)
                    {
                        runs[0] = runs[0] with { Text = NumberPrefix.Replace(runs[0].Text, "") };
                    }
                    html.Append("<li>").Append(Inline(runs, imageSource)).Append("</li>");
                    break;
                case MarkdownBlockType.CodeBlock:
                    html.Append("<pre><code>").Append(Escape(block.Runs[0].Text)).Append("</code></pre>");
                    break;
                case MarkdownBlockType.Quote:
                    html.Append("<blockquote>").Append(Inline(block.Runs, imageSource)).Append("</blockquote>");
                    break;
                case MarkdownBlockType.Table:
                    html.Append("<table>");
                    for (var r = 0; r < block.Rows!.Count; r++)
                    {
                        var cell = r == 0 ? "th" : "td";
                        html.Append("<tr>");
                        foreach (var runsInCell in block.Rows[r])
                        {
                            html.Append($"<{cell}>").Append(Inline(runsInCell, imageSource)).Append($"</{cell}>");
                        }
                        html.Append("</tr>");
                    }
                    html.Append("</table>");
                    break;
                default:
                    html.Append("<p>").Append(Inline(block.Runs, imageSource)).Append("</p>");
                    break;
            }
        }
        return html.Append(list is null ? "" : $"</{list}>").Append("</body></html>").ToString();
    }

    // A plain line right after another plain line continues its paragraph.
    internal static string JoinSoftWraps(string markdown)
    {
        var lines = new List<string>();
        var inFence = false;
        foreach (var line in markdown.Replace("\r\n", "\n").Split('\n'))
        {
            var fence = line.TrimStart().StartsWith("```");
            if (!inFence && !fence && lines.Count > 0 && IsPlain(line) && IsPlain(lines[^1]))
            {
                lines[^1] += " " + line.Trim();
            }
            else
            {
                lines.Add(line);
            }
            inFence ^= fence;
        }
        return string.Join("\n", lines);

        static bool IsPlain(string line) => line.Trim().Length > 0 && !line.Contains('|') && !BlockStart.IsMatch(line);
    }

    // "![alt](src)" arrives as text ending "!" then a link run.
    private static string Inline(IReadOnlyList<MarkdownRun> runs, Func<string, string?> imageSource)
    {
        var html = new StringBuilder();
        for (var i = 0; i < runs.Count; i++)
        {
            var run = runs[i];
            if (run.Link is null && run.Text.EndsWith('!') && i + 1 < runs.Count && runs[i + 1] is { Link: { } src } image && image.Text != src)
            {
                html.Append(Escape(run.Text[..^1]));
                html.Append(imageSource(src) is { } data
                    ? $"<img src=\"{Escape(data)}\" alt=\"{Escape(image.Text)}\">"
                    : $"<em>{Escape(image.Text)}</em>");
                i++;
                continue;
            }
            var text = Escape(run.Text);
            if (run.Code)
            {
                text = $"<code>{text}</code>";
            }
            if (run.Bold)
            {
                text = $"<strong>{text}</strong>";
            }
            if (run.Italic)
            {
                text = $"<em>{text}</em>";
            }
            if (run.Strike)
            {
                text = $"<s>{text}</s>";
            }
            html.Append(run.Link is { } link ? $"<a href=\"{Escape(link)}\">{text}</a>" : text);
        }
        return html.ToString();
    }

    private static string Escape(string text) => WebUtility.HtmlEncode(text);

    internal static string Css(Color c) => $"#{c.R:x2}{c.G:x2}{c.B:x2}";

    // The chat window's colours and fonts (DarkTheme, so every preset).
    private static string Style() =>
        $$"""
        html { background: {{Css(DarkTheme.Background)}}; }
        body { color: {{Css(DarkTheme.Text)}}; font: 14px/1.55 "Segoe UI", sans-serif; margin: 0; padding: 12px 16px 24px; }
        h1, h2, h3, h4, h5, h6 { font-family: "Segoe UI Semibold", "Segoe UI", sans-serif; margin: 1.1em 0 0.4em; }
        h1 { font-size: 22px; } h2 { font-size: 18px; } h3 { font-size: 16px; } h4, h5, h6 { font-size: 14px; }
        a { color: {{Css(DarkTheme.Accent)}}; }
        code { font-family: Consolas, monospace; font-size: 13px; color: {{Css(DarkTheme.CodeText)}}; background: {{Css(DarkTheme.Panel2)}}; padding: 0 3px; border-radius: 4px; }
        pre { background: {{Css(DarkTheme.Panel2)}}; border: 1px solid {{Css(DarkTheme.Border)}}; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; }
        pre code { background: none; padding: 0; }
        blockquote { margin: 0.5em 0; padding-left: 10px; border-left: 3px solid {{Css(DarkTheme.Accent)}}; color: {{Css(DarkTheme.Muted)}}; }
        table { border-collapse: collapse; margin: 0.5em 0; }
        th, td { border: 1px solid {{Css(DarkTheme.Border)}}; padding: 4px 8px; text-align: left; }
        th { background: {{Css(DarkTheme.Panel2)}}; }
        img { max-width: 100%; }
        """;
}

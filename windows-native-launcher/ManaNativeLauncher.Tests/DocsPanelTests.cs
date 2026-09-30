using System;
using System.Drawing;
using System.IO;
using System.Linq;
using Folio;
using Folio.Skia;
using Folio.Typography;
using Folio.WinForms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1127: Mana's docs drawn by Folio -- the Markdown-to-HTML step and which
// links and images the docs view will follow.
public class DocsPanelTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"mana-docs-{Guid.NewGuid():N}");

    public DocsPanelTests()
    {
        Directory.CreateDirectory(Path.Combine(root, "plugins", "notes"));
        File.WriteAllText(Path.Combine(root, "plugins", "README.md"), "# Plugins");
        File.WriteAllText(Path.Combine(root, "plugins", "notes", "README.md"), "# Notes");
        File.WriteAllBytes(Path.Combine(root, "plugins", "shot.png"), new byte[] { 1, 2, 3 });
    }

    [Fact]
    public void ToHtml_UsesTheChatParser_WithLevelsListsCodeAndTables()
    {
        var html = MarkdownHtml.ToHtml(
            """
            # Guide
            Plugins live in
            this folder.

            ## Install
            - one
            - **two**
            1. first
            2. second

            ```
            <b>not bold</b>
            ```

            | Name | What |
            |---|---|
            | [notes](notes/) | `x` |

            ![shot](shot.png) and ![web](https://example.com/a.png) <script>
            """,
            src => src == "shot.png" ? "data:image/png;base64,AQID" : null);

        Assert.Contains("<h1>Guide</h1><p>Plugins live in this folder.</p><h2>Install</h2>", html);
        Assert.Contains("<ul><li>one</li><li><strong>two</strong></li></ul><ol><li>first</li><li>second</li></ol>", html);
        Assert.Contains("<pre><code>&lt;b&gt;not bold&lt;/b&gt;</code></pre>", html);
        Assert.Contains("<table><tr><th>Name</th><th>What</th></tr><tr><td><a href=\"notes/\">notes</a></td><td><code>x</code></td></tr></table>", html);
        Assert.Contains("<img src=\"data:image/png;base64,AQID\" alt=\"shot\"> and <em>web</em> &lt;script&gt;", html);
    }

    [Fact]
    public void ResolveDoc_FollowsMarkdownAndFolderReadmesInsideTheRepoOnly()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var docs = new DocsPanel(root);
            var plugins = Path.Combine(root, "plugins");
            Assert.Equal(Path.Combine(plugins, "notes", "README.md"), docs.ResolveDoc(Path.Combine(plugins, "notes")));
            Assert.Equal(Path.Combine(plugins, "README.md"), docs.ResolveDoc(Path.Combine(plugins, "notes", "..", "README.md")));
            Assert.Null(docs.ResolveDoc(Path.Combine(plugins, "shot.png")));
            Assert.Null(docs.ResolveDoc(Path.Combine(root, "..", "elsewhere.md")));

            Assert.Equal("data:image/png;base64,AQID", docs.ImageDataUrl(plugins, "shot.png"));
            Assert.Null(docs.ImageDataUrl(plugins, "../../outside.png"));
            Assert.Null(docs.ImageDataUrl(plugins, "https://example.com/a.png"));
        });
    }

    [Fact]
    public void FolioDrawsTheDocsPage()
    {
        using var view = new FolioView { Size = new Size(200, 60), Options = new FolioOptions { Fonts = new FontSettings { Source = new SystemFontSource() } } };
        view.LoadHtml(MarkdownHtml.ToHtml("# Hi", _ => null));
        using var bitmap = new Bitmap(200, 60);
        view.DrawToBitmap(bitmap, new Rectangle(0, 0, 200, 60));
        var background = bitmap.GetPixel(199, 59);
        Assert.Contains(Enumerable.Range(0, 200 * 60), i => bitmap.GetPixel(i % 200, i / 200) != background);
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}

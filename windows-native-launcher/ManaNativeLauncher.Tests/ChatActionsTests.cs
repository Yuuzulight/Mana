using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

[Collection("DarkTheme palette")] // paints with the shared static palette
public class ChatActionsTests
{
    private static ChatView NewView()
    {
        DarkTheme.ApplyPreset("violet", null);
        var view = new ChatView { Dock = System.Windows.Forms.DockStyle.None, Size = new System.Drawing.Size(700, 500) };
        view.CreateControl();
        return view;
    }

    [Fact]
    public async Task ActionsAttachToManasLatestMessage_AndANoteReplacesThemOnceRun()
    {
        using var view = NewView();
        view.AppendUserMessage("fix it");
        view.AppendReplySentence("Proposed a fix.");
        var before = view.Messages[1].Bounds.Height;

        view.AttachActions(new[]
        {
            new ChatView.ChatAction("Approve", true, () => Task.FromResult<string?>("Approved.")),
            new ChatView.ChatAction("Review", false, () => Task.FromResult<string?>(null)),
        });
        Assert.Equal(2, view.Messages[1].Actions.Count);
        Assert.True(view.Messages[1].Bounds.Height > before, "the button row should make the bubble taller");

        await view.RunActionAsync(1, 1); // Review keeps the buttons
        Assert.Equal(2, view.Messages[1].Actions.Count);

        await view.RunActionAsync(1, 0);
        Assert.Empty(view.Messages[1].Actions);
        Assert.Equal("Approved.", view.Messages[1].Note);
    }

    [Fact]
    public async Task AnArtifactMovesBehindAKeptOpenButton_InsteadOfPoppingUp()
    {
        using var view = NewView();
        DetectedArtifact? recorded = null;
        var opened = new List<ArtifactOpen>();
        view.Artifacts = artifact =>
        {
            recorded = artifact;
            return opened.Add;
        };
        view.AppendUserMessage("make a page");

        view.ReportReply("Here it is:\n```mermaid\ngraph TD; A-->B\n```\nEnjoy.");

        var mana = view.Messages[1];
        Assert.Equal("mermaid", recorded?.Language);
        Assert.Empty(opened); // nothing opens until the button is pressed
        Assert.Equal("Here it is:\nEnjoy.", mana.Text);
        Assert.Equal("Open mermaid content in new window", Assert.Single(mana.Actions).Label);
        await view.RunActionAsync(1, 0);
        Assert.Equal(new[] { ArtifactOpen.Default }, opened);

        // Edit-approval buttons go first, and their note doesn't remove it.
        view.AttachActions(new[] { new ChatView.ChatAction("Approve", true, () => Task.FromResult<string?>("Approved.")) });
        Assert.Equal(new[] { "Approve", "Open mermaid content in new window" }, mana.Actions.Select(a => a.Label));
        await view.RunActionAsync(1, 0);
        Assert.Equal("Open mermaid content in new window", Assert.Single(mana.Actions).Label);
        Assert.Equal("Approved.", mana.Note);
    }

    [Theory]
    [InlineData("<b>hi</b>", true)]
    [InlineData("<script>alert(1)</script>", false)]
    [InlineData("<canvas></canvas>", false)]
    public async Task AnHtmlArtifact_GetsAnOpenSplitButton_InManaOnlyWhenItCanBeDrawn(string page, bool inMana)
    {
        using var view = NewView();
        var opened = new List<ArtifactOpen>();
        view.Artifacts = _ => opened.Add;
        view.AppendUserMessage("make a page");
        view.ReportReply($"```html\n{page}\n```");

        var open = Assert.Single(view.Messages[1].Actions);
        Assert.Equal("Open", open.Label);
        Assert.Equal(new[] { "Open in browser", "View source", "Save as..." }, open.Menu!.Skip(1).Select(i => i.Label));
        Assert.Equal(inMana, open.Menu![0].Enabled);
        await view.RunActionAsync(1, 0); // the main part: the viewer decides (in Mana or browser)
        foreach (var item in open.Menu!)
        {
            await item.Run();
        }
        Assert.Equal(new[] { ArtifactOpen.Default, ArtifactOpen.InMana, ArtifactOpen.Browser, ArtifactOpen.Source, ArtifactOpen.SaveAs }, opened);
    }

    // #937: Folio's ArtifactClassifier decides; anything but Static goes to the browser.
    [Theory]
    [InlineData("<p>plain <b>text</b> <img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=\"></p>", false)]
    [InlineData("<header>not a head</header>", false)]
    [InlineData("<style>.a{display:grid}</style><div class=a>x</div>", false)] // Folio lays out grid and flex
    [InlineData("<SCRIPT src=x></SCRIPT>", true)]
    [InlineData("<button onclick=\"go()\">x</button>", true)]
    [InlineData("<canvas></canvas>", true)]
    [InlineData("<svg></svg>", true)]
    [InlineData("<img src=\"https://example.com/a.png\">", true)] // Folio loads nothing from the network
    public void HtmlArtifact_NeedsBrowser(string html, bool expected)
    {
        Assert.Equal(expected, HtmlArtifact.BrowserReasons(html) is not null);
    }

    [Fact]
    public void HtmlArtifact_SaysWhyAPageNeedsABrowser()
    {
        Assert.Equal("uses inline SVG", HtmlArtifact.BrowserReasons("<svg></svg>"));
    }

    [Theory]
    [InlineData("<html><head><title>t</title></head></html>", "<html><head>CSP<title>")]
    [InlineData("<!DOCTYPE html>\n<p>hi</p>", "<!DOCTYPE html>CSP\n<p>")]
    [InlineData("<p>hi</p>", "CSP<p>hi</p>")]
    public void HtmlArtifact_WithCsp_BlocksConnectionsFromTheHead(string html, string expectedStart)
    {
        const string csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'none'\">";
        Assert.StartsWith(expectedStart.Replace("CSP", csp), HtmlArtifact.WithCsp(html));
    }

    // #937: without the system fonts Folio lays text out but draws none of it.
    [Fact]
    public void TheViewerDrawsHtmlTextWithFolio()
    {
        using var viewer = new ArtifactViewerForm();
        var view = viewer.HtmlView;
        view.Size = new Size(160, 60);
        view.LoadHtml("<p style=\"margin:0; font: 40px sans-serif; color: black\">Hi</p>");
        using var bitmap = new Bitmap(160, 60);
        view.DrawToBitmap(bitmap, new Rectangle(0, 0, 160, 60));
        Assert.Contains(Enumerable.Range(0, 160 * 60), i => bitmap.GetPixel(i % 160, i / 160).R < 128);
    }

    // #1265: Folio updates merge themselves once CI passes, so a broken one
    // has to fail here: a representative artifact (a style sheet, custom
    // properties, flex, a list, a table, an SVG) draws without throwing,
    // and its text and colours come out.
    [Fact]
    public void TheViewerDrawsARepresentativeHtmlArtifact()
    {
        const string html = """
            <!DOCTYPE html>
            <html><head><meta charset="utf-8"><title>Plan</title><style>
            :root { --accent: #2563eb; }
            body { margin: 0; font: 14px sans-serif; background: #fff; color: #000; }
            h1 { font-size: 22px; margin: 6px 8px; }
            .row { display: flex; gap: 8px; padding: 0 8px; }
            .card { flex: 1; border: 1px solid #999; border-radius: 6px; padding: 4px; }
            .badge { width: 60px; height: 20px; background: var(--accent); margin: 6px 8px; }
            table { border-collapse: collapse; margin: 0 8px; } td, th { border: 1px solid #999; padding: 2px 6px; }
            </style></head><body>
            <h1>Weekly plan</h1>
            <div class="badge"></div>
            <div class="row"><div class="card"><b>Mon</b><ul><li>Stream</li><li>Edit</li></ul></div><div class="card"><b>Tue</b><p>Rest</p></div></div>
            <table><tr><th>Task</th><th>Done</th></tr><tr><td>Thumbnail</td><td>yes</td></tr></table>
            <svg width="40" height="20"><rect width="40" height="20" fill="#16a34a"/></svg>
            </body></html>
            """;
        using var viewer = new ArtifactViewerForm();
        var view = viewer.HtmlView;
        view.Size = new Size(400, 300);
        view.LoadHtml(HtmlArtifact.WithCsp(html));
        using var bitmap = new Bitmap(400, 300);
        view.DrawToBitmap(bitmap, new Rectangle(0, 0, 400, 300));
        var pixels = Enumerable.Range(0, 400 * 300).Select(i => bitmap.GetPixel(i % 400, i / 400)).ToList();
        Assert.Contains(pixels, p => p.R < 100 && p.G < 100 && p.B < 100); // text
        Assert.Contains(pixels, p => p.B > 200 && p.R < 80 && p.G < 140); // the accent badge
    }

    [Theory]
    [InlineData("https://example.com/a", true)]
    [InlineData("HTTP://example.com/", true)]
    [InlineData("mailto:a@example.com", false)]
    [InlineData("file:///C:/Windows/System32/calc.exe", false)]
    [InlineData("ms-settings:privacy", false)]
    public void HtmlArtifact_OnlyWebLinksOpen(string uri, bool expected)
    {
        Assert.Equal(expected, HtmlArtifact.IsWebLink(new Uri(uri)));
    }

    [Fact]
    public void ReplyFinished_RaisesReplyEnded()
    {
        using var view = NewView();
        var raised = 0;
        view.ReplyEnded += () => raised++;

        view.ReplyFinished();

        Assert.Equal(1, raised);
    }

    [Theory]
    [InlineData(null, true)]                              // no turn start known: offer it
    [InlineData("2026-09-28T10:00:03Z", true)]            // during the turn
    [InlineData("2026-09-28T09:59:57Z", true)]            // within the few seconds' slack
    [InlineData("2026-09-28T09:58:00Z", false)]           // from an earlier turn
    [InlineData("not a date", true)]                      // unreadable: don't hide it
    public void CreatedSince_KeepsOnlyEditsFromThisTurn(string? createdAt, bool expected)
    {
        var turnStart = new DateTime(2026, 9, 28, 10, 0, 0, DateTimeKind.Utc);
        var proposal = new ManaProposalSummary { Id = "p1", Status = "pending", CreatedAt = createdAt };

        Assert.Equal(expected, SessionListForm.CreatedSince(proposal, createdAt is null ? null : turnStart));
    }
}

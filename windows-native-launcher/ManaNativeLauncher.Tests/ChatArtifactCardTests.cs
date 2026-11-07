using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1526: a reply's artifact shows as a card inside the chat, where it was in the reply.
[Collection("DarkTheme palette")] // paints with the shared static palette
public class ChatArtifactCardTests
{
    private static ChatView NewView()
    {
        DarkTheme.ApplyPreset("violet", null);
        var view = new ChatView { Dock = DockStyle.None, Size = new Size(700, 900) };
        view.CreateControl();
        view.Artifacts = _ => _ => { };
        view.AppendUserMessage("show me");
        return view;
    }

    // More than a flat fill: something was drawn there.
    private static bool Drawn(ChatView view, Rectangle rect)
    {
        using var bitmap = new Bitmap(view.Width, view.Height);
        view.DrawToBitmap(bitmap, new Rectangle(Point.Empty, view.Size));
        var colors = new System.Collections.Generic.HashSet<int>();
        for (var x = rect.Left; x < rect.Right; x += 2)
            for (var y = rect.Top; y < rect.Bottom; y += 2)
                colors.Add(bitmap.GetPixel(x, y).ToArgb());
        return colors.Count > 3;
    }

    private static Point Middle(Rectangle r) => new(r.X + r.Width / 2, r.Y + r.Height / 2);

    [Fact]
    public void ADiagramIsDrawnInItsCard_WhereItWasInTheReply()
    {
        using var view = NewView();
        view.ReportReply("Here it is:\n```mermaid\ngraph TD\nA --> B\n```\nEnjoy.");

        var mana = view.Messages[1];
        Assert.Equal(new[] { MarkdownBlockType.Paragraph, MarkdownBlockType.Artifact, MarkdownBlockType.Paragraph }, mana.Blocks.Select(b => b.Type));
        var card = mana.ArtifactBounds;
        Assert.True(mana.Lines[0].Y < card.Top && card.Bottom < mana.Lines[^1].Y, "the card sits between the two paragraphs");
        Assert.Equal("Here it is:\nEnjoy.", mana.Text); // a picture adds no text
        Assert.Equal("graph TD\nA --> B", Assert.Single(mana.CodeBlocks).Code); // its Copy copies the source
        Assert.True(Drawn(view, view.ArtifactRect(1)), "the diagram is drawn");
        Assert.Equal("Open mermaid content in new window", Assert.Single(mana.Actions).Label); // Open stays
    }

    [Fact]
    public void AnHtmlPageShowsAsAPicture_AndGoesLiveWhenClicked()
    {
        using var view = NewView();
        view.ReportReply("A page:\n```html\n<body style=\"background:#fff\"><h1 style=\"color:#d22\">Hello</h1><p>From Mana</p></body>\n```");

        var rect = view.ArtifactRect(1);
        Assert.False(rect.IsEmpty);
        Assert.True(Drawn(view, rect), "Folio drew the page");
        Assert.Empty(view.Controls.OfType<ArtifactView>());

        view.SimulateClick(Middle(rect));
        var live = Assert.Single(view.Controls.OfType<ArtifactView>());
        Assert.Equal(rect, live.Bounds);

        Assert.True(view.SimulateCmdKey(Keys.Escape)); // Esc puts the picture back
        Assert.Empty(view.Controls.OfType<ArtifactView>());

        view.SimulateClick(Middle(rect));
        Assert.Single(view.Controls.OfType<ArtifactView>());
        view.SimulateClick(new Point(rect.X + 2, rect.Bottom + 40)); // anywhere else in the chat
        Assert.Empty(view.Controls.OfType<ArtifactView>());
    }

    [Fact]
    public void LongCodeShowsItsFirstLines_AndCopyCopiesAllOfIt()
    {
        using var view = NewView();
        var code = string.Join("\n", Enumerable.Range(1, 40).Select(i => $"print('line {i} of the script')"));
        view.ReportReply($"The script:\n```python\n{code}\n```");

        var mana = view.Messages[1];
        Assert.Equal(code, Assert.Single(mana.CodeBlocks).Code);
        Assert.Contains("print('line 12 of the script')", mana.Text);
        Assert.DoesNotContain("line 13 of", mana.Text);
        Assert.Contains("28 more lines", mana.Text);
        Assert.Equal("python", view.Messages[1].Artifact?.Language);
    }

    [Fact]
    public void AReopenedChatShowsItsArtifactsAsCardsToo()
    {
        using var view = NewView();
        view.ShowHistory(new[] { new ManaSessionTurn { User = "draw it", Assistant = "Sure:\n```mermaid\ngraph TD\nA --> B\n```" } });

        var mana = view.Messages[1];
        Assert.Contains(MarkdownBlockType.Artifact, mana.Blocks.Select(b => b.Type));
        Assert.True(Drawn(view, view.ArtifactRect(1)));
    }
}

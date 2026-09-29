using System.Drawing;
using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

[Collection("DarkTheme palette")] // paints with the shared static palette
public class ChatViewTests
{
    private static ChatView NewView(int width = 700, int height = 500)
    {
        DarkTheme.ApplyPreset("violet", null);
        var view = new ChatView { Dock = System.Windows.Forms.DockStyle.None, Size = new Size(width, height) };
        view.CreateControl(); // appends are dropped until the handle exists, same as the old chat log
        return view;
    }

    [Fact]
    public void ManasSentencesJoinOneBubbleUntilYouSpeakAgain()
    {
        using var view = NewView();
        view.AppendUserMessage("hi");
        view.AppendReplySentence("One.");
        view.AppendReplySentence("Two.");
        view.AppendUserMessage("again");
        view.AppendReplySentence("Three.");

        Assert.Equal(new[] { "You", "Mana", "You", "Mana" }, view.Messages.Select(m => m.Speaker));
        Assert.Equal("One. Two.", view.Messages[1].PlainText);
        Assert.Equal("Three.", view.Messages[3].PlainText);
    }

    [Fact]
    public void AppendSentence_ListItemsAndCodeStartTheirOwnBlocks()
    {
        var message = new ChatView.Message(fromUser: false);
        ChatView.AppendSentence(message, ChatMarkdownParser.Parse("Here's the plan."));
        ChatView.AppendSentence(message, ChatMarkdownParser.Parse("- open the file"));
        ChatView.AppendSentence(message, ChatMarkdownParser.Parse("Then **save** it."));

        Assert.Equal(new[] { MarkdownBlockType.Paragraph, MarkdownBlockType.BulletItem, MarkdownBlockType.Paragraph },
            message.Blocks.Select(b => b.Type));
        Assert.Equal("Here's the plan.\n• open the file\nThen save it.", message.PlainText.Replace("\r", ""));
    }

    [Fact]
    public void ConversationText_LabelsEachMessage()
    {
        using var view = NewView();
        view.AppendUserMessage("what's on my screen?");
        view.AppendReplySentence("A build log.");

        var lines = view.ConversationText().Replace("\r", "").Split("\n\n");
        Assert.Equal(new[] { "You: what's on my screen?", "Mana: A build log." }, lines);
    }

    [Fact]
    public void LongMessagesWrapAndBubblesAreHitTestable()
    {
        using var view = NewView(width: 320);
        view.AppendReplySentence(string.Join(" ", Enumerable.Repeat("glass", 60)));
        view.AppendUserMessage("ok");

        var mana = view.Messages[0];
        Assert.True(mana.Lines.Count > 3, $"expected wrapping, got {mana.Lines.Count} line(s)");
        Assert.True(mana.Bounds.Width <= 320);
        var inside = new Point(mana.Bounds.X + 5, mana.Bounds.Y + 5);
        Assert.Equal(0, view.HitTest(inside));
    }

    [Fact]
    public void SelectedText_WithinOneBubble()
    {
        using var view = NewView();
        view.AppendReplySentence("Looks like a build log.");

        view.SelectText((0, 6), (0, 10));

        Assert.True(view.HasTextSelection);
        Assert.Equal("like", view.SelectedText());
    }

    [Fact]
    public void SelectedText_AcrossBubblesJoinsWithABlankLine_AndWorksBackwards()
    {
        using var view = NewView();
        view.AppendUserMessage("fix it");
        view.AppendReplySentence("Done.");

        view.SelectText((1, 4), (0, 4)); // dragged upwards

        Assert.Equal("it\n\nDone", view.SelectedText().Replace("\r", ""));
    }

    [Fact]
    public void TextPositionAt_MapsBubbleEdgesToTheStartAndEndOfItsText()
    {
        using var view = NewView();
        view.AppendReplySentence("Looks like a build log.");
        var bubble = view.Messages[0].Bounds;

        Assert.Equal((0, 0), view.TextPositionAt(new Point(bubble.X + 2, bubble.Y + bubble.Height / 2)));
        Assert.Equal((0, view.Messages[0].Text.Length), view.TextPositionAt(new Point(bubble.Right - 2, bubble.Y + bubble.Height / 2)));
    }

    [Fact]
    public void ReportReply_RebuildsTheStreamedBubbleFromTheFullText_AndTheFallbackDoesNotRepeatIt()
    {
        using var view = NewView();
        const string reply = "Here:\n| Item | Cost |\n|---|---|\n| Tea. | 3 |";
        view.AppendUserMessage("prices?");
        // What streaming delivers: line breaks between sentences are gone.
        view.AppendReplySentence("Here: | Item | Cost | |---|---| | Tea.");
        view.AppendReplySentence("| 3 |");

        view.ReportReply(reply);
        view.AppendReplySentence(reply); // VoiceLoop's non-streamed fallback logs the reply too

        Assert.Equal(2, view.Messages.Count);
        var mana = view.Messages[1];
        Assert.Equal(new[] { MarkdownBlockType.Paragraph, MarkdownBlockType.Table }, mana.Blocks.Select(b => b.Type));
        Assert.Equal(4, mana.Cells.Count);
        Assert.Equal("Here:\nItem\tCost\nTea.\t3", mana.Text);

        view.AppendReplySentence("A later sentence."); // no user message between: a new bubble, not the finished one
        Assert.Equal(3, view.Messages.Count);
    }

    [Fact]
    public void TableCellsSitSideBySide_AndCopyTabSeparated()
    {
        using var view = NewView();
        view.ReportReply("| Name | Score |\n|---|---|\n| Mana | 10 |");

        var mana = view.Messages[0];
        var header = mana.Lines[0].Fragments;
        Assert.Equal(new[] { "Name", "Score" }, header.Select(f => f.Text));
        Assert.True(header[1].X > header[0].X + header[0].Width, "the second column starts right of the first");
        view.SelectText((0, 0), (0, mana.Text.Length));
        Assert.Equal("Name\tScore\nMana\t10", view.SelectedText());
    }

    [Fact]
    public void LinkAt_FindsTheLinkUnderThePointer_AndOnlyWebAndMailLinksAreOpened()
    {
        using var view = NewView();
        view.ReportReply("Read [the docs](https://x.dev) first.");

        var mana = view.Messages[0];
        var link = mana.Lines[0].Fragments.First(f => f.Link is not null);
        var point = new Point(mana.Bounds.X + 14 + link.X + 2, mana.Bounds.Y + 9 + mana.Lines[0].Y + 2);
        Assert.Equal("https://x.dev", view.LinkAt(point));
        Assert.Null(view.LinkAt(new Point(mana.Bounds.X + 16, point.Y)));

        Assert.True(ChatView.IsSafeLink("https://x.dev"));
        Assert.True(ChatView.IsSafeLink("mailto:a@b.c"));
        Assert.False(ChatView.IsSafeLink("file:///C:/Windows/System32/calc.exe"));
        Assert.False(ChatView.IsSafeLink("ms-settings:privacy"));
        Assert.False(ChatView.IsSafeLink("/relative"));
    }
}

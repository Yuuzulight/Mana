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
}

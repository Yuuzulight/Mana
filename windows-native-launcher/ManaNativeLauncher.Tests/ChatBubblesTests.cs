using System.Drawing;
using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #701: floating chat bubbles beside the avatar.
[Collection("DarkTheme palette")] // lays out a ChatView with the shared static palette
public class ChatBubblesTests
{
    [Theory]
    [InlineData("Hi!", 4000)]                                                     // short: the 4 s floor
    [InlineData("one two three four five six seven eight nine ten eleven twelve " +
                "thirteen fourteen fifteen sixteen seventeen eighteen", 6000)]    // 18 words: 1 s per 3
    public void LingerMs_IsAboutOneSecondPerThreeWordsWithAFloor(string text, double expected)
    {
        Assert.Equal(expected, ChatBubbleStack.LingerMs(text));
    }

    [Fact]
    public void LingerMs_IsCappedAtTwentySeconds()
    {
        Assert.Equal(20000, ChatBubbleStack.LingerMs(string.Join(' ', Enumerable.Repeat("word", 200))));
    }

    [Fact]
    public void ABubbleLingersAfterItsSentenceThenFadesOut()
    {
        var stack = new ChatBubbleStack();
        stack.Add("Hi!", now: 0, durationMs: 1000);

        stack.Tick(4999);
        Assert.Equal(1, stack.Bubbles[0].Alpha);          // 1 s of speech + 4 s reading
        stack.Tick(5000 + (ChatBubbleStack.FadeMs / 2));
        Assert.Equal(0.5, stack.Bubbles[0].Alpha, 3);
        stack.Tick(5000 + ChatBubbleStack.FadeMs);
        Assert.Empty(stack.Bubbles);
    }

    [Fact]
    public void UnknownLengthLastsUntilSpeechEnds()
    {
        var stack = new ChatBubbleStack();
        stack.Add("Sorry, that didn't work.", now: 0, durationMs: 0);
        stack.Tick(60000);
        Assert.Single(stack.Bubbles);

        stack.SpeechEnded(60000);
        stack.Tick(64000 + ChatBubbleStack.FadeMs);
        Assert.Empty(stack.Bubbles);
    }

    [Fact]
    public void ANewBubbleHalvesWhatsLeftOfTheOlderOnesReadingTime()
    {
        var stack = new ChatBubbleStack();
        stack.Add("First.", now: 0, durationMs: 1000);     // fades at 5000
        stack.Add("Second.", now: 3000, durationMs: 1000);
        Assert.Equal(4000, stack.Bubbles[0].FadeAt);        // 2000 left -> 1000
    }

    [Fact]
    public void AFourthBubblePushesTheOldestOutAtOnce()
    {
        var stack = new ChatBubbleStack();
        for (var i = 0; i < 4; i++)
        {
            stack.Add($"Sentence {i}.", now: i * 100, durationMs: 100);
        }
        Assert.Equal(300, stack.Bubbles[0].FadeAt);
        Assert.True(stack.Bubbles[1].FadeAt > 300);
    }

    [Fact]
    public void HoverPausesTheFade()
    {
        var stack = new ChatBubbleStack();
        stack.Add("Hi!", now: 0, durationMs: 1000);
        stack.Pause(10000);
        stack.Tick(14999);
        Assert.Equal(1, stack.Bubbles[0].Alpha);
    }

    [Fact]
    public void Place_SitsRightOfTheAvatarOrLeftWhenThereIsNoRoom()
    {
        var area = new Rectangle(0, 0, 1920, 1080);
        var right = ChatBubblesForm.Place(new Size(280, 100), new Rectangle(800, 700, 234, 288), area);
        Assert.Equal(new Point(1042, 744), right); // bottom level with her middle
        var left = ChatBubblesForm.Place(new Size(280, 100), new Rectangle(1680, 700, 234, 288), area);
        Assert.Equal(1680 - 8 - 280, left.X);
    }

    [Fact]
    public void LatestManaMessage_FindsTheClickedSentenceElseHerLatestMessage()
    {
        using var view = new ChatView { Dock = System.Windows.Forms.DockStyle.None, Size = new Size(700, 500) };
        view.CreateControl(); // appends are dropped until the handle exists
        Assert.Equal(-1, view.LatestManaMessage("anything"));
        view.AppendUserMessage("hello");
        view.ReportReply("Hi there. How are you?");
        view.AppendUserMessage("fine");
        view.ReportReply("Good to hear.");

        Assert.Equal(1, view.LatestManaMessage("Hi there."));
        Assert.Equal(3, view.LatestManaMessage("not said"));
    }
}

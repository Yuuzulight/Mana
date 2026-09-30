using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

[Collection("DarkTheme palette")] // chips take the shared static palette
public class MessageQueueStripTests
{
    [Fact]
    public void SendsInOrder_WithEditsAndRemovalsApplied_ThenClears()
    {
        using var strip = new MessageQueueStrip();
        strip.Add("first");
        strip.Add("second");
        strip.Add("third");
        strip.Add("fourth,\r\nwith a second line");
        strip.CreateControl(); // real native text boxes, which is where a newline could get lost
        Assert.True(strip.Controls[3].Controls[0].IsHandleCreated);

        strip.Controls[0].Controls[0].Text = "first, edited";
        ((Button)strip.Controls[1].Controls[1]).PerformClick(); // x on "second"
        strip.Controls[1].Controls[0].Text = "   "; // "third" edited down to nothing

        Assert.Equal("first, edited", strip.PeekReady());
        strip.RemoveFirst();
        Assert.Equal("fourth,\r\nwith a second line", strip.PeekReady()); // the blank chip was dropped
        Assert.Equal(1, strip.Count);

        Assert.True(strip.ClearAll());
        Assert.Equal(0, strip.Count);
        Assert.Null(strip.PeekReady());
        Assert.False(strip.ClearAll()); // second stage: nothing left to clear
    }

    [Fact]
    public void SendButton_BecomesStopWhileReplying_AndBack()
    {
        using var button = new Button { Text = "Send" };
        SessionListForm.ShowSendOrStop(button, replying: true);
        Assert.Equal("Stop", button.Text);
        Assert.True(SessionListForm.IsStopButton(button));
        SessionListForm.ShowSendOrStop(button, replying: false);
        Assert.Equal("Send", button.Text);
        Assert.False(SessionListForm.IsStopButton(button));
    }

    // The chat header shows the open chat's name; one not saved yet is "New chat".
    [Fact]
    public void ChatTitle_IsTheOpenChatsName()
    {
        var sessions = new[] { new ManaSession { SessionId = "a", Name = "FFXIV market check" }, new ManaSession { SessionId = "b" } };

        Assert.Equal("FFXIV market check", SessionListForm.ChatTitle(sessions, "a"));
        Assert.Equal("b", SessionListForm.ChatTitle(sessions, "b"));
        Assert.Equal("New chat", SessionListForm.ChatTitle(sessions, "fresh-guid"));
        Assert.Equal("New chat", SessionListForm.ChatTitle(sessions, null));
    }
}

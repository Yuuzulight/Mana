using System;
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

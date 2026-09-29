using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #661: what counts as waiting on the user, and announcing each item once.
public class WaitingForYouTests
{
    [Fact]
    public void Items_CombinesApprovalsAndOnlyPendingEdits()
    {
        var items = WaitingForYou.Items(
            [
                new ManaPendingApproval { Id = "1", ActionType = "tool-shell", Summary = "run `npm test`" },
                new ManaPendingApproval { Id = "2", ActionType = "memory-write", Summary = "" },
                new ManaPendingApproval { Id = "3", ActionType = "tool-web", Summary = "" },
            ],
            [
                new ManaProposalSummary { Id = "1", Status = "pending", RelativePath = "src/app.js" },
                new ManaProposalSummary { Id = "9", Status = "approved", RelativePath = "old.js" },
            ]);

        Assert.Equal(
            [("approval:1", "run `npm test`"), ("approval:2", "a memory write"), ("approval:3", "a tool call"), ("edit:1", "an edit to src/app.js")],
            items);
    }

    [Fact]
    public void Items_IncludesTheAgentsPendingWrites()
    {
        var items = WaitingForYou.Items([], [], [new ManaPendingWrite { Id = "hook-ask-1", Kind = "hook ask", Summary = "Check writes (file_write)" }]);

        Assert.Equal([("write:hook-ask-1", "hook ask: Check writes (file_write)")], items);
    }

    [Fact]
    public void NewItemsNotice_AnnouncesEachItemOnce_AndForgetsResolvedOnes()
    {
        var announced = new HashSet<string>();
        (string, string)[] first = [("approval:1", "a memory write")];

        Assert.Equal("Mana needs your OK for a memory write.", WaitingForYou.NewItemsNotice(first, announced));
        Assert.Null(WaitingForYou.NewItemsNotice(first, announced)); // same poll result again

        (string, string)[] more = [("approval:1", "a memory write"), ("edit:4", "an edit to a.js"), ("edit:5", "an edit to b.js")];
        Assert.Equal("Mana needs your OK for an edit to a.js and 1 more.", WaitingForYou.NewItemsNotice(more, announced));

        Assert.Null(WaitingForYou.NewItemsNotice([], announced)); // all resolved
        Assert.Empty(announced);
        Assert.NotNull(WaitingForYou.NewItemsNotice(first, announced)); // a new request with a reused id is new again
    }
}

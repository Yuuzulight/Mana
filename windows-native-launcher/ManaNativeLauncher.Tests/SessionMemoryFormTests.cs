using System.Collections.Generic;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class SessionMemoryFormTests
{
    [Fact]
    public void FormatDetail_ReturnsNoMemoryMessageForNull()
    {
        var text = SessionMemoryForm.FormatDetail(null);

        Assert.Contains("no stored memory yet", text);
    }

    [Fact]
    public void FormatDetail_ShowsPlaceholdersWhenGoalAndSummaryAreMissing()
    {
        var detail = new ManaSessionDetail { RecentTurns = new List<ManaSessionTurn>(), TotalTurnCount = 0 };

        var text = SessionMemoryForm.FormatDetail(detail);

        Assert.Contains("Goal: (none)", text);
        Assert.Contains("(none yet)", text);
        Assert.Contains("(no turns yet)", text);
    }

    [Fact]
    public void FormatDetail_IncludesGoalSummaryAndTurns()
    {
        var detail = new ManaSessionDetail
        {
            Goal = "finish the raid",
            Summary = "Talked about FFXIV.",
            TotalTurnCount = 2,
            RecentTurns = new List<ManaSessionTurn>
            {
                new() { User = "hi", Assistant = "hello" },
                new() { User = "bye", Assistant = "goodbye" },
            },
        };

        var text = SessionMemoryForm.FormatDetail(detail);

        Assert.Contains("Goal: finish the raid", text);
        Assert.Contains("Talked about FFXIV.", text);
        Assert.Contains("showing 2 of 2", text);
        Assert.Contains("You: hi", text);
        Assert.Contains("Mana: hello", text);
        Assert.Contains("You: bye", text);
        Assert.Contains("Mana: goodbye", text);
    }
}

using System.Collections.Generic;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ResearchFormatterTests
{
    [Fact]
    public void FormatReply_JustTheReportWhenThereIsNothingElse()
    {
        var result = new ManaResearchResult { Report = "The sky is blue." };

        Assert.Equal("The sky is blue.\n", ResearchFormatter.FormatReply(result));
    }

    [Fact]
    public void FormatReply_ListsSourcesWithTitleFallingBackToUrl()
    {
        var result = new ManaResearchResult
        {
            Report = "Report text.",
            Sources = new List<ManaResearchSource>
            {
                new() { Index = 1, Title = "Example Site", Url = "https://example.com" },
                new() { Index = 2, Url = "https://no-title.example" },
            },
        };

        var text = ResearchFormatter.FormatReply(result);

        Assert.Contains("Sources:", text);
        Assert.Contains("[1] Example Site - https://example.com", text);
        Assert.Contains("[2] https://no-title.example - https://no-title.example", text);
    }

    [Fact]
    public void FormatReply_MarksSourcesThatFailedToRead()
    {
        var result = new ManaResearchResult
        {
            Report = "Report text.",
            Sources = new List<ManaResearchSource> { new() { Index = 1, Url = "https://example.com", ReadFailed = true } },
        };

        Assert.Contains("(couldn't be read; used search snippet)", ResearchFormatter.FormatReply(result));
    }

    [Fact]
    public void FormatReply_ListsSubQueriesPipeSeparated()
    {
        var result = new ManaResearchResult { Report = "Report.", SubQueries = new List<string> { "query one", "query two" } };

        Assert.Contains("Searched: query one | query two", ResearchFormatter.FormatReply(result));
    }

    [Fact]
    public void FormatReply_NotesAnEarlyStopFromTheTimeLimit()
    {
        var result = new ManaResearchResult
        {
            Report = "Report.",
            Bounds = new ManaResearchBounds { HitTimeLimit = true, SourcesUsed = 3, MaxSources = 8, ElapsedMs = 45000 },
        };

        Assert.Contains("(Stopped early: 3 of up to 8 sources read, 45s time budget reached.)", ResearchFormatter.FormatReply(result));
    }

    [Fact]
    public void FormatReply_NotesAnEarlyStopFromTheSourceLimitWithoutATimeSuffix()
    {
        var result = new ManaResearchResult
        {
            Report = "Report.",
            Bounds = new ManaResearchBounds { HitSourceLimit = true, SourcesUsed = 8, MaxSources = 8 },
        };

        Assert.Contains("(Stopped early: 8 of up to 8 sources read.)", ResearchFormatter.FormatReply(result));
    }

    [Fact]
    public void FormatReply_OmitsTheBoundsNoteWhenNeitherLimitWasHit()
    {
        var result = new ManaResearchResult
        {
            Report = "Report.",
            Bounds = new ManaResearchBounds { SourcesUsed = 2, MaxSources = 8 },
        };

        Assert.DoesNotContain("Stopped early", ResearchFormatter.FormatReply(result));
    }
}

using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class SessionListFormatterTests
{
    [Fact]
    public void FormatDisplayName_PrefersTheSessionsName()
    {
        var session = new ManaSession { SessionId = "s1", Name = "Chat about FFXIV" };

        Assert.Equal("Chat about FFXIV", SessionListFormatter.FormatDisplayName(session));
    }

    [Fact]
    public void FormatDisplayName_FallsBackToTheSessionIdWhenNameIsNull()
    {
        var session = new ManaSession { SessionId = "s1", Name = null };

        Assert.Equal("s1", SessionListFormatter.FormatDisplayName(session));
    }

    [Fact]
    public void FormatDisplayName_FallsBackToTheSessionIdWhenNameIsEmpty()
    {
        var session = new ManaSession { SessionId = "s1", Name = "" };

        Assert.Equal("s1", SessionListFormatter.FormatDisplayName(session));
    }

    [Fact]
    public void FormatUpdatedAt_ReturnsEmptyForNull()
    {
        Assert.Equal("", SessionListFormatter.FormatUpdatedAt(null));
    }

    [Fact]
    public void FormatUpdatedAt_ReturnsEmptyForEmptyString()
    {
        Assert.Equal("", SessionListFormatter.FormatUpdatedAt(""));
    }

    [Fact]
    public void FormatUpdatedAt_ReturnsEmptyForUnparseableText()
    {
        Assert.Equal("", SessionListFormatter.FormatUpdatedAt("not a date"));
    }

    [Fact]
    public void FormatUpdatedAt_FormatsAValidIsoTimestamp()
    {
        var formatted = SessionListFormatter.FormatUpdatedAt("2026-03-15T14:30:00.000Z");

        Assert.NotEqual("", formatted);
        Assert.Contains("Mar", formatted);
        Assert.Contains("15", formatted);
    }

    // #687: the sidebar search box.
    [Theory]
    [InlineData("ffxiv", true)]
    [InlineData("  Chat ", true)]
    [InlineData("", true)]
    [InlineData("zelda", false)]
    public void MatchesSearch_IsACaseInsensitiveTitleMatch(string query, bool expected)
    {
        var session = new ManaSession { SessionId = "s1", Name = "Chat about FFXIV" };
        Assert.Equal(expected, SessionListFormatter.MatchesSearch(session, query));
    }

    [Fact]
    public void ParseTurnTime_ReadsIsoAsUtcAndFallsBackToMinValue()
    {
        Assert.Equal(new System.DateTime(2026, 9, 29, 4, 0, 0, System.DateTimeKind.Utc),
            SessionListFormatter.ParseTurnTime("2026-09-29T12:00:00+08:00"));
        Assert.Equal(System.DateTime.MinValue, SessionListFormatter.ParseTurnTime(null));
    }

    // Wednesday 30 Sep 2026, 15:00 local.
    private static readonly System.DateTimeOffset Now = new(new System.DateTime(2026, 9, 30, 15, 0, 0, System.DateTimeKind.Local));

    [Theory]
    [InlineData(-20, "just now")]
    [InlineData(120, "just now")] // a clock a little ahead
    [InlineData(-5 * 60, "5 min ago")]
    [InlineData(-2 * 3600, "2 h ago")]
    [InlineData(-16 * 3600, "yesterday")] // 23:00 the day before, not "16 h ago"
    [InlineData(-3 * 86400, "Sun")]
    [InlineData(-8 * 86400, "Sep 22")]
    public void FormatRelative_ReadsLikeTheMockup(int secondsFromNow, string expected) =>
        Assert.Equal(expected, SessionListFormatter.FormatRelative(Now.AddSeconds(secondsFromNow).ToString("o"), Now));

    [Fact]
    public void FormatRelative_AddsTheYearOnlyWhenItDiffers()
    {
        Assert.Equal("Dec 1, 2025", SessionListFormatter.FormatRelative(new System.DateTimeOffset(new System.DateTime(2025, 12, 1, 9, 0, 0, System.DateTimeKind.Local)).ToString("o"), Now));
        Assert.Equal("", SessionListFormatter.FormatRelative("not a date", Now));
    }

    [Fact]
    public void FormatDisplayName_PrefixesBranchedSessionsWithBranchSymbol()
    {
        var session = new ManaSession { SessionId = "s1-fork", Name = "Branched topic", ForkedFrom = "s1" };
        Assert.Equal("↳ Branched topic", SessionListFormatter.FormatDisplayName(session));
    }
}

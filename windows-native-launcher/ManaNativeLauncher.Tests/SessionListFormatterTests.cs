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
}

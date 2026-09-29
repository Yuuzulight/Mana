using System;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class AutoSessionTests
{
    private DateTime now = new(2026, 9, 29, 12, 0, 0, DateTimeKind.Utc);

    private AutoSession NewSession() => new(() => now);

    [Fact]
    public void NoSessionYet_TheFirstTurnStartsOne()
    {
        var session = NewSession();

        var id = session.EnsureForTurn();

        Assert.False(string.IsNullOrEmpty(id));
        Assert.Equal(id, session.CurrentId);
    }

    [Fact]
    public void AutoSessionUsedRecently_IsKept()
    {
        var session = NewSession();
        var first = session.EnsureForTurn();

        now += TimeSpan.FromHours(3.9);

        Assert.Equal(first, session.EnsureForTurn());
    }

    [Fact]
    public void AutoSessionIdleForFourHours_IsReplaced()
    {
        var session = NewSession();
        var first = session.EnsureForTurn();

        now += AutoSession.IdleLimit;

        Assert.NotEqual(first, session.EnsureForTurn());
    }

    [Fact]
    public void IdleTimeCountsFromTheLastTurn_NotTheSessionStart()
    {
        var session = NewSession();
        var first = session.EnsureForTurn();
        now += TimeSpan.FromHours(3);
        session.EnsureForTurn();

        now += TimeSpan.FromHours(3);

        Assert.Equal(first, session.EnsureForTurn());
    }

    [Fact]
    public void UserPickedSession_IsNeverRotated()
    {
        var session = NewSession();
        session.Set("picked");
        session.EnsureForTurn();

        now += TimeSpan.FromDays(3);

        Assert.Equal("picked", session.EnsureForTurn());
    }

    [Fact]
    public void AfterTheActiveSessionIsDeleted_TheNextTurnStartsAnAutoSessionThatRotates()
    {
        var session = NewSession();
        session.Set("picked");
        session.Set(null); // what SessionListForm does on deleting the active session

        var fresh = session.EnsureForTurn();
        Assert.NotEqual("picked", fresh);

        now += AutoSession.IdleLimit;
        Assert.NotEqual(fresh, session.EnsureForTurn());
    }

    [Fact]
    public void DeepResearchBeforeAnyChat_GetsASessionTheNextChatTurnReuses()
    {
        var session = NewSession();

        var researchSession = session.EnsureForTurn(); // ResearchForm's getSessionId

        Assert.Equal(researchSession, session.EnsureForTurn());
    }

    // #687: the session open at the last exit, reopened at launch.
    [Fact]
    public void RestoredAutoSession_StillRotatesFourHoursAfterItsLastTurn()
    {
        var session = NewSession();
        session.Restore("yesterday", auto: true, lastTurnAtUtc: now - TimeSpan.FromHours(3));

        Assert.True(session.IsAuto);
        Assert.Equal("yesterday", session.EnsureForTurn());

        var restartedLater = NewSession();
        restartedLater.Restore("yesterday", auto: true, lastTurnAtUtc: now - AutoSession.IdleLimit);
        Assert.NotEqual("yesterday", restartedLater.EnsureForTurn());
    }

    [Fact]
    public void RestoredPickedSession_IsKeptHoweverOld()
    {
        var session = NewSession();
        session.Restore("picked", auto: false, lastTurnAtUtc: DateTime.MinValue);

        Assert.False(session.IsAuto);
        Assert.Equal("picked", session.EnsureForTurn());
    }

    [Fact]
    public void Restore_DoesNothingOnceASessionIsSet()
    {
        var session = NewSession();
        var started = session.EnsureForTurn();

        session.Restore("old", auto: false, lastTurnAtUtc: now);

        Assert.Equal(started, session.CurrentId);
    }
}

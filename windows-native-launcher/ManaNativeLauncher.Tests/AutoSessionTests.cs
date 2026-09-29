using System;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class AutoSessionTests
{
    private static readonly DateTime Now = new(2026, 9, 29, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void NoSessionYet_NeedsANewOne() =>
        Assert.True(AutoSession.NeedsNew(null, false, default, Now));

    [Fact]
    public void AutoSessionUsedRecently_IsKept() =>
        Assert.False(AutoSession.NeedsNew("s1", true, Now - TimeSpan.FromHours(3.9), Now));

    [Fact]
    public void AutoSessionIdleForFourHours_IsReplaced() =>
        Assert.True(AutoSession.NeedsNew("s1", true, Now - AutoSession.IdleLimit, Now));

    [Fact]
    public void UserPickedSession_IsNeverRotated() =>
        Assert.False(AutoSession.NeedsNew("s1", false, Now - TimeSpan.FromDays(3), Now));
}

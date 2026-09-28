using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class SystemIdleTests
{
    [Theory]
    [InlineData(100_000u, 40_000u, 60)]
    [InlineData(5_000u, 5_000u, 0)]
    [InlineData(1_999u, 1_000u, 0)]
    // #681: the tick counter wrapped between the last input and now.
    [InlineData(10_000u, 4_294_962_296u, 15)]
    public void IdleSecondsBetween_ReturnsWholeSecondsSinceLastInput(uint now, uint lastInput, int expected)
    {
        Assert.Equal(expected, SystemIdle.IdleSecondsBetween(now, lastInput));
    }
}

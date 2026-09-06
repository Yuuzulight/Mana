using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class BackendLogBufferTests
{
    [Fact]
    public void Snapshot_ReturnsLinesInTheOrderTheyWereAdded()
    {
        var buffer = new BackendLogBuffer();

        buffer.Add("first");
        buffer.Add("second");
        buffer.Add("third");

        Assert.Equal(new[] { "first", "second", "third" }, buffer.Snapshot());
    }

    [Fact]
    public void Snapshot_IsEmptyWhenNothingHasBeenAdded()
    {
        var buffer = new BackendLogBuffer();

        Assert.Empty(buffer.Snapshot());
    }

    [Fact]
    public void Add_DropsTheOldestLineOncePastFiveHundred()
    {
        var buffer = new BackendLogBuffer();

        for (var i = 0; i < 510; i++)
        {
            buffer.Add($"line {i}");
        }

        var snapshot = buffer.Snapshot();

        Assert.Equal(500, snapshot.Count);
        Assert.Equal("line 10", snapshot[0]);
        Assert.Equal("line 509", snapshot[^1]);
    }
}

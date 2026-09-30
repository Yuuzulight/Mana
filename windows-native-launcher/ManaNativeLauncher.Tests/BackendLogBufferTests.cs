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

    // The backend's lines also go to disk, and a new run keeps the last one's.
    [Fact]
    public void StartFile_WritesLinesToTheFileAndKeepsTheLastRun()
    {
        var dir = Directory.CreateTempSubdirectory("mana-backend-log-");
        try
        {
            var log = Path.Combine(dir.FullName, "logs", "backend.log");
            var buffer = new BackendLogBuffer();
            buffer.Add("before any file");
            buffer.StartFile(log);
            buffer.Add("first run crashed");

            buffer.StartFile(log);
            buffer.Add("second run");

            Assert.Equal(new[] { "second run" }, File.ReadAllLines(log));
            Assert.Equal(new[] { "first run crashed" }, File.ReadAllLines(Path.Combine(dir.FullName, "logs", "backend.prev.log")));
            Assert.Equal(new[] { "before any file", "first run crashed", "second run" }, buffer.Snapshot());
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}

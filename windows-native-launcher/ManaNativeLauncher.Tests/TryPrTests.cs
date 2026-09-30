using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1010: the tray's "Back to main" shows only while try-pr.ps1 left a PR running.
public class TryPrTests
{
    [Fact]
    public void TryingPr_ReadsTheMarkerTryPrLeaves()
    {
        var launcherDir = Directory.CreateTempSubdirectory("mana-try-pr-").FullName;
        try
        {
            Assert.Null(ManaApplicationContext.TryingPr(launcherDir));
            Directory.CreateDirectory(Path.Combine(launcherDir, "bin"));
            File.WriteAllText(Path.Combine(launcherDir, "bin", "trying-pr"), "1020\r\n");
            Assert.Equal(1020, ManaApplicationContext.TryingPr(launcherDir));
            File.WriteAllText(Path.Combine(launcherDir, "bin", "trying-pr"), "not a number");
            Assert.Null(ManaApplicationContext.TryingPr(launcherDir));
        }
        finally
        {
            Directory.Delete(launcherDir, recursive: true);
        }
    }
}

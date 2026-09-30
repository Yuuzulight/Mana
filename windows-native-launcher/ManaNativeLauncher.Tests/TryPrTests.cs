using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1010: the tray's "Back to main" shows only while try-pr.ps1 left a PR running.
public class TryPrTests
{
    [Fact]
    public void RunningOffMain_ReadsTheMarkerTryPrLeaves()
    {
        var launcherDir = Directory.CreateTempSubdirectory("mana-try-pr-").FullName;
        try
        {
            Assert.Null(ManaApplicationContext.RunningOffMain(launcherDir));
            Directory.CreateDirectory(Path.Combine(launcherDir, "bin"));
            File.WriteAllText(Path.Combine(launcherDir, "bin", "trying-pr"), "PR #1020\r\n");
            Assert.Equal("PR #1020", ManaApplicationContext.RunningOffMain(launcherDir));
            File.WriteAllText(Path.Combine(launcherDir, "bin", "trying-pr"), "the previous build\r\n");
            Assert.Equal("the previous build", ManaApplicationContext.RunningOffMain(launcherDir));
            File.WriteAllText(Path.Combine(launcherDir, "bin", "trying-pr"), " ");
            Assert.Null(ManaApplicationContext.RunningOffMain(launcherDir));
        }
        finally
        {
            Directory.Delete(launcherDir, recursive: true);
        }
    }
}

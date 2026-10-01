using System;
using System.Diagnostics;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// What's left behind when the launcher dies: nothing of node-bot's tree,
// and a line in launcher-errors.log.
public class LauncherCrashTests
{
    [Fact]
    public void KillOnCloseJob_KillsItsProcessesWhenTheHandleCloses()
    {
        using var child = Process.Start(new ProcessStartInfo("ping", "-n 60 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true })!;
        try
        {
            var job = KillOnCloseJob.Create();
            Assert.True(KillOnCloseJob.Assign(job, child.Handle));

            job.Dispose(); // as when the launcher crashes

            Assert.True(child.WaitForExit(TimeSpan.FromSeconds(10)), "the job didn't kill its process");
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill();
            }
        }
    }

    [Fact]
    public void LogError_AppendsATimestampedLineAndCreatesTheFolder()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-errors-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(dir, "logs", "launcher-errors.log");
        try
        {
            Program.LogError(path, new InvalidOperationException("first"));
            Program.LogError(path, new InvalidOperationException("second"));

            var lines = File.ReadAllText(path);
            Assert.Matches(@"^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] System.InvalidOperationException: first", lines);
            Assert.Contains("second", lines);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}

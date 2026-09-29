using System.Collections.Generic;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ForegroundWindowReporterTests
{
    // #697 part 1: only a change is sent -- the same app and title again
    // (a foreground event for the window that was already in front) isn't.
    [Fact]
    public void Report_SendsOnlyChanges()
    {
        var sent = new List<string>();
        using var reporter = new ForegroundWindowReporter((app, title) =>
        {
            sent.Add($"{app}|{title}");
            return Task.CompletedTask;
        });

        reporter.Report("ffxiv_dx11.exe", "FINAL FANTASY XIV");
        reporter.Report("ffxiv_dx11.exe", "FINAL FANTASY XIV");
        reporter.Report("chrome.exe", "Guide");
        reporter.Report("chrome.exe", "Other tab");

        Assert.Equal(new[] { "ffxiv_dx11.exe|FINAL FANTASY XIV", "chrome.exe|Guide", "chrome.exe|Other tab" }, sent);
    }
}

using System.Diagnostics;
using System.Drawing;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #995: the staged launcher update's file moves, self-check and handoff.
public class LauncherUpdateTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "mana-update-" + Guid.NewGuid().ToString("N"));
    private string Live => Path.Combine(dir, "net10");

    public LauncherUpdateTests() => Directory.CreateDirectory(dir);

    public void Dispose()
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The rolled-back build it restarted may still be exiting.
        }
    }

    private void Build(string folder, string file, string exeSource)
    {
        Directory.CreateDirectory(Path.Combine(folder, "runtimes"));
        File.WriteAllText(Path.Combine(folder, "runtimes", file), "");
        File.Copy(exeSource, Path.Combine(folder, "ManaNativeLauncher.exe"));
    }

    // A console tool that exits straight away, as a launcher build that
    // never gets to its message loop would.
    private static readonly string BrokenExe = Path.Combine(Environment.SystemDirectory, "where.exe");

    [Fact]
    public void SwapThenRollback_KeepsExactlyOnePreviousBuild()
    {
        var staging = LauncherUpdate.StagingDir(Live);
        var previous = LauncherUpdate.PreviousDir(Live);
        Build(Live, "old.dll", BrokenExe);
        Build(staging, "new.dll", BrokenExe);
        Directory.CreateDirectory(previous);
        File.WriteAllText(Path.Combine(previous, "older.dll"), "");

        LauncherUpdate.Swap(Live, staging, previous);

        Assert.True(File.Exists(Path.Combine(Live, "runtimes", "new.dll")));
        Assert.False(File.Exists(Path.Combine(Live, "runtimes", "old.dll")));
        Assert.True(File.Exists(Path.Combine(previous, "runtimes", "old.dll")));
        Assert.False(File.Exists(Path.Combine(previous, "older.dll")));

        LauncherUpdate.Rollback(Live, previous);

        Assert.True(File.Exists(Path.Combine(Live, "runtimes", "old.dll")));
        Assert.False(File.Exists(Path.Combine(Live, "runtimes", "new.dll")));
        Assert.False(Directory.Exists(previous));
    }

    [Fact]
    public void RunInstaller_PutsThePreviousBuildBackWhenTheNewOneDoesNotStart()
    {
        var staging = LauncherUpdate.StagingDir(Live);
        Build(Live, "old.dll", BrokenExe);
        Build(staging, "new.dll", BrokenExe);
        File.WriteAllText(Path.Combine(staging, LauncherUpdate.ReadyMarker), "");
        Assert.True(LauncherUpdate.IsStaged(Live));
        using var gone = Process.Start(new ProcessStartInfo(BrokenExe) { UseShellExecute = false, CreateNoWindow = true })!;
        gone.WaitForExit();

        Assert.False(LauncherUpdate.RunInstaller(staging, gone.Id, [], TimeSpan.FromSeconds(30)));

        Assert.True(File.Exists(Path.Combine(Live, "runtimes", "old.dll")));
        Assert.True(File.Exists(Path.Combine(Live, LauncherUpdate.RolledBackNote)));
        Assert.False(LauncherUpdate.IsStaged(Live)); // never retried in a loop
    }

    [Fact]
    public void ChatBounds_RoundTripThroughTheHandoffArgs()
    {
        var bounds = new Rectangle(-1200, 40, 900, 700);

        Assert.Equal(bounds, LauncherUpdate.ChatBoundsFrom([LauncherUpdate.UpdatedArg, .. LauncherUpdate.ChatBoundsArgs(bounds)]));
        Assert.Null(LauncherUpdate.ChatBoundsFrom([LauncherUpdate.UpdatedArg]));
        Assert.Null(LauncherUpdate.ChatBoundsFrom(["--chat", "1,2,x,4"]));
    }

    [Theory]
    [InlineData(true, false, 120, true)]
    [InlineData(false, false, 600, false)] // she's talking or thinking
    [InlineData(true, true, 600, false)]   // a watched game is running
    [InlineData(true, false, 30, false)]   // I'm at the keyboard
    public void IsQuietMoment_OnlyWhenSheAndIAreBothIdleOutsideAGame(bool voiceIdle, bool gaming, int idleSeconds, bool expected) =>
        Assert.Equal(expected, ManaApplicationContext.IsQuietMoment(voiceIdle, gaming, idleSeconds));
}

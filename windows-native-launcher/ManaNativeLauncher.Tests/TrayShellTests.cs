using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #689: single-instance lock and the tray tooltip.
public class TrayShellTests
{
    [Fact]
    public void SecondInstance_IsRefusedAndAsksTheFirstToShow()
    {
        var name = $"Mana.Tests.{Guid.NewGuid():N}"; // never the real launcher's name
        using var first = SingleInstance.Claim(name);
        Assert.NotNull(first);
        using var shown = new ManualResetEventSlim();
        using var listener = SingleInstance.ListenForShow(shown.Set, name);

        Assert.Null(SingleInstance.Claim(name));
        Assert.True(shown.Wait(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void QuitSignal_ReachesTheRunningLauncher()
    {
        var name = $"Mana.Tests.{Guid.NewGuid():N}";
        using var quit = new ManualResetEventSlim();
        using var listener = SingleInstance.ListenForQuit(quit.Set, name);

        Assert.True(EventWaitHandle.TryOpenExisting($@"Local\{name}.Quit", out var signal));
        using (signal)
        {
            signal.Set();
        }
        Assert.True(quit.Wait(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void QuitScript_ReturnsOnlyOnceTheLauncherHasLetGoOfItsLock()
    {
        var name = $"Mana.Tests.{Guid.NewGuid():N}";
        var mutex = SingleInstance.Claim(name)!;
        using var released = new ManualResetEventSlim();
        // As the launcher does: shut down for a moment after the signal, then exit.
        using var listener = SingleInstance.ListenForQuit(() =>
        {
            Thread.Sleep(700);
            released.Set();
            mutex.Dispose();
        }, name);
        var script = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "quit-mana.ps1");

        using var ps = Process.Start(new ProcessStartInfo("powershell", $"-NoProfile -ExecutionPolicy Bypass -File \"{script}\" -Name {name}")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
        })!;
        var output = ps.StandardOutput.ReadToEnd();
        Assert.True(ps.WaitForExit(TimeSpan.FromSeconds(60)));

        Assert.True(released.IsSet, $"quit-mana.ps1 returned while Mana was still closing: {output}");
        Assert.Equal(0, ps.ExitCode);
        Assert.Contains("Mana has closed.", output);
    }

    [Fact]
    public void TrayTooltip_AddsTheDoctorAlertAndStaysWithinTheLimit()
    {
        Assert.Equal("Mana", ManaApplicationContext.TrayTooltip("Mana", null));
        Assert.Equal("Mana - game mode - Doctor: warning: Disk: low", ManaApplicationContext.TrayTooltip("Mana - game mode", "Doctor: warning: Disk: low"));
        var longAlert = new string('x', 300);
        Assert.Equal(127, ManaApplicationContext.TrayTooltip("Mana", longAlert).Length);
    }
}

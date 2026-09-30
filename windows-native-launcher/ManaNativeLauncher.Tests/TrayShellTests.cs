using System;
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
    public void TrayTooltip_AddsTheDoctorAlertAndStaysWithinTheLimit()
    {
        Assert.Equal("Mana", ManaApplicationContext.TrayTooltip("Mana", null));
        Assert.Equal("Mana - game mode - Doctor: warning: Disk: low", ManaApplicationContext.TrayTooltip("Mana - game mode", "Doctor: warning: Disk: low"));
        var longAlert = new string('x', 300);
        Assert.Equal(127, ManaApplicationContext.TrayTooltip("Mana", longAlert).Length);
    }
}

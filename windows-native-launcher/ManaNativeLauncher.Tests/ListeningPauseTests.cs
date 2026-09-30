using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ListeningPauseTests
{
    private bool listening;
    private int toggles;

    private ListeningPause Pause() => new(() => listening, () => { listening = !listening; toggles++; });

    [Fact]
    public void PausesAndResumesListeningThatWasOn()
    {
        listening = true;
        var pause = Pause();

        pause.Pause();
        pause.Pause(); // must still remember it was on
        Assert.False(listening);
        pause.Resume();
        Assert.True(listening);

        pause.Resume(); // Settings closing after the enrolment's finally
        Assert.Equal(2, toggles);
    }

    [Fact]
    public void LeavesListeningThatWasOffOff()
    {
        var pause = Pause();

        pause.Pause();
        pause.Resume();

        Assert.False(listening);
        Assert.Equal(0, toggles);
    }

    [Fact]
    public void LeavesListeningTurnedBackOnByHandAlone()
    {
        listening = true;
        var pause = Pause();
        pause.Pause();
        listening = true; // the tray's Start listening mid-enrolment

        pause.Resume();

        Assert.True(listening);
        Assert.Equal(1, toggles);
    }

    [Fact]
    public void ResumeWithoutPauseDoesNothing()
    {
        Pause().Resume();

        Assert.Equal(0, toggles);
    }
}

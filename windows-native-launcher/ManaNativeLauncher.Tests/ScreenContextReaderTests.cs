using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ScreenContextReaderTests
{
    private const int OwnPid = 4242;

    [Fact]
    public void IsTreeUsable_TrueForAUsableTreeFromAnotherProcess()
    {
        var tree = new AccessibilityTreeResult(9999, "line one\nline two\nline three long enough");

        Assert.True(ScreenContextReader.IsTreeUsable(tree, OwnPid));
    }

    [Fact]
    public void IsTreeUsable_FalseWhenTheTreeIsNull()
    {
        Assert.False(ScreenContextReader.IsTreeUsable(null, OwnPid));
    }

    [Fact]
    public void IsTreeUsable_FalseWhenTheOwnerPidIsThisLaunchersOwnProcess()
    {
        // Reading our own window is a self-description, not real
        // context -- must fall back to OCR even though the text itself
        // would otherwise pass IsUsable.
        var tree = new AccessibilityTreeResult(OwnPid, "line one\nline two\nline three long enough");

        Assert.False(ScreenContextReader.IsTreeUsable(tree, OwnPid));
    }

    [Fact]
    public void IsTreeUsable_FalseWhenTheExtractedTextIsTooSparse()
    {
        var tree = new AccessibilityTreeResult(9999, "a\nb");

        Assert.False(ScreenContextReader.IsTreeUsable(tree, OwnPid));
    }

    // Q37: beside the avatar's window, never under it (her pixels hit-test as Mana).
    [Fact]
    public void BesideAvatar_LeftOfHerAtMidHeight_OrRightWhenAtTheDesktopEdge()
    {
        var desktop = new System.Drawing.Rectangle(0, 0, 1920, 1080);
        Assert.Equal(new System.Drawing.Point(740, 844),
            ScreenContextReader.BesideAvatar(new System.Drawing.Rectangle(780, 700, 234, 288), desktop));
        Assert.Equal(new System.Drawing.Point(274, 844),
            ScreenContextReader.BesideAvatar(new System.Drawing.Rectangle(0, 700, 234, 288), desktop));
    }

    [Fact]
    public void IsSlowTreeApp_MatchesTheKnownSlowAppsCaseInsensitively()
    {
        Assert.True(ScreenContextReader.IsSlowTreeApp("OUTLOOK"));
        Assert.False(ScreenContextReader.IsSlowTreeApp("notepad"));
        Assert.False(ScreenContextReader.IsSlowTreeApp(""));
    }

    // #671/Q2: GetLastInputInfo-based -- any keyboard or mouse input in the
    // last second skips the tree walk; an unknown idle time never does.
    [Theory]
    [InlineData(0L, true)]
    [InlineData(999L, true)]
    [InlineData(1000L, false)]
    [InlineData(null, false)]
    public void InUse_WithinASecondOfTheLastInput(long? idleMs, bool expected) =>
        Assert.Equal(expected, ScreenContextReader.InUse(idleMs));
}

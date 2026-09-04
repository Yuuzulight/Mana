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
}

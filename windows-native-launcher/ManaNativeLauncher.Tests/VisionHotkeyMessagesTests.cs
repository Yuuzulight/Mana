using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class VisionHotkeyMessagesTests
{
    [Fact]
    public void DescribeError_SpecialCasesTheMissingVisionModelString()
    {
        Assert.Equal(
            "Mana has no vision model installed. See docs/vision_setup.md.",
            VisionHotkeyMessages.DescribeError("no local vision model available"));
    }

    [Fact]
    public void DescribeError_WrapsAnyOtherErrorMessage()
    {
        Assert.Equal(
            "Mana couldn't look at the screen: backend timed out",
            VisionHotkeyMessages.DescribeError("backend timed out"));
    }

    [Fact]
    public void DescribeError_FallsBackToAGenericMessageWhenErrorIsEmpty()
    {
        Assert.Equal("Mana couldn't look at the screen.", VisionHotkeyMessages.DescribeError(""));
    }

    [Fact]
    public void DescribeError_FallsBackToAGenericMessageWhenErrorIsNull()
    {
        Assert.Equal("Mana couldn't look at the screen.", VisionHotkeyMessages.DescribeError(null));
    }
}

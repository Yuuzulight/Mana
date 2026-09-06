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

    [Fact]
    public void BuildClipHotkeyPrompt_StatesTheRealSpanNotAHardcodedTarget()
    {
        Assert.Equal(
            "Look back over the last 15 seconds and tell me what just happened. Answer briefly.",
            VisionHotkeyMessages.BuildClipHotkeyPrompt(15));
        Assert.Equal(
            "Look back over the last 6 seconds and tell me what just happened. Answer briefly.",
            VisionHotkeyMessages.BuildClipHotkeyPrompt(6));
    }

    [Fact]
    public void BuildClipHotkeyPrompt_UsesSingularSecondForAOneSecondSpan()
    {
        Assert.Equal(
            "Look back over the last 1 second and tell me what just happened. Answer briefly.",
            VisionHotkeyMessages.BuildClipHotkeyPrompt(1));
    }

    [Fact]
    public void BuildClipHotkeyPrompt_FallsBackToNoNumericSpanForAnEmptyOrSingleFrameBuffer()
    {
        Assert.Equal(
            "Look back at what just happened and tell me. Answer briefly.",
            VisionHotkeyMessages.BuildClipHotkeyPrompt(0));
    }

    [Fact]
    public void BuildClipHotkeyPrompt_RoundsAFractionalSpanToTheNearestSecond()
    {
        Assert.Equal(
            "Look back over the last 6 seconds and tell me what just happened. Answer briefly.",
            VisionHotkeyMessages.BuildClipHotkeyPrompt(6.4));
    }
}

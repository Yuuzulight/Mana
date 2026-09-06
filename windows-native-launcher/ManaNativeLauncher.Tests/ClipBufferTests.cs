using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ClipBufferTests
{
    [Fact]
    public void GetImages_ReturnsEmptyForANewBuffer()
    {
        var buffer = new ClipBuffer();

        Assert.Empty(buffer.GetImages());
    }

    [Fact]
    public void PushFrame_KeepsAtMostMaxFramesInOldestFirstOrder()
    {
        var buffer = new ClipBuffer();
        for (var i = 0; i < ClipBuffer.MaxFrames + 3; i++)
        {
            buffer.PushFrame($"frame-{i}", i * 1000);
        }

        var images = buffer.GetImages();

        Assert.Equal(ClipBuffer.MaxFrames, images.Count);
        Assert.Equal("frame-3", images[0]);
        Assert.Equal($"frame-{ClipBuffer.MaxFrames + 2}", images[^1]);
    }

    [Fact]
    public void GetSpanSeconds_IsZeroForAnEmptyOrSingleFrameBuffer()
    {
        var buffer = new ClipBuffer();
        Assert.Equal(0, buffer.GetSpanSeconds());

        buffer.PushFrame("frame-0", 5000);
        Assert.Equal(0, buffer.GetSpanSeconds());
    }

    [Fact]
    public void GetSpanSeconds_IsTheGapBetweenOldestAndNewestTimestamp()
    {
        var buffer = new ClipBuffer();
        buffer.PushFrame("frame-0", 1000);
        buffer.PushFrame("frame-1", 4000);
        buffer.PushFrame("frame-2", 16000);

        Assert.Equal(15, buffer.GetSpanSeconds());
    }

    [Fact]
    public void GetSpanSeconds_UsesTheOldestSurvivingFrameAfterEviction()
    {
        var buffer = new ClipBuffer();
        for (var i = 0; i < ClipBuffer.MaxFrames + 1; i++)
        {
            buffer.PushFrame($"frame-{i}", i * 1000);
        }

        // frame-0 (timestamp 0) was evicted -- the span is now measured
        // from frame-1 (timestamp 1000), not the original oldest frame.
        Assert.Equal(ClipBuffer.MaxFrames - 1, buffer.GetSpanSeconds());
    }
}

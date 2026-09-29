using System;
using System.Runtime.InteropServices;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #912: the camera failures that get a plain answer (never opens a camera).
public class WebcamCaptureTests
{
    [Fact]
    public void Describe_NamesTheCommonCameraFailures()
    {
        Assert.Equal(WebcamCapture.BlockedMessage, WebcamCapture.Describe(new UnauthorizedAccessException()));
        Assert.Equal(WebcamCapture.NoCameraMessage, WebcamCapture.Describe(new COMException("", unchecked((int)0xC00DABE0))));
        Assert.Equal(WebcamCapture.InUseMessage, WebcamCapture.Describe(new COMException("", unchecked((int)0xC00D3704))));
        Assert.Null(WebcamCapture.Describe(new InvalidOperationException("The camera sent no picture.")));
    }
}

using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #697: audio and media awareness tests.
public sealed class AudioSessionActivityTests
{
    [Theory]
    [InlineData((int)ListenMode.Idle, false, false, true)]
    [InlineData((int)ListenMode.Idle, false, true, false)]
    [InlineData((int)ListenMode.Idle, true, false, false)]
    [InlineData((int)ListenMode.Idle, true, true, false)]
    [InlineData((int)ListenMode.Processing, false, false, false)]
    [InlineData((int)ListenMode.Processing, false, true, false)]
    [InlineData((int)ListenMode.Speaking, false, false, false)]
    public void IsQuietForAnnouncement_RespectsAudioBusy(int mode, bool heardSpeech, bool audioBusy, bool expected)
    {
        Assert.Equal(expected, VoiceLoop.IsQuietForAnnouncement((ListenMode)mode, heardSpeech, audioBusy));
    }

    [Fact]
    public void WindowsAudioSessionDetector_RunsWithoutException()
    {
        var detector = new WindowsAudioSessionDetector();
        // Regardless of whether an audio endpoint is present in CI/test runner,
        // it must safely return a boolean without throwing an unhandled exception.
        var busy = detector.IsAudioBusy();
        Assert.True(busy || !busy);
    }
}

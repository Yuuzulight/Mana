using System;
using System.Runtime.InteropServices;
using Mana.NativeLauncher;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #619: the pure decisions around the echo-cancelled capture. The capture
// itself needs a real microphone, so it's checked in the live run.
public class EchoCancellationTests
{
    private static readonly Guid Ns = new("6f64adbf-8211-11e2-8c70-2c27d7f001fa");

    [Theory]
    [InlineData(null, null, true)] // default: on
    [InlineData(null, false, false)]
    [InlineData(null, true, true)]
    [InlineData("0", true, false)] // env wins over the setting
    [InlineData(" OFF ", null, false)]
    [InlineData("false", null, false)]
    [InlineData("1", false, true)]
    [InlineData("on", false, true)]
    [InlineData("", false, false)] // blank env: the setting decides
    [InlineData("maybe", false, false)]
    public void IsEnabled_EnvOverridesSettingDefaultOn(string? env, bool? setting, bool expected)
    {
        Assert.Equal(expected, EchoCancellation.IsEnabled(env, setting));
    }

    [Fact]
    public void KeepsCommunicationsCapture_WhenAecIsOn()
    {
        Assert.True(EchoCancellation.KeepCommunicationsCapture(new[] { (Ns, true), (EchoCancellation.AcousticEchoCancellation, true) }));
    }

    [Fact]
    public void KeepsCommunicationsCapture_WhenWindowsCantReportEffects()
    {
        Assert.True(EchoCancellation.KeepCommunicationsCapture(null));
    }

    [Fact]
    public void FallsBackToRaw_WhenNoAecIsApplied()
    {
        Assert.False(EchoCancellation.KeepCommunicationsCapture(Array.Empty<(Guid, bool)>()));
        Assert.False(EchoCancellation.KeepCommunicationsCapture(new[] { (Ns, true) }));
        // Listed but switched off (e.g. Voice Clarity turned off by the user).
        Assert.False(EchoCancellation.KeepCommunicationsCapture(new[] { (EchoCancellation.AcousticEchoCancellation, false) }));
    }

    [Fact]
    public void Describe_NamesKnownEffects()
    {
        var unknown = new Guid("12345678-0000-0000-0000-000000000000");

        Assert.Equal("unknown", EchoCancellation.Describe(null));
        Assert.Equal("none", EchoCancellation.Describe(Array.Empty<(Guid, bool)>()));
        Assert.Equal("AEC:on,NS:off,12345678:on", EchoCancellation.Describe(new[] { (EchoCancellation.AcousticEchoCancellation, true), (Ns, false), (unknown, true) }));
    }

    [Fact]
    public void NAudioStillHasThePrivateFieldsItReads()
    {
        // An NAudio upgrade that renames these would silently turn AEC into
        // a logged fallback on every start -- fail here instead.
        Assert.Equal(typeof(AudioClient), EchoCancellation.CaptureClientField?.FieldType);
        Assert.Equal(typeof(IAudioClient), EchoCancellation.ClientInterfaceField?.FieldType);
    }

    [Fact]
    public void InteropStructsMatchTheWindowsLayouts()
    {
        Assert.Equal(16, Marshal.SizeOf<AudioClientProperties>()); // UINT32, BOOL, category, options
        Assert.Equal(24, Marshal.SizeOf<EchoCancellation.AudioEffect>()); // GUID, BOOL, state
    }
}

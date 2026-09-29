using System;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #682: ports windows-launcher/test/speech-filters.test.js, on 16kHz int16
// segments like the ones VoiceLoop sends to Whisper.
public class SpeechFiltersTests
{
    private static short[] Sine(double amplitude, double frequency, double seconds = 1)
    {
        var samples = new short[(int)(SileroVadRunner.SampleRate * seconds)];
        for (var i = 0; i < samples.Length; i++)
        {
            samples[i] = (short)(amplitude * short.MaxValue * Math.Sin(2 * Math.PI * frequency * i / SileroVadRunner.SampleRate));
        }
        return samples;
    }

    // Electron's defaults, with the zero-crossing cutoff at native's rate.
    private static string? Reject(short[] samples) =>
        SpeechFilters.GetSpeechRejectReason(samples, 0.012, 0.04, 0.28 * 3);

    [Fact]
    public void RejectReason_AcceptsNormalVolumeSpeechFrequency() =>
        Assert.Null(Reject(Sine(0.3, 200)));

    [Fact]
    public void RejectReason_RejectsNearSilenceAsQuiet() =>
        Assert.Equal("quiet", Reject(Sine(0.001, 200)));

    [Fact]
    public void RejectReason_RejectsNearNyquistHissAsClicky() =>
        Assert.Equal("clicky", Reject(Sine(0.3, 7500)));

    [Fact]
    public void RejectReason_KeepsSibilantSpeechThatElectronsRateWouldAlsoKeep()
    {
        // 4kHz at 16kHz is 0.5 crossings/sample -- over Electron's 0.28 if
        // compared unscaled, but only ~0.17 at Electron's 48kHz decode.
        Assert.Null(Reject(Sine(0.3, 4000)));
        Assert.Equal(0.28 * 3, SpeechFilters.MaxClickyZcr, 6);
    }

    [Fact]
    public void ComputeGainFactor_BoostsTowardTargetCappedAtMaxBoost()
    {
        Assert.Equal(4, SpeechFilters.ComputeGainFactor(0.05, 0.2, 6), 6);
        Assert.Equal(6, SpeechFilters.ComputeGainFactor(0.01, 0.2, 6));
    }

    [Fact]
    public void ComputeGainFactor_IsNoOpForSilenceLoudClipOrDisabled()
    {
        Assert.Equal(1, SpeechFilters.ComputeGainFactor(0, 0.2, 6));
        Assert.Equal(1, SpeechFilters.ComputeGainFactor(0.3, 0.2, 6));
        Assert.Equal(1, SpeechFilters.ComputeGainFactor(0.05, 0, 6));
        Assert.Equal(1, SpeechFilters.ComputeGainFactor(0.05, 0.2, 0));
    }

    [Fact]
    public void ApplySpeechGain_RescuesQuietSpeechFromTheQuietGate()
    {
        var quiet = Sine(0.03, 200); // rms ~0.021 but peak 0.03 < 0.04
        Assert.Equal("quiet", Reject(quiet));

        var (boosted, gain) = SpeechFilters.ApplySpeechGain(quiet, 0.2, 6);

        Assert.Equal(6, gain);
        Assert.Null(Reject(boosted));
        Assert.Equal(0.03, SpeechFilters.GetAudioStats(quiet).Peak, 3); // input untouched
    }

    [Fact]
    public void ApplySpeechGain_ReturnsInputWhenAlreadyLoud()
    {
        var loud = Sine(0.5, 200);
        Assert.Same(loud, SpeechFilters.ApplySpeechGain(loud, 0.2, 6).Samples);
    }

    [Theory]
    [InlineData("Thank you.", 0.8)]
    [InlineData(" Thanks for watching", 1.2)]
    [InlineData("Please subscribe", 2.5)]
    public void IsLikelyWhisperHallucination_FlagsPhantomPhraseFromShortClip(string transcript, double seconds) =>
        Assert.True(SpeechFilters.IsLikelyWhisperHallucination(transcript, seconds));

    [Fact]
    public void IsLikelyWhisperHallucination_TrustsLongerClipsAndRealSpeech()
    {
        Assert.False(SpeechFilters.IsLikelyWhisperHallucination("thank you", 2.51));
        Assert.False(SpeechFilters.IsLikelyWhisperHallucination("what time is it", 1));
        Assert.False(SpeechFilters.IsLikelyWhisperHallucination("mana, thank you", 1));
    }

    [Theory]
    [InlineData("[BLANK_AUDIO]")]
    [InlineData("(keyboard clicking)")]
    [InlineData(" Music.")]
    [InlineData("  ")]
    public void IsNoiseOnlyTranscript_DropsAnnotationsAndNoiseDescriptions(string transcript) =>
        Assert.True(SpeechFilters.IsNoiseOnlyTranscript(transcript));

    [Theory]
    [InlineData("Mana, play some music")]
    [InlineData("(laughs) Mana, you're funny")]
    public void IsNoiseOnlyTranscript_KeepsRealSpeech(string transcript) =>
        Assert.False(SpeechFilters.IsNoiseOnlyTranscript(transcript));
}

using System;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #678: voiceprint gating, against a fake embedder.
public class SpeakerGateTests
{
    // Fake embedder: the "voice" is the loudness of the audio.
    private static float[] FakeEmbed(short[] samples) => new[] { samples[0] / 1000f, 1f };

    private static short[] Voice(short level)
    {
        var samples = new short[16000];
        Array.Fill(samples, level);
        return samples;
    }

    [Fact]
    public void NoModelOrNoVoiceprint_PassesEverythingThrough()
    {
        Assert.Equal((true, (float?)null), SpeakerGate.IsEnrolledSpeaker(Voice(1000), null, new[] { 1f, 0f }, 0.45f));
        Assert.Equal((true, (float?)null), SpeakerGate.IsEnrolledSpeaker(Voice(1000), FakeEmbed, null, 0.45f));
        // A voiceprint from another model, or an embedding that came out NaN.
        Assert.Equal((true, (float?)null), SpeakerGate.IsEnrolledSpeaker(Voice(1000), FakeEmbed, new[] { 1f, 0f, 0f }, 0.45f));
        Assert.Equal((true, (float?)null), SpeakerGate.IsEnrolledSpeaker(Voice(1000), _ => new[] { float.NaN, 1f }, new[] { 1f, 0f }, 0.45f));
    }

    [Fact]
    public void ScoresAgainstTheVoiceprint()
    {
        var voiceprint = SpeakerGate.Voiceprint(new[] { FakeEmbed(Voice(1000)), FakeEmbed(Voice(1000)) });

        var (mePass, meScore) = SpeakerGate.IsEnrolledSpeaker(Voice(1000), FakeEmbed, voiceprint, 0.9f);
        Assert.True(mePass);
        Assert.Equal(1f, meScore!.Value, 3);

        var (tvPass, tvScore) = SpeakerGate.IsEnrolledSpeaker(Voice(-3000), FakeEmbed, voiceprint, 0.9f);
        Assert.False(tvPass);
        Assert.True(tvScore < 0.9f);

        // The threshold decides.
        Assert.True(SpeakerGate.IsEnrolledSpeaker(Voice(-3000), FakeEmbed, voiceprint, tvScore!.Value).Pass);
    }

    [Fact]
    public void Voiceprint_IsTheNormalisedMean()
    {
        var voiceprint = SpeakerGate.Voiceprint(new[] { new[] { 3f, 0f }, new[] { 0f, 0.5f } });
        Assert.Equal(1 / MathF.Sqrt(2), voiceprint[0], 4);
        Assert.Equal(1 / MathF.Sqrt(2), voiceprint[1], 4);
    }

    [Theory]
    [InlineData(SpeakerGateMode.Off, false, false, false)]
    [InlineData(SpeakerGateMode.WakeWord, false, false, true)]
    [InlineData(SpeakerGateMode.WakeWord, true, false, false)]
    [InlineData(SpeakerGateMode.WakeWord, true, true, false)]
    [InlineData(SpeakerGateMode.WakeWordAndBargeIn, false, false, true)]
    [InlineData(SpeakerGateMode.WakeWordAndBargeIn, true, true, true)]
    [InlineData(SpeakerGateMode.WakeWordAndBargeIn, true, false, false)]
    [InlineData(SpeakerGateMode.AllSpeech, true, false, true)]
    public void Applies(object mode, bool awake, bool wasInterruption, bool expected)
    {
        Assert.Equal(expected, SpeakerGate.Applies((SpeakerGateMode)mode, awake, wasInterruption));
    }

    [Theory]
    [InlineData(null, null, SpeakerGateMode.Off)]
    [InlineData(null, "wakeWord", SpeakerGateMode.WakeWord)]
    [InlineData("allspeech", "wakeWord", SpeakerGateMode.AllSpeech)]
    [InlineData("nonsense", "wakeWord", SpeakerGateMode.Off)]
    public void ResolveMode(string? env, string? setting, object expected)
    {
        Assert.Equal((SpeakerGateMode)expected, SpeakerGate.ResolveMode(env, setting));
    }

    // #965: MANA_SPEAKER_THRESHOLD wins over Settings > Voice; out-of-range
    // values fall through.
    [Theory]
    [InlineData(null, null, SpeakerGate.DefaultThreshold)]
    [InlineData(null, 0.6f, 0.6f)]
    [InlineData("0.3", 0.6f, 0.3f)]
    [InlineData("1.5", 0.6f, 0.6f)]
    [InlineData(null, 0f, SpeakerGate.DefaultThreshold)]
    public void ResolveThreshold(string? env, float? setting, float expected)
    {
        Assert.Equal(expected, SpeakerGate.ResolveThreshold(env, setting));
    }

    [Fact]
    public void SpeechSpan_DropsSilenceAroundTheVoiceAndCaps()
    {
        var samples = new short[16000 * 6];
        for (var i = 3200; i < 8000; i++)
        {
            samples[i] = (short)(i % 2 == 0 ? 5000 : -5000);
        }
        Assert.Equal(4800, SpeakerGate.SpeechSpan(samples).Length);

        Array.Fill(samples, (short)5000);
        Assert.Equal(SpeakerGate.MaxSamples, SpeakerGate.SpeechSpan(samples).Length);
    }

    // Reference values from torchaudio.compliance.kaldi.fbank (num_mel_bins
    // 80, 25/10ms, dither 0, hamming, use_energy False) minus the per-bin
    // mean, on the same deterministic signal -- WeSpeaker's infer_onnx.py.
    [Fact]
    public void Fbank_MatchesTorchaudioKaldi()
    {
        var samples = new short[16000];
        long s = 1;
        for (var n = 0; n < samples.Length; n++)
        {
            s = (s * 1103515245 + 12345) % 2147483648;
            samples[n] = (short)Math.Round(8000 * Math.Sin(2 * Math.PI * 440 * n / 16000) + 3000 * Math.Sin(2 * Math.PI * 1234 * n / 16000) + s % 2001 - 1000, MidpointRounding.ToEven);
        }
        var feats = SpeakerEmbedder.Fbank(samples);
        Assert.Equal(98 * SpeakerEmbedder.MelBins, feats.Length);
        foreach (var (frame, bin, expected) in new[] { (0, 0, -0.16823), (0, 10, 0.98888), (5, 40, 0.45489), (50, 79, -0.37749), (97, 3, 0.77491), (20, 25, 0.10319) })
        {
            Assert.Equal(expected, feats[frame * SpeakerEmbedder.MelBins + bin], 2);
        }
    }
}

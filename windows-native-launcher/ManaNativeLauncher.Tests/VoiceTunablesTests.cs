using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #858: voice tunables (env var over Settings > Voice) and the RMS fallback.
public class VoiceTunablesTests
{
    [Theory]
    [InlineData(null, null, 2200)]       // default
    [InlineData(null, 1500L, 1500)]      // Settings > Voice
    [InlineData("3000", 1500L, 3000)]    // MANA_SILENCE_BUFFER_MS wins
    [InlineData("abc", 1500L, 1500)]     // unparseable env: the setting
    [InlineData("50", 99999L, 2200)]     // both out of range: default
    public void SilenceBuffer(string? env, long? saved, long expected)
    {
        Assert.Equal(expected, RecordingSegmenter.ResolveSilenceBufferMs(env, saved));
    }

    [Theory]
    [InlineData(null, null, 0.5f)]
    [InlineData(null, 0.35f, 0.35f)]
    [InlineData("0.7", 0.35f, 0.7f)]     // MANA_VAD_THRESHOLD wins
    [InlineData("1.5", 0.35f, 0.35f)]    // out of range: ignored
    [InlineData("0", null, 0.5f)]
    public void VadThreshold(string? env, float? saved, float expected)
    {
        Assert.Equal(expected, SileroVadRunner.ResolveThreshold(env, saved));
    }

    [Fact]
    public void RmsFallback_HearsSpeechLevelAudioButNotSilence()
    {
        var quiet = new float[512];
        var loud = new float[512];
        for (var i = 0; i < loud.Length; i++)
        {
            quiet[i] = (i % 2 == 0 ? 1 : -1) * 0.005f;
            loud[i] = (i % 2 == 0 ? 1 : -1) * 0.05f;
        }
        Assert.False(VoiceLoop.IsSpeechByRms(quiet, 0.012));
        Assert.True(VoiceLoop.IsSpeechByRms(loud, 0.012));
        Assert.False(VoiceLoop.IsSpeechByRms([], 0.012));
    }
}

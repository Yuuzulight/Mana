using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class SmartTurnRunnerTests
{
    internal static readonly string ModelPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "assets", "turn", SmartTurnRunner.ModelFileName);

    // #909: the model only knows Whisper's features. Expected values are from
    // transformers' WhisperFeatureExtractor(chunk_length=8) on the same 1.5s
    // signal, front-padded to 8s the way pipecat's inference.py does.
    [Theory]
    [InlineData(0, 0, -0.07803667f)]
    [InlineData(5, 700, 1.6697735f)]
    [InlineData(10, 799, 0.9586932f)]
    [InlineData(20, 649, 0.1490587f)]
    [InlineData(40, 760, -0.0940375f)]
    [InlineData(79, 799, -0.0005764f)]
    public void LogMel_MatchesWhisperFeatureExtractor(int mel, int frame, float expected)
    {
        var samples = new short[24000];
        for (var n = 0; n < samples.Length; n++)
        {
            var x = 0.3 * Math.Sin(2 * Math.PI * 220 * n / 16000) * (n / 24000.0) + 0.1 * Math.Sin(2 * Math.PI * 3000 * n / 16000);
            samples[n] = (short)(x * 32767);
        }

        var features = SmartTurnRunner.LogMel(samples);

        Assert.Equal(SmartTurnRunner.MelBins * SmartTurnRunner.Frames, features.Length);
        Assert.Equal(expected, features[mel * SmartTurnRunner.Frames + frame], 0.002f);
    }

    [Theory]
    [InlineData(null, 0.5f)]
    [InlineData("0.7", 0.7f)]
    [InlineData("2", 0.5f)]
    [InlineData("off", null)]
    [InlineData(" OFF ", null)]
    [InlineData("0", null)]
    public void ResolveThreshold_ReadsMANA_SMART_TURN(string? env, float? expected)
    {
        Assert.Equal(expected, SmartTurnRunner.ResolveThreshold(env));
    }

    [SmartTurnModelFact]
    public void PredictComplete_ReturnsAProbability()
    {
        using var runner = new SmartTurnRunner(ModelPath);
        var samples = new short[3 * 16000];
        var rng = new Random(1);
        for (var i = 0; i < samples.Length; i++)
        {
            samples[i] = (short)rng.Next(-4000, 4000);
        }

        var p = runner.PredictComplete(samples);

        Assert.InRange(p, 0f, 1f);
    }
}

internal sealed class SmartTurnModelFactAttribute : FactAttribute
{
    public SmartTurnModelFactAttribute()
    {
        if (!File.Exists(SmartTurnRunnerTests.ModelPath))
        {
            Skip = "Smart Turn model not available";
        }
    }
}

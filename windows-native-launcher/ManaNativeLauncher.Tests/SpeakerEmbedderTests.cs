using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #678: the real speaker model -- build-time-fetched and gitignored, so this
// skips when it's missing (same as WakeWordClassifierTests).
public class SpeakerEmbedderTests
{
    internal static readonly string ModelPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "assets", "speaker", SpeakerEmbedder.ModelFileName);

    [SpeakerModelFact]
    public void Embed_Returns256FiniteValues()
    {
        using var embedder = new SpeakerEmbedder(ModelPath);
        var rng = new Random(1);
        var samples = new short[SpeakerGate.MaxSamples];
        for (var i = 0; i < samples.Length; i++)
        {
            samples[i] = (short)rng.Next(-4000, 4000);
        }

        var embedding = embedder.Embed(samples);

        Assert.Equal(256, embedding.Length);
        Assert.All(embedding, value => Assert.True(float.IsFinite(value)));
    }
}

internal sealed class SpeakerModelFactAttribute : FactAttribute
{
    public SpeakerModelFactAttribute()
    {
        if (!File.Exists(SpeakerEmbedderTests.ModelPath))
        {
            Skip = "speaker model not available (the build-time fetch may have failed offline)";
        }
    }
}

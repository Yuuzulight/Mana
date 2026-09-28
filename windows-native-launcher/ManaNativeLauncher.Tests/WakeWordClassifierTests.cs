using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class WakeWordClassifierTests
{
    // melspectrogram.onnx and embedding_model.onnx are build-time-fetched,
    // gitignored binaries (same reasoning as SileroVadRunnerTests'
    // ModelPath); mana.onnx is committed directly but still resolved the
    // same way for symmetry. Skips gracefully rather than failing CI
    // elsewhere.
    private static readonly string WakeWordDir = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "assets", "wakeword");

    internal static readonly string MelspecPath = Path.Combine(WakeWordDir, "melspectrogram.onnx");
    internal static readonly string EmbeddingPath = Path.Combine(WakeWordDir, "embedding_model.onnx");
    internal static readonly string ClassifierPath = Path.Combine(WakeWordDir, "mana.onnx");

    internal static bool ModelsAvailable =>
        File.Exists(MelspecPath) && new FileInfo(MelspecPath).Length > 0 &&
        File.Exists(EmbeddingPath) && new FileInfo(EmbeddingPath).Length > 0 &&
        File.Exists(ClassifierPath) && new FileInfo(ClassifierPath).Length > 0;

    private static WakeWordClassifier CreateClassifier() =>
        new(MelspecPath, EmbeddingPath, ClassifierPath);

    [SkippableFact]
    public void Score_AnySegmentLengthProducesValidProbability()
    {
        using var classifier = CreateClassifier();

        // Empty, shorter than the 2.0s window, and (#682) a max-length 20s
        // segment -- every length is left-padded and slid over, none throws.
        foreach (var length in new[] { 0, WakeWordClassifier.SampleRate / 2, (int)RecordingSegmenter.DefaultMaxUtteranceMs * 16 })
        {
            Assert.InRange(classifier.Score(new short[length]), 0f, 1f);
        }
    }

    // #682: env beats the Settings > Voice choice; anything unrecognised
    // (or nothing at all) fails open to off rather than making Mana deaf.
    [Theory]
    [InlineData(null, null, null)]
    [InlineData("", "loose", WakeWordClassifier.LooseThreshold)]
    [InlineData(" Normal ", "loose", WakeWordClassifier.NormalThreshold)]
    [InlineData("off", "normal", null)]
    [InlineData("0.7", null, 0.7f)]
    [InlineData("1.5", "normal", null)]
    [InlineData("garbage", null, null)]
    public void ResolveThreshold_MapsModes(string? env, string? setting, float? expected)
    {
        Assert.Equal(expected, WakeWordClassifier.ResolveThreshold(env, setting));
    }
}

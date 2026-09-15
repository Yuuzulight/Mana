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

    private static WakeWordClassifier CreateClassifier(float threshold = WakeWordClassifier.DefaultThreshold) =>
        new(MelspecPath, EmbeddingPath, ClassifierPath, threshold);

    [SkippableFact]
    public void Score_SilenceProducesValidProbability()
    {
        using var classifier = CreateClassifier();
        var silence = new short[WakeWordClassifier.WindowSamples];

        var score = classifier.Score(silence);

        Assert.InRange(score, 0f, 1f);
    }

    [SkippableFact]
    public void Score_ShorterThanWindowIsPaddedNotThrown()
    {
        using var classifier = CreateClassifier();
        // Half a second -- well under the model's 2.0s training window --
        // exercises AlignToWindow's left-pad path.
        var shortClip = new short[WakeWordClassifier.SampleRate / 2];

        var score = classifier.Score(shortClip);

        Assert.InRange(score, 0f, 1f);
    }

    [SkippableFact]
    public void Score_LongerThanWindowIsTruncatedNotThrown()
    {
        using var classifier = CreateClassifier();
        // Five seconds -- well over the model's 2.0s training window --
        // exercises AlignToWindow's right-align/truncate path.
        var longClip = new short[WakeWordClassifier.SampleRate * 5];

        var score = classifier.Score(longClip);

        Assert.InRange(score, 0f, 1f);
    }

    [SkippableFact]
    public void MayContainWakeWord_RespectsConfiguredThreshold()
    {
        // A threshold of exactly 0 must always pass (any real sigmoid
        // score is >= 0); a threshold of 1 immediately above the maximum
        // possible score must never pass for silence. This only pins
        // down the threshold comparison itself, not the real model's
        // actual weights/accuracy.
        var silence = new short[WakeWordClassifier.WindowSamples];

        using var alwaysPasses = CreateClassifier(threshold: 0f);
        Assert.True(alwaysPasses.MayContainWakeWord(silence));

        using var neverPasses = CreateClassifier(threshold: 1.0001f);
        Assert.False(neverPasses.MayContainWakeWord(silence));
    }
}

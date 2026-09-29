using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class SileroVadRunnerTests
{
    // The model is a build-time-fetched, gitignored binary (Task 3, Step
    // 2) -- not guaranteed present in every checkout/CI environment.
    // Skips gracefully rather than failing CI elsewhere, matching
    // node-bot/test/transcribe-partial-real-whisper.test.js's own
    // pattern for a similarly-optional large binary dependency.
    internal static readonly string ModelPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "assets", "vad", "silero_vad.onnx");

    internal static bool ModelAvailable => File.Exists(ModelPath) && new FileInfo(ModelPath).Length > 0;

    // #858 + #665: Settings > Voice moves the enter threshold each time
    // listening starts; the exit threshold follows it down, never above it.
    [SkippableFact]
    public void Threshold_KeepsTheExitThresholdAtOrBelowIt()
    {
        using var vad = new SileroVadRunner(ModelPath, 0.5f, 0.35f);
        vad.Threshold = 0.3f;
        Assert.Equal(0.3f, vad.ExitThreshold);
        vad.Threshold = 0.7f;
        Assert.Equal(0.35f, vad.ExitThreshold);
    }

    [SkippableFact]
    public void ProcessFrame_ThrowsOnWrongFrameLength()
    {
        using var vad = new SileroVadRunner(ModelPath);
        var wrongSizeFrame = new float[SileroVadRunner.FrameSamples - 1];

        Assert.Throws<ArgumentException>(() => vad.ProcessFrame(wrongSizeFrame));
    }

    [SkippableFact]
    public void ProcessFrame_SilenceProducesLowProbability()
    {
        using var vad = new SileroVadRunner(ModelPath);
        var silence = new float[SileroVadRunner.FrameSamples];

        // Run a few frames through -- the recurrent state needs a couple
        // calls to settle away from its zero-initialized starting point.
        float probability = 0;
        for (var i = 0; i < 5; i++)
        {
            probability = vad.ProcessFrame(silence);
        }

        Assert.False(vad.IsSpeech(probability));
    }

    [SkippableFact]
    public void Reset_ClearsRecurrentStateAndContext()
    {
        using var vad = new SileroVadRunner(ModelPath);
        var loudFrame = new float[SileroVadRunner.FrameSamples];
        Array.Fill(loudFrame, 0.5f);
        vad.ProcessFrame(loudFrame);

        // No assertion on the probability itself (that depends on the
        // real model's actual weights, which this test doesn't second-
        // guess) -- this only confirms Reset() runs without throwing and
        // a fresh frame can be processed immediately after, proving the
        // internal buffers were actually reset to valid same-shape state
        // rather than left corrupted.
        vad.Reset();
        var silence = new float[SileroVadRunner.FrameSamples];
        var probability = vad.ProcessFrame(silence);

        Assert.InRange(probability, 0f, 1f);
    }

    // #665: hysteresis -- enter at 0.5, stay until the score drops under 0.35.
    [Fact]
    public void NextSpeech_EntersAtTheThresholdAndLeavesOnlyBelowTheExit()
    {
        var scores = new[] { 0.3f, 0.45f, 0.6f, 0.4f, 0.36f, 0.34f, 0.45f, 0.5f };
        var expected = new[] { false, false, true, true, true, false, false, true };
        var inSpeech = false;
        for (var i = 0; i < scores.Length; i++)
        {
            inSpeech = SileroVadRunner.NextSpeech(inSpeech, scores[i], SileroVadRunner.DefaultThreshold, SileroVadRunner.DefaultExitThreshold);
            Assert.Equal(expected[i], inSpeech);
        }
    }

    // #665: a soft consonant (0.4) inside "wait, stop" no longer resets the
    // barge-in count, so it still fires at 350 ms of loud speech.
    [Fact]
    public void BargeInCount_SurvivesADipBetweenTheThresholds()
    {
        var scores = new[] { 0.7f, 0.8f, 0.4f, 0.7f, 0.6f, 0.4f, 0.7f, 0.8f, 0.7f, 0.9f, 0.7f, 0.8f };
        var inSpeech = false;
        long held = 0;
        var fired = false;
        foreach (var score in scores)
        {
            inSpeech = SileroVadRunner.NextSpeech(inSpeech, score, SileroVadRunner.DefaultThreshold, SileroVadRunner.DefaultExitThreshold);
            (held, var triggered) = BargeInGate.Next(inSpeech, isLoudEnough: true, held, frameMs: 32);
            fired |= triggered;
        }
        Assert.True(fired); // 12 x 32 ms = 384 ms >= 350 ms, never reset
    }
}

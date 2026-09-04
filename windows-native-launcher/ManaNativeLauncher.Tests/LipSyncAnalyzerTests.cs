using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// Test cases mirror windows-launcher/test/lip-sync.test.js's own coverage
// for the ported functions (computeMfcc/classifyViseme/visemeToMouthForm/
// rmsToMouth/smoothMouthValue) -- same synthetic-spectrum construction
// (spectrumForHz) so the classification logic is checked against the same
// real-world formant-band cases the JS original was tuned against.
public class LipSyncAnalyzerTests
{
    private const int FftSize = 512;
    private const int SampleRate = 48000;
    private const int NumBins = FftSize / 2 + 1;
    private const double BinHz = SampleRate / (double)FftSize;

    // Builds a synthetic getFloatFrequencyData-shaped spectrum with loud
    // energy concentrated at the given Hz values (everything else at the
    // noise floor).
    private static float[] SpectrumForHz(double[] hzList, float loudDb = -10f, float floorDb = -100f)
    {
        var magnitudes = new float[NumBins];
        Array.Fill(magnitudes, floorDb);
        foreach (var hz in hzList)
        {
            magnitudes[(int)Math.Round(hz / BinHz)] = loudDb;
        }
        return magnitudes;
    }

    [Fact]
    public void RmsToMouth_And_SmoothMouthValue_BasicBehavior()
    {
        Assert.Equal(0f, LipSyncAnalyzer.RmsToMouth(0));
        Assert.Equal(1f, LipSyncAnalyzer.SmoothMouthValue(0, 1, 1000));
    }

    [Fact]
    public void ComputeMelEnergies_ReturnsTheExpectedShape()
    {
        var silent = new float[NumBins];
        Array.Fill(silent, -100f);

        var result = LipSyncAnalyzer.ComputeMelEnergies(silent, SampleRate, FftSize);

        Assert.Equal(26, result.MelEnergies.Length);
        Assert.Equal(26, result.MelCenterHz.Length);
        for (var i = 1; i < result.MelCenterHz.Length; i++)
        {
            Assert.True(result.MelCenterHz[i] > result.MelCenterHz[i - 1], "mel filter centers must be monotonically increasing");
        }
    }

    [Fact]
    public void ComputeMelEnergies_HonorsACustomNumFilters()
    {
        var silent = new float[NumBins];
        Array.Fill(silent, -100f);

        var result = LipSyncAnalyzer.ComputeMelEnergies(silent, SampleRate, FftSize, numFilters: 10);

        Assert.Equal(10, result.MelEnergies.Length);
    }

    [Fact]
    public void ClassifyViseme_ReturnsNeutralForSilence()
    {
        var silent = new float[NumBins];
        Array.Fill(silent, -100f);
        var result = LipSyncAnalyzer.ComputeMelEnergies(silent, SampleRate, FftSize);

        Assert.Equal("neutral", LipSyncAnalyzer.ClassifyViseme(result));
    }

    [Fact]
    public void ClassifyViseme_ReturnsNeutralForAnEmptyResultInsteadOfThrowing()
    {
        Assert.Equal("neutral", LipSyncAnalyzer.ClassifyViseme(default));
    }

    // Formant-band energy at each viseme's typical F1/F2 midpoints (see
    // LipSyncAnalyzer.VisemeFormantBands) should classify to that viseme --
    // verified against real adult vowel formant ranges, not tuned to make
    // the test pass, same as the JS original's own comment.
    [Fact]
    public void ClassifyViseme_DistinguishesAaEeOoFromTheirTypicalFormantBands()
    {
        var aa = LipSyncAnalyzer.ComputeMelEnergies(SpectrumForHz([800, 1450]), SampleRate, FftSize);
        Assert.Equal("aa", LipSyncAnalyzer.ClassifyViseme(aa));

        var ee = LipSyncAnalyzer.ComputeMelEnergies(SpectrumForHz([350, 2450]), SampleRate, FftSize);
        Assert.Equal("ee", LipSyncAnalyzer.ClassifyViseme(ee));

        var oo = LipSyncAnalyzer.ComputeMelEnergies(SpectrumForHz([350, 850]), SampleRate, FftSize);
        Assert.Equal("oo", LipSyncAnalyzer.ClassifyViseme(oo));
    }

    [Fact]
    public void VisemeToMouthForm_MapsEeOoToPlusMinusOneAndAnythingElseToNeutral()
    {
        Assert.Equal(1f, LipSyncAnalyzer.VisemeToMouthForm("ee"));
        Assert.Equal(-1f, LipSyncAnalyzer.VisemeToMouthForm("oo"));
        Assert.Equal(0f, LipSyncAnalyzer.VisemeToMouthForm("aa"));
        Assert.Equal(0f, LipSyncAnalyzer.VisemeToMouthForm("neutral"));
    }
}

using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class SimpleFftTests
{
    [Fact]
    public void MagnitudesDb_ThrowsForANonPowerOfTwoSampleCount()
    {
        Assert.Throws<ArgumentException>(() => SimpleFft.MagnitudesDb(new float[100]));
    }

    [Fact]
    public void MagnitudesDb_SilenceProducesTheFloorEverywhere()
    {
        var silence = new float[512];
        var magnitudes = SimpleFft.MagnitudesDb(silence);

        Assert.Equal(257, magnitudes.Length); // n/2 + 1
        Assert.All(magnitudes, db => Assert.Equal(-100.0, db, 3));
    }

    [Fact]
    public void MagnitudesDb_APureSineWavePeaksAtItsOwnFrequencyBin()
    {
        const int fftSize = 512;
        const int sampleRate = 48000;
        const double toneHz = 1000; // lands close to a bin center: bin = 1000 / (48000/512) ~= 10.67
        var expectedBin = (int)Math.Round(toneHz / (sampleRate / (double)fftSize));

        var samples = new float[fftSize];
        for (var i = 0; i < fftSize; i++)
        {
            samples[i] = (float)Math.Sin(2 * Math.PI * toneHz * i / sampleRate);
        }

        var magnitudes = SimpleFft.MagnitudesDb(samples);

        // The loudest bin should be at (or immediately adjacent to, given
        // Hann-window spectral spreading) the tone's own frequency bin --
        // and clearly louder than a bin far away from it.
        var loudestBin = 0;
        for (var i = 1; i < magnitudes.Length; i++)
        {
            if (magnitudes[i] > magnitudes[loudestBin])
            {
                loudestBin = i;
            }
        }

        Assert.InRange(loudestBin, expectedBin - 1, expectedBin + 1);
        Assert.True(magnitudes[loudestBin] > magnitudes[expectedBin + 50], "expected the tone's bin to be far louder than an unrelated distant bin");
    }
}

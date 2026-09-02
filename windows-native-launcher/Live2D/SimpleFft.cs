namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: minimal radix-2 FFT + Hann windowing, standing in
// for the browser's built-in AnalyserNode.getFloatFrequencyData that
// windows-launcher's lip-sync pipeline relies on -- .NET has no equivalent
// built-in, and pulling in a numerical-computing dependency for one FFT
// this size is more than this needs.
internal static class SimpleFft
{
    // samples.Length must be a non-zero power of two. Returns dB magnitude
    // per frequency bin (length samples.Length/2 + 1), matching the shape
    // AnalyserNode.getFloatFrequencyData produces.
    public static float[] MagnitudesDb(ReadOnlySpan<float> samples)
    {
        var n = samples.Length;
        if (n == 0 || (n & (n - 1)) != 0)
        {
            throw new ArgumentException("sample count must be a non-zero power of two", nameof(samples));
        }

        var real = new double[n];
        var imag = new double[n];
        for (var i = 0; i < n; i++)
        {
            // Hann window -- reduces spectral leakage, roughly matching
            // the windowing AnalyserNode applies internally.
            var window = n > 1 ? 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (n - 1)) : 1.0;
            real[i] = samples[i] * window;
        }

        Transform(real, imag);

        var bins = n / 2 + 1;
        var result = new float[bins];
        const double floorDb = -100.0;
        for (var i = 0; i < bins; i++)
        {
            var magnitude = Math.Sqrt(real[i] * real[i] + imag[i] * imag[i]) / n;
            var db = magnitude > 0 ? 20 * Math.Log10(magnitude) : floorDb;
            result[i] = (float)Math.Max(db, floorDb);
        }
        return result;
    }

    // In-place iterative radix-2 Cooley-Tukey.
    private static void Transform(double[] real, double[] imag)
    {
        var n = real.Length;

        // Bit-reversal permutation.
        for (int i = 1, j = 0; i < n; i++)
        {
            var bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1)
            {
                j ^= bit;
            }
            j ^= bit;
            if (i < j)
            {
                (real[i], real[j]) = (real[j], real[i]);
                (imag[i], imag[j]) = (imag[j], imag[i]);
            }
        }

        for (var length = 2; length <= n; length <<= 1)
        {
            var angle = -2 * Math.PI / length;
            var wReal = Math.Cos(angle);
            var wImag = Math.Sin(angle);
            var half = length / 2;
            for (var i = 0; i < n; i += length)
            {
                double curReal = 1, curImag = 0;
                for (var k = 0; k < half; k++)
                {
                    var evenReal = real[i + k];
                    var evenImag = imag[i + k];
                    var oddReal = real[i + k + half] * curReal - imag[i + k + half] * curImag;
                    var oddImag = real[i + k + half] * curImag + imag[i + k + half] * curReal;

                    real[i + k] = evenReal + oddReal;
                    imag[i + k] = evenImag + oddImag;
                    real[i + k + half] = evenReal - oddReal;
                    imag[i + k + half] = evenImag - oddImag;

                    var nextReal = curReal * wReal - curImag * wImag;
                    var nextImag = curReal * wImag + curImag * wReal;
                    curReal = nextReal;
                    curImag = nextImag;
                }
            }
        }
    }
}

using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Numerics;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace Mana.NativeLauncher;

// #909: semantic end-of-turn. Smart Turn v3.2 (pipecat-ai, BSD-2-Clause, see
// THIRD_PARTY.md) is a Whisper-tiny encoder with a one-output head: from the
// last 8s of the turn's audio it hears whether the speaker has finished (a
// falling "done" tone versus a mid-thought "and, um..."), whatever the words
// or accent. It runs on the CPU once per pause, not per frame.
//
// Input is Whisper's 80-bin log-mel, computed here the way pipecat's
// inference.py gets it from transformers' WhisperFeatureExtractor(chunk_length
// = 8, do_normalize=True): zero-padded at the FRONT to 8s, zero-mean/unit-
// variance over those whole 8s, 400-sample periodic Hann frames every 160
// samples (centred, reflect-padded; the last frame dropped), power spectrum,
// Slaney mel filters 0-8kHz, log10, floored 8 below the peak, (x + 4) / 4.
internal sealed class SmartTurnRunner : IDisposable
{
    internal const string ModelFileName = "smart-turn-v3.2-cpu.onnx";
    internal const float DefaultThreshold = 0.5f;

    private const int SampleRate = SileroVadRunner.SampleRate;
    internal const int MaxSamples = 8 * SampleRate;
    private const int FftSize = 400;
    private const int Hop = 160;
    private const int Bins = FftSize / 2 + 1;
    internal const int MelBins = 80;
    internal const int Frames = MaxSamples / Hop;

    private static readonly float[] Window = Enumerable.Range(0, FftSize)
        .Select(n => (float)(0.5 - 0.5 * Math.Cos(2 * Math.PI * n / FftSize))).ToArray();
    // Row k: cos / sin of 2*pi*k*n/400, for a straight DFT (400 isn't a
    // power of two; all 800 frames take ~17ms in Release with SIMD dots).
    // Field initialisers only, no static constructor, so ResolveThreshold
    // and TryLoad don't build these when the model is off or missing.
    private static readonly float[] Cos = DftTable(Math.Cos);
    private static readonly float[] Sin = DftTable(Math.Sin);
    private static readonly (int Start, float[] Weights)[] MelFilters = BuildMelFilters();

    private readonly InferenceSession session;

    private static float[] DftTable(Func<double, double> f)
    {
        var table = new float[Bins * FftSize];
        for (var i = 0; i < table.Length; i++)
        {
            table[i] = (float)f(2 * Math.PI * (i / FftSize * (i % FftSize) % FftSize) / FftSize);
        }
        return table;
    }

    public SmartTurnRunner(string modelPath)
    {
        // Two threads: quick enough (one pause, one run) without taking
        // every core from a game.
        using var options = new SessionOptions { IntraOpNumThreads = 2, InterOpNumThreads = 1 };
        session = new InferenceSession(modelPath, options);
    }

    // MANA_SMART_TURN: "off" (or "0") turns it off -- the end of a turn is
    // then decided exactly as before #909 -- and a number in (0, 1) is the
    // "finished" threshold; anything else keeps 0.5. Null means off.
    internal static float? ResolveThreshold(string? env) =>
        env is not null && (env.Trim().Equals("off", StringComparison.OrdinalIgnoreCase) || env.Trim() == "0") ? null
        : float.TryParse(env, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) && value > 0f && value < 1f ? value
        : DefaultThreshold;

    // assets\turn\ (fetched at build time, gitignored). A missing or broken
    // model leaves the end of a turn to the silence and transcript rules.
    internal static SmartTurnRunner? TryLoad(string rootDir)
    {
        var path = Path.Combine(rootDir, "windows-native-launcher", "assets", "turn", ModelFileName);
        if (!File.Exists(path))
        {
            Console.WriteLine($"SmartTurnRunner: no turn model at {path}, using silence and transcript only.");
            return null;
        }
        try
        {
            return new SmartTurnRunner(path);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Console.WriteLine($"SmartTurnRunner: couldn't load {path}, using silence and transcript only. {ex.Message}");
            return null;
        }
    }

    // samples: the turn so far, 16-bit PCM at 16kHz (only the last 8s are
    // used). Returns P(the speaker has finished).
    public float PredictComplete(short[] samples)
    {
        var input = new DenseTensor<float>(LogMel(samples), new[] { 1, MelBins, Frames });
        using var results = session.Run(new[] { NamedOnnxValue.CreateFromTensor("input_features", input) });
        return results.First().AsEnumerable<float>().First();
    }

    // (MelBins x Frames), row-major.
    internal static float[] LogMel(short[] samples)
    {
        var take = Math.Min(samples.Length, MaxSamples);
        var audio = new float[MaxSamples];
        for (var i = 0; i < take; i++)
        {
            audio[MaxSamples - take + i] = samples[samples.Length - take + i] / 32768f;
        }
        double sum = 0, sumSq = 0;
        foreach (var x in audio)
        {
            sum += x;
            sumSq += (double)x * x;
        }
        var mean = sum / MaxSamples;
        var scale = 1 / Math.Sqrt(sumSq / MaxSamples - mean * mean + 1e-7);

        const int pad = FftSize / 2;
        var padded = new float[MaxSamples + 2 * pad];
        for (var i = 0; i < padded.Length; i++)
        {
            var j = i - pad;
            j = j < 0 ? -j : j >= MaxSamples ? 2 * MaxSamples - 2 - j : j;
            padded[i] = (float)((audio[j] - mean) * scale);
        }

        var mel = new float[MelBins * Frames];
        var frame = new float[FftSize];
        var power = new float[Bins];
        var peak = float.MinValue;
        for (var t = 0; t < Frames; t++)
        {
            for (var n = 0; n < FftSize; n++)
            {
                frame[n] = padded[t * Hop + n] * Window[n];
            }
            for (var k = 0; k < Bins; k++)
            {
                var re = Dot(frame, Cos.AsSpan(k * FftSize, FftSize));
                var im = Dot(frame, Sin.AsSpan(k * FftSize, FftSize));
                power[k] = re * re + im * im;
            }
            for (var m = 0; m < MelBins; m++)
            {
                var (start, weights) = MelFilters[m];
                float energy = 0;
                for (var j = 0; j < weights.Length; j++)
                {
                    energy += weights[j] * power[start + j];
                }
                var value = (float)Math.Log10(Math.Max(energy, 1e-10f));
                mel[m * Frames + t] = value;
                peak = Math.Max(peak, value);
            }
        }
        for (var i = 0; i < mel.Length; i++)
        {
            mel[i] = (Math.Max(mel[i], peak - 8f) + 4f) / 4f;
        }
        return mel;
    }

    private static float Dot(ReadOnlySpan<float> a, ReadOnlySpan<float> b)
    {
        var width = Vector<float>.Count;
        var acc = Vector<float>.Zero;
        var i = 0;
        for (; i <= a.Length - width; i += width)
        {
            acc += new Vector<float>(a.Slice(i, width)) * new Vector<float>(b.Slice(i, width));
        }
        var total = Vector.Dot(acc, Vector<float>.One);
        for (; i < a.Length; i++)
        {
            total += a[i] * b[i];
        }
        return total;
    }

    // transformers' mel_filter_bank(201, 80, 0, 8000, 16000, norm="slaney",
    // mel_scale="slaney"): each filter's first FFT bin and its weights.
    private static (int Start, float[] Weights)[] BuildMelFilters()
    {
        const double minLogHz = 1000, minLogMel = 15, logStep = 27 / 1.8562979903656263; // ln(6.4)
        static double HzToMel(double hz) => hz < minLogHz ? 3 * hz / 200 : minLogMel + Math.Log(hz / minLogHz) * logStep;
        static double MelToHz(double mel) => mel < minLogMel ? 200 * mel / 3 : minLogHz * Math.Exp((mel - minLogMel) / logStep);
        var maxMel = HzToMel(SampleRate / 2.0);
        var edges = Enumerable.Range(0, MelBins + 2).Select(i => MelToHz(maxMel * i / (MelBins + 1))).ToArray();
        var filters = new (int, float[])[MelBins];
        for (var m = 0; m < MelBins; m++)
        {
            double left = edges[m], center = edges[m + 1], right = edges[m + 2];
            var norm = 2 / (right - left);
            var weights = Enumerable.Range(0, Bins)
                .Select(k => k * (SampleRate / 2.0) / (Bins - 1))
                .Select(hz => Math.Max(0, Math.Min((hz - left) / (center - left), (right - hz) / (right - center))) * norm)
                .ToArray();
            var start = Array.FindIndex(weights, w => w > 0);
            var end = Array.FindLastIndex(weights, w => w > 0);
            filters[m] = start < 0 ? (0, Array.Empty<float>()) : (start, weights[start..(end + 1)].Select(w => (float)w).ToArray());
        }
        return filters;
    }

    public void Dispose() => session.Dispose();
}

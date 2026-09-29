using System;
using System.IO;
using System.Linq;
using Mana.NativeLauncher.Live2D;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace Mana.NativeLauncher;

// #678: a speaker embedding for SpeakerGate, from WeSpeaker's VoxCeleb
// ResNet34-LM export (voxceleb_resnet34_LM.onnx, CC BY 4.0, see
// THIRD_PARTY.md). It takes 80-bin Kaldi fbank frames, computed here the
// way WeSpeaker's infer_onnx.py does (torchaudio's kaldi.fbank: 25ms/10ms
// hamming frames, no dither, CMN), and returns one 256-dim vector.
internal sealed class SpeakerEmbedder : IDisposable
{
    internal const string ModelFileName = "voxceleb_resnet34_LM.onnx";

    private const int FrameLength = 400; // 25ms at 16kHz
    private const int FrameShift = 160;  // 10ms
    private const int FftSize = 512;
    internal const int MelBins = 80;

    private static readonly double[] Window = Enumerable.Range(0, FrameLength)
        .Select(i => 0.54 - 0.46 * Math.Cos(2 * Math.PI * i / (FrameLength - 1))).ToArray();
    private static readonly (int Start, double[] Weights)[] MelFilters = BuildMelFilters();

    private readonly InferenceSession session;
    private readonly string inputName;

    public SpeakerEmbedder(string modelPath)
    {
        session = new InferenceSession(modelPath);
        inputName = session.InputMetadata.Keys.First();
    }

    // MANA_SPEAKER_MODEL, else assets\speaker\ (fetched at build time,
    // gitignored, like silero_vad.onnx).
    internal static string ResolveModelPath(string rootDir) =>
        Environment.GetEnvironmentVariable("MANA_SPEAKER_MODEL") is { Length: > 0 } env
            ? env
            : Path.Combine(rootDir, "windows-native-launcher", "assets", "speaker", ModelFileName);

    // A missing or broken model turns the gate into a pass-through.
    internal static SpeakerEmbedder? TryLoad(string rootDir)
    {
        var path = ResolveModelPath(rootDir);
        if (!File.Exists(path))
        {
            Console.WriteLine($"SpeakerEmbedder: no speaker model at {path}, voiceprint gate passes all speech through.");
            return null;
        }
        try
        {
            return new SpeakerEmbedder(path);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Console.WriteLine($"SpeakerEmbedder: couldn't load {path}, voiceprint gate passes all speech through. {ex.Message}");
            return null;
        }
    }

    // samples: 16-bit PCM at 16kHz, at least 25ms.
    public float[] Embed(short[] samples)
    {
        var feats = Fbank(samples);
        var frames = feats.Length / MelBins;
        var input = new DenseTensor<float>(feats, new[] { 1, frames, MelBins });
        using var results = session.Run(new[] { NamedOnnxValue.CreateFromTensor(inputName, input) });
        return results.First().AsEnumerable<float>().ToArray();
    }

    // (frames * MelBins), row-major, mean-normalised per bin. Samples stay
    // on the int16 scale, as WeSpeaker multiplies its float audio by 2^15.
    internal static float[] Fbank(short[] samples)
    {
        var frames = samples.Length < FrameLength ? 0 : 1 + (samples.Length - FrameLength) / FrameShift;
        var feats = new float[frames * MelBins];
        var real = new double[FftSize];
        var imag = new double[FftSize];
        for (var f = 0; f < frames; f++)
        {
            var offset = f * FrameShift;
            double mean = 0;
            for (var i = 0; i < FrameLength; i++)
            {
                mean += samples[offset + i];
            }
            mean /= FrameLength;
            for (var i = 0; i < FrameLength; i++)
            {
                real[i] = samples[offset + i] - mean;
            }
            // Pre-emphasis 0.97 (the first sample against itself), then the window.
            for (var i = FrameLength - 1; i > 0; i--)
            {
                real[i] -= 0.97 * real[i - 1];
            }
            real[0] -= 0.97 * real[0];
            for (var i = 0; i < FftSize; i++)
            {
                real[i] = i < FrameLength ? real[i] * Window[i] : 0;
                imag[i] = 0;
            }
            SimpleFft.Transform(real, imag);
            for (var m = 0; m < MelBins; m++)
            {
                var (start, weights) = MelFilters[m];
                double energy = 0;
                for (var j = 0; j < weights.Length; j++)
                {
                    var k = start + j;
                    energy += weights[j] * (real[k] * real[k] + imag[k] * imag[k]);
                }
                feats[f * MelBins + m] = (float)Math.Log(Math.Max(energy, 1.1920928955078125e-07));
            }
        }
        for (var m = 0; m < MelBins && frames > 0; m++)
        {
            double mean = 0;
            for (var f = 0; f < frames; f++)
            {
                mean += feats[f * MelBins + m];
            }
            mean /= frames;
            for (var f = 0; f < frames; f++)
            {
                feats[f * MelBins + m] -= (float)mean;
            }
        }
        return feats;
    }

    // Kaldi's triangular mel filters, 20Hz to Nyquist: each filter's first
    // FFT bin and its weights from there.
    private static (int Start, double[] Weights)[] BuildMelFilters()
    {
        static double Mel(double hz) => 1127.0 * Math.Log(1 + hz / 700.0);
        double low = Mel(20), high = Mel(SileroVadRunner.SampleRate / 2.0);
        var delta = (high - low) / (MelBins + 1);
        var filters = new (int, double[])[MelBins];
        for (var m = 0; m < MelBins; m++)
        {
            double left = low + m * delta, center = left + delta, right = center + delta;
            var bins = Enumerable.Range(0, FftSize / 2)
                .Select(k => (K: k, Mel: Mel(k * (double)SileroVadRunner.SampleRate / FftSize)))
                .Where(b => b.Mel > left && b.Mel < right)
                .ToList();
            filters[m] = (bins[0].K, bins.Select(b => b.Mel <= center ? (b.Mel - left) / (center - left) : (right - b.Mel) / (right - center)).ToArray());
        }
        return filters;
    }

    public void Dispose() => session.Dispose();
}

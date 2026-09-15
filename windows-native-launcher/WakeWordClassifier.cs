using System;
using System.Linq;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace Mana.NativeLauncher;

// Acoustic pre-filter for wake-word detection (#342): runs on every
// VAD-closed segment before it's sent to Whisper, so segments that don't
// acoustically contain "Mana" never pay the transcription cost. This is a
// soft optimization, not the wake-up decision itself -- WakeWordMatcher's
// existing text-based check on the (now-conditionally-reached) transcript
// still has final say, per the #342 integration design: a false acoustic
// trigger only ever wastes one Whisper call, it can never cause a false
// wake-up on its own.
//
// Chains three ONNX models exactly as openWakeWord's own Python
// `AudioFeatures`/training code does -- ported from, not reimplemented
// independently of, tts-service/venv/Lib/site-packages/openwakeword/
// utils.py's `_get_melspectrogram`/`_get_embeddings`, and verified against
// the real ONNX models' actual input/output shapes at each stage (not
// assumed from the Python source alone -- see tools/wakeword-training/'s
// own PRs for how this was confirmed):
//
//   raw 16-bit PCM audio (1, samples)
//     -> melspectrogram.onnx -> (1, 1, time, 32), squeezed to (time, 32),
//        transformed by x/10+2 to match the original TF implementation
//     -> a sliding window of 76 mel-frames, stepped by 8, over the time
//        axis -- each full window becomes one (76, 32, 1) input
//     -> embedding_model.onnx, batched over all windows -> (windows, 1, 1, 96),
//        squeezed to (windows, 96)
//     -> mana.onnx (ours, trained in tools/wakeword-training/) -> (1, 1)
//        sigmoid score, when windows == EmbeddingFrames (16)
//
// melspectrogram.onnx and embedding_model.onnx are openWakeWord's own
// third-party pretrained models, fetched at build time (same convention
// as silero_vad.onnx -- see the .csproj). mana.onnx is ours, committed
// directly since nothing else hosts it.
internal sealed class WakeWordClassifier : IDisposable
{
    internal const int SampleRate = 16000;

    // The fixed embedding-frame window mana.onnx was trained on --
    // confirmed empirically in tools/wakeword-training/train_model.py by
    // calling AudioFeatures.get_embedding_shape() at increasing window
    // lengths until it matched the training data's own shape, not assumed.
    internal const int EmbeddingFrames = 16;

    // 2.0 seconds at 16kHz -- the audio length that produces exactly
    // EmbeddingFrames embedding windows (197 mel-frames -> 16 windows of
    // 76 stepped by 8), confirmed against the real ONNX models.
    internal const int WindowSamples = SampleRate * 2;

    // See tools/wakeword-training/README.md's measured false-positive-
    // rate-by-threshold table: 7.2/hour at 0.5, 1.0/hour at 0.99. 0.9 is a
    // reasonable middle ground for a v1 model trained on a modest amount
    // of positive data -- configurable via ManaSettingsStore, not a fixed
    // constant callers are stuck with.
    internal const float DefaultThreshold = 0.9f;

    private const int MelWindowSize = 76;
    private const int MelStepSize = 8;
    private const int MelBins = 32;
    private const int EmbeddingDim = 96;

    private readonly InferenceSession melspecSession;
    private readonly InferenceSession embeddingSession;
    private readonly InferenceSession classifierSession;
    private readonly float threshold;

    public WakeWordClassifier(
        string melspecModelPath,
        string embeddingModelPath,
        string classifierModelPath,
        float threshold = DefaultThreshold)
    {
        melspecSession = new InferenceSession(melspecModelPath);
        embeddingSession = new InferenceSession(embeddingModelPath);
        classifierSession = new InferenceSession(classifierModelPath);
        this.threshold = threshold;
    }

    // samples: 16-bit PCM at 16kHz, any length. Right-aligned/padded to
    // exactly WindowSamples to match how the training clips were aligned
    // (the wake phrase ends near the window's end, with a small start
    // jitter -- see train_model.py's `starts` calculation) -- mana.onnx
    // only ever saw fixed 2.0s windows during training, so a real VAD
    // segment of a different length needs to land in the same place a
    // training example would have.
    public float Score(short[] samples)
    {
        var windowed = AlignToWindow(samples);
        var melspec = Melspectrogram(windowed);
        var embeddings = Embed(melspec);

        if (embeddings.GetLength(0) != EmbeddingFrames)
        {
            // A 2.0s input should always produce exactly 16 windows against
            // these specific models -- if it doesn't, something upstream
            // changed shape in a way this port didn't anticipate. Fail
            // loudly rather than feed a wrong-shaped tensor into the
            // classifier and get a meaningless score back.
            throw new InvalidOperationException(
                $"Expected {EmbeddingFrames} embedding windows from a {WindowSamples}-sample input, got {embeddings.GetLength(0)}.");
        }

        return Classify(embeddings);
    }

    public bool MayContainWakeWord(short[] samples) => Score(samples) >= threshold;

    private static short[] AlignToWindow(short[] samples)
    {
        if (samples.Length == WindowSamples)
        {
            return samples;
        }

        var aligned = new short[WindowSamples];
        if (samples.Length > WindowSamples)
        {
            // Longest final WindowSamples -- matches training's
            // end-aligned convention when the real segment ran longer
            // than the model's training window.
            Array.Copy(samples, samples.Length - WindowSamples, aligned, 0, WindowSamples);
        }
        else
        {
            // Left-pad with silence so the (shorter) real segment still
            // ends at the window's end, same alignment as training.
            Array.Copy(samples, 0, aligned, WindowSamples - samples.Length, samples.Length);
        }

        return aligned;
    }

    // Raw int16 samples cast to float32, NOT normalized to [-1,1] -- this
    // model's own training/inference convention (confirmed against
    // openwakeword.utils.AudioFeatures._get_melspectrogram, which raises
    // if given anything other than int16-range data).
    private float[,] Melspectrogram(short[] samples)
    {
        var floatSamples = new float[samples.Length];
        for (int i = 0; i < samples.Length; i++)
        {
            floatSamples[i] = samples[i];
        }

        var inputTensor = new DenseTensor<float>(floatSamples, new[] { 1, samples.Length });
        var inputs = new[] { NamedOnnxValue.CreateFromTensor("input", inputTensor) };

        using var results = melspecSession.Run(inputs);
        var output = results.First().AsTensor<float>();

        // Real shape confirmed as (1, 1, time, 32) -- the two leading
        // size-1 dims contribute nothing to a flat-array stride, so a
        // flat[t * MelBins + b] index is equivalent to squeezing them
        // away first, without needing to actually reshape the array.
        var dims = output.Dimensions.ToArray();
        int frames = dims[dims.Length - 2];
        var flat = output.ToArray();

        var mel = new float[frames, MelBins];
        for (int t = 0; t < frames; t++)
        {
            for (int b = 0; b < MelBins; b++)
            {
                // The fixed transform openWakeWord applies to match the
                // original TensorFlow implementation's scale.
                mel[t, b] = flat[(t * MelBins) + b] / 10f + 2f;
            }
        }

        return mel;
    }

    // Slides a MelWindowSize-frame window over the mel spectrogram's time
    // axis, stepped by MelStepSize, dropping any short trailing window --
    // matches openwakeword.utils.AudioFeatures._get_embeddings exactly.
    private float[,] Embed(float[,] melspec)
    {
        int totalFrames = melspec.GetLength(0);
        var windowStarts = new System.Collections.Generic.List<int>();
        for (int i = 0; i + MelWindowSize <= totalFrames; i += MelStepSize)
        {
            windowStarts.Add(i);
        }

        int windowCount = windowStarts.Count;
        var batchData = new float[windowCount * MelWindowSize * MelBins];
        for (int w = 0; w < windowCount; w++)
        {
            int start = windowStarts[w];
            for (int t = 0; t < MelWindowSize; t++)
            {
                for (int b = 0; b < MelBins; b++)
                {
                    batchData[(w * MelWindowSize * MelBins) + (t * MelBins) + b] = melspec[start + t, b];
                }
            }
        }

        var inputTensor = new DenseTensor<float>(batchData, new[] { windowCount, MelWindowSize, MelBins, 1 });
        var inputs = new[] { NamedOnnxValue.CreateFromTensor("input_1", inputTensor) };

        using var results = embeddingSession.Run(inputs);
        var output = results.First().AsTensor<float>();
        var flat = output.ToArray();

        // Real shape confirmed as (windows, 1, 1, 96) -- same
        // stride-through-size-1-dims reasoning as Melspectrogram above.
        var embeddings = new float[windowCount, EmbeddingDim];
        for (int w = 0; w < windowCount; w++)
        {
            for (int d = 0; d < EmbeddingDim; d++)
            {
                embeddings[w, d] = flat[(w * EmbeddingDim) + d];
            }
        }

        return embeddings;
    }

    private float Classify(float[,] embeddings)
    {
        int frames = embeddings.GetLength(0);
        var data = new float[frames * EmbeddingDim];
        for (int t = 0; t < frames; t++)
        {
            for (int d = 0; d < EmbeddingDim; d++)
            {
                data[(t * EmbeddingDim) + d] = embeddings[t, d];
            }
        }

        var inputTensor = new DenseTensor<float>(data, new[] { 1, frames, EmbeddingDim });
        var inputs = new[] { NamedOnnxValue.CreateFromTensor("input", inputTensor) };

        using var results = classifierSession.Run(inputs);
        return results.First().AsTensor<float>().ToArray()[0];
    }

    public void Dispose()
    {
        melspecSession.Dispose();
        embeddingSession.Dispose();
        classifierSession.Dispose();
    }
}

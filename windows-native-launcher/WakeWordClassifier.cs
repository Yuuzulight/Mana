using System;
using System.Globalization;
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
//     -> mana.onnx (ours, trained in tools/wakeword-training/), batched over
//        every EmbeddingFrames (16)-long run -> one sigmoid score each
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

    // #682: named thresholds for MANA_WAKE_PREFILTER / Settings > Voice.
    // tools/wakeword-training/README.md measured 7.2 false positives/hour
    // at 0.5 and 2.7/hour at 0.9 -- a false positive only costs one
    // Whisper call (the text matcher still decides), a false negative
    // makes Mana deaf.
    internal const float LooseThreshold = 0.5f;
    internal const float NormalThreshold = 0.9f;

    private const int MelWindowSize = 76;
    private const int MelStepSize = 8;
    private const int MelBins = 32;
    private const int EmbeddingDim = 96;

    private readonly InferenceSession melspecSession;
    private readonly InferenceSession embeddingSession;
    private readonly InferenceSession classifierSession;
    public WakeWordClassifier(
        string melspecModelPath,
        string embeddingModelPath,
        string classifierModelPath,
        float? threshold = null)
    {
        melspecSession = new InferenceSession(melspecModelPath);
        embeddingSession = new InferenceSession(embeddingModelPath);
        classifierSession = new InferenceSession(classifierModelPath);
        Threshold = threshold;
    }

    // null = never gates: segments are still scored (for speech-debug.log)
    // but all reach Whisper, i.e. the pre-#342 text-only behavior.
    public float? Threshold { get; }

    // #682: MANA_WAKE_PREFILTER (env / node-bot/.env) wins over the
    // Settings > Voice choice. off (default) | loose | normal | a number in
    // 0-1. Off by default because on the user's own recordings (QuadCast S,
    // accented English) even the fixed Score below mostly stays under 0.5
    // -- the model only ever saw 168 synthetic Kokoro US/UK clips. Anything
    // unrecognised falls back to off: failing open costs Whisper calls,
    // failing closed makes Mana deaf.
    internal static float? ResolveThreshold(string? env, string? setting)
    {
        var value = (string.IsNullOrWhiteSpace(env) ? setting : env)?.Trim().ToLowerInvariant();
        return value switch
        {
            "loose" => LooseThreshold,
            "normal" => NormalThreshold,
            _ when float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var t) && t >= 0f && t <= 1f => t,
            _ => null,
        };
    }

    // samples: 16-bit PCM at 16kHz, any length. Returns the max score over
    // every EmbeddingFrames-long run of embeddings in the segment --
    // openWakeWord's own streaming inference, and how train_model.py
    // measured the README's false-positive rates. Left-padded with
    // WindowSamples of silence so a wake word at the very start of the
    // segment can still end at a window's end, where training put it.
    //
    // #682: this used to score only the segment's last 2.0s. VoiceLoop
    // closes a segment after RecordingSegmenter's 2.2s of trailing
    // silence, so that window was always pure silence: all 168 training
    // clips scored ~0.000 through the real segmenting (0.999 end-aligned),
    // and every segment of the user's live run was dropped before Whisper.
    public float Score(short[] samples)
    {
        var padded = new short[WindowSamples + samples.Length];
        Array.Copy(samples, 0, padded, WindowSamples, samples.Length);
        var embeddings = Embed(Melspectrogram(padded));

        // At least WindowSamples in always yields >= EmbeddingFrames
        // embeddings against these models -- fail loudly if a model
        // swap ever changes that, rather than score a wrong shape.
        int windows = embeddings.GetLength(0) - EmbeddingFrames + 1;
        if (windows < 1)
        {
            throw new InvalidOperationException(
                $"Expected at least {EmbeddingFrames} embedding windows from a {padded.Length}-sample input, got {embeddings.GetLength(0)}.");
        }

        return Classify(embeddings, windows).Max();
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

    // One batched run over every EmbeddingFrames-long slice starting at
    // 0..windows-1 (mana.onnx's batch axis is dynamic) -> one score each.
    private float[] Classify(float[,] embeddings, int windows)
    {
        var data = new float[windows * EmbeddingFrames * EmbeddingDim];
        for (int w = 0; w < windows; w++)
        {
            for (int t = 0; t < EmbeddingFrames; t++)
            {
                for (int d = 0; d < EmbeddingDim; d++)
                {
                    data[(((w * EmbeddingFrames) + t) * EmbeddingDim) + d] = embeddings[w + t, d];
                }
            }
        }

        var inputTensor = new DenseTensor<float>(data, new[] { windows, EmbeddingFrames, EmbeddingDim });
        var inputs = new[] { NamedOnnxValue.CreateFromTensor("input", inputTensor) };

        using var results = classifierSession.Run(inputs);
        return results.First().AsTensor<float>().ToArray();
    }

    public void Dispose()
    {
        melspecSession.Dispose();
        embeddingSession.Dispose();
        classifierSession.Dispose();
    }
}

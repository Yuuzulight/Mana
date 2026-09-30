using System;
using System.Globalization;
using System.Linq;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace Mana.NativeLauncher;

// Ports windows-launcher/renderer/silero-vad.js's exact I/O contract onto
// Microsoft.ML.OnnxRuntime -- see that file's header comment for how this
// shape was confirmed against the real ONNX graph (a wrong-shaped `input`
// doesn't error there, since the axis is dynamic, it just silently
// produces near-zero probability). This port throws on a shape mismatch
// instead of letting that failure mode through silently -- a native
// build's own wiring bug should surface loudly, not degrade quietly.
//
// The `sr` input is a true scalar (empty shape `[]` in the JS/ONNX graph,
// not a 1-element vector) -- verified against the model at Task 3 Step 6's
// test run; if InferenceSession.Run throws a shape-mismatch error on `sr`
// specifically, change srTensor's dims below to `new[] { 1 }` instead of
// `Array.Empty<int>()`.
internal sealed class SileroVadRunner : IDisposable
{
    internal const int FrameSamples = 512;
    internal const int ContextSize = 64;
    internal const int SampleRate = 16000;
    internal const float DefaultThreshold = 0.5f;
    // #665: once in speech, it takes a score under this to leave it, so soft
    // consonants, trailing syllables and quieter or accented speech don't
    // flicker out mid-word (and reset the barge-in count).
    internal const float DefaultExitThreshold = 0.35f;
    private const int StateSize = 2 * 1 * 128;

    private readonly InferenceSession session;
    // #665 hysteresis; #858: the enter threshold is set each time
    // listening starts, and the exit one follows it down (never above it).
    private readonly float configuredExitThreshold;
    private float threshold;
    private float exitThreshold;
    private bool inSpeech;
    private float[] state = new float[StateSize];
    private float[] context = new float[ContextSize];

    public SileroVadRunner(string modelPath, float threshold = DefaultThreshold, float exitThreshold = DefaultExitThreshold)
    {
        session = new InferenceSession(modelPath);
        configuredExitThreshold = exitThreshold;
        Threshold = threshold;
    }

    // #858: the speech-probability cutoff to enter speech; VoiceLoop sets it
    // each time listening starts (ResolveThreshold). The exit threshold
    // (#665, MANA_VAD_EXIT_THRESHOLD) is capped at it.
    public float Threshold
    {
        get => threshold;
        set
        {
            threshold = value;
            exitThreshold = Math.Min(configuredExitThreshold, value);
        }
    }

    internal float ExitThreshold => exitThreshold;

    // #858: MANA_VAD_THRESHOLD (Electron's knob) wins over Settings > Voice,
    // else 0.5. Anything outside (0, 1) is ignored.
    internal static float ResolveThreshold(string? env, float? saved) =>
        float.TryParse(env, NumberStyles.Float, CultureInfo.InvariantCulture, out var fromEnv) && fromEnv > 0f && fromEnv < 1f ? fromEnv
        : saved is > 0f and < 1f ? saved.Value
        : DefaultThreshold;

    // New utterance: neither the recurrent state nor the leading context
    // window should carry over speech from a previous, unrelated segment.
    public void Reset()
    {
        state = new float[StateSize];
        context = new float[ContextSize];
        inSpeech = false;
    }

    public float ProcessFrame(float[] frame)
    {
        if (frame is null || frame.Length != FrameSamples)
        {
            throw new ArgumentException(
                $"ProcessFrame expects exactly {FrameSamples} samples at {SampleRate}Hz, got {frame?.Length.ToString() ?? "null"}",
                nameof(frame));
        }

        var input = new float[ContextSize + FrameSamples];
        Array.Copy(context, 0, input, 0, ContextSize);
        Array.Copy(frame, 0, input, ContextSize, FrameSamples);

        var inputTensor = new DenseTensor<float>(input, new[] { 1, ContextSize + FrameSamples });
        var stateTensor = new DenseTensor<float>(state, new[] { 2, 1, 128 });
        var srTensor = new DenseTensor<long>(new long[] { SampleRate }, Array.Empty<int>());

        var inputs = new[]
        {
            NamedOnnxValue.CreateFromTensor("input", inputTensor),
            NamedOnnxValue.CreateFromTensor("state", stateTensor),
            NamedOnnxValue.CreateFromTensor("sr", srTensor),
        };

        using var results = session.Run(inputs);
        var output = results.First(r => r.Name == "output").AsTensor<float>().ToArray();
        state = results.First(r => r.Name == "stateN").AsTensor<float>().ToArray();

        context = new float[ContextSize];
        Array.Copy(input, input.Length - ContextSize, context, 0, ContextSize);

        return output[0];
    }

    // #665: with hysteresis -- call once per frame, in order (Reset starts over).
    public bool IsSpeech(float probability) => inSpeech = NextSpeech(inSpeech, probability, threshold, exitThreshold);

    internal static bool NextSpeech(bool inSpeech, float probability, float enter, float exit) =>
        probability >= (inSpeech ? exit : enter);

    public void Dispose() => session.Dispose();
}

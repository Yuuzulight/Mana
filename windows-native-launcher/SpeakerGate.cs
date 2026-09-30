using System;
using System.Collections.Generic;
using System.Globalization;

namespace Mana.NativeLauncher;

// #678: which speech has to be my voice (Settings > Voice, MANA_SPEAKER_GATE).
internal enum SpeakerGateMode
{
    Off,
    WakeWord,           // waking her
    WakeWordAndBargeIn, // ...and talking over her
    AllSpeech,          // ...and every command while she's awake
}

// #678: voiceprint gating. Pure decisions; SpeakerEmbedder does the model.
// With no model or no enrolled voiceprint everything passes, i.e. exactly
// the behaviour from before the gate existed.
internal static class SpeakerGate
{
    internal static readonly string[] ModeNames = { "off", "wakeWord", "wakeWordAndBargeIn", "allSpeech" };

    // Cosine similarity to the voiceprint. Logged per segment in
    // speech-debug.log (speaker=) so it can be tuned.
    internal const float DefaultThreshold = 0.45f;

    // Enough audio to recognise a voice without a long segment costing more
    // than the ~50ms budget on the wake path.
    internal const int MaxSamples = 3 * SileroVadRunner.SampleRate;

    // MANA_SPEAKER_GATE (env) wins over Settings > Voice; unknown = off.
    internal static SpeakerGateMode ResolveMode(string? env, string? setting)
    {
        var value = string.IsNullOrWhiteSpace(env) ? setting : env;
        var index = Array.FindIndex(ModeNames, name => string.Equals(name, value?.Trim(), StringComparison.OrdinalIgnoreCase));
        return index < 0 ? SpeakerGateMode.Off : (SpeakerGateMode)index;
    }

    // #965: MANA_SPEAKER_THRESHOLD (env) wins over Settings > Voice; either
    // must be between 0 and 1.
    internal static float ResolveThreshold(string? env, float? setting = null) =>
        float.TryParse(env, NumberStyles.Float, CultureInfo.InvariantCulture, out var t) && t is > 0f and < 1f ? t
        : setting is > 0f and < 1f ? setting.Value
        : DefaultThreshold;

    // Whether this segment is checked. An interruption only happens while
    // she's awake and speaking.
    internal static bool Applies(SpeakerGateMode mode, bool awake, bool wasInterruption) => mode switch
    {
        SpeakerGateMode.WakeWord => !awake && !wasInterruption,
        SpeakerGateMode.WakeWordAndBargeIn => !awake || wasInterruption,
        SpeakerGateMode.AllSpeech => true,
        _ => false,
    };

    // The issue's SpeakerGate.IsEnrolledSpeaker: score is null when nothing
    // could be compared (no model, no voiceprint, a voiceprint from another
    // model, or audio too short to embed), which always passes -- failing
    // closed would make Mana deaf.
    internal static (bool Pass, float? Score) IsEnrolledSpeaker(short[] samples, Func<short[], float[]>? embed, float[]? voiceprint, float threshold)
    {
        if (embed is null || voiceprint is null)
        {
            return (true, null);
        }
        var embedding = embed(SpeechSpan(samples));
        var score = embedding.Length == voiceprint.Length ? Cosine(embedding, voiceprint) : float.NaN;
        return float.IsNaN(score) ? (true, null) : (score >= threshold, score);
    }

    // The averaged, normalised embedding of the enrollment clips.
    internal static float[] Voiceprint(IReadOnlyList<float[]> embeddings)
    {
        var sum = new float[embeddings[0].Length];
        foreach (var embedding in embeddings)
        {
            var unit = Normalize(embedding);
            for (var i = 0; i < sum.Length; i++)
            {
                sum[i] += unit[i];
            }
        }
        return Normalize(sum);
    }

    internal static float Cosine(float[] a, float[] b)
    {
        double dot = 0, na = 0, nb = 0;
        for (var i = 0; i < a.Length; i++)
        {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        return na == 0 || nb == 0 ? 0f : (float)(dot / Math.Sqrt(na * nb));
    }

    private static float[] Normalize(float[] v)
    {
        double norm = 0;
        foreach (var x in v)
        {
            norm += x * x;
        }
        norm = Math.Sqrt(norm);
        var result = new float[v.Length];
        for (var i = 0; i < v.Length && norm > 0; i++)
        {
            result[i] = (float)(v[i] / norm);
        }
        return result;
    }

    // The voiced part of a segment: from the first to the last 20ms chunk
    // within 20 dB of the loudest, at most MaxSamples. A segment closes on
    // 2.2s of silence, which would otherwise dilute the embedding.
    internal static short[] SpeechSpan(short[] samples)
    {
        const int chunk = SileroVadRunner.SampleRate / 50;
        var chunks = samples.Length / chunk;
        var energy = new double[chunks];
        double loudest = 0;
        for (var c = 0; c < chunks; c++)
        {
            double sum = 0;
            for (var i = c * chunk; i < (c + 1) * chunk; i++)
            {
                sum += (double)samples[i] * samples[i];
            }
            energy[c] = sum;
            loudest = Math.Max(loudest, sum);
        }
        var first = Array.FindIndex(energy, e => e > 0 && e >= loudest / 100);
        if (first < 0)
        {
            return samples;
        }
        var last = Array.FindLastIndex(energy, e => e >= loudest / 100);
        var start = first * chunk;
        var length = Math.Min((last + 1) * chunk - start, MaxSamples);
        return samples.AsSpan(start, length).ToArray();
    }
}

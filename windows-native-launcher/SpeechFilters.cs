using System;
using System.Collections.Generic;
using System.Globalization;

namespace Mana.NativeLauncher;

// #682: native port of windows-launcher/renderer/speech-filters.js plus
// renderer.js's getAudioStats/applySpeechGain/isNoiseOnlyTranscript -- the
// client-side checks Electron runs around every Whisper call: boost a quiet
// segment, skip one too quiet or too hiss-like to be speech, and drop
// Whisper's known phantom phrases and noise-only captions.
internal static class SpeechFilters
{
    // Same env vars and defaults as renderer.js, read once.
    internal static readonly double MinSpeechRms = EnvDouble("MANA_MIN_SPEECH_RMS", 0.012);
    internal static readonly double MinSpeechPeak = EnvDouble("MANA_MIN_SPEECH_PEAK", 0.04);
    // Electron counts zero crossings per sample at its AudioContext's rate
    // (typically 48kHz); native segments are 16kHz, so the same crossings
    // per second -- the same cutoff frequency -- is 3x the per-sample rate.
    internal static readonly double MaxClickyZcr =
        EnvDouble("MANA_MAX_CLICKY_ZCR", 0.28) * 48000 / SileroVadRunner.SampleRate;
    internal static readonly double GainTargetPeak = EnvDouble("MANA_SPEECH_GAIN_TARGET_PEAK", 0.2);
    internal static readonly double GainMaxBoost = EnvDouble("MANA_SPEECH_GAIN_MAX_BOOST", 6);

    // Only filtered when the whole segment was this short: a real "thank
    // you" said normally takes longer, so a longer clip is trusted.
    internal const double MaxHallucinationAudioSeconds = 2.5;

    private static readonly HashSet<string> HallucinationPhrases = new(StringComparer.Ordinal)
    {
        "thank you", "thanks for watching", "thank you for watching", "please subscribe",
        "like and subscribe", "subscribe to my channel", "subtitles by", "the end", "bye bye",
    };

    private static readonly HashSet<string> NoiseOnlyTranscripts = new(StringComparer.Ordinal)
    {
        "blank audio", "silence", "silent", "keyboard clicking", "keyboard clicks", "typing",
        "clicking", "click", "mouse clicking", "background noise", "noise", "sound effect",
        "sound effects", "music", "laughter", "laughing", "applause", "clapping",
    };

    private static double EnvDouble(string name, double fallback) =>
        double.TryParse(Environment.GetEnvironmentVariable(name), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            && double.IsFinite(value)
            ? value
            : fallback;

    // rms/peak in [0, 1]; zcr = zero crossings per sample.
    internal static (double Rms, double Peak, double Zcr) GetAudioStats(short[] samples)
    {
        double sumSquares = 0, peak = 0;
        var crossings = 0;
        var previous = samples.Length > 0 ? samples[0] : (short)0;
        foreach (var raw in samples)
        {
            var sample = raw / (double)short.MaxValue;
            sumSquares += sample * sample;
            peak = Math.Max(peak, Math.Abs(sample));
            if ((previous < 0) != (raw < 0))
            {
                crossings++;
            }
            previous = raw;
        }
        var length = Math.Max(samples.Length, 1);
        return (Math.Sqrt(sumSquares / length), peak, crossings / (double)length);
    }

    // Never below 1: a max boost of 0 disables the boost rather than
    // silencing the segment.
    internal static double ComputeGainFactor(double peak, double targetPeak, double maxBoost) =>
        targetPeak <= 0 || peak <= 0 || peak >= targetPeak ? 1 : Math.Max(1, Math.Min(targetPeak / peak, maxBoost));

    // The samples to send to Whisper -- a boosted, clamped copy, or the
    // input itself when no boost applies -- and the gain used.
    internal static (short[] Samples, double Gain) ApplySpeechGain(short[] samples, double targetPeak, double maxBoost)
    {
        var gain = ComputeGainFactor(GetAudioStats(samples).Peak, targetPeak, maxBoost);
        if (gain == 1)
        {
            return (samples, 1);
        }
        var boosted = new short[samples.Length];
        for (var i = 0; i < samples.Length; i++)
        {
            boosted[i] = (short)Math.Clamp(samples[i] * gain, short.MinValue, short.MaxValue);
        }
        return (boosted, gain);
    }

    // "quiet" | "clicky" | null (looks like speech).
    internal static string? GetSpeechRejectReason(short[] samples, double minRms, double minPeak, double maxZcr)
    {
        var (rms, peak, zcr) = GetAudioStats(samples);
        if (rms < minRms || peak < minPeak)
        {
            return "quiet";
        }
        return zcr > maxZcr ? "clicky" : null;
    }

    internal static bool IsLikelyWhisperHallucination(string transcript, double durationSeconds) =>
        durationSeconds <= MaxHallucinationAudioSeconds
        && HallucinationPhrases.Contains(Normalize(transcript));

    // Empty once "[BLANK_AUDIO]"/"(music)"-style annotations are stripped,
    // or nothing but a description of non-speech.
    internal static bool IsNoiseOnlyTranscript(string transcript)
    {
        var normalized = Normalize(transcript);
        return normalized.Length == 0 || NoiseOnlyTranscripts.Contains(normalized);
    }

    private static string Normalize(string transcript) =>
        ScreenContextTrigger.CleanTranscriptText(transcript).ToLowerInvariant();
}

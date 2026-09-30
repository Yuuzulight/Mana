using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using NAudio.Wave;

namespace Mana.NativeLauncher;

// #1107: recordings of my voice for fine-tuning a smaller Whisper on my
// accent later. Kept on this PC only, nothing is uploaded, under
// MANA_VOICE_DATA_DIR (default D:\ManaAI\voice-data) in folders of their
// own -- whatever else is in there is left alone:
//   turns\  my real spoken turns, while Settings > Voice's "Keep my voice
//           clips for training" is on: <time>.wav (16 kHz mono, what
//           Whisper heard) and <time>.json (TurnClip). node-bot's
//           voice-data.js fills in Corrected when I add a mishearing fix.
// The turns folder is capped (MANA_VOICE_DATA_MAX_MB, default 2 GB),
// oldest clips deleted first.
internal static class VoiceData
{
    public const string DefaultRoot = @"D:\ManaAI\voice-data";
    public const long DefaultMaxBytes = 2048L * 1024 * 1024;

    private const int BytesPerSecond = SileroVadRunner.SampleRate * 2;
    private const int WavHeaderBytes = 44;
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    public static string Root(string? env) => string.IsNullOrWhiteSpace(env) ? DefaultRoot : env;

    public static string TurnsFolder => Path.Combine(Root(Environment.GetEnvironmentVariable("MANA_VOICE_DATA_DIR")), "turns");

    public static long MaxBytes(string? envMb) => long.TryParse(envMb, out var mb) && mb > 0 ? mb * 1024 * 1024 : DefaultMaxBytes;

    // Heard: what Whisper wrote; Transcript: after my mishearing fixes.
    public sealed record TurnClip(string Heard, string Transcript, string? Corrected, string? Language, string? Model, double DurationSec, DateTimeOffset RecordedAt);

    // A turn worth keeping is one that reached Mana: transcribed, not dropped
    // by any of listening's filters (the voiceprint gate, too quiet or
    // hiss-like, a Whisper hallucination, noise only, a few-word
    // interruption), not merged into a later turn (that one keeps the
    // audio), and more than a bare wake word.
    public static bool ShouldKeep(VoiceSegmentLogEntry entry, string commandText) =>
        entry.Whisper == "ok" && entry.Drop is null && !entry.Merged && !string.IsNullOrWhiteSpace(commandText);

    // Saves one turn and prunes the folder back under maxBytes.
    public static void KeepTurn(string folder, short[] samples, TurnClip clip, long maxBytes)
    {
        // The time sorts oldest first; the random tail keeps two turns in
        // the same millisecond apart.
        Save(folder, string.Create(CultureInfo.InvariantCulture, $"{clip.RecordedAt:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}")[..24], samples, clip);
        Prune(folder, maxBytes);
    }

    // name.wav (16 kHz mono) and name.json next to it; returns the wav path.
    public static string Save(string folder, string name, short[] samples, object sidecar)
    {
        Directory.CreateDirectory(folder);
        var wav = Path.Combine(folder, name + ".wav");
        using (var writer = new WaveFileWriter(wav, new WaveFormat(SileroVadRunner.SampleRate, 16, 1)))
        {
            writer.WriteSamples(samples, 0, samples.Length);
        }
        File.WriteAllText(Path.ChangeExtension(wav, ".json"), JsonSerializer.Serialize(sidecar, sidecar.GetType(), Json));
        return wav;
    }

    // Oldest (by name) first, each wav with its sidecar.
    public static void Prune(string folder, long maxBytes)
    {
        var wavs = new DirectoryInfo(folder).GetFiles("*.wav").OrderBy(f => f.Name, StringComparer.Ordinal).ToList();
        var total = wavs.Sum(f => f.Length + SidecarLength(f));
        foreach (var wav in wavs)
        {
            if (total <= maxBytes)
            {
                return;
            }
            total -= wav.Length + SidecarLength(wav);
            File.Delete(Path.ChangeExtension(wav.FullName, ".json"));
            wav.Delete();
        }
    }

    private static long SidecarLength(FileInfo wav)
    {
        var json = new FileInfo(Path.ChangeExtension(wav.FullName, ".json"));
        return json.Exists ? json.Length : 0;
    }

    // How many clips, and how many minutes of audio, a folder holds.
    public static (int Clips, double Minutes) Totals(string folder)
    {
        if (!Directory.Exists(folder))
        {
            return (0, 0);
        }
        var wavs = new DirectoryInfo(folder).GetFiles("*.wav");
        return (wavs.Length, wavs.Sum(f => Math.Max(0, f.Length - WavHeaderBytes)) / (double)BytesPerSecond / 60);
    }

    // Only the clips and sidecars this writes; anything else in the folder stays.
    public static void Delete(string folder)
    {
        if (!Directory.Exists(folder))
        {
            return;
        }
        foreach (var file in Directory.EnumerateFiles(folder, "*.wav").Concat(Directory.EnumerateFiles(folder, "*.json")).ToList())
        {
            File.Delete(file);
        }
    }
}

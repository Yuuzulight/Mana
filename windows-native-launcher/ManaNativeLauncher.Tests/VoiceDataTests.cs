using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Mana.NativeLauncher;
using NAudio.Wave;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1107: kept voice clips -- the keep filter, WAV + sidecar, pruning, totals
// and delete. Temp folders only; no mic.
public sealed class VoiceDataTests : IDisposable
{
    private readonly string folder = Directory.CreateTempSubdirectory("mana-voice-data-").FullName;

    public void Dispose() => Directory.Delete(folder, true);

    private static VoiceData.TurnClip Clip(string text, DateTimeOffset at) => new(text, text, null, "en", "ggml-small.en.bin", 1, at);

    [Fact]
    public void KeepsOnlyTurnsThatReachedMana()
    {
        var ok = new VoiceSegmentLogEntry { Whisper = "ok", Transcript = "Mana, what's on my calendar" };
        Assert.True(VoiceData.ShouldKeep(ok, "what's on my calendar"));

        Assert.False(VoiceData.ShouldKeep(ok, "")); // a bare wake word
        Assert.False(VoiceData.ShouldKeep(ok, "  "));
        foreach (var drop in new[] { "speaker", "quiet", "hallucination", "noise", "few-words" })
        {
            Assert.False(VoiceData.ShouldKeep(new VoiceSegmentLogEntry { Whisper = "ok", Drop = drop }, "hello"));
        }
        foreach (var whisper in new[] { "skipped", "failed", "empty" })
        {
            Assert.False(VoiceData.ShouldKeep(new VoiceSegmentLogEntry { Whisper = whisper }, "hello"));
        }
        Assert.False(VoiceData.ShouldKeep(new VoiceSegmentLogEntry { Whisper = "ok", Merged = true }, "hello"));
    }

    [Fact]
    public void SavesA16kMonoWavAndItsSidecar()
    {
        var at = new DateTimeOffset(2026, 10, 1, 21, 5, 9, 42, TimeSpan.FromHours(8));
        var samples = Enumerable.Range(0, 16000).Select(i => (short)(i % 200 - 100)).ToArray();

        VoiceData.KeepTurn(folder, samples, new VoiceData.TurnClip("watch GG Moon", "watch Gigi Murin", null, "en", "ggml-small.en.bin", 1, at), long.MaxValue);

        var wav = Assert.Single(Directory.GetFiles(folder, "*.wav"));
        Assert.StartsWith("20261001-210509-042-", Path.GetFileName(wav));
        using (var reader = new WaveFileReader(wav))
        {
            Assert.Equal(new WaveFormat(16000, 16, 1), reader.WaveFormat);
            Assert.Equal(16000, reader.SampleCount);
        }
        using var json = JsonDocument.Parse(File.ReadAllText(Path.ChangeExtension(wav, ".json")));
        var root = json.RootElement;
        Assert.Equal("watch GG Moon", root.GetProperty("heard").GetString());
        Assert.Equal("watch Gigi Murin", root.GetProperty("transcript").GetString());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("corrected").ValueKind); // node-bot's voice-data.js fills it in
        Assert.Equal("en", root.GetProperty("language").GetString());
        Assert.Equal("ggml-small.en.bin", root.GetProperty("model").GetString());
        Assert.Equal(1, root.GetProperty("durationSec").GetDouble());
        Assert.Equal(at, root.GetProperty("recordedAt").GetDateTimeOffset());

        var (clips, minutes) = VoiceData.Totals(folder);
        Assert.Equal(1, clips);
        Assert.Equal(1 / 60.0, minutes, 3);
    }

    [Fact]
    public void PrunesTheOldestClipsFirstOnceOverTheCap()
    {
        var second = new short[16000]; // 32 KB of audio each
        var start = new DateTimeOffset(2026, 10, 1, 9, 0, 0, TimeSpan.Zero);
        VoiceData.KeepTurn(folder, second, Clip("first", start), long.MaxValue);
        VoiceData.KeepTurn(folder, second, Clip("second", start.AddMinutes(1)), long.MaxValue);
        var oneClip = Directory.GetFiles(folder).Sum(f => new FileInfo(f).Length) / 2;

        // Room for two clips (with their sidecars) and a bit, not three.
        VoiceData.KeepTurn(folder, second, Clip("third", start.AddMinutes(2)), oneClip * 2 + 100);

        var left = Directory.GetFiles(folder, "*.json").Select(f => JsonDocument.Parse(File.ReadAllText(f)).RootElement.GetProperty("heard").GetString()).Order();
        Assert.Equal(new[] { "second", "third" }, left);
        Assert.Equal(2, Directory.GetFiles(folder, "*.wav").Length);
    }

    [Fact]
    public void DeleteRemovesTheClipsAndLeavesAnythingElse()
    {
        VoiceData.KeepTurn(folder, new short[160], Clip("hi", DateTimeOffset.Now), long.MaxValue);
        File.WriteAllText(Path.Combine(folder, "notes.txt"), "mine");

        VoiceData.Delete(folder);

        Assert.Equal(new[] { "notes.txt" }, Directory.GetFiles(folder).Select(Path.GetFileName));
        Assert.Equal((0, 0.0), VoiceData.Totals(folder));
        Assert.Equal((0, 0.0), VoiceData.Totals(Path.Combine(folder, "missing")));
        VoiceData.Delete(Path.Combine(folder, "missing"));
    }

    [Fact]
    public void FolderAndCapComeFromTheEnvironmentOrDefaults()
    {
        Assert.Equal(@"D:\ManaAI\voice-data", VoiceData.Root(null));
        Assert.Equal(@"E:\voice", VoiceData.Root(@"E:\voice"));
        Assert.Equal(2048L * 1024 * 1024, VoiceData.MaxBytes(null));
        Assert.Equal(2048L * 1024 * 1024, VoiceData.MaxBytes("zero"));
        Assert.Equal(500L * 1024 * 1024, VoiceData.MaxBytes("500"));
    }
}

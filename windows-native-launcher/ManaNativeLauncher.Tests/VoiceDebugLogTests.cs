using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class VoiceDebugLogTests
{
    private static readonly DateTime At = new(2026, 9, 29, 14, 3, 12, 345);

    [Fact]
    public void Entry_RejectedByPrefilter()
    {
        var entry = new VoiceSegmentLogEntry
        {
            At = At,
            // 1s at a constant ~-20 dBFS, half of it VAD speech.
            Samples = Filled(16000, 3277),
            SpeechMs = 500,
            Score = 0.0151f,
            Threshold = 0.9f,
        };

        Assert.Equal(
            "2026-09-29T14:03:12.345 len=1000ms close=silence peak=-20.0dBFS rms=-20.0dBFS speech=50% awake=no prefilter=reject score=0.015 threshold=0.90 whisper=skipped",
            entry.ToString());
    }

    [Fact]
    public void Entry_SentWithTranscriptAndWakeMatch()
    {
        var entry = new VoiceSegmentLogEntry
        {
            At = At,
            Samples = Filled(8000, 3277),
            Close = "max",
            Score = 0.93f,
            Threshold = null,
            Whisper = "ok",
            Transcript = "Mana,\r\nsay \"hi\"",
            WakeMatch = true,
        };

        var line = entry.ToString();

        Assert.Contains(" close=max ", line);
        Assert.Contains(" prefilter=off score=0.930 threshold=- whisper=ok wake=yes transcript=\"Mana,  say 'hi'\"", line);
        Assert.DoesNotContain("\n", line);
    }

    [Theory]
    [InlineData(true, false, 0.2f, 0.5f, "n/a")]
    [InlineData(false, true, null, 0.5f, "error")]
    [InlineData(false, false, null, 0.5f, "unavailable")]
    [InlineData(false, false, 0.5f, 0.5f, "pass")]
    [InlineData(false, false, 0.2f, null, "off")]
    public void Entry_PrefilterDecision(bool awake, bool failed, float? score, float? threshold, string expected)
    {
        var entry = new VoiceSegmentLogEntry { Awake = awake, ClassifierFailed = failed, Score = score, Threshold = threshold };

        Assert.Contains($" prefilter={expected} ", entry.ToString());
    }

    [Fact]
    public void Entry_SilenceAndLongTranscriptAreBounded()
    {
        var entry = new VoiceSegmentLogEntry { Samples = new short[160], Whisper = "ok", Transcript = new string('a', 1000) };

        var line = entry.ToString();

        Assert.Contains("peak=-120.0dBFS rms=-120.0dBFS", line);
        Assert.EndsWith(new string('a', VoiceSegmentLogEntry.MaxTranscriptChars) + "...\"", line);
    }

    [Fact]
    public void Append_RotatesOnceOverCap()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-voice-log-" + Guid.NewGuid());
        var path = Path.Combine(dir, "speech-debug.log");
        try
        {
            var entry = new VoiceSegmentLogEntry();
            VoiceDebugLog.Append(entry, path, maxBytes: 10);
            VoiceDebugLog.Append(entry, path, maxBytes: 10); // over cap -> rotated to .1 first
            VoiceDebugLog.Append(entry, path, maxBytes: 10); // replaces the old .1

            Assert.Single(File.ReadAllLines(path));
            Assert.Single(File.ReadAllLines(path + ".1"));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Append_NeverThrowsOnIoFailure()
    {
        // The target path is an existing directory, so every write fails.
        var dir = Path.Combine(Path.GetTempPath(), "mana-voice-log-" + Guid.NewGuid());
        Directory.CreateDirectory(dir);
        try
        {
            VoiceDebugLog.Append(new VoiceSegmentLogEntry(), dir);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void AppendNote_WritesOneTimestampedLine()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-voice-log-" + Guid.NewGuid());
        var path = Path.Combine(dir, "speech-debug.log");
        try
        {
            VoiceDebugLog.AppendNote("capture: aec=on", path);

            var line = Assert.Single(File.ReadAllLines(path));
            Assert.Matches(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3} capture: aec=on$", line);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static short[] Filled(int length, short value)
    {
        var samples = new short[length];
        Array.Fill(samples, value);
        return samples;
    }
}

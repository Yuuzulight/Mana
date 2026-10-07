using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class VoiceDebugLogTests
{
    // The log is opt-in (it holds my transcripts); the write tests turn it on.
    private static void WithSpeechDebug(string? value, Action body)
    {
        var prior = Environment.GetEnvironmentVariable("MANA_SPEECH_DEBUG");
        Environment.SetEnvironmentVariable("MANA_SPEECH_DEBUG", value);
        try
        {
            body();
        }
        finally
        {
            Environment.SetEnvironmentVariable("MANA_SPEECH_DEBUG", prior);
        }
    }

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
    public void Entry_TurnDetectionDecisions()
    {
        // #619: end-of-turn reason, the partials behind it, and a merge.
        var entry = new VoiceSegmentLogEntry
        {
            Awake = true,
            Eot = "800ms/complete",
            Partials = 2,
            PartialMs = 640,
            Partial = "turn on \"the\" lights.",
            Merged = true,
            Whisper = "ok",
            Transcript = "Turn on the lights.",
        };

        Assert.EndsWith(
            " whisper=ok eot=800ms/complete partials=2/640ms merged=yes partial=\"turn on 'the' lights.\" transcript=\"Turn on the lights.\"",
            entry.ToString());
    }

    [Fact]
    public void Entry_SpeechFilterDecisions()
    {
        var entry = new VoiceSegmentLogEntry { Awake = true, Whisper = "ok", Gain = 2.5, Drop = "hallucination", Transcript = "Thank you." };

        Assert.EndsWith(" whisper=ok gain=2.5 drop=hallucination transcript=\"Thank you.\"", entry.ToString());
    }

    [Fact]
    public void Entry_ShowsWhatWhisperHeardBeforeAMishearingFix()
    {
        var entry = new VoiceSegmentLogEntry { Awake = true, Whisper = "ok", Transcript = "watch Gigi Murin", Heard = "watch GG Moon" };

        Assert.EndsWith(" transcript=\"watch Gigi Murin\" heard=\"watch GG Moon\"", entry.ToString());
    }

    [Fact]
    public void Entry_WithoutTurnDetectionFields_IsUnchanged()
    {
        var line = new VoiceSegmentLogEntry { Whisper = "empty" }.ToString();

        Assert.EndsWith(" whisper=empty", line);
    }

    [Fact]
    public void Append_RotatesOnceOverCap()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-voice-log-" + Guid.NewGuid());
        var path = Path.Combine(dir, "speech-debug.log");
        try
        {
            var entry = new VoiceSegmentLogEntry();
            WithSpeechDebug("1", () =>
            {
                VoiceDebugLog.Append(entry, path, maxBytes: 10);
                VoiceDebugLog.Append(entry, path, maxBytes: 10); // over cap -> rotated to .1 first
                VoiceDebugLog.Append(entry, path, maxBytes: 10); // replaces the old .1
            });

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
            WithSpeechDebug("1", () => VoiceDebugLog.Append(new VoiceSegmentLogEntry(), dir));
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
            WithSpeechDebug("1", () => VoiceDebugLog.AppendNote("capture: aec=on", path));

            var line = Assert.Single(File.ReadAllLines(path));
            Assert.Matches(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3} capture: aec=on$", line);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("0")]
    public void Append_WritesNothingUnlessOptedIn(string? value)
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-voice-log-" + Guid.NewGuid());
        var path = Path.Combine(dir, "speech-debug.log");

        WithSpeechDebug(value, () =>
        {
            VoiceDebugLog.Append(new VoiceSegmentLogEntry { Transcript = "hi" }, path);
            VoiceDebugLog.AppendNote("capture: aec=on", path);
        });

        Assert.False(File.Exists(path));
    }

    // #965: the Settings slider shows the last speaker= scores, oldest first.
    [Fact]
    public void RecentSpeakerScores_ReadsTheLastFew()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-voice-log-" + Guid.NewGuid());
        var path = Path.Combine(dir, "speech-debug.log");
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllLines(path, new[]
            {
                "2026-09-29T14:03:12.345 len=1000ms whisper=ok speaker=0.812/31ms wake=yes",
                "2026-09-29T14:03:13.000 speaker: gate=wakeWord enrolled=yes model=loaded threshold=0.45",
                "2026-09-29T14:03:14.345 len=900ms whisper=skipped speaker=-0.050/28ms",
                "2026-09-29T14:03:15.345 len=900ms whisper=ok speaker=0.401/30ms transcript=\"hi\"",
            });

            Assert.Equal(new[] { -0.05f, 0.401f }, VoiceDebugLog.RecentSpeakerScores(2, path));
            Assert.Empty(VoiceDebugLog.RecentSpeakerScores(path: Path.Combine(dir, "missing.log")));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // Settings > Voice re-reads the log each tick, so a score logged while
    // the tab is open shows up without reopening Settings.
    [Fact]
    public void SpeakerScoresText_PicksUpNewScores()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-voice-log-" + Guid.NewGuid());
        var path = Path.Combine(dir, "speech-debug.log");
        Directory.CreateDirectory(dir);
        try
        {
            Assert.Equal("", SettingsPanel.SpeakerScoresText(path));

            File.AppendAllLines(path, new[] { "2026-09-29T14:03:12.345 len=1000ms whisper=ok speaker=0.812/31ms" });
            Assert.Equal("Recent: 0.81", SettingsPanel.SpeakerScoresText(path));

            File.AppendAllLines(path, new[] { "2026-09-29T14:03:14.345 len=900ms whisper=ok speaker=0.401/30ms" });
            Assert.Equal("Recent: 0.81, 0.40", SettingsPanel.SpeakerScoresText(path));
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

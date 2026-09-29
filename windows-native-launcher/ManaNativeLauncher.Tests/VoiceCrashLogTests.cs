using System;
using System.IO;
using System.Text.Json;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #860: voice-crash.log, Electron's fields as one JSON line per crash.
public class VoiceCrashLogTests
{
    private static Exception Thrown()
    {
        try
        {
            throw new InvalidOperationException("mic went away");
        }
        catch (Exception ex)
        {
            return ex;
        }
    }

    [Fact]
    public void Format_IsOneJsonLineWithElectronsFields()
    {
        var line = VoiceCrashLog.Format(Thrown(), "turn", "silero-vad", "Headset Mic", awake: true, listening: true,
            new DateTimeOffset(2026, 9, 29, 14, 3, 12, TimeSpan.FromHours(8)));

        Assert.DoesNotContain('\n', line);
        var root = JsonDocument.Parse(line).RootElement;
        Assert.Equal("2026-09-29T14:03:12.0000000+08:00", root.GetProperty("at").GetString());
        Assert.Equal("turn", root.GetProperty("where").GetString());
        Assert.Equal("mic went away", root.GetProperty("error").GetString());
        Assert.Equal("System.InvalidOperationException", root.GetProperty("type").GetString());
        Assert.Contains(nameof(Thrown), root.GetProperty("stack").GetString());
        Assert.Equal("silero-vad", root.GetProperty("audioBackend").GetString());
        Assert.Equal("Headset Mic", root.GetProperty("inputDeviceLabel").GetString());
        Assert.True(root.GetProperty("awake").GetBoolean());
        Assert.True(root.GetProperty("listening").GetBoolean());
    }

    [Fact]
    public void Append_AddsALineAndNeverThrows()
    {
        var path = Path.Combine(Path.GetTempPath(), $"voice-crash-{Guid.NewGuid():N}.log");
        VoiceCrashLog.Append(Thrown(), "capture", "silero-vad", null, awake: false, listening: true, path);
        VoiceCrashLog.Append(Thrown(), "capture", "silero-vad", null, awake: false, listening: true, path);
        Assert.Equal(2, File.ReadAllLines(path).Length);

        // A path that can't be written is logged to the console, not thrown.
        VoiceCrashLog.Append(Thrown(), "turn", "silero-vad", null, false, false, Path.Combine(path, "not-a-dir", "x.log"));
    }
}

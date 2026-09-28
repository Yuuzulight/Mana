using System;
using System.Globalization;
using System.IO;

namespace Mana.NativeLauncher;

// #682: what happened to one closed VAD segment, filled in as
// VoiceLoop.ProcessTurnAsync decides -- written as a single
// speech-debug.log line by VoiceDebugLog.Append.
internal sealed class VoiceSegmentLogEntry
{
    public DateTime At { get; init; } = DateTime.Now;
    public short[] Samples { get; init; } = Array.Empty<short>();
    public long SpeechMs { get; init; }
    public string Close { get; init; } = "silence";
    public bool Awake { get; set; }
    // #342 acoustic pre-filter: Score null = no classifier loaded (or it
    // threw -- ClassifierFailed); Threshold null = scored but not gating.
    public float? Score { get; set; }
    public float? Threshold { get; set; }
    public bool ClassifierFailed { get; set; }
    // skipped (pre-filter rejected) | failed | empty | ok
    public string Whisper { get; set; } = "skipped";
    public string? Transcript { get; set; }
    public bool? WakeMatch { get; set; }

    internal const int MaxTranscriptChars = 300;

    public override string ToString()
    {
        var inv = CultureInfo.InvariantCulture;
        double peak = 0, sumSquares = 0;
        foreach (var s in Samples)
        {
            peak = Math.Max(peak, Math.Abs((double)s));
            sumSquares += (double)s * s;
        }
        var rms = Samples.Length == 0 ? 0 : Math.Sqrt(sumSquares / Samples.Length);
        var lengthMs = Samples.Length * 1000L / SileroVadRunner.SampleRate;
        var speechPct = lengthMs == 0 ? 0 : Math.Min(100, SpeechMs * 100 / lengthMs);

        var prefilter = Awake ? "n/a"
            : ClassifierFailed ? "error"
            : Score is null ? "unavailable"
            : Threshold is null ? "off"
            : Score >= Threshold ? "pass" : "reject";

        var line = string.Format(inv,
            "{0:yyyy-MM-ddTHH:mm:ss.fff} len={1}ms close={2} peak={3:F1}dBFS rms={4:F1}dBFS speech={5}% awake={6} prefilter={7} score={8} threshold={9} whisper={10}",
            At, lengthMs, Close, Dbfs(peak), Dbfs(rms), speechPct, Awake ? "yes" : "no", prefilter,
            Score?.ToString("F3", inv) ?? "-", Threshold?.ToString("F2", inv) ?? "-", Whisper);
        if (WakeMatch is bool matched)
        {
            line += matched ? " wake=yes" : " wake=no";
        }
        if (Transcript is not null)
        {
            var text = Transcript.Replace('\r', ' ').Replace('\n', ' ').Replace('"', '\'');
            if (text.Length > MaxTranscriptChars)
            {
                text = text[..MaxTranscriptChars] + "...";
            }
            line += $" transcript=\"{text}\"";
        }
        return line;
    }

    // Floored at -120 so digital silence reads as a number, not -Infinity.
    private static double Dbfs(double amplitude) =>
        Math.Max(-120, 20 * Math.Log10(Math.Max(amplitude, 1e-9) / short.MaxValue));
}

// #682: native port of windows-launcher's speech-debug.log (main.js's
// SPEECH_DEBUG_LOG_PATH), one line per closed VAD segment, so a "Mana
// didn't hear me" report can be diagnosed after the fact -- the live run
// that motivated this dropped every segment in the #342 acoustic
// pre-filter without a trace. Unlike Electron's it's on by default (that
// silent failure is exactly what it exists to catch); it holds the user's
// own transcripts, so it stays local, is capped at MaxBytes plus one
// rotated ".1" file, and MANA_SPEECH_DEBUG=0 turns it off.
internal static class VoiceDebugLog
{
    internal static readonly string DefaultPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Mana",
        "logs",
        "speech-debug.log");

    internal const long MaxBytes = 512 * 1024;

    private static readonly object gate = new();

    // Never throws: a locked file or full disk must not break the voice loop.
    public static void Append(VoiceSegmentLogEntry entry, string? path = null, long maxBytes = MaxBytes) =>
        Write(entry.ToString, path, maxBytes);

    // #619: a one-off event between segment lines (e.g. which capture path
    // listening started with), timestamped the same way.
    public static void AppendNote(string text, string? path = null, long maxBytes = MaxBytes) =>
        Write(() => DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + text, path, maxBytes);

    private static void Write(Func<string> format, string? path, long maxBytes)
    {
        if (Environment.GetEnvironmentVariable("MANA_SPEECH_DEBUG") == "0")
        {
            return;
        }
        path ??= DefaultPath;
        try
        {
            var line = format();
            lock (gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (File.Exists(path) && new FileInfo(path).Length >= maxBytes)
                {
                    File.Move(path, path + ".1", overwrite: true);
                }
                File.AppendAllText(path, line + Environment.NewLine);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceDebugLog: couldn't write {path}. {ex.Message}");
        }
    }
}

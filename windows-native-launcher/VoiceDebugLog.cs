using System;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

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
    // skipped (pre-filter or speech gate rejected) | failed | empty | ok
    public string Whisper { get; set; } = "skipped";
    public string? Transcript { get; set; }
    // #925: what whisper wrote, when a mishearing fix changed it.
    public string? Heard { get; set; }
    public bool? WakeMatch { get; set; }
    // #619: the end-of-turn silence that closed this segment and why
    // ("800ms/complete", "2200ms/stale", ...), the live partials behind it
    // (count, last round trip, last text), and whether a merge superseded
    // this segment (its audio was re-sent as the start of the next line's).
    public string? Eot { get; init; }
    public int Partials { get; init; }
    public long? PartialMs { get; init; }
    public string? Partial { get; init; }
    public bool Merged { get; set; }
    // #682 speech filters: the boost applied before Whisper, and why the
    // segment was dropped (quiet | clicky before Whisper; hallucination |
    // noise after it), null if it wasn't.
    public double Gain { get; set; } = 1;
    public string? Drop { get; set; }
    // #678: cosine similarity to my voiceprint and how long it took; null
    // when the segment wasn't checked.
    public float? Speaker { get; set; }
    public long SpeakerMs { get; set; }

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
        if (Gain != 1)
        {
            line += string.Format(inv, " gain={0:F1}", Gain);
        }
        if (Drop is not null)
        {
            line += $" drop={Drop}";
        }
        if (Speaker is float speaker)
        {
            line += string.Format(inv, " speaker={0:F3}/{1}ms", speaker, SpeakerMs);
        }
        if (WakeMatch is bool matched)
        {
            line += matched ? " wake=yes" : " wake=no";
        }
        if (Eot is not null)
        {
            line += $" eot={Eot} partials={Partials}";
            if (PartialMs is long partialMs)
            {
                line += string.Format(inv, "/{0}ms", partialMs);
            }
        }
        if (Merged)
        {
            line += " merged=yes";
        }
        if (Partial is not null)
        {
            line += $" partial=\"{Clean(Partial)}\"";
        }
        if (Transcript is not null)
        {
            line += $" transcript=\"{Clean(Transcript)}\"";
            if (Heard is not null)
            {
                line += $" heard=\"{Clean(Heard)}\"";
            }
        }
        return line;
    }

    private static string Clean(string text)
    {
        text = text.Replace('\r', ' ').Replace('\n', ' ').Replace('"', '\'');
        return text.Length > MaxTranscriptChars ? text[..MaxTranscriptChars] + "..." : text;
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

    private static readonly Regex SpeakerScore = new(@" speaker=(-?\d+\.\d+)/");

    // #965: the last few speaker= scores (oldest first) for Settings >
    // Voice's threshold slider. Empty when there's no log yet. The read is
    // shared, so a segment logged meanwhile isn't lost.
    internal static IReadOnlyList<float> RecentSpeakerScores(int count = 8, string? path = null)
    {
        try
        {
            using var stream = new FileStream(path ?? DefaultPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            var scores = new List<float>();
            while (reader.ReadLine() is { } line)
            {
                if (SpeakerScore.Match(line) is { Success: true } match)
                {
                    scores.Add(float.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture));
                }
            }
            return scores.TakeLast(count).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Array.Empty<float>();
        }
    }

    // Never throws: a locked file or full disk must not break the voice loop.
    public static void Append(VoiceSegmentLogEntry entry, string? path = null, long maxBytes = MaxBytes) =>
        Write(entry.ToString, path, maxBytes);

    // #619: a one-off event between segment lines (e.g. which capture path
    // listening started with), timestamped the same way.
    public static void AppendNote(string text, string? path = null, long maxBytes = MaxBytes) =>
        Write(() => DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + text, path, maxBytes);

    private static void Write(Func<string> format, string? path, long maxBytes)
    {
        if (Environment.GetEnvironmentVariable("MANA_SPEECH_DEBUG") != "0")
        {
            WriteLine(format, path ?? DefaultPath, maxBytes);
        }
    }

    // Appends one line, rotating at maxBytes. Never throws.
    internal static void WriteLine(Func<string> format, string path, long maxBytes)
    {
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

// #860: native port of windows-launcher's voice-crash.log (main.js's
// VOICE_CRASH_LOG_PATH, #147) -- one JSON line per exception that escapes
// the voice loop, next to speech-debug.log, instead of only the console.
// Always on (it only ever holds errors, never transcripts); same size cap.
internal static class VoiceCrashLog
{
    internal static readonly string DefaultPath = Path.Combine(Path.GetDirectoryName(VoiceDebugLog.DefaultPath)!, "voice-crash.log");

    // Never throws.
    public static void Append(Exception error, string where, string audioBackend, string? inputDevice, bool awake, bool listening, string? path = null) =>
        VoiceDebugLog.WriteLine(() => Format(error, where, audioBackend, inputDevice, awake, listening, DateTimeOffset.Now), path ?? DefaultPath, VoiceDebugLog.MaxBytes);

    // Electron's fields (error, stack, audioBackend, inputDeviceLabel,
    // awake, listening), plus where in the loop it happened.
    internal static string Format(Exception error, string where, string audioBackend, string? inputDevice, bool awake, bool listening, DateTimeOffset at) =>
        JsonSerializer.Serialize(new
        {
            at = at.ToString("o", CultureInfo.InvariantCulture),
            where,
            error = error.Message,
            type = error.GetType().FullName,
            stack = error.StackTrace,
            audioBackend,
            inputDeviceLabel = inputDevice,
            awake,
            listening,
        });
}

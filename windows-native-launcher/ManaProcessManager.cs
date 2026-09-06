using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

internal sealed class ManaProcessManager : IDisposable
{
    private readonly HttpClient http;
    private Process? backendProcess;
    private Process? kokoroProcess;
    private Process? fishSpeechProcess;

    public string RootDirectory { get; }

    // #582: only captures output for a backend process THIS launcher
    // spawned -- if StartAsync's health check found node-bot already
    // running externally, backendProcess stays null and there is nothing
    // to redirect, so the buffer just stays empty (no log to show, not
    // an error).
    public BackendLogBuffer BackendLog { get; } = new();

    // #479 review: distinct from "did THIS launch start a process handle" --
    // true whether Fish Speech was already running externally (health check
    // passed, fishSpeechProcess stays null, nothing to start) or this
    // launch started it. False only for the actual graceful-degradation
    // case: missing native setup, or a launch failure. Lets callers (the
    // tray status) tell "fish is really answering requests" apart from
    // "TTS_PROVIDER=fish is configured but Kokoro is silently covering for
    // it" -- the two look identical from the configured-provider name alone.
    public bool IsFishSpeechAvailable { get; private set; }

    // handler: null (the default, and every existing call site's behavior)
    // constructs a real HttpClient for live health checks. Tests pass a
    // fake HttpMessageHandler to exercise the health-check-then-start
    // selection logic without live servers -- same pattern as
    // ManaBackendClient.
    public ManaProcessManager(string rootDirectory, HttpMessageHandler? handler = null)
    {
        RootDirectory = rootDirectory;
        http = handler is null ? new HttpClient() : new HttpClient(handler);
    }

    // onServiceReady, when given, fires once per service (key "backend"/
    // "kokoro"/"fish-speech") the moment its own health-check-then-start
    // resolves -- lets a caller (the startup overlay) flip that row from
    // "Starting..." to "Ready"/"Unavailable" live instead of only knowing
    // "all three are done" after StartAsync itself returns. Fires on
    // whatever context awaited into this method (the UI thread, for the
    // launcher's own real call site) -- no ConfigureAwait(false) anywhere
    // in this file to break that.
    public async Task StartAsync(Action<string, bool>? onServiceReady = null)
    {
        async Task<(Process? Process, bool Available)> StartAndReport(string key, string healthUrl, Func<Task<Process?>> start)
        {
            var result = await StartIfNotRunningAsync(healthUrl, start);
            onServiceReady?.Invoke(key, result.Available);
            return result;
        }

        // Fish Speech (S1-mini) is Mana's default TTS provider
        // (docs/fish_speech_tts.md) -- Kokoro is its automatic fallback
        // voice, not the primary, so both services need to actually be
        // running: Fish Speech to answer synthesis requests by default,
        // Kokoro so the fallback has something live to fall back to.
        //
        // These three checks are independent (none needs another already
        // running before it can start), so they run concurrently instead
        // of one-after-another -- a stale/wedged listener on one port no
        // longer serializes an ~100s HttpClient timeout in front of the
        // other two.
        var kokoroTask = StartAndReport("kokoro", "http://127.0.0.1:5011/health", () => Task.FromResult<Process?>(StartKokoro()));
        var fishSpeechTask = StartAndReport("fish-speech", "http://127.0.0.1:8080/v1/health", () => Task.FromResult(StartFishSpeech()));
        var backendTask = StartAndReport("backend", "http://127.0.0.1:5005/health", () => Task.FromResult<Process?>(StartBackend()));

        try
        {
            await Task.WhenAll(kokoroTask, fishSpeechTask, backendTask);
        }
        finally
        {
            // Task.WhenAll waits for every task to reach a terminal state
            // (success or failure) before it throws -- so by here all
            // three are guaranteed completed, and it's safe to store
            // whichever processes actually started even if a sibling
            // failed (e.g. Kokoro's missing-venv throw, unchanged, still
            // fatal by design). Without this, a successfully-started Fish
            // Speech or backend process would be orphaned: started, but
            // never given a Process handle for Dispose() to kill.
            if (kokoroTask.IsCompletedSuccessfully) kokoroProcess = kokoroTask.Result.Process;
            if (fishSpeechTask.IsCompletedSuccessfully)
            {
                fishSpeechProcess = fishSpeechTask.Result.Process;
                IsFishSpeechAvailable = fishSpeechTask.Result.Available;
            }
            if (backendTask.IsCompletedSuccessfully) backendProcess = backendTask.Result.Process;
        }
    }

    // #479 review: named as worth tracking rather than a full crash-recovery
    // system (no Process.Exited watcher, no auto-restart) -- this is
    // explicitly a manual action a user can reach for (the tray's "Restart
    // Fish Speech" item) once they've noticed the fallback note above, not
    // an unattended self-healing loop. Stops whatever's there first (a
    // hung/half-working process, if any) before starting fresh, the same
    // as StartFishSpeech()'s own non-fatal degrade path.
    public void RestartFishSpeech()
    {
        StopProcess(fishSpeechProcess);
        fishSpeechProcess = StartFishSpeech();
        IsFishSpeechAvailable = fishSpeechProcess is not null;
    }

    private async Task<(Process? Process, bool Available)> StartIfNotRunningAsync(string healthUrl, Func<Task<Process?>> start)
    {
        if (await IsServiceRunningAsync(healthUrl))
        {
            // Already running externally -- nothing to start, but very
            // much available.
            return (null, true);
        }
        var process = await start();
        // For Kokoro/the backend, start() either returns a real process or
        // throws (fatal) -- so `process is not null` here is always true
        // whenever this line is reached at all. Fish Speech is the one
        // caller where start() can return null non-fatally (missing native
        // setup, or a launch failure) -- that's the actual degraded case.
        return (process, process is not null);
    }

    private async Task<bool> IsServiceRunningAsync(string url)
    {
        try
        {
            using var response = await http.GetAsync(url);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private Process StartKokoro()
    {
        var ttsDir = Path.Combine(RootDirectory, "tts-service");
        var python = ResolveVenvPython(ttsDir, "venv");
        if (!File.Exists(python))
        {
            throw new FileNotFoundException("Kokoro Python environment was not found. Run the Electron launcher once for setup.", python);
        }

        return StartHiddenProcess(
            python,
            "-m uvicorn kokoro_service:app --host 127.0.0.1 --port 5011",
            ttsDir);
    }

    // Launches tools/fish_speech_native_server.py directly, not
    // tools/start_fish_speech_native.ps1 -- the .ps1 script's own
    // Start-Process call detaches the actual server process from the
    // launching shell (by design, so the script itself can exit after
    // polling health), which would leak that process past this app's
    // lifetime if we shelled out to the script instead of the server
    // directly. Launching it here the same way StartKokoro() does gives
    // Dispose() a real, trackable, killable Process handle.
    //
    // This same tradeoff (a Start-Process-based launcher script vs. a
    // trackable handle) isn't unique to Fish Speech -- tools/start-local-
    // services.ps1 uses the identical shape for SearXNG and llama-server.
    // If this launcher adopts either of those the same way, expect to
    // re-solve this same fork, including re-porting whatever safety logic
    // that script carries (this file already had to re-port Fish Speech's
    // own RAM-headroom check below once).
    //
    // fish_speech_native_server.py's own docstring requires its working
    // directory be tools/fish-speech (it resolves checkpoint paths
    // relative to cwd) and takes no arguments of its own -- it hardcodes
    // `--compile` internally before handing off to the vendored
    // api_server.py.
    private Process? StartFishSpeech()
    {
        var fishDir = Path.Combine(RootDirectory, "tools", "fish-speech");
        var python = ResolveVenvPython(fishDir, ".venv-native");
        var serverScript = Path.Combine(RootDirectory, "tools", "fish_speech_native_server.py");
        if (!File.Exists(python) || !File.Exists(serverScript))
        {
            // Unlike Kokoro (thrown as fatal above) -- Fish Speech missing
            // its native setup is not fatal to app startup. TTS_PROVIDER=fish
            // combined with node-bot's own FISH_TTS_FALLBACK_PROVIDER
            // default ("kokoro") already degrades gracefully to
            // Kokoro-only operation when Fish Speech is unreachable, and
            // its native setup (docs/fish_speech_tts.md) is a substantial
            // manual install most users won't have done yet.
            LogFishSpeechDiagnostic(
                fishDir,
                $"Fish Speech native setup incomplete (python.exe found: {File.Exists(python)}, fish_speech_native_server.py found: {File.Exists(serverScript)}); skipping -- Mana will use Kokoro until it's set up (see docs/fish_speech_tts.md).");
            return null;
        }

        // Ported from start_fish_speech_native.ps1's own free-RAM check --
        // the checkpoint loads via mmap, which stages through host RAM
        // regardless of its eventual GPU destination, so a low-RAM machine
        // can crash here, not just run slowly. Warning only, not a hard
        // block, matching the .ps1 script's own behavior.
        var freeRamGB = GetFreeRamGB();
        if (freeRamGB < 6)
        {
            LogFishSpeechDiagnostic(
                fishDir,
                $"Warning: only {freeRamGB:F1}GB RAM free -- loading Fish Speech's checkpoint (~3.6GB, mmap'd through host RAM) may be tight. Consider closing other apps first.");
        }

        try
        {
            // Redirected to the same log file names start_fish_speech_native.ps1
            // itself uses, so a failure here leaves the same diagnostic
            // trail a manual run of that script would -- unlike Kokoro/the
            // backend, Fish Speech's cold-compile startup is slow and
            // failure-prone enough (docs/fish_speech_tts.md) that silent
            // failure with nothing to inspect is a real cost.
            return StartHiddenProcess(
                python,
                Quote(serverScript),
                fishDir,
                stdoutLogPath: Path.Combine(fishDir, "native_server.out.log"),
                stderrLogPath: Path.Combine(fishDir, "native_server.err.log"));
        }
        catch (Exception ex)
        {
            // Same non-fatal reasoning as the missing-setup case above --
            // a launch failure here must not take down backend startup or
            // the voice loop.
            LogFishSpeechDiagnostic(fishDir, $"Fish Speech failed to start: {ex.Message} -- Mana will use Kokoro until this is resolved.");
            return null;
        }
    }

    private Process StartBackend()
    {
        var nodeBotDir = Path.Combine(RootDirectory, "node-bot");
        var nodeServer = Path.Combine(nodeBotDir, "server.js");
        var whisperDir = Path.Combine(RootDirectory, "tools", "whisper");
        var startInfo = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = Quote(nodeServer),
            WorkingDirectory = nodeBotDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        startInfo.Environment["WHISPER_BIN"] =
            Environment.GetEnvironmentVariable("WHISPER_BIN") ??
            Path.Combine(whisperDir, "Release", "whisper-cli.exe");
        startInfo.Environment["WHISPER_MODEL"] =
            Environment.GetEnvironmentVariable("WHISPER_MODEL") ??
            Path.Combine(whisperDir, "models", "ggml-tiny.en.bin");
        // "fish" (Fish Speech / S1-mini) matches node-bot's own default
        // (tts-runtime.js: env.TTS_PROVIDER || (ttsBin ? "cli" : "fish")) and
        // docs/fish_speech_tts.md's stated default -- Kokoro is the
        // fallback, not the primary. KOKORO_TTS_FALLBACK_PROVIDER below is
        // a different, correctly-named variable (Kokoro's own fallback,
        // not Fish Speech's) and is left as-is.
        startInfo.Environment["TTS_PROVIDER"] =
            Environment.GetEnvironmentVariable("TTS_PROVIDER") ?? "fish";
        startInfo.Environment["KOKORO_TTS_FALLBACK_PROVIDER"] =
            Environment.GetEnvironmentVariable("KOKORO_TTS_FALLBACK_PROVIDER") ?? "none";
        startInfo.Environment["START_FALLBACK_CHATTERBOX"] = "0";

        var process = Process.Start(startInfo) ??
               throw new InvalidOperationException("Failed to start Mana backend.");

        void OnLine(object? sender, DataReceivedEventArgs e)
        {
            if (e.Data is not null)
            {
                BackendLog.Add(e.Data);
            }
        }
        process.OutputDataReceived += OnLine;
        process.ErrorDataReceived += OnLine;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return process;
    }

    // Shared by StartKokoro/StartFishSpeech -- both are "python from a
    // dedicated venv" services differing only in the venv's directory
    // layout (Kokoro: tts-service/venv/..., Fish Speech:
    // tools/fish-speech/.venv-native/...). What to do when it's missing
    // (throw vs. log-and-return-null) genuinely differs per caller and is
    // deliberately NOT folded into this helper.
    internal static string ResolveVenvPython(string venvRootDir, string venvSubdir)
    {
        return Path.Combine(venvRootDir, venvSubdir, "Scripts", "python.exe");
    }

    private static Process StartHiddenProcess(
        string fileName,
        string arguments,
        string workingDirectory,
        string? stdoutLogPath = null,
        string? stderrLogPath = null)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = stdoutLogPath is not null,
            RedirectStandardError = stderrLogPath is not null,
        };

        var process = Process.Start(startInfo) ??
               throw new InvalidOperationException($"Failed to start {fileName}.");

        if (stdoutLogPath is not null)
        {
            AttachLineLogger(process, isError: false, stdoutLogPath);
        }
        if (stderrLogPath is not null)
        {
            AttachLineLogger(process, isError: true, stderrLogPath);
        }

        return process;
    }

    // #479 review: this app is a WinExe (no console window), so
    // Console.WriteLine here previously wrote to a stream nobody was
    // attached to -- a user whose Fish Speech setup is incomplete or whose
    // launch failed had no way to find out short of the voice sounding
    // different. Appended (not truncated) so a launch failure survives
    // across restarts to actually be found, unlike the child process's own
    // fresh-per-launch stdout/stderr logs below. Best-effort: a log
    // directory that can't be written to must never fail the caller.
    private static void LogFishSpeechDiagnostic(string fishDir, string message)
    {
        Console.WriteLine(message);
        try
        {
            // No Directory.CreateDirectory here on purpose -- tools/fish-speech
            // already exists in any real checkout (it's the missing venv/
            // checkpoint inside it that triggers this), and this must stay a
            // pure best-effort write, never a reason to create directories
            // the caller (e.g. a test pointed at a nonexistent root) didn't
            // ask for.
            var logPath = Path.Combine(fishDir, "launcher.log");
            File.AppendAllText(logPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}{Environment.NewLine}");
        }
        catch
        {
            // Best effort.
        }
    }

    // Fresh log file per launch (truncated, not appended) -- matches
    // start_fish_speech_native.ps1's own -RedirectStandardOutput/-Error
    // behavior, which overwrites on each run rather than accumulating
    // forever. Best-effort only: a log directory that can't be written to
    // must never prevent the service itself from starting.
    private static void AttachLineLogger(Process process, bool isError, string logPath)
    {
        try
        {
            File.WriteAllText(logPath, string.Empty);
        }
        catch
        {
            // Best effort.
        }

        DataReceivedEventHandler handler = (_, e) =>
        {
            if (e.Data is null) return;
            try
            {
                File.AppendAllText(logPath, e.Data + Environment.NewLine);
            }
            catch
            {
                // Best effort.
            }
        };

        if (isError)
        {
            process.ErrorDataReceived += handler;
            process.BeginErrorReadLine();
        }
        else
        {
            process.OutputDataReceived += handler;
            process.BeginOutputReadLine();
        }
    }

    private static string Quote(string value)
    {
        return $"\"{value.Replace("\"", "\\\"")}\"";
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    // Ported from start_fish_speech_native.ps1's own free-RAM check (there,
    // via Get-CimInstance Win32_OperatingSystem). GlobalMemoryStatusEx is
    // the native Win32 equivalent -- avoids adding a new NuGet dependency
    // (e.g. System.Management) for a single read.
    private static double GetFreeRamGB()
    {
        var status = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        if (!GlobalMemoryStatusEx(ref status))
        {
            return double.MaxValue; // can't determine -- don't warn spuriously
        }
        return status.ullAvailPhys / 1024.0 / 1024.0 / 1024.0;
    }

    // Graceful, progress-reporting counterpart to Dispose()'s own
    // synchronous kill-and-forget -- used by the shutdown overlay so "Exit
    // Mana" isn't silently invisible while these processes actually stop.
    // Safe to run before Dispose() (called later from ExitThreadCore
    // regardless, as a safety net): StopProcess/Kill on an already-exited
    // process is already a no-op, so nothing here duplicates work Dispose()
    // would otherwise do.
    public async Task StopAllAsync(Action<string, bool>? onServiceStopped = null)
    {
        async Task StopAndReport(string key, Process? process)
        {
            if (process is not null && !process.HasExited)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    await process.WaitForExitAsync(timeout.Token);
                }
                catch
                {
                    // Best effort, same reasoning as StopProcess below --
                    // a stubborn process still gets its row's own
                    // stopped/still-running report either way.
                }
            }
            onServiceStopped?.Invoke(key, process is null || process.HasExited);
        }

        await Task.WhenAll(
            StopAndReport("backend", backendProcess),
            StopAndReport("kokoro", kokoroProcess),
            StopAndReport("fish-speech", fishSpeechProcess));
    }

    public void Dispose()
    {
        http.Dispose();
        StopProcess(backendProcess);
        StopProcess(kokoroProcess);
        StopProcess(fishSpeechProcess);
    }

    private static void StopProcess(Process? process)
    {
        if (process is null || process.HasExited)
        {
            return;
        }

        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best effort cleanup on app exit.
        }
    }
}

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

internal sealed class ManaProcessManager : IDisposable
{
    private readonly HttpClient http = new();
    private Process? backendProcess;
    private Process? kokoroProcess;
    private Process? fishSpeechProcess;

    public string RootDirectory { get; }

    public ManaProcessManager(string rootDirectory)
    {
        RootDirectory = rootDirectory;
    }

    public async Task StartAsync()
    {
        // Fish Speech (S1-mini) is Mana's default TTS provider
        // (docs/fish_speech_tts.md) -- Kokoro is its automatic fallback
        // voice, not the primary, so both services need to actually be
        // running: Fish Speech to answer synthesis requests by default,
        // Kokoro so the fallback has something live to fall back to.
        if (!await IsServiceRunningAsync("http://127.0.0.1:5011/health"))
        {
            kokoroProcess = StartKokoro();
        }

        if (!await IsServiceRunningAsync("http://127.0.0.1:8080/v1/health"))
        {
            fishSpeechProcess = StartFishSpeech();
        }

        if (!await IsServiceRunningAsync("http://127.0.0.1:5005/health"))
        {
            backendProcess = StartBackend();
        }
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
        var python = Path.Combine(ttsDir, "venv", "Scripts", "python.exe");
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
    // fish_speech_native_server.py's own docstring requires its working
    // directory be tools/fish-speech (it resolves checkpoint paths
    // relative to cwd) and takes no arguments of its own -- it hardcodes
    // `--compile` internally before handing off to the vendored
    // api_server.py.
    private Process? StartFishSpeech()
    {
        var fishDir = Path.Combine(RootDirectory, "tools", "fish-speech");
        var python = Path.Combine(fishDir, ".venv-native", "Scripts", "python.exe");
        var serverScript = Path.Combine(RootDirectory, "tools", "fish_speech_native_server.py");
        if (!File.Exists(python))
        {
            // Unlike Kokoro (thrown as fatal below) -- Fish Speech missing
            // its native venv is not fatal to app startup. TTS_PROVIDER=fish
            // combined with node-bot's own FISH_TTS_FALLBACK_PROVIDER
            // default ("kokoro") already degrades gracefully to
            // Kokoro-only operation when Fish Speech is unreachable, and
            // its native setup (docs/fish_speech_tts.md) is a substantial
            // manual install most users won't have done yet.
            Console.WriteLine(
                $"Fish Speech native venv not found at {python}; skipping -- Mana will use Kokoro until it's set up (see docs/fish_speech_tts.md).");
            return null;
        }

        return StartHiddenProcess(python, Quote(serverScript), fishDir);
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

        return Process.Start(startInfo) ??
               throw new InvalidOperationException("Failed to start Mana backend.");
    }

    private static Process StartHiddenProcess(string fileName, string arguments, string workingDirectory)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        return Process.Start(startInfo) ??
               throw new InvalidOperationException($"Failed to start {fileName}.");
    }

    private static string Quote(string value)
    {
        return $"\"{value.Replace("\"", "\\\"")}\"";
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

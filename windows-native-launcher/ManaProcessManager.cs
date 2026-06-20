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
    private Process? ttsProcess;

    public string RootDirectory { get; }

    public ManaProcessManager(string rootDirectory)
    {
        RootDirectory = rootDirectory;
    }

    public async Task StartAsync()
    {
        if (!await IsServiceRunningAsync("http://127.0.0.1:5011/health"))
        {
            ttsProcess = StartKokoro();
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
        startInfo.Environment["TTS_PROVIDER"] =
            Environment.GetEnvironmentVariable("TTS_PROVIDER") ?? "kokoro";
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
        StopProcess(ttsProcess);
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

using System;
using System.Diagnostics;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

internal static class Program
{
    private static VoiceLoop? voiceLoop;
    private static AudioPlayer? audioPlayer;
    private static AvatarOverlayForm? avatarOverlay;

    private static async Task Main(string[] args)
    {
        Console.WriteLine("[Native Launcher] Starting...");

        // Step 1: Start backend server as a separate process (low memory footprint)
        var backendPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "backend_server.py");
        
        if (!File.Exists(backendPath))
        {
            Console.WriteLine($"[Native Launcher] Warning: backend_server.py not found at {backendPath}");
            Console.WriteLine("[Native Launcher] Falling back to embedded BackendServer.cs contract...");
            // In production, you'd either:
            // 1. Bundle the Python file alongside the .NET executable
            // 2. Or use a pre-built backend service (e.g., Docker container)
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "python3",
                Arguments = $"\"{backendPath}\"",
                WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var backendProcess = Process.Start(startInfo);
            
            // Wait for server to be ready (with timeout)
            int attempts = 0;
            while (attempts < 30 && !backendProcess.HasExited)
            {
                await Task.Delay(1000);
                
                try
                {
                    using var client = new System.Net.Http.HttpClient();
                    var response = await client.GetAsync("http://127.0.0.1:5005/perf/status");
                    
                    if (response.IsSuccessStatusCode)
                    {
                        Console.WriteLine("[Native Launcher] Backend server is ready.");
                        break;
                    }
                }
                catch
                {
                    // Server not yet listening, keep trying
                }

                attempts++;
            }

            if (backendProcess.HasExited && attempts >= 30)
            {
                Console.WriteLine("[Native Launcher] Error: Backend server failed to start within timeout.");
                return;
            }

            // Step 2: Initialize native launcher components
            var vad = new SileroVadRunner(
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets\\vad\\silero_vad.onnx"),
                threshold: 0.5f);

            var backendClient = new ManaBackendClient(); // Uses live HTTP client against 127.0.0.1:5005
            
            audioPlayer = new AudioPlayer();
            
            // Avatar overlay (Windows Forms UI)
            avatarOverlay = new AvatarOverlayForm(AppDomain.CurrentDomain.BaseDirectory);
            avatarOverlay.Show();

            // Step 3: Start voice loop
            Console.WriteLine("[Native Launcher] Starting voice loop...");
            voiceLoop = new VoiceLoop(vad, backendClient, audioPlayer, avatarOverlay);
            voiceLoop.Start();

            // Keep app alive (in production, wire up proper shutdown events)
            Console.WriteLine("[Native Launcher] Press Ctrl+C to exit.");
            
            await Task.Delay(Timeout.Infinite);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Native Launcher] Fatal error: {ex.Message}");
            Console.WriteLine(ex.StackTrace);
        }
        finally
        {
            // Cleanup backend process if still running
            try
            {
                var backendProcess = Process.GetProcessesByName("python3")
                    .FirstOrDefault(p => p.MainModule?.FileName.Contains("backend_server.py") ?? false);
                
                if (backendProcess != null)
                {
                    Console.WriteLine("[Native Launcher] Shutting down backend server...");
                    backendProcess.Kill();
                }
            }
            catch { /* Ignore cleanup errors */ }

            // Cleanup native launcher resources
            try
            {
                voiceLoop?.Dispose();
                audioPlayer?.Dispose();
                avatarOverlay?.Close();
                avatarOverlay?.Dispose();
            }
            catch { /* Ignore cleanup errors */ }
        }
    }
}

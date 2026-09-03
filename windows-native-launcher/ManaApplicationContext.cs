using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal sealed class ManaApplicationContext : ApplicationContext
{
    private readonly AvatarOverlayForm avatarOverlay;
    private readonly NotifyIcon trayIcon;
    private readonly ManaProcessManager processManager;
    private readonly ManaBackendClient backendClient;
    private readonly System.Windows.Forms.Timer statusTimer;
    private readonly SileroVadRunner sileroVad;
    private readonly AudioPlayer audioPlayer;
    private readonly VoiceLoop voiceLoop;
    private readonly QuickEntryForm quickEntry;
    private readonly SessionListForm sessionListForm;

    public ManaApplicationContext()
    {
        var rootDir = FindRootDirectory();
        processManager = new ManaProcessManager(rootDir);
        backendClient = new ManaBackendClient();
        avatarOverlay = new AvatarOverlayForm(rootDir);

        var vadModelPath = Path.Combine(rootDir, "windows-native-launcher", "assets", "vad", "silero_vad.onnx");
        sileroVad = new SileroVadRunner(vadModelPath);
        // #479 sub-project 4: taps live playback samples for
        // avatarOverlay's lip-sync render loop -- a no-op when no Cubism
        // model is loaded (LipSyncDriver still runs, just nothing reads
        // its output).
        audioPlayer = new AudioPlayer(avatarOverlay.LipSyncDriver.OnSamplesPlayed);
        // #521: constructed before voiceLoop so it can be passed in as
        // VoiceLoop's IChatLog -- SessionListForm only needs the control
        // itself (to embed it), not the other way around.
        var chatLog = new ChatLogPanel();
        voiceLoop = new VoiceLoop(sileroVad, backendClient, audioPlayer, avatarOverlay, chatLog);
        sessionListForm = new SessionListForm(backendClient, voiceLoop, chatLog, avatarOverlay);
        // #525: Ctrl+Alt+Space types a command instead of speaking one,
        // through the exact same turn-processing path.
        quickEntry = new QuickEntryForm(voiceLoop.SubmitTypedCommandAsync);

        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Mana",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu(),
        };

        trayIcon.DoubleClick += (_, _) => ShowStatus();
        avatarOverlay.Show();

        // Quick rundown: start the existing local services, but keep this host native and small.
        _ = StartServicesAsync();

        statusTimer = new System.Windows.Forms.Timer
        {
            Interval = 5000,
        };
        statusTimer.Tick += async (_, _) => await RefreshTrayStatusAsync();
        statusTimer.Start();
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show status", null, (_, _) => ShowStatus());
        menu.Items.Add("Sessions", null, (_, _) => ShowSessionList());
        menu.Items.Add("Open project folder", null, (_, _) => OpenProjectFolder());
        menu.Items.Add("Set avatar idle", null, (_, _) => avatarOverlay.SetState(AvatarState.Idle));
        menu.Items.Add("Set avatar talking", null, (_, _) => avatarOverlay.SetState(AvatarState.Talking));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart Fish Speech", null, (_, _) => RestartFishSpeech());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit Mana", null, (_, _) => ExitThread());
        return menu;
    }

    private async Task StartServicesAsync()
    {
        await processManager.StartAsync();
        await RefreshTrayStatusAsync();
        voiceLoop.Start();
    }

    private async Task RefreshTrayStatusAsync()
    {
        try
        {
            var status = await backendClient.GetPerformanceStatusAsync();
            trayIcon.Text = status.GamingAppRunning ? "Mana - game mode" : "Mana";
        }
        catch
        {
            trayIcon.Text = "Mana - backend starting";
        }
    }

    private async void ShowStatus()
    {
        try
        {
            var status = await backendClient.GetPerformanceStatusAsync();
            MessageBox.Show(
                $"Backend: running\nGame detected: {status.GamingAppRunning}\nMemory: {status.TotalMemoryMb} MB\nTTS: {status.TtsProvider}{FallbackNoteFor(status.TtsProvider)}",
                "Mana Status",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Mana backend is not ready yet.\n\n{error.Message}",
                "Mana Status",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    // #520: reused (Hide, not Close), so Load's own one-time-only refresh
    // isn't enough -- explicitly refresh on every open instead.
    private void ShowSessionList()
    {
        sessionListForm.Show();
        sessionListForm.Activate();
        _ = sessionListForm.RefreshAsync();
    }

    // #479 review: `status.TtsProvider` is node-bot's *configured* value
    // (the TTS_PROVIDER env var this launcher itself sets to "fish") --
    // not whether Fish Speech's native process is actually up. Without
    // this, a missing native setup or a launch failure (both silently
    // degrade to Kokoro, by design) would still show "TTS: fish" here,
    // giving no indication the voice is actually coming from the fallback.
    private string FallbackNoteFor(string? configuredProvider)
    {
        var isFishConfigured = string.Equals(configuredProvider, "fish", StringComparison.OrdinalIgnoreCase);
        return isFishConfigured && !processManager.IsFishSpeechAvailable ? " (Kokoro fallback active)" : "";
    }

    // #479 review: a manual escape hatch for the fallback case FallbackNoteFor
    // above surfaces -- Fish Speech's cold-compile startup (docs/fish_speech_tts.md)
    // is slow/failure-prone enough that "fix the underlying issue, then
    // retry" without restarting the whole tray app is worth having.
    private void RestartFishSpeech()
    {
        processManager.RestartFishSpeech();
        MessageBox.Show(
            processManager.IsFishSpeechAvailable
                ? "Fish Speech restarted."
                : "Fish Speech failed to start again -- Mana will keep using Kokoro. See tools/fish-speech/launcher.log for details.",
            "Mana Status",
            MessageBoxButtons.OK,
            processManager.IsFishSpeechAvailable ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
    }

    private void OpenProjectFolder()
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = processManager.RootDirectory,
            UseShellExecute = true,
        });
    }

    protected override void ExitThreadCore()
    {
        statusTimer.Stop();
        voiceLoop.Dispose();
        audioPlayer.Dispose();
        sileroVad.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        avatarOverlay.Close();
        quickEntry.Close();
        // #520: Dispose, not Close -- OnFormClosing overrides UserClosing
        // to Hide-and-cancel for the reuse pattern, so a plain Close()
        // here would risk not actually tearing the window down.
        sessionListForm.Dispose();
        processManager.Dispose();
        base.ExitThreadCore();
    }

    private static string FindRootDirectory()
    {
        var current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (Directory.Exists(Path.Combine(current, "node-bot")))
            {
                return current;
            }

            var parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
    }
}

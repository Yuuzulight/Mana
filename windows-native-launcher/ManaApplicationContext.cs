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
    private readonly VisionHotkeyListener visionHotkeyListener;
    private readonly TrayNotificationClient trayNotifications;
    private readonly ArtifactViewerForm artifactViewer;
    private readonly QuickEntryForm quickEntry;
    private readonly SessionListForm sessionListForm;

    // #522: updated by RefreshTrayStatusAsync's existing 5s poll --
    // VoiceLoop reads it (via a delegate, not a captured snapshot) to
    // pick the screen-context read interval, same signal the tray icon
    // text already reflects.
    private bool gamingModeActive;

    // The 3 services ManaProcessManager actually starts/stops -- shared
    // between the startup and shutdown overlays, same as windows-launcher's
    // single #startupOverlay markup being reused for both (there it also
    // tracks Voice/Web search/Local AI, which don't apply here: this
    // launcher waits on one backend health check for all of node-bot's own
    // internal readiness, not separate per-feature ones).
    private static readonly (string Key, string Label)[] ServiceRows =
    {
        ("backend", "Backend"),
        ("kokoro", "Kokoro TTS"),
        ("fish-speech", "Fish Speech TTS"),
    };

    // Guards against "Exit Mana" clicked twice while ShutdownAsync's own
    // overlay/graceful-stop is still running -- without it, a second click
    // would show a second overlay and re-kill already-exiting processes.
    private bool isShuttingDown;

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
        artifactViewer = new ArtifactViewerForm();
        // #521: constructed before voiceLoop so it can be passed in as
        // VoiceLoop's IChatLog -- SessionListForm only needs the control
        // itself (to embed it), not the other way around.
        var chatLog = new ChatLogPanel();
        // #522: ScreenContextReader owns its own min-interval/keyword-gate
        // caching internally, so this is just held and passed straight
        // through to VoiceLoop, same as the other optional collaborators
        // constructed above it.
        var screenContextReader = new ScreenContextReader(rootDir, backendClient);
        voiceLoop = new VoiceLoop(sileroVad, backendClient, audioPlayer, avatarOverlay, chatLog, artifactViewer, screenContextReader, () => gamingModeActive);
        // #523: Ctrl+Alt+M asks Mana to look at the screen, through the
        // same reply/TTS pipeline a normal turn uses.
        visionHotkeyListener = new VisionHotkeyListener(() => _ = voiceLoop.SubmitVisionHotkeyAsync());
        sessionListForm = new SessionListForm(backendClient, voiceLoop, chatLog, avatarOverlay);
        // #525: Ctrl+Alt+Space types a command instead of speaking one,
        // through the exact same turn-processing path.
        quickEntry = new QuickEntryForm(voiceLoop.SubmitTypedCommandAsync);
        // #524: originally a no-op (no chat/session window existed on
        // this branch yet) -- #521/#520 shipped one since, so this now
        // does what the original comment here flagged as the real
        // upgrade path. ToastNotificationManagerCompat.OnActivated fires
        // on a threadpool thread, not this app's UI thread (it's raised
        // via Windows Shell/COM activation, which can even relaunch the
        // app), so ShowSessionList can't be wired directly -- it calls
        // sessionListForm.Show()/Activate() with no marshaling of its
        // own. Routed through sessionListForm's own Invoke instead, same
        // IsDisposed-then-marshal shape as this codebase's other
        // background-thread-to-UI call sites (e.g. ChatLogPanel's
        // RunOnUiThread).
        trayNotifications = new TrayNotificationClient(openChat: () =>
        {
            if (sessionListForm.IsDisposed)
            {
                return;
            }
            if (sessionListForm.InvokeRequired)
            {
                sessionListForm.BeginInvoke(ShowSessionList);
                return;
            }
            ShowSessionList();
        });

        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Mana",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu(),
        };

        trayIcon.DoubleClick += (_, _) => ShowStatus();
        avatarOverlay.Show();
        trayNotifications.Start();

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
        menu.Items.Add("Artifact Viewer", null, (_, _) => { artifactViewer.Show(); artifactViewer.Activate(); });
        menu.Items.Add("Compare Models", null, (_, _) => new CompareModeForm(backendClient).Show());
        menu.Items.Add("Deep Research", null, (_, _) => new ResearchForm(backendClient, () => voiceLoop.CurrentSessionId).Show());
        menu.Items.Add("Doctor", null, (_, _) => ShowDoctorPanel());
        menu.Items.Add("Sessions", null, (_, _) => ShowSessionList());
        menu.Items.Add("Open project folder", null, (_, _) => OpenProjectFolder());
        menu.Items.Add("Set avatar idle", null, (_, _) => avatarOverlay.SetState(AvatarState.Idle));
        menu.Items.Add("Set avatar talking", null, (_, _) => avatarOverlay.SetState(AvatarState.Talking));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart Fish Speech", null, (_, _) => RestartFishSpeech());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit Mana", null, (_, _) => _ = ShutdownAsync());
        return menu;
    }

    private async Task StartServicesAsync()
    {
        var overlay = new StartupOverlayForm("Starting Mana", "Starting...", ServiceRows);
        overlay.Show();
        try
        {
            await processManager.StartAsync((key, available) =>
                overlay.SetRowStatus(key, available ? "Ready" : "Unavailable", available ? RowState.Ready : RowState.Warn));
            await RefreshTrayStatusAsync();
            voiceLoop.Start();
        }
        finally
        {
            overlay.Close();
        }
    }

    // #479 follow-up: mirrors windows-launcher's own close-intercept ->
    // runGracefulShutdown() -> app.exit(0) flow. ExitThread() alone would
    // tear the process down invisibly (no window to watch it happen in,
    // just the tray icon vanishing) while backend/Kokoro/Fish Speech are
    // still being killed -- this shows the same overlay startup used,
    // relabeled, stops the 3 managed services with live per-row feedback,
    // then actually exits. ExitThreadCore's own processManager.Dispose()
    // still runs afterward as a synchronous safety net; StopAllAsync
    // already leaves it nothing to do for services it stopped cleanly.
    private async Task ShutdownAsync()
    {
        if (isShuttingDown)
        {
            return;
        }
        isShuttingDown = true;

        var overlay = new StartupOverlayForm("Closing Mana", "Shutting down...", ServiceRows);
        overlay.Show();
        try
        {
            await processManager.StopAllAsync((key, stopped) =>
                overlay.SetRowStatus(key, stopped ? "Stopped" : "Force-stopping", stopped ? RowState.Ready : RowState.Warn));
            // Brief pause so the final "all stopped" frame is actually
            // visible before the overlay (and everything else) vanishes --
            // same reasoning as windows-launcher's own post-shutdown grace
            // pause before app.exit(0).
            await Task.Delay(400);
        }
        finally
        {
            overlay.Close();
        }

        ExitThread();
    }

    private async Task RefreshTrayStatusAsync()
    {
        try
        {
            var status = await backendClient.GetPerformanceStatusAsync();
            gamingModeActive = status.GamingAppRunning;
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

    // #526: a fresh dialog per open -- simpler than keeping one instance
    // alive/reused (QuickEntryForm's own pattern), and this isn't opened
    // often enough for that cost to matter.
    private void ShowDoctorPanel()
    {
        using var panel = new DoctorPanelForm(backendClient);
        panel.ShowDialog();
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
        visionHotkeyListener.Dispose();
        trayNotifications.Dispose();
        voiceLoop.Dispose();
        audioPlayer.Dispose();
        sileroVad.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        avatarOverlay.Close();
        // Dispose, not Close -- OnFormClosing overrides UserClosing to
        // Hide-and-cancel for the reuse pattern, so a plain Close() here
        // would risk not actually tearing the window down.
        artifactViewer.Dispose();
        quickEntry.Close();
        // #520: same Dispose-not-Close reasoning as artifactViewer above.
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

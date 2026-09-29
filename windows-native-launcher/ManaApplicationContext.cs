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
    private readonly BrowserAutomationPanel browserAutomationPanel;
    private readonly AgentActivityPanel agentActivityPanel;
    private readonly NotifyIcon trayIcon;
    private readonly ManaProcessManager processManager;
    private readonly ManaBackendClient backendClient;
    private readonly System.Windows.Forms.Timer statusTimer;
    private readonly System.Windows.Forms.Timer idleReportTimer;
    private readonly SileroVadRunner sileroVad;
    private readonly WakeWordClassifier? wakeWordClassifier;
    private readonly AudioPlayer audioPlayer;
    private readonly VoiceLoop voiceLoop;
    private readonly VisionHotkeyListener visionHotkeyListener;
    private readonly ClipHotkeyListener clipHotkeyListener;
    private readonly ClipBuffer clipBuffer = new();
    private readonly System.Windows.Forms.Timer? clipCaptureTimer;
    private readonly GlobalHotkeyListener globalHotkeys;
    private readonly TrayNotificationClient trayNotifications;
    private readonly CaptionOverlayForm captionOverlay;
    private readonly VisionCaptureClient visionCaptureClient;
    private readonly ArtifactViewerForm artifactViewer;
    private readonly QuickEntryForm quickEntry;
    private readonly SessionListForm sessionListForm;

    // #522: updated by RefreshTrayStatusAsync's existing 5s poll --
    // VoiceLoop reads it (via a delegate, not a captured snapshot) to
    // pick the screen-context read interval, same signal the tray icon
    // text already reflects.
    private bool gamingModeActive;

    // #661: approvals/edit proposals waiting on the user (see
    // RefreshWaitingAsync), and whether Dream Mode's idle consolidation has
    // started and the user hasn't come back yet.
    private readonly HashSet<string> announcedWaiting = [];
    private Icon? normalTrayIcon;
    private Icon? waitingTrayIcon;
    private bool dreaming;

    // #574: client-side-only override, matching windows-launcher's own
    // #gamingMode checkbox -- it isn't a 3-way auto/on/off switch, just an
    // enable/disable for the auto-detection RefreshTrayStatusAsync already
    // does. Off forces gamingModeActive false regardless of what the
    // backend's process scan reports; no new backend route needed.
    private bool gamingModeEnabled = true;

    // The 3 services ManaProcessManager actually starts/stops (no Kokoro
    // row since #694 / the user decision: node-bot starts Kokoro on
    // demand) -- shared between the startup and shutdown overlays, same
    // as windows-launcher's single #startupOverlay markup being reused for both (there it also
    // tracks Voice/Web search/Local AI, which don't apply here: this
    // launcher waits on one backend health check for all of node-bot's own
    // internal readiness, not separate per-feature ones).
    internal static readonly (string Key, string Label)[] ServiceRows =
    {
        ("backend", "Backend"),
        ("fish-speech", "Fish Speech TTS"),
        ("embedder", "Memory search"),
    };

    // Guards against "Exit Mana" clicked twice while ShutdownAsync's own
    // overlay/graceful-stop is still running -- without it, a second click
    // would show a second overlay and re-kill already-exiting processes.
    private bool isShuttingDown;

    public ManaApplicationContext()
    {
        var rootDir = FindRootDirectory();
        var settings = ManaSettingsStore.Load();
        processManager = new ManaProcessManager(rootDir, backendBaseUrl: settings.BackendBaseUrl);
        backendClient = new ManaBackendClient(baseUrl: settings.BackendBaseUrl, adminToken: settings.AdminToken);
        avatarOverlay = new AvatarOverlayForm(rootDir);
        // #578: ambient indicator, no tray entry -- starts polling
        // immediately and shows itself only while browser automation is
        // genuinely active.
        browserAutomationPanel = new BrowserAutomationPanel(backendClient);
        // #646: same ambient kind, for the chat tool loop, with a Stop button.
        agentActivityPanel = new AgentActivityPanel(backendClient);

        var vadModelPath = Path.Combine(rootDir, "windows-native-launcher", "assets", "vad", "silero_vad.onnx");
        sileroVad = new SileroVadRunner(vadModelPath);
        wakeWordClassifier = TryLoadWakeWordClassifier(
            rootDir,
            WakeWordClassifier.ResolveThreshold(Environment.GetEnvironmentVariable("MANA_WAKE_PREFILTER"), settings.WakePrefilter));
        // #479 sub-project 4: taps live playback samples for
        // avatarOverlay's lip-sync render loop -- a no-op when no Cubism
        // model is loaded (LipSyncDriver still runs, just nothing reads
        // its output).
        audioPlayer = new AudioPlayer(avatarOverlay.LipSyncDriver.OnSamplesPlayed);
        artifactViewer = new ArtifactViewerForm();
        // #521: constructed before voiceLoop so it can be passed in as
        // VoiceLoop's IChatLog -- SessionListForm only needs the control
        // itself (to embed it), not the other way around.
        // #686: also VoiceLoop's artifact sink, so it can re-render Mana's
        // bubble from the final reply text and give an artifact its button.
        var chatLog = new ChatView { Artifacts = artifactViewer.Add };
        // #522: ScreenContextReader owns its own min-interval/keyword-gate
        // caching internally, so this is just held and passed straight
        // through to VoiceLoop, same as the other optional collaborators
        // constructed above it.
        var screenContextReader = new ScreenContextReader(rootDir, backendClient);
        // #571: on-screen equivalent of spoken output, fed sentence by
        // sentence by VoiceLoop's own playback.
        captionOverlay = new CaptionOverlayForm();
        voiceLoop = new VoiceLoop(sileroVad, backendClient, audioPlayer, avatarOverlay, chatLog, chatLog, screenContextReader, () => gamingModeActive, clipBuffer, wakeWordClassifier, captionOverlay);
        voiceLoop.SetPresetId(settings.ActivePresetId); // #681
        // #523: Ctrl+Alt+M asks Mana to look at the screen, through the
        // same reply/TTS pipeline a normal turn uses.
        visionHotkeyListener = new VisionHotkeyListener(() => _ = voiceLoop.SubmitVisionHotkeyAsync());
        // #585: Ctrl+Alt+Shift+M asks Mana what just happened, using
        // whatever clipCaptureTimer below has already buffered.
        clipHotkeyListener = new ClipHotkeyListener(() => _ = voiceLoop.SubmitClipHotkeyAsync());
        // windows-launcher only runs its own clip-buffer capture timer
        // when screen sensing is opted into (MANA_SCREEN_SENSING_ENABLED=1)
        // -- same gate here, so this launcher doesn't start silently
        // holding rolling screenshots in memory a user never opted into;
        // the hotkey itself stays registered either way (matching the
        // reference), it just always reports an empty buffer if this
        // never ran.
        if (Environment.GetEnvironmentVariable("MANA_SCREEN_SENSING_ENABLED") == "1")
        {
            var intervalEnv = Environment.GetEnvironmentVariable("MANA_CLIP_BUFFER_INTERVAL_MS");
            var intervalMs = int.TryParse(intervalEnv, out var parsedInterval) && parsedInterval > 0 ? parsedInterval : 3000;
            clipCaptureTimer = new System.Windows.Forms.Timer { Interval = intervalMs };
            clipCaptureTimer.Tick += async (_, _) => await CaptureClipFrameAsync();
            clipCaptureTimer.Start();
        }
        sessionListForm = new SessionListForm(backendClient, voiceLoop, chatLog, avatarOverlay, processManager.BackendLog);
        // #525: Ctrl+Alt+Space types a command instead of speaking one,
        // through the exact same turn-processing path.
        quickEntry = new QuickEntryForm(voiceLoop.SubmitTypedCommandAsync);
        // #584: windows-launcher's own defaults are Ctrl+Alt+Space for the
        // window toggle and Ctrl+Alt+I for manual interrupt -- the first
        // collides with quickEntry's own hotkey right above (already
        // shipped, #525), so this uses Ctrl+Alt+W instead; Ctrl+Alt+I has
        // no native collision and is kept as-is. Manual interrupt stops
        // playback and drops any held reply via VoiceLoop.InterruptSpeech
        // -- matches windows-launcher's own "interrupt-speech" handler
        // (stopReplyAudio() + heldReply = null), not the fuller
        // barge-in/re-capture path VoiceLoop's internal interruption
        // handling uses for a detected spoken interruption.
        globalHotkeys = new GlobalHotkeyListener(
            (0xA584, GlobalHotkeyListener.ModControl | GlobalHotkeyListener.ModAlt, (uint)'W', "MANA_WINDOW_HOTKEY", ToggleSessionListVisible),
            (0xA585, GlobalHotkeyListener.ModControl | GlobalHotkeyListener.ModAlt, (uint)'I', "MANA_INTERRUPT_HOTKEY", voiceLoop.InterruptSpeech));
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
        // background-thread-to-UI call sites (e.g. ChatView's
        // RunOnUiThread).
        trayNotifications = new TrayNotificationClient(backendBaseUrl: settings.BackendBaseUrl, openChat: () =>
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
        // #681: answers the model's mid-reply screenshot requests.
        visionCaptureClient = new VisionCaptureClient(backendClient, backendBaseUrl: settings.BackendBaseUrl);

        trayIcon = new NotifyIcon
        {
            // #615: the exe's own embedded icon (assets/mana.ico, set via
            // <ApplicationIcon> in the .csproj) is the real Mana crystal
            // mark -- falls back to the generic Windows icon only if
            // extraction genuinely fails, which ExtractAssociatedIcon's own
            // signature allows for but shouldn't happen for the running exe.
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application,
            Text = "Mana",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu(),
        };

        trayIcon.DoubleClick += (_, _) => ShowStatus();
        trayNotifications.Start();
        visionCaptureClient.Start();

        // Quick rundown: start the existing local services, but keep this host native and small.
        _ = StartServicesAsync();

        statusTimer = new System.Windows.Forms.Timer
        {
            Interval = 5000,
        };
        statusTimer.Tick += async (_, _) =>
        {
            await RefreshTrayStatusAsync();
            await RefreshWaitingAsync();
            if (dreaming && SystemIdle.GetIdleSeconds() < 5)
            {
                // #661: the user's back -- she wakes up.
                dreaming = false;
                avatarOverlay.SetActivity(AvatarState.Dreaming, false);
            }
        };
        statusTimer.Start();

        // #681: tells node-bot how long the user has been idle, so Dream
        // Mode's idle-triggered consolidation runs with native as the only
        // client (windows-launcher main.js: every 60s, best-effort).
        idleReportTimer = new System.Windows.Forms.Timer { Interval = 60000 };
        idleReportTimer.Tick += async (_, _) =>
        {
            try
            {
                if (await backendClient.ReportIdleAsync(SystemIdle.GetIdleSeconds()))
                {
                    // #661: Dream Mode just started consolidating memories.
                    dreaming = true;
                    avatarOverlay.SetActivity(AvatarState.Dreaming, true);
                }
            }
            catch (Exception ex)
            {
                // Backend not up yet or unreachable -- its hourly timer
                // still covers consolidation, so just try again next tick.
                Console.WriteLine($"ManaApplicationContext: idle report failed. {ex.Message}");
            }
        };
        idleReportTimer.Start();
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show status", null, (_, _) => ShowStatus());
        menu.Items.Add("Artifact Viewer", null, (_, _) => { artifactViewer.Show(); artifactViewer.Activate(); });
        menu.Items.Add("Compare Models", null, (_, _) => new CompareModeForm(backendClient).Show());
        menu.Items.Add("Pending Edits", null, (_, _) => new ProposalsForm(backendClient).Show());
        menu.Items.Add("Edit Snapshots", null, (_, _) => new SnapshotsForm(backendClient).Show());
        menu.Items.Add("Memory Graph", null, (_, _) => new MemoryGraphForm(backendClient).Show());
        menu.Items.Add("Deep Research", null, (_, _) => new ResearchForm(backendClient, () => voiceLoop.CurrentSessionId).Show());
        menu.Items.Add("Doctor", null, (_, _) => ShowDoctorPanel());
        menu.Items.Add("VTube Studio", null, (_, _) => new VTubeStudioForm(backendClient).Show());
        menu.Items.Add("Sessions", null, (_, _) => ShowSessionList());
        menu.Items.Add("Open project folder", null, (_, _) => OpenProjectFolder());
        menu.Items.Add("Set avatar idle", null, (_, _) => avatarOverlay.SetState(AvatarState.Idle));
        menu.Items.Add("Set avatar talking", null, (_, _) => avatarOverlay.SetState(AvatarState.Talking));
        menu.Items.Add(new ToolStripSeparator());
        var gamingModeItem = new ToolStripMenuItem("Gaming mode detection") { CheckOnClick = true, Checked = gamingModeEnabled };
        gamingModeItem.Click += (_, _) =>
        {
            gamingModeEnabled = gamingModeItem.Checked;
            if (!gamingModeEnabled)
            {
                gamingModeActive = false;
                trayIcon.Text = "Mana";
            }
        };
        menu.Items.Add(gamingModeItem);
        // #681: Stop listening turns the mic off and puts Mana back to
        // sleep; Start listening needs the wake word again.
        var listeningItem = new ToolStripMenuItem();
        listeningItem.Click += (_, _) => voiceLoop.ToggleListening();
        menu.Opening += (_, _) => listeningItem.Text = voiceLoop.IsListening ? "Stop listening" : "Start listening";
        menu.Items.Add(listeningItem);
        menu.Items.Add(new ToolStripSeparator());
        if (processManager.IsBackendLocal)
        {
            // A remote backend's Fish Speech isn't this launcher's to restart.
            menu.Items.Add("Restart Fish Speech", null, (_, _) => RestartFishSpeech());
        }
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
            // Launched isn't ready: Fish Speech can compile for minutes. Hold
            // the screen (and listening) until her voice actually answers,
            // so the avatar never appears before she can talk.
            if (processManager.IsBackendLocal && processManager.IsFishSpeechAvailable)
            {
                overlay.SetRowStatus("fish-speech", "Warming up...", RowState.Starting);
                var fishReady = await processManager.WaitForFishSpeechReadyAsync(TimeSpan.FromMinutes(6));
                overlay.SetRowStatus("fish-speech", fishReady ? "Ready" : "Not ready yet", fishReady ? RowState.Ready : RowState.Warn);
            }
            await RefreshTrayStatusAsync();
            voiceLoop.Start();
        }
        catch (Exception ex)
        {
            // #614: backend startup failures are fatal by design
            // (ManaProcessManager's own comment) but nothing ever caught
            // them -- StartServicesAsync runs as a discarded task from the
            // constructor, so this exception used to just crash or vanish
            // silently instead of telling the user what actually failed.
            // The thrown messages are already specific and user-facing
            // ("Failed to start Mana backend."), so surfacing ex.Message as-is is
            // enough -- no need to re-derive which service failed here.
            MessageBox.Show(ex.Message, "Mana failed to start", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            overlay.Close();
            // The avatar appears only once the startup screen is done, so
            // she never pops up over it half-started.
            avatarOverlay.Show();
            ReportAvatarModelProblem();
        }
    }

    // #479 follow-up: mirrors windows-launcher's own close-intercept ->
    // runGracefulShutdown() -> app.exit(0) flow. ExitThread() alone would
    // tear the process down invisibly (no window to watch it happen in,
    // just the tray icon vanishing) while backend/Fish Speech/the embedder are
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

    // #585: mirrors windows-launcher's own captureClipFrame -- a cheap
    // local screenshot with no model call, run on the thread pool (same
    // reasoning as SubmitVisionHotkeyAsync's own screen capture: CopyFromScreen
    // is enough work to visibly hitch the UI if done inline on a Timer.Tick).
    // Never skips during processing/reply/idle, unlike a "smarter" gate
    // would -- skipping would create gaps in the buffer at exactly the
    // moments (mid-conversation about something on screen) it would be
    // most useful to have covered.
    private async Task CaptureClipFrameAsync()
    {
        try
        {
            var image = await Task.Run(ScreenCapture.CaptureAsJpegDataUrl);
            clipBuffer.PushFrame(image, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }
        catch (Exception ex)
        {
            Console.WriteLine($"ManaApplicationContext: clip buffer capture failed. {ex.Message}");
        }
    }

    private async Task RefreshTrayStatusAsync()
    {
        try
        {
            var status = await backendClient.GetPerformanceStatusAsync();
            gamingModeActive = gamingModeEnabled && status.GamingAppRunning;
            trayIcon.Text = gamingModeActive ? "Mana - game mode" : "Mana";
        }
        catch
        {
            trayIcon.Text = "Mana - backend starting";
        }
    }

    // #661: anything waiting on the user holds the avatar's Waiting pose and
    // badges the tray icon; a new item also gets a toast when no Mana window
    // has focus. Approving or dismissing clears it on the next 5s poll.
    private async Task RefreshWaitingAsync()
    {
        IReadOnlyList<ManaPendingApproval> approvals;
        try
        {
            approvals = await backendClient.GetPendingApprovalsAsync();
        }
        catch
        {
            return; // backend not up yet -- leave things as they are
        }
        IReadOnlyList<ManaProposalSummary> proposals = [];
        try
        {
            proposals = await backendClient.GetProposalsAsync();
        }
        catch
        {
            // Edit proposals need admin access / the editors integration.
        }

        var items = WaitingForYou.Items(approvals, proposals);
        avatarOverlay.SetActivity(AvatarState.Waiting, items.Count > 0);
        normalTrayIcon ??= trayIcon.Icon;
        trayIcon.Icon = items.Count > 0 ? waitingTrayIcon ??= WaitingForYou.Badged(normalTrayIcon!) : normalTrayIcon;
        var notice = WaitingForYou.NewItemsNotice(items, announcedWaiting);
        if (notice is not null && Form.ActiveForm is null)
        {
            trayIcon.ShowBalloonTip(8000, "Mana is waiting for you", notice, ToolTipIcon.Info);
        }
    }

    // A found-but-unusable Live2D model used to fall back to the static
    // avatar silently. Tray balloons truncate around 255 characters, so the
    // balloon carries the first line and clicking it shows the whole
    // explanation (also available from "Show status").
    private void ReportAvatarModelProblem()
    {
        var problem = avatarOverlay.ModelLoadProblem;
        if (problem is null)
        {
            return;
        }
        var firstLine = problem.Split('\n')[0];
        trayIcon.BalloonTipClicked += (_, _) => ShowAvatarModelProblem();
        trayIcon.ShowBalloonTip(
            10000,
            "Avatar model couldn't load",
            (firstLine.Length > 200 ? firstLine[..200] + "…" : firstLine) + "\nClick for details.",
            ToolTipIcon.Warning);
    }

    private void ShowAvatarModelProblem() =>
        MessageBox.Show(
            avatarOverlay.ModelLoadProblem + "\n\nMana is using the built-in static avatar for now.",
            "Avatar model couldn't load",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);

    private string AvatarStatusLine()
    {
        if (avatarOverlay.ModelLoadProblem is not null)
        {
            return "\n\nAvatar: static fallback -- model couldn't load:\n" + avatarOverlay.ModelLoadProblem;
        }
        if (avatarOverlay.ModelPath is null)
        {
            return "\nAvatar: static (no Live2D model installed)";
        }
        var line = $"\nAvatar: Live2D ({Path.GetFileName(avatarOverlay.ModelPath)})";
        return avatarOverlay.ModelLoadWarnings.Count == 0
            ? line
            : line + "\n" + string.Join("\n", avatarOverlay.ModelLoadWarnings.Select(warning => "  • " + warning));
    }

    private async void ShowStatus()
    {
        try
        {
            var status = await backendClient.GetPerformanceStatusAsync();
            MessageBox.Show(
                $"Backend: running\nGame detected: {status.GamingAppRunning}\nMemory: {status.TotalMemoryMb} MB\nTTS: {status.TtsProvider}{FallbackNoteFor(status.TtsProvider)}{AvatarStatusLine()}",
                "Mana Status",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Mana backend is not ready yet.\n\n{error.Message}{AvatarStatusLine()}",
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

    // #584: SessionListForm is this app's closest equivalent to
    // windows-launcher's single main BrowserWindow -- its own
    // OnFormClosing already turns UserClosing into Hide (not a real
    // Close), so "visible" is a reliable proxy for "shown" here. The show
    // path reuses ShowSessionList (Activate + RefreshAsync), same as
    // every other menu/tray entry point into this window.
    private void ToggleSessionListVisible()
    {
        if (sessionListForm.Visible)
        {
            sessionListForm.Hide();
        }
        else
        {
            ShowSessionList();
        }
    }

    // #479 review: `status.TtsProvider` is node-bot's *configured* value
    // (the TTS_PROVIDER env var this launcher itself sets to "fish") --
    // not whether Fish Speech's native process is actually up. Without
    // this, a missing native setup or a launch failure would still show
    // "TTS: fish" here, giving no indication Fish Speech isn't answering.
    // #694 / user decision: there's no Kokoro fallback to report any more
    // (node-bot only starts Kokoro on demand, e.g. while gaming).
    private string FallbackNoteFor(string? configuredProvider)
    {
        var isFishConfigured = string.Equals(configuredProvider, "fish", StringComparison.OrdinalIgnoreCase);
        // A remote backend uses its own machine's TTS, which this launcher
        // neither starts nor can see -- no local fallback to report.
        return isFishConfigured && processManager.IsBackendLocal && !processManager.IsFishSpeechAvailable ? " (Fish Speech unavailable)" : "";
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
                : "Fish Speech failed to start again -- no Fish Speech voice until it's fixed. See tools/fish-speech/launcher.log for details.",
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
        idleReportTimer.Stop();
        clipCaptureTimer?.Stop();
        visionHotkeyListener.Dispose();
        clipHotkeyListener.Dispose();
        globalHotkeys.Dispose();
        trayNotifications.Dispose();
        visionCaptureClient.Dispose();
        captionOverlay.Close();
        voiceLoop.Dispose();
        audioPlayer.Dispose();
        sileroVad.Dispose();
        wakeWordClassifier?.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        avatarOverlay.Close();
        browserAutomationPanel.Close();
        agentActivityPanel.Close();
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

    // #342: the acoustic wake-word pre-filter is a soft optimization, not
    // a required service -- if any of its three model files are missing
    // (e.g. the build-time fetch of melspectrogram.onnx/embedding_model.onnx
    // failed, or hasn't run yet on a fresh checkout) or fail to load,
    // VoiceLoop just skips the acoustic gate entirely and falls back to
    // today's existing behavior (every segment reaches Whisper, text-match
    // decides). Unlike sileroVad above, this must never take the whole app
    // down over a missing model file.
    private static WakeWordClassifier? TryLoadWakeWordClassifier(string rootDir, float? threshold)
    {
        var wakeWordDir = Path.Combine(rootDir, "windows-native-launcher", "assets", "wakeword");
        var melspecPath = Path.Combine(wakeWordDir, "melspectrogram.onnx");
        var embeddingPath = Path.Combine(wakeWordDir, "embedding_model.onnx");
        var classifierPath = Path.Combine(wakeWordDir, "mana.onnx");

        if (!File.Exists(melspecPath) || !File.Exists(embeddingPath) || !File.Exists(classifierPath))
        {
            Console.WriteLine("WakeWordClassifier: one or more model files missing, acoustic pre-filter disabled.");
            return null;
        }

        try
        {
            return new WakeWordClassifier(melspecPath, embeddingPath, classifierPath, threshold);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"WakeWordClassifier: failed to load, acoustic pre-filter disabled. {ex.Message}");
            return null;
        }
    }

    internal static string FindRootDirectory()
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

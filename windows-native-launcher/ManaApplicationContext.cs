using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.Json;
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
    private readonly SileroVadRunner? sileroVad; // #858: null = RMS fallback
    private readonly WakeWordClassifier? wakeWordClassifier;
    private readonly AudioPlayer audioPlayer;
    private readonly VoiceLoop voiceLoop;
    private readonly ClipBuffer clipBuffer = new();
    private readonly System.Windows.Forms.Timer? clipCaptureTimer;
    private readonly System.Windows.Forms.Timer? glanceTimer; // #690
    private readonly GlobalHotkeyListener globalHotkeys;
    private readonly TrayNotificationClient trayNotifications;
    private readonly ForegroundWindowReporter foregroundReporter;
    private readonly CaptionOverlayForm captionOverlay;
    private readonly ChatBubblesForm chatBubbles; // #701
    private readonly VisionCaptureClient visionCaptureClient;
    private readonly ArtifactViewerForm artifactViewer;
    private readonly QuickEntryForm quickEntry;
    private readonly SessionListForm sessionListForm;
    private readonly ChatView chatLog;
    private readonly SynchronizationContext uiContext;
    // #991: the backend restart in progress, if any; a second request joins it.
    private Task? backendRestart;
    private readonly IDisposable showRequests;
    // #689: Doctor's latest warn/fail ("label: message"), kept in the tray
    // tooltip until the Doctor panel is opened.
    private string? doctorAlert;
    private string trayStatus = "Mana";
    // What clicking the tray balloon on screen does (each balloon sets it).
    private Action? balloonClicked;

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
    // backend's process scan reports; no new backend route needed. #688:
    // saved (ManaSettingsStore.GamingModeDetection), also set from Settings >
    // Performance, so the 5s poll re-reads it.
    private bool gamingModeEnabled = ManaSettingsStore.Load().GamingModeDetection;

    // The services ManaProcessManager actually starts/stops (no Kokoro
    // row since #694 / the user decision: node-bot starts Kokoro on
    // demand) -- shared between the startup and shutdown overlays, same
    // as windows-launcher's single #startupOverlay markup being reused for both (there it also
    // tracks Voice/Local AI, which don't apply here: this
    // launcher waits on one backend health check for all of node-bot's own
    // internal readiness, not separate per-feature ones).
    internal static readonly (string Key, string Label)[] ServiceRows =
    {
        ("backend", "Backend"),
        ("fish-speech", "Fish Speech TTS"),
        ("embedder", "Memory search"),
        ("websearch", "Web search"),
        ("retriever", "Retriever"),
        ("gpt-sovits", "GPT-SoVITS TTS"),
        ("qwen3-tts", "Qwen3-TTS"),
    };

    // #691: the opt-in services only get a row when they're turned on,
    // and only the selected TTS provider gets one.
    internal static (string Key, string Label)[] ServiceRowsFor(ManaProcessManager manager) =>
        ServiceRows.Where(row => row.Key switch
        {
            "fish-speech" => manager.UsesFishSpeech,
            "retriever" => manager.UsesRetriever,
            "gpt-sovits" => manager.UsesGptSovits,
            "qwen3-tts" => manager.UsesQwen3Tts,
            _ => true,
        }).ToArray();

    // Guards against "Exit Mana" clicked twice while ShutdownAsync's own
    // overlay/graceful-stop is still running -- without it, a second click
    // would show a second overlay and re-kill already-exiting processes.
    private bool isShuttingDown;

    // #684: see ManaSettingsStore.AvatarHidesWithChat. servicesStarted: the
    // avatar first appears once startup is done, so nothing shows her earlier.
    private bool avatarHidesWithChat = ManaSettingsStore.Load().AvatarHidesWithChat;
    private bool servicesStarted;

    public ManaApplicationContext()
    {
        var rootDir = FindRootDirectory();
        var settings = ManaSettingsStore.Load();
        processManager = new ManaProcessManager(rootDir, backendBaseUrl: settings.BackendBaseUrl, localOnly: settings.LocalOnly);
        backendClient = new ManaBackendClient(baseUrl: settings.BackendBaseUrl, adminToken: settings.AdminToken, launcherKey: processManager.LauncherKey);
        avatarOverlay = new AvatarOverlayForm(rootDir);
        // #578: ambient indicator, no tray entry -- starts polling
        // immediately and shows itself only while browser automation is
        // genuinely active.
        browserAutomationPanel = new BrowserAutomationPanel(backendClient);
        // #646: same ambient kind, for the chat tool loop, with a Stop button.
        agentActivityPanel = new AgentActivityPanel(backendClient);

        sileroVad = TryLoadSileroVad(rootDir);
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
        chatLog = new ChatView { Artifacts = artifactViewer.Add };
        // #522: ScreenContextReader owns its own min-interval/keyword-gate
        // caching internally, so this is just held and passed straight
        // through to VoiceLoop, same as the other optional collaborators
        // constructed above it.
        // Q37: "next to you" reads beside the avatar while she's showing
        // (a hidden overlay is Visible false; it's never minimized). Called
        // off the UI thread: Visible and Bounds are plain field reads.
        var screenContextReader = new ScreenContextReader(rootDir, backendClient,
            () => avatarOverlay.Visible ? avatarOverlay.Bounds : null);
        // #571: on-screen equivalent of spoken output, fed sentence by
        // sentence by VoiceLoop's own playback.
        // Q8: under Mana while she's showing (Visible/Bounds are plain field reads).
        // #899: above her visible top, not the top of her (framed, bigger) window.
        captionOverlay = new CaptionOverlayForm(() => avatarOverlay.Visible ? avatarOverlay.VisibleBounds : null);
        chatBubbles = new ChatBubblesForm(() => avatarOverlay.Visible ? avatarOverlay.Bounds : null, () => ChatBubblesForm.InView(sessionListForm));
        captionOverlay.Suppressed = chatBubbles.BubblesOn; // #701: bubbles replace the caption bar
        chatBubbles.BubbleClicked += text =>
        {
            ShowSessionList();
            chatLog.SelectMessageContaining(text);
        };
        voiceLoop = new VoiceLoop(sileroVad, backendClient, audioPlayer, avatarOverlay, chatLog, chatLog, screenContextReader, () => gamingModeActive, clipBuffer, wakeWordClassifier, captionOverlay, chatBubbles);
        voiceLoop.SetPresetId(settings.ActivePresetId); // #681
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

            // #690: the ambient glance itself, on Electron's schedule.
            var glance = new ScreenSensingGlance(
                backendClient,
                () => voiceLoop.IsIdle,
                () => gamingModeActive,
                () => SystemIdle.GetIdleMilliseconds() ?? 0,
                screenContextReader.ReadForGlanceAsync,
                ScreenCapture.CaptureAsJpegDataUrl,
                chatLog.AppendManaMessage,
                PositiveIntEnv("MANA_SCREEN_SENSING_PRESENCE_IDLE_MS", 90000));
            glanceTimer = new System.Windows.Forms.Timer { Interval = PositiveIntEnv("MANA_SCREEN_SENSING_INTERVAL_MS", 120000) };
            glanceTimer.Tick += async (_, _) => await glance.RunOnceAsync();
            glanceTimer.Start();
        }
        sessionListForm = new SessionListForm(backendClient, voiceLoop, chatLog, avatarOverlay, processManager.BackendLog);
        // Creating the first form installed WinForms' context on this (UI)
        // thread; RunOnUi posts to it.
        uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        // #525: quick entry types a command instead of speaking one,
        // through the exact same turn-processing path.
        quickEntry = new QuickEntryForm(text => voiceLoop.SubmitTypedCommandAsync(text));
        // #689: every global hotkey, bound from Settings > Hotkeys (defaults
        // in HotkeyBindings). #523 vision and #585 clip go through the normal
        // reply pipeline. #584's manual interrupt stops playback and drops
        // any held reply via VoiceLoop.InterruptSpeech -- windows-launcher's
        // "interrupt-speech" handler, not the fuller barge-in path. #680 text
        // actions run on the selection in any app; "Ask Mana..." hands it to
        // quick entry as a normal turn.
        var hotkeyHandlers = new Dictionary<string, Action>
        {
            ["window"] = ToggleSessionListVisible,
            ["quickEntry"] = quickEntry.ToggleVisible,
            ["vision"] = () => _ = voiceLoop.SubmitVisionHotkeyAsync(),
            ["clip"] = () => _ = voiceLoop.SubmitClipHotkeyAsync(),
            ["camera"] = () => _ = voiceLoop.SubmitVisionHotkeyAsync(CaptureCameraAsync, VisionHotkeyMessages.CameraPrompt),
            ["interrupt"] = voiceLoop.InterruptSpeech,
            ["textAction"] = () => _ = TextActionForm.RunAsync(backendClient, text =>
                quickEntry.OpenWith($"About \"{System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ")}\": ")),
            // #910: a normal typed turn; its wording routes the screen read through JapaneseOcr.
            ["translate"] = () => _ = voiceLoop.SubmitTypedCommandAsync("Translate my screen"),
        };
        globalHotkeys = new GlobalHotkeyListener(HotkeyBindings.Actions
            .Select(a => (a.Id, HotkeyBindings.Resolve(settings.Hotkeys, a), a.DisableEnvVar, hotkeyHandlers[a.Key]))
            .ToArray());
        sessionListForm.BindHotkey = (action, keys) => globalHotkeys.Bind(action.Id, keys);
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
        trayNotifications = new TrayNotificationClient(
            backendBaseUrl: settings.BackendBaseUrl,
            openChat: () => RunOnUi(ShowSessionList),
            onDoctor: payload => RunOnUi(() => ShowDoctorAlert(payload)),
            // #905: a reminder is said out loud too, even mid-game.
            onSpeak: text => _ = voiceLoop.SpeakAnnouncementAsync(text),
            // #914: the new character's Live2D model, loaded in place (and
            // why not, when her own model can't be used).
            onCharacter: payload => RunOnUi(() =>
            {
                avatarOverlay.LoadModel(payload.Model);
                if (payload.Model is not null)
                {
                    ReportAvatarModelProblem();
                }
            }),
            onSelfWork: payload => RunOnUi(() => ShowSelfWorkNotice(chatLog, payload)));
        // #689: a second launcher started -- show this one's window instead.
        showRequests = SingleInstance.ListenForShow(() => RunOnUi(ShowSessionList));
        // #681: answers the model's mid-reply screenshot requests, and
        // #911's desktop actions (media keys, volume, apps, audio output, file moves).
        visionCaptureClient = new VisionCaptureClient(backendClient, backendBaseUrl: settings.BackendBaseUrl, captureCamera: CaptureCameraAsync, desktopAction: (action, args) => DesktopActions.Run(action, args, ManaSettingsStore.Load().DesktopActionFolders));

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

        // #689: left-click toggles the chat window, like Electron's tray.
        trayIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
            {
                ToggleSessionListVisible();
            }
        };
        trayIcon.BalloonTipClicked += (_, _) => balloonClicked?.Invoke();
        sessionListForm.VisibleChanged += (_, _) => SyncAvatarWithChat();
        sessionListForm.Resize += (_, _) => SyncAvatarWithChat(); // minimized or restored
        avatarOverlay.Clicked += voiceLoop.Wake; // #662
        trayNotifications.Start();
        visionCaptureClient.Start();
        // #991: node-bot's own /restart.
        processManager.BackendRestartRequested += () => RunOnUi(() => _ = RestartBackendAsync());

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
        // #697 part 1: node-bot's proactive pipeline learns which app is in front.
        foregroundReporter = new ForegroundWindowReporter(backendClient.ReportForegroundAsync);
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        // #689: Electron's tray entries, plus its two quick buttons.
        menu.Items.Add("Open Mana", null, (_, _) => ShowSessionList());
        menu.Items.Add("Minimize to overlay", null, (_, _) => sessionListForm.Hide());
        menu.Items.Add("Look at my screen now", null, (_, _) => _ = voiceLoop.SubmitVisionHotkeyAsync());
        menu.Items.Add("Open Model Web UI", null, (_, _) => OpenModelWebUi());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Show status", null, (_, _) => ShowStatus());
        menu.Items.Add("Artifact Viewer", null, (_, _) => { artifactViewer.Show(); artifactViewer.Activate(); });
        menu.Items.Add("Compare Models", null, (_, _) => new CompareModeForm(backendClient).Show());
        menu.Items.Add("Pending Edits", null, (_, _) => new ProposalsForm(backendClient).Show());
        menu.Items.Add("Edit Snapshots", null, (_, _) => new SnapshotsForm(backendClient).Show());
        menu.Items.Add("Memory Graph", null, (_, _) => new MemoryGraphForm(backendClient).Show());
        menu.Items.Add("Deep Research", null, (_, _) => new ResearchForm(backendClient, voiceLoop.EnsureSessionId).Show());
        menu.Items.Add("What I'm working on", null, (_, _) => new SelfWorkForm(backendClient).Show()); // #1008
        menu.Items.Add("Doctor", null, (_, _) => ShowDoctorPanel());
        menu.Items.Add("VTube Studio", null, (_, _) => new VTubeStudioForm(backendClient).Show());
        menu.Items.Add("Open project folder", null, (_, _) => OpenProjectFolder());
        menu.Items.Add("Set avatar idle", null, (_, _) => avatarOverlay.SetState(AvatarState.Idle));
        menu.Items.Add("Set avatar talking", null, (_, _) => avatarOverlay.SetState(AvatarState.Talking));
        menu.Items.Add(new ToolStripSeparator());
        var gamingModeItem = new ToolStripMenuItem("Gaming mode detection") { CheckOnClick = true, Checked = gamingModeEnabled };
        menu.Opening += (_, _) => gamingModeItem.Checked = gamingModeEnabled;
        gamingModeItem.Click += (_, _) =>
        {
            gamingModeEnabled = gamingModeItem.Checked;
            var latest = ManaSettingsStore.Load();
            latest.GamingModeDetection = gamingModeEnabled;
            latest.Save();
            if (!gamingModeEnabled)
            {
                gamingModeActive = false;
                SetTrayStatus("Mana");
                avatarOverlay.GameRunning = false;
            }
        };
        menu.Items.Add(gamingModeItem);
        // #662: back to an avatar that ignores the mouse entirely (she
        // already does while a game runs -- Q3).
        var clickThroughItem = new ToolStripMenuItem("Click-through avatar") { CheckOnClick = true, Checked = avatarOverlay.ClickThrough };
        clickThroughItem.Click += (_, _) =>
        {
            avatarOverlay.ClickThrough = clickThroughItem.Checked;
            var latest = ManaSettingsStore.Load();
            latest.AvatarClickThrough = clickThroughItem.Checked;
            latest.Save();
        };
        menu.Items.Add(clickThroughItem);
        var hidesWithChatItem = new ToolStripMenuItem("Hide avatar while chat is open") { CheckOnClick = true, Checked = avatarHidesWithChat };
        hidesWithChatItem.Click += (_, _) =>
        {
            avatarHidesWithChat = hidesWithChatItem.Checked;
            var latest = ManaSettingsStore.Load();
            latest.AvatarHidesWithChat = avatarHidesWithChat;
            latest.Save();
            if (avatarHidesWithChat)
            {
                SyncAvatarWithChat();
            }
            else if (servicesStarted)
            {
                avatarOverlay.Show();
            }
        };
        menu.Items.Add(hidesWithChatItem);
        // #899: the overlay's framing and size, applied live.
        var framingMenu = new ToolStripMenuItem("Framing");
        foreach (var (framing, label) in new[] { ("full", "Full body"), ("upperHalf", "Upper half"), ("bust", "Bust") })
        {
            framingMenu.DropDownItems.Add(new ToolStripMenuItem(label, null, (_, _) => SetOverlayFraming(framing, avatarOverlay.OverlayScale)) { Tag = framing });
        }
        var sizeMenu = new ToolStripMenuItem("Size");
        foreach (var scale in AvatarOverlayForm.OverlayScales)
        {
            sizeMenu.DropDownItems.Add(new ToolStripMenuItem($"{scale * 100:0}%", null, (_, _) => SetOverlayFraming(avatarOverlay.OverlayFraming, scale)) { Tag = scale });
        }
        menu.Opening += (_, _) =>
        {
            foreach (ToolStripMenuItem item in framingMenu.DropDownItems)
            {
                item.Checked = Equals(item.Tag, avatarOverlay.OverlayFraming);
            }
            foreach (ToolStripMenuItem item in sizeMenu.DropDownItems)
            {
                item.Checked = Equals(item.Tag, avatarOverlay.OverlayScale);
            }
        };
        menu.Items.Add(framingMenu);
        menu.Items.Add(sizeMenu);
        // #914: who's talking, listed from node-bot each time it opens (its
        // data/characters.json can change). Picking one switches and she
        // says her handoff line; her model follows via onCharacter.
        var characterMenu = new ToolStripMenuItem("Character");
        characterMenu.DropDownItems.Add(new ToolStripMenuItem("Mana") { Enabled = false }); // shows the arrow
        characterMenu.DropDownOpening += async (_, _) => await FillCharacterMenuAsync(characterMenu);
        menu.Items.Add(characterMenu);
        // #701: off by default.
        var bubblesItem = new ToolStripMenuItem("Chat bubbles beside Mana") { CheckOnClick = true, Checked = chatBubbles.BubblesOn };
        bubblesItem.Click += (_, _) =>
        {
            chatBubbles.BubblesOn = bubblesItem.Checked;
            captionOverlay.Suppressed = bubblesItem.Checked; // #701
            var latest = ManaSettingsStore.Load();
            latest.ChatBubbles = bubblesItem.Checked;
            latest.Save();
        };
        menu.Items.Add(bubblesItem);
        // #681: Stop listening turns the mic off and puts Mana back to
        // sleep; Start listening needs the wake word again.
        var listeningItem = new ToolStripMenuItem();
        listeningItem.Click += (_, _) => voiceLoop.ToggleListening();
        menu.Opening += (_, _) => listeningItem.Text = voiceLoop.IsListening ? "Stop listening" : "Start listening";
        menu.Items.Add(listeningItem);
        menu.Items.Add(new ToolStripSeparator());
        if (processManager.IsBackendLocal)
        {
            menu.Items.Add("Restart backend", null, (_, _) => _ = RestartBackendAsync()); // #991
        }
        if (processManager.IsBackendLocal && processManager.UsesFishSpeech)
        {
            // A remote backend's Fish Speech isn't this launcher's to restart,
            // and another selected TTS provider means Fish isn't in use.
            menu.Items.Add("Restart Fish Speech", null, (_, _) => RestartFishSpeech());
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit Mana", null, (_, _) => _ = ShutdownAsync());
        return menu;
    }

    private async Task StartServicesAsync()
    {
        var overlay = new StartupOverlayForm("Starting Mana", "Starting...", ServiceRowsFor(processManager));
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
            if (processManager.IsBackendLocal && processManager.IsQwen3TtsAvailable)
            {
                overlay.SetRowStatus("qwen3-tts", "Warming up...", RowState.Starting);
                var qwenReady = await processManager.WaitForQwen3TtsReadyAsync(TimeSpan.FromMinutes(2));
                overlay.SetRowStatus("qwen3-tts", qwenReady ? "Ready" : "Not ready yet", qwenReady ? RowState.Ready : RowState.Warn);
            }
            await RefreshTrayStatusAsync();
            await sessionListForm.ReopenLastSessionAsync(); // #687
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
            servicesStarted = true;
            avatarOverlay.Show();
            SyncAvatarWithChat();
            ReportAvatarModelProblem();
        }
    }

    // #479 follow-up: mirrors windows-launcher's own close-intercept ->
    // runGracefulShutdown() -> app.exit(0) flow. ExitThread() alone would
    // tear the process down invisibly (no window to watch it happen in,
    // just the tray icon vanishing) while backend/Fish Speech/the embedder are
    // still being killed -- this shows the same overlay startup used,
    // relabeled, stops the managed services with live per-row feedback,
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

        var overlay = new StartupOverlayForm("Closing Mana", "Shutting down...", ServiceRowsFor(processManager));
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

    private static int PositiveIntEnv(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

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
            // ponytail: re-reads the small settings file each 5s poll rather
            // than wiring a change event from Settings.
            gamingModeEnabled = ManaSettingsStore.Load().GamingModeDetection;
            gamingModeActive = gamingModeEnabled && status.GamingAppRunning;
            SetTrayStatus(gamingModeActive ? "Mana - game mode" : "Mana");
            avatarOverlay.GameRunning = gamingModeActive; // Q3: click-through while gaming
        }
        catch
        {
            SetTrayStatus("Mana - backend starting");
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
        IReadOnlyList<ManaPendingWrite> writes = [];
        try
        {
            writes = await backendClient.GetPendingWritesAsync();
        }
        catch
        {
            // Admin-only, like edit proposals.
        }

        var items = WaitingForYou.Items(approvals, proposals, writes);
        avatarOverlay.SetActivity(AvatarState.Waiting, items.Count > 0);
        normalTrayIcon ??= trayIcon.Icon;
        trayIcon.Icon = items.Count > 0 ? waitingTrayIcon ??= WaitingForYou.Badged(normalTrayIcon!) : normalTrayIcon;
        var notice = WaitingForYou.NewItemsNotice(items, announcedWaiting);
        if (notice is not null && Form.ActiveForm is null)
        {
            balloonClicked = null;
            trayIcon.ShowBalloonTip(8000, "Mana is waiting for you", notice, ToolTipIcon.Info);
        }
    }

    // #1008: her work on her own code starting or ending -- a chat line and
    // a balloon that opens the PR (or the "What I'm working on" window).
    private void ShowSelfWorkNotice(ChatView chat, TrayNotificationPayload payload)
    {
        chat.AppendManaMessage(payload.Text);
        balloonClicked = SelfWorkForm.IsPrUrl(payload.Url) ? () => SelfWorkForm.OpenPr(payload.Url) : () => new SelfWorkForm(backendClient).Show();
        trayIcon.ShowBalloonTip(8000, payload.Title, payload.Text, ToolTipIcon.Info);
    }

    // #912: every camera snapshot (hotkey and vision__camera) comes through
    // here: only while Settings > Voice allows it, with a toast while the
    // camera is on (besides its light) and one saying why it couldn't be.
    private async Task<string> CaptureCameraAsync()
    {
        try
        {
            if (!ManaSettingsStore.Load().CameraSnapshots)
            {
                throw new InvalidOperationException(WebcamCapture.OffMessage);
            }
            ShowCameraBalloon("Mana is looking through your camera", "One snapshot, not saved.", ToolTipIcon.Info);
            return await WebcamCapture.CaptureAsJpegDataUrlAsync();
        }
        catch (Exception ex)
        {
            ShowCameraBalloon("Mana couldn't use the camera", ex.Message, ToolTipIcon.Warning);
            throw;
        }
    }

    private void ShowCameraBalloon(string title, string text, ToolTipIcon icon) => RunOnUi(() =>
    {
        balloonClicked = null;
        trayIcon.ShowBalloonTip(3000, title, text, icon);
    });

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
        balloonClicked = ShowAvatarModelProblem;
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
                $"Backend: running\nGame detected: {status.GamingAppRunning}\nChat model: {status.ChatModel ?? "not loaded"}\nMemory: {status.TotalMemoryMb} MB\nTTS: {status.TtsProvider}{FallbackNoteFor(status.TtsProvider)}\nVoice detector: {voiceLoop.VadInUse}{AvatarStatusLine()}",
                "Mana Status",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Mana backend is not ready yet.\n\n{error.Message}\nVoice detector: {voiceLoop.VadInUse}{AvatarStatusLine()}",
                "Mana Status",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    // #899: a saved (dragged-to) spot follows the resize, so she stays put
    // on the next launch; without one she keeps using the default corner.
    private void SetOverlayFraming(string framing, float scale)
    {
        avatarOverlay.SetFraming(framing, scale);
        var latest = ManaSettingsStore.Load();
        latest.OverlayFraming = avatarOverlay.OverlayFraming;
        latest.OverlayScale = avatarOverlay.OverlayScale;
        if (latest.AvatarLeft is not null && latest.AvatarTop is not null)
        {
            latest.AvatarLeft = avatarOverlay.Left;
            latest.AvatarTop = avatarOverlay.Top;
        }
        latest.Save();
    }

    // #914: the tray's Character submenu, the active one checked.
    private async Task FillCharacterMenuAsync(ToolStripMenuItem characterMenu)
    {
        IEnumerable<ToolStripItem> items;
        try
        {
            var (active, characters) = await backendClient.GetCharactersAsync();
            items = characters.Select(c => new ToolStripMenuItem(c.Name, null, async (_, _) => await SwitchCharacterAsync(c.Id)) { Checked = c.Id == active });
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or InvalidOperationException)
        {
            items = [new ToolStripMenuItem("Mana isn't reachable") { Enabled = false }];
        }
        characterMenu.DropDownItems.Clear();
        characterMenu.DropDownItems.AddRange(items.ToArray());
    }

    private async Task SwitchCharacterAsync(string id)
    {
        try
        {
            if (await backendClient.SetCharacterAsync(id) is string handoff)
            {
                await voiceLoop.SpeakAnnouncementAsync(handoff);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            Console.WriteLine($"Couldn't switch character to {id}. {ex.Message}");
        }
    }

    // #526: a fresh dialog per open -- simpler than keeping one instance
    // alive/reused (QuickEntryForm's own pattern), and this isn't opened
    // often enough for that cost to matter.
    // #684: with AvatarHidesWithChat on, she shows exactly while the chat
    // window is closed or minimized.
    private void SyncAvatarWithChat()
    {
        if (!servicesStarted || !avatarHidesWithChat || avatarOverlay.IsDisposed)
        {
            return;
        }
        var show = AvatarShowsBesideChat(sessionListForm.Visible, sessionListForm.WindowState);
        if (avatarOverlay.Visible != show)
        {
            avatarOverlay.Visible = show;
        }
    }

    internal static bool AvatarShowsBesideChat(bool chatVisible, FormWindowState chatState) =>
        !chatVisible || chatState == FormWindowState.Minimized;

    private void ShowDoctorPanel()
    {
        if (doctorAlert is not null)
        {
            doctorAlert = null; // seen
            SetTrayStatus(trayStatus);
        }
        using var panel = new DoctorPanelForm(backendClient);
        panel.ShowDialog();
    }

    // #689: like Electron's tray: tooltip plus a balloon; clicking it opens Doctor.
    private void ShowDoctorAlert(TrayNotificationPayload payload)
    {
        doctorAlert = $"{payload.Title}: {payload.Text}";
        SetTrayStatus(trayStatus);
        balloonClicked = ShowDoctorPanel;
        trayIcon.ShowBalloonTip(10000, payload.Title, payload.Text, payload.Title.Contains("problem") ? ToolTipIcon.Error : ToolTipIcon.Warning);
    }

    private void SetTrayStatus(string status)
    {
        trayStatus = status;
        trayIcon.Text = TrayTooltip(status, doctorAlert);
    }

    // NotifyIcon.Text throws past 127 characters.
    internal static string TrayTooltip(string status, string? doctorAlert)
    {
        var text = doctorAlert is null ? status : $"{status} - {doctorAlert}";
        return text.Length <= 127 ? text : text[..126] + "…";
    }

    // Electron's "Open Model Web UI" quick button: the local model web UI
    // on port 7860.
    private static void OpenModelWebUi()
    {
        try
        {
            Process.Start(new ProcessStartInfo("http://localhost:7860") { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Console.WriteLine($"ManaApplicationContext: couldn't open the model web UI. {ex.Message}");
        }
    }

    // For callbacks raised off the UI thread (toast activation, the tray
    // socket, a second launcher); dropped once the chat window is gone.
    // Posts to the UI thread's context, not sessionListForm.InvokeRequired:
    // that is false until the window has a handle, so before it was first
    // shown the action ran on the calling (MTA) thread and Show() created
    // the window there -- "DragDrop registration did not succeed".
    private void RunOnUi(Action action)
    {
        if (sessionListForm.IsDisposed)
        {
            return;
        }
        if (SynchronizationContext.Current == uiContext)
        {
            action();
            return;
        }
        uiContext.Post(_ =>
        {
            if (!sessionListForm.IsDisposed)
            {
                action();
            }
        }, null);
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

    // #991: node-bot restarts under a running launcher -- windows, avatar,
    // voice loop, session and LauncherKey all stay. If the new one doesn't
    // come up it says so once and keeps trying every 30 s until it does (or
    // Mana exits); rolling the code back would mean git surgery on the live
    // checkout, so it doesn't. UI thread only.
    private Task RestartBackendAsync() =>
        backendRestart is { IsCompleted: false } ? backendRestart : backendRestart = RunBackendRestartAsync();

    private async Task RunBackendRestartAsync()
    {
        if (!processManager.CanRestartBackend)
        {
            ShowBalloon("Mana's backend wasn't restarted", "It was already running when Mana started, so it isn't mine to restart.", ToolTipIcon.Warning);
            return;
        }
        var done = new TaskCompletionSource();
        voiceLoop.BackendRestart = done.Task;
        var reported = false;
        try
        {
            while (!isShuttingDown)
            {
                SetTrayStatus("Mana - restarting backend");
                bool healthy;
                try
                {
                    healthy = await processManager.RestartBackendAsync(TimeSpan.FromSeconds(90));
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"ManaApplicationContext: backend restart failed. {ex.Message}");
                    healthy = false;
                }
                if (healthy)
                {
                    if (reported)
                    {
                        chatLog.AppendManaMessage("My backend is back.");
                    }
                    await RefreshTrayStatusAsync();
                    return;
                }
                if (!reported)
                {
                    reported = true;
                    ShowBalloon("Mana's backend didn't come back", "I'll keep trying every 30 seconds. The backend log has the details.", ToolTipIcon.Error);
                    chatLog.AppendManaMessage("My backend didn't come back after that restart. I'll keep trying every 30 seconds; the backend log has the details.");
                }
                await Task.Delay(TimeSpan.FromSeconds(30));
            }
        }
        finally
        {
            voiceLoop.BackendRestart = null;
            done.SetResult();
        }
    }

    private void ShowBalloon(string title, string text, ToolTipIcon icon)
    {
        balloonClicked = null;
        trayIcon.ShowBalloonTip(8000, title, text, icon);
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
        foregroundReporter.Dispose();
        clipCaptureTimer?.Stop();
        glanceTimer?.Stop();
        globalHotkeys.Dispose();
        trayNotifications.Dispose();
        showRequests.Dispose();
        visionCaptureClient.Dispose();
        captionOverlay.Close();
        chatBubbles.Close();
        voiceLoop.Dispose();
        audioPlayer.Dispose();
        sileroVad?.Dispose();
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

    // #858: like Electron, MANA_DISABLE_VAD=1 or a missing/broken Silero
    // model means RMS speech detection (VoiceLoop.IsSpeechFrame) instead of
    // no voice loop at all.
    private static SileroVadRunner? TryLoadSileroVad(string rootDir)
    {
        if (Environment.GetEnvironmentVariable("MANA_DISABLE_VAD") == "1")
        {
            return null;
        }
        var modelPath = Path.Combine(rootDir, "windows-native-launcher", "assets", "vad", "silero_vad.onnx");
        try
        {
            // #665: MANA_VAD_THRESHOLD (Electron's name) enters speech,
            // MANA_VAD_EXIT_THRESHOLD leaves it. #858: VoiceLoop re-resolves
            // the enter threshold (env, then Settings > Voice) each time
            // listening starts.
            return new SileroVadRunner(
                modelPath,
                ReadFloatEnv("MANA_VAD_THRESHOLD", SileroVadRunner.DefaultThreshold),
                ReadFloatEnv("MANA_VAD_EXIT_THRESHOLD", SileroVadRunner.DefaultExitThreshold));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Console.WriteLine($"SileroVadRunner: couldn't load {modelPath}, using RMS speech detection. {ex.Message}");
            return null;
        }
    }

    // #342: the acoustic wake-word pre-filter is a soft optimization, not
    // a required service -- if any of its three model files are missing
    // (e.g. the build-time fetch of melspectrogram.onnx/embedding_model.onnx
    // failed, or hasn't run yet on a fresh checkout) or fail to load,
    // VoiceLoop just skips the acoustic gate entirely and falls back to
    // today's existing behavior (every segment reaches Whisper, text-match
    // decides). Like sileroVad above (#858), this must never take the whole app
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

    private static float ReadFloatEnv(string name, float fallback) =>
        float.TryParse(Environment.GetEnvironmentVariable(name), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value) && value is > 0 and < 1
            ? value
            : fallback;

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

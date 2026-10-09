using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher.Dictation;

namespace Mana.NativeLauncher;

internal sealed class ManaApplicationContext : ApplicationContext
{
    private readonly AvatarOverlayForm avatarOverlay;
    // #914 group mode: the partner's overlay beside Mana's (made on first
    // use), and her id while she's alongside (null otherwise).
    private AvatarOverlayForm? partnerOverlay;
    private volatile string? partnerId;
    private readonly string rootDir;
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
    private readonly DictationService dictationService;
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
    private readonly MiniMessageBoxForm miniMessageBox; // #844
    private readonly SessionListForm sessionListForm;
    private readonly ChatView chatLog;
    private readonly SynchronizationContext uiContext;
    // #991: the backend restart in progress, if any; a second request joins it.
    private Task? backendRestart;
    // When node-bot crashed or a restart failed, within BackendCrashWindow.
    private readonly Queue<DateTime> backendCrashes = new();
    private readonly IDisposable showRequests;
    // #995: update-mana.ps1's signals, a launcher build waiting for a quiet
    // moment, the chat window to reopen where it was after an update, and
    // whether the tray's Update now is already running.
    private readonly IDisposable updateRequests;
    private readonly IDisposable updateNowRequests;
    private readonly IDisposable quitRequests;
    private bool swapPending;
    private readonly Rectangle? restoreChat;
    private bool updateRunning;
    // #689: Doctor's latest warn/fail ("label: message"), kept in the tray
    // tooltip until the Doctor panel is opened.
    private string? doctorAlert;
    private string trayStatus = "Mana";
    // Part of #700: her mood in words ("tired, chatty"), from GET /mood --
    // in the tooltip and a greyed line atop the tray menu, never numbers.
    private string? moodSummary;
    private readonly ToolStripMenuItem moodItem = new() { Enabled = false, Visible = false };
    // What clicking the tray balloon on screen does (each balloon sets it).
    private Action? balloonClicked;

    // #522: updated by RefreshTrayStatusAsync's existing 5s poll --
    // VoiceLoop reads it (via a delegate, not a captured snapshot) to
    // pick the screen-context read interval, same signal the tray icon
    // text already reflects.
    private bool gamingModeActive;
    // #697: audio and call awareness
    private readonly IAudioSessionDetector audioDetector = new WindowsAudioSessionDetector();

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
    private bool showAvatar = ManaSettingsStore.Load().ShowAvatar;
    private bool servicesStarted;

    public ManaApplicationContext(Rectangle? restoreChat = null)
    {
        this.restoreChat = restoreChat;
        rootDir = FindRootDirectory();
        var settings = ManaSettingsStore.Load();
        processManager = new ManaProcessManager(rootDir, backendBaseUrl: settings.BackendBaseUrl, localOnly: settings.LocalOnly, noCheckIns: settings.NoCheckIns);
        backendClient = new ManaBackendClient(baseUrl: settings.BackendBaseUrl, adminToken: settings.AdminToken, launcherKey: processManager.LauncherKey);
        avatarOverlay = new AvatarOverlayForm(rootDir);
        // #578: ambient indicator, no tray entry -- starts polling
        // immediately and shows itself only while browser automation is
        // genuinely active.
        browserAutomationPanel = new BrowserAutomationPanel(backendClient, () => sessionListForm?.BrowserToolShowing == true);
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
        // #914: to the partner's avatar while her sentence plays.
        audioPlayer = new AudioPlayer(OnSamplesPlayed);
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
        captionOverlay = new CaptionOverlayForm(() => avatarOverlay.Visible ? avatarOverlay.VisibleBounds : null, () => ChatBubblesForm.InView(sessionListForm));
        chatBubbles = new ChatBubblesForm(() => avatarOverlay.Visible ? avatarOverlay.Bounds : null, () => ChatBubblesForm.InView(sessionListForm));
        captionOverlay.Suppressed = !settings.CaptionsShown();
        chatBubbles.BubbleClicked += text =>
        {
            ShowSessionList();
            chatLog.SelectMessageContaining(text);
        };
        // #845: text-only remarks (ambient screen glance, backend notices, held remarks)
        // show as chat bubbles when bubbles are on.
        chatLog.ManaMessageAppended += text => chatBubbles.ShowTextRemark(text);
        voiceLoop = new VoiceLoop(sileroVad, backendClient, audioPlayer, avatarOverlay, chatLog, chatLog, screenContextReader, () => gamingModeActive, clipBuffer, wakeWordClassifier, captionOverlay, chatBubbles, isAudioBusy: () => settings.HoldSpeechDuringAudio && audioDetector.IsAudioBusy());
        voiceLoop.SetPresetId(settings.ActivePresetId); // #681
        // #849: dictate anywhere
        dictationService = new DictationService(backendClient, () => voiceLoop)
        {
            IsEnabled = settings.DictateAnywhere
        };
        if (settings.DictateHoldThresholdMs is { } thresh && thresh > 0)
        {
            dictationService.StateMachine.ThresholdMs = thresh;
        }
        // #914 group mode: her sister's mouth closes when the reply ends, and
        // her avatar shows and hides with Mana's.
        voiceLoop.TalkingEnded += () => RunOnUi(() => partnerOverlay?.LipSyncDriver.Reset());
        avatarOverlay.VisibleChanged += (_, _) =>
        {
            if (partnerOverlay is not null && partnerId is not null)
            {
                partnerOverlay.Visible = avatarOverlay.Visible;
            }
        };
        avatarOverlay.IsListening = () => voiceLoop.IsListening;
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

            // #690: the ambient glance itself. #1286: on window switches and
            // title changes (settled 2s, at most every
            // MANA_SCREEN_SENSING_MIN_INTERVAL_MS), with the old interval
            // timer as a slow fallback.
            var glance = new ScreenSensingGlance(
                backendClient,
                () => voiceLoop.IsIdle,
                () => gamingModeActive,
                () => SystemIdle.GetIdleMilliseconds() ?? 0,
                screenContextReader.ReadForGlanceAsync,
                ScreenCapture.CaptureAsJpegDataUrl,
                chatLog.AppendManaMessage,
                PositiveIntEnv("MANA_SCREEN_SENSING_PRESENCE_IDLE_MS", 90000),
                ScreenPrivacyGuard.GlanceBlockReason);
            var glanceTrigger = new GlanceTrigger(
                settleMs: 2000,
                minIntervalMs: PositiveIntEnv("MANA_SCREEN_SENSING_MIN_INTERVAL_MS", 30000),
                fallbackMs: PositiveIntEnv("MANA_SCREEN_SENSING_INTERVAL_MS", 600000),
                Environment.TickCount64);
            glanceTimer = new System.Windows.Forms.Timer { Interval = 1000 };
            glanceTimer.Tick += async (_, _) =>
            {
                var (window, title) = ScreenPrivacyGuard.Foreground();
                if (glanceTrigger.Poll(window, title, Environment.TickCount64))
                {
                    await glance.RunOnceAsync();
                }
            };
            glanceTimer.Start();
        }
        sessionListForm = new SessionListForm(backendClient, voiceLoop, chatLog, avatarOverlay, processManager.BackendLog, artifactViewer);
        artifactViewer.CurrentSessionId = () => voiceLoop.CurrentSessionId; // #1120
        // Creating the first form installed WinForms' context on this (UI)
        // thread; RunOnUi posts to it.
        uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        // #525: quick entry types a command instead of speaking one,
        // through the exact same turn-processing path.
        quickEntry = new QuickEntryForm(text => voiceLoop.SubmitTypedCommandAsync(text));
        // #844: a small floating message box under Mana when chat bubbles are on,
        // queued like the chat window's box while she's busy.
        miniMessageBox = new MiniMessageBoxForm(
            text => sessionListForm.SendToManaAsync(text),
            () => avatarOverlay.Visible ? avatarOverlay.VisibleBounds : null);
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
            // Same as the tray's Start/Stop listening. (Hold-to-talk would
            // need key-up, which RegisterHotKey doesn't report.)
            ["listening"] = voiceLoop.ToggleListening,
        };
        globalHotkeys = new GlobalHotkeyListener(HotkeyBindings.Actions
            .Select(a => (a.Id, HotkeyBindings.Resolve(settings.Hotkeys, a), a.DisableEnvVar, hotkeyHandlers[a.Key]))
            .ToArray());
        sessionListForm.BindHotkey = (action, keys) => globalHotkeys.Bind(action.Id, keys);
        sessionListForm.DictateAnywhereChanged = on => dictationService.IsEnabled = on; // #1426: from Settings > Voice
        sessionListForm.AvatarSettingsChanged = () => RunOnUi(ApplyAvatarSettings); // #1426: from Settings > General > Avatar
        sessionListForm.SwitchCharacter = SwitchCharacterAsync; // #1426: from Settings > Memory > Characters
        sessionListForm.RevertMergedPr = PromptRevertPr; // #1426: from Settings > Advanced > Developer
        sessionListForm.RefreshWaiting = RefreshWaitingAsync; // #1426: after an answer in the chat window
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
            onSpeak: payload => _ = voiceLoop.SpeakAnnouncementAsync(payload.Speak!, AnnouncementEmotion.For(payload.Emotion, payload.Kind ?? payload.Type)),
            // #914: the new character's Live2D model, loaded in place (and
            // why not, when her own model can't be used).
            onCharacter: payload => RunOnUi(() =>
            {
                if (payload.Type == "group")
                {
                    ShowPartner(payload.Id, payload.Model);
                    return;
                }
                avatarOverlay.LoadModel(payload.Model);
                if (payload.Model is not null)
                {
                    ReportAvatarModelProblem();
                }
            }),
            onSelfWork: payload => RunOnUi(() => ShowSelfWorkNotice(chatLog, payload)),
            backendClient: backendClient,
            // #1158: where a download I approved went.
            onBrowserDownload: payload => RunOnUi(() => chatLog.AppendManaMessage(payload.Text)),
            // #1337: "Background task completed · <title>" in the chat that started it.
            onBackgroundTaskDone: payload => RunOnUi(() =>
            {
                if (payload.TaskId is { } taskId && payload.SessionId is not null && payload.SessionId == voiceLoop.CurrentSessionId)
                {
                    chatLog.AppendTaskNotice(new ManaTaskNotice(taskId, payload.Title, payload.Status, null));
                }
            }));
        // #689: a second launcher started -- show this one's window instead.
        showRequests = SingleInstance.ListenForShow(() => RunOnUi(ShowSessionList));
        updateRequests = SingleInstance.ListenForUpdate(false, () => RunOnUi(() => ApplyUpdate(now: false)));
        updateNowRequests = SingleInstance.ListenForUpdate(true, () => RunOnUi(() => ApplyUpdate(now: true)));
        quitRequests = SingleInstance.ListenForQuit(() => RunOnUi(() => _ = ShutdownAsync()));
        // #681: answers the model's mid-reply screenshot requests, and
        // #911's desktop actions (media keys, volume, apps, audio output, file moves).
        visionCaptureClient = new VisionCaptureClient(backendClient, backendBaseUrl: settings.BackendBaseUrl, captureCamera: CaptureCameraAsync, saveCameraSnapshot: SaveCameraSnapshotAsync, desktopAction: (action, args) => DesktopActions.Run(action, args, ManaSettingsStore.Load().DesktopActionFolders));

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
        // #662: a click wakes her -- but never turns listening back on after
        // I switched it off (the chat window's mic button still does).
        // #844: with chat bubbles on, opens a small floating message box under
        // her instead, so I can reply without opening the chat window.
        avatarOverlay.Clicked += () =>
        {
            if (chatBubbles.BubblesOn)
            {
                miniMessageBox.Open();
            }
            else if (voiceLoop.IsListening)
            {
                voiceLoop.Wake();
            }
        };
        trayNotifications.Start();
        visionCaptureClient.Start();
        // #991: node-bot's own /restart.
        processManager.BackendRestartRequested += () => RunOnUi(() => _ = RestartBackendAsync());
        processManager.BackendCrashed += exitCode => RunOnUi(() => OnBackendCrashed(exitCode));

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
            if (swapPending && IsQuietMoment(voiceLoop.IsIdle, gamingModeActive, SystemIdle.GetIdleSeconds()))
            {
                SwapLauncher();
            }
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
            await RefreshMoodAsync(); // #700: mood drifts slowly; once a minute is plenty
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

    // #1426: trimmed from 38 entries to 10. Things to do stay; settings (the
    // avatar's, coding mode, dictation, gaming mode) live in Settings, and
    // the tool windows beside the settings they belong with.
    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add(moodItem); // #700
        menu.Items.Add("Open Mana", null, (_, _) => ShowSessionList());
        menu.Items.Add("Settings…", null, (_, _) => sessionListForm.OpenSettings()); // #1426: its own window
        menu.Items.Add("Look at my screen now", null, (_, _) => _ = voiceLoop.SubmitVisionHotkeyAsync());
        // #681: Stop listening turns the mic off and puts Mana back to
        // sleep; Start listening needs the wake word again.
        var listeningItem = new ToolStripMenuItem();
        listeningItem.Click += (_, _) => voiceLoop.ToggleListening();
        menu.Opening += (_, _) => listeningItem.Text = voiceLoop.IsListening ? "Stop listening" : "Start listening";
        menu.Items.Add(listeningItem);
        menu.Items.Add(BuildShowAvatarItem());
        menu.Items.Add("Minimize to overlay", null, (_, _) => sessionListForm.Hide());
        menu.Items.Add(new ToolStripSeparator());
        // #914: who's talking, listed from node-bot each time it opens (its
        // data/characters.json can change). Picking one switches and she
        // says her handoff line; her model follows via onCharacter.
        var characterMenu = new ToolStripMenuItem("Character");
        characterMenu.DropDownItems.Add(new ToolStripMenuItem("Mana") { Enabled = false }); // shows the arrow
        characterMenu.DropDownOpening += async (_, _) => await FillCharacterMenuAsync(characterMenu);
        menu.Items.Add(characterMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(BuildMaintenanceMenu(menu));
        // #1010: only while a PR runs as the live Mana.
        var backToMainItem = new ToolStripMenuItem("Back to main", null, (_, _) => _ = RunLauncherScriptAsync("try-pr.ps1", ["-Main"], "Going back to main", "Mana's switch back to main failed", "try-pr.log"));
        menu.Items.Add(backToMainItem);
        menu.Opening += (_, _) =>
        {
            var running = RunningOffMain(Path.Combine(processManager.RootDirectory, "windows-native-launcher"));
            backToMainItem.Visible = running is not null;
            backToMainItem.Text = $"Back to main (running {running})";
        };
        menu.Items.Add("Exit Mana", null, (_, _) => _ = ShutdownAsync());
        return menu;
    }

    // Hiding her for a moment is something you do, so it stays in the tray.
    private ToolStripMenuItem BuildShowAvatarItem()
    {
        var showAvatarItem = new ToolStripMenuItem("Show avatar") { CheckOnClick = true, Checked = showAvatar };
        showAvatarItem.Click += (_, _) =>
        {
            showAvatar = showAvatarItem.Checked;
            var latest = ManaSettingsStore.Load();
            latest.ShowAvatar = showAvatar;
            latest.Save();
            SyncAvatarWithChat();
        };
        return showAvatarItem;
    }

    // #1426: Settings > General > Avatar saved something; apply it live.
    private void ApplyAvatarSettings()
    {
        var saved = ManaSettingsStore.Load();
        avatarHidesWithChat = saved.AvatarHidesWithChat;
        avatarOverlay.ClickThrough = saved.AvatarClickThrough;
        captionOverlay.Suppressed = !saved.CaptionsShown();
        chatBubbles.BubblesOn = saved.ChatBubbles;
        var framing = saved.OverlayFraming ?? avatarOverlay.OverlayFraming;
        var scale = saved.OverlayScale ?? avatarOverlay.OverlayScale;
        if (framing != avatarOverlay.OverlayFraming || scale != avatarOverlay.OverlayScale)
        {
            SetOverlayFraming(framing, scale);
        }
        SyncAvatarWithChat();
    }

    private ToolStripMenuItem BuildMaintenanceMenu(ContextMenuStrip menu)
    {
        var upkeep = new ToolStripMenuItem("Maintenance");
        upkeep.DropDownItems.Add("Show status", null, (_, _) => ShowStatus());
        upkeep.DropDownItems.Add("Doctor", null, (_, _) => ShowDoctorPanel());
        if (processManager.IsBackendLocal)
        {
            upkeep.DropDownItems.Add(new ToolStripSeparator());
            upkeep.DropDownItems.Add("Restart backend", null, (_, _) =>
            {
                backendCrashes.Clear(); // asked for: try again even after giving up
                _ = RestartBackendAsync(); // #991
            });
        }
        if (processManager.IsBackendLocal && processManager.UsesFishSpeech)
        {
            // A remote backend's Fish Speech isn't this launcher's to restart,
            // and another selected TTS provider means Fish isn't in use --
            // #1076: which, with TTS_PROVIDER unset, is only known once the
            // backend has picked.
            var restartFishItem = new ToolStripMenuItem("Restart Fish Speech", null, (_, _) => RestartFishSpeech());
            menu.Opening += (_, _) => restartFishItem.Visible = processManager.UsesFishSpeech;
            upkeep.DropDownItems.Add(restartFishItem);
        }
        upkeep.DropDownItems.Add(new ToolStripSeparator());
        upkeep.DropDownItems.Add("Update now", null, (_, _) => _ = RunUpdateScriptAsync()); // #995
        upkeep.DropDownItems.Add("Try a PR...", null, (_, _) => PromptTryPr()); // #1010
        return upkeep;
    }

    private async Task StartServicesAsync()
    {
        var overlay = new StartupOverlayForm("Starting Mana", "Starting...", ServiceRowsFor(processManager));
        overlay.Show();
        try
        {
            await processManager.StartAsync((key, available) =>
                overlay.SetRowStatus(key, available ? "Ready" : "Unavailable", available ? RowState.Ready : RowState.Warn));
            if (!processManager.UsesFishSpeech)
            {
                // #1076: the backend picked another voice (Kokoro without a
                // CUDA GPU with room for Fish); a no-op without the row.
                overlay.SetRowStatus("fish-speech", "Not needed", RowState.Ready);
            }
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
            SyncAvatarWithChat();
            ReportAvatarModelProblem();
            ReportUpdateRolledBack();
            if (restoreChat is { } bounds)
            {
                sessionListForm.StartPosition = FormStartPosition.Manual;
                sessionListForm.Bounds = bounds;
                ShowSessionList();
            }
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
        // #1286: the one gap it does allow -- no frame while a private
        // window (ScreenPrivacyGuard) is in front.
        if (ScreenPrivacyGuard.CurrentBlockReason() is not null)
        {
            return;
        }
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
            if (partnerOverlay is not null)
            {
                partnerOverlay.GameRunning = gamingModeActive; // #914: her sister too
            }
            chatBubbles.GameRunning = gamingModeActive;
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

        sessionListForm.ShowWaiting(new WaitingSnapshot(approvals, proposals, writes)); // #1426
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
            var snapshot = await WebcamCapture.CaptureAsync();
            lastCameraSnapshot = snapshot.Jpeg;
            return snapshot.VisionDataUrl;
        }
        catch (Exception ex)
        {
            ShowCameraBalloon("Mana couldn't use the camera", ex.Message, ToolTipIcon.Warning);
            throw;
        }
    }

    // #962: the last snapshot's full-resolution JPEG, in memory only, for
    // "save that".
    private volatile byte[]? lastCameraSnapshot;

    // #962: vision__save_snapshot (write tier, so smart approval asks first)
    // writes it to Settings > Voice's folder or Pictures\Mana.
    private Task<string> SaveCameraSnapshotAsync() => Task.Run(() =>
    {
        var path = WebcamCapture.SaveSnapshot(lastCameraSnapshot, ManaSettingsStore.Load().CameraSnapshotFolder, DateTime.Now);
        ShowCameraBalloon("Saved the camera snapshot", path, ToolTipIcon.Info);
        return path;
    });

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

    // #914 group mode: her sister's avatar stands beside Mana's while she's
    // alongside, wearing her own model; hidden when group mode ends or pauses.
    private void ShowPartner(string? id, string? model)
    {
        partnerId = id;
        if (id is null)
        {
            partnerOverlay?.Hide();
            return;
        }
        partnerOverlay ??= new AvatarOverlayForm(rootDir, partner: true);
        partnerOverlay.LoadModel(model);
        partnerOverlay.Location = AvatarOverlayForm.BesideLocation(avatarOverlay.Bounds, partnerOverlay.Size, Screen.FromControl(avatarOverlay).WorkingArea);
        partnerOverlay.Visible = avatarOverlay.Visible;
    }

    // Playback samples (audio thread) move the mouth of whoever is speaking.
    private void OnSamplesPlayed(ReadOnlySpan<float> samples, int sampleRate)
    {
        var partner = partnerOverlay;
        if (partner is not null && partnerId is { } id && voiceLoop.PlayingCharacter == id)
        {
            partner.LipSyncDriver.OnSamplesPlayed(samples, sampleRate);
            return;
        }
        avatarOverlay.LipSyncDriver.OnSamplesPlayed(samples, sampleRate);
    }

    // #914: the tray's Character submenu, the active one checked.
    private async Task FillCharacterMenuAsync(ToolStripMenuItem characterMenu)
    {
        IEnumerable<ToolStripItem> items;
        try
        {
            var (active, characters, _) = await backendClient.GetCharactersAsync();
            // #1426: group mode moved to Settings > Memory > Group mode.
            items = characters.Select(c => (ToolStripItem)new ToolStripMenuItem(c.Name, null, async (_, _) => await SwitchCharacterAsync(c.Id)) { Checked = c.Id == active });
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
                await voiceLoop.SpeakAnnouncementAsync(handoff, AnnouncementEmotion.For(null, "handoff"));
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
    // window is closed or minimized; the tray's Show avatar off hides her.
    private void SyncAvatarWithChat()
    {
        if (!servicesStarted || avatarOverlay.IsDisposed)
        {
            return;
        }
        var show = AvatarVisible(showAvatar, avatarHidesWithChat, sessionListForm.Visible, sessionListForm.WindowState);
        if (avatarOverlay.Visible != show)
        {
            avatarOverlay.Visible = show;
        }
    }

    internal static bool AvatarVisible(bool showAvatar, bool hidesWithChat, bool chatVisible, FormWindowState chatState) =>
        showAvatar && (!hidesWithChat || AvatarShowsBesideChat(chatVisible, chatState));

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
        trayIcon.Text = TrayTooltip(status, doctorAlert, moodSummary);
    }

    // Part of #700: her mood shows in the tray, and leans her idle face.
    private async Task RefreshMoodAsync()
    {
        try
        {
            var mood = await backendClient.GetMoodAsync();
            moodSummary = mood.Summary;
            moodItem.Text = $"Feeling {mood.Summary}";
            moodItem.Visible = true;
            avatarOverlay.IdleEmotion = mood.Emotion; // the active character's mood
            SetTrayStatus(trayStatus);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            Console.WriteLine($"ManaApplicationContext: couldn't read her mood. {ex.Message}");
        }
    }

    // NotifyIcon.Text throws past 127 characters.
    internal static string TrayTooltip(string status, string? doctorAlert, string? mood = null)
    {
        var text = mood is null ? status : $"{status} - feeling {mood}";
        text = doctorAlert is null ? text : $"{text} - {doctorAlert}";
        return text.Length <= 127 ? text : text[..126] + "…";
    }

    // Electron's "Open Model Web UI" quick button: the local model web UI
    // on port 7860.
    internal static void OpenModelWebUi()
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

    private void ShowArtifactViewer()
    {
        artifactViewer.Show();
        artifactViewer.Activate();
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
    private async void RestartFishSpeech()
    {
        try { await processManager.RestartFishSpeech(); }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Mana Status", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
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
    // Mana exits, or it has failed BackendCrashLimit times inside
    // BackendCrashWindow); rolling the code back would mean git surgery on the live
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
                if (!CountBackendCrash())
                {
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

    internal const int BackendCrashLimit = 3;
    internal static readonly TimeSpan BackendCrashWindow = TimeSpan.FromMinutes(5);

    // node-bot exited without being asked to: start it again, the same way
    // as #991's restart, until it has crashed BackendCrashLimit times inside
    // BackendCrashWindow. A restart in progress sees its own node-bot fail,
    // and one this launcher didn't start isn't its to restart.
    private void OnBackendCrashed(int exitCode)
    {
        Console.WriteLine($"ManaApplicationContext: node-bot exited unexpectedly (code {exitCode}).");
        if (isShuttingDown || backendRestart is { IsCompleted: false } || !processManager.CanRestartBackend)
        {
            return;
        }
        if (CountBackendCrash())
        {
            _ = RestartBackendAsync();
        }
    }

    // False once node-bot has failed too often to keep restarting it, and
    // says so the first time.
    private bool CountBackendCrash()
    {
        if (RecordCrash(backendCrashes, DateTime.UtcNow))
        {
            return true;
        }
        if (backendCrashes.Count == BackendCrashLimit)
        {
            ShowBalloon("Mana's backend keeps crashing", $"It stopped {BackendCrashLimit} times in {BackendCrashWindow.TotalMinutes:0} minutes, so I've stopped restarting it. Restart backend in the tray tries again.", ToolTipIcon.Error);
            chatLog.AppendManaMessage("My backend keeps crashing, so I've stopped restarting it. Restart backend in the tray menu tries again; the backend log has the details.");
        }
        return false;
    }

    // Adds a crash at now and forgets the ones older than the window; false
    // once BackendCrashLimit of them fall inside it.
    internal static bool RecordCrash(Queue<DateTime> crashes, DateTime now)
    {
        while (crashes.Count > 0 && now - crashes.Peek() >= BackendCrashWindow)
        {
            crashes.Dequeue();
        }
        crashes.Enqueue(now);
        return crashes.Count < BackendCrashLimit;
    }

    private void ShowBalloon(string title, string text, ToolTipIcon icon)
    {
        balloonClicked = null;
        trayIcon.ShowBalloonTip(8000, title, text, icon);
    }

    // #995: after a pull, a staged launcher build is swapped in (which
    // restarts the backend with it); with none, only the backend restarts.
    private void ApplyUpdate(bool now)
    {
        backendCrashes.Clear(); // new code may well have fixed the crash
        if (!LauncherUpdate.IsStaged(LauncherUpdate.LiveDir))
        {
            _ = RestartBackendAsync();
            return;
        }
        swapPending = true;
        if (now)
        {
            SwapLauncher();
        }
    }

    // Not while she's talking or thinking, not in a watched game, and only
    // once the keyboard and mouse have been left alone for 2 minutes.
    internal static bool IsQuietMoment(bool voiceIdle, bool gaming, int userIdleSeconds) =>
        voiceIdle && !gaming && userIdleSeconds >= 120;

    // The staged build installs itself once this launcher has exited, and
    // reopens the chat window where it was.
    private void SwapLauncher()
    {
        if (isShuttingDown)
        {
            return;
        }
        swapPending = false;
        var chat = sessionListForm.Visible && sessionListForm.WindowState != FormWindowState.Minimized
            ? LauncherUpdate.ChatBoundsArgs(sessionListForm.WindowState == FormWindowState.Normal ? sessionListForm.Bounds : sessionListForm.RestoreBounds)
            : [];
        try
        {
            LauncherUpdate.StartInstaller(LauncherUpdate.LiveDir, chat);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            ShowBalloon("Mana couldn't update", ex.Message, ToolTipIcon.Warning);
            return;
        }
        _ = ShutdownAsync();
    }

    private void ReportUpdateRolledBack()
    {
        var note = Path.Combine(LauncherUpdate.LiveDir, LauncherUpdate.RolledBackNote);
        if (!File.Exists(note))
        {
            return;
        }
        var reason = File.ReadAllText(note).Trim();
        File.Delete(note);
        if (reason.Length == 0)
        {
            reason = "The new launcher build didn't start";
        }
        Console.WriteLine($"Launcher update rolled back: {reason}");
        ShowBalloon("Mana's update was rolled back", $"{reason}, so I'm back on the previous one.", ToolTipIcon.Warning);
    }

    // #995: the tray's Update now -- pull, build, then apply straight away
    // (update-mana.ps1 -Now). Mana keeps running while it builds.
    private Task RunUpdateScriptAsync() =>
        RunLauncherScriptAsync("update-mana.ps1", ["-Now"], "Updating Mana", "Mana's update failed", "update.log");

    // #1010: what try-pr.ps1 left running instead of main ("PR #1020", or
    // #1011's "the previous build"), from bin/trying-pr; null on main.
    internal static string? RunningOffMain(string launcherDir)
    {
        var marker = Path.Combine(launcherDir, "bin", "trying-pr");
        var running = File.Exists(marker) ? File.ReadAllText(marker).Trim() : "";
        return running.Length > 0 ? running : null;
    }

    // #1011: a merged PR broke something -- node-bot opens its issue and a
    // revert PR, then the running build rolls back to the previous one.
    private async void PromptRevertPr()
    {
        using var dialog = new TextPromptDialog("Revert a merged PR", "Merged PR number to revert:", "");
        if (dialog.ShowDialog() != DialogResult.OK || !int.TryParse(dialog.Value.Trim().TrimStart('#'), out var pr) || pr <= 0)
        {
            return;
        }
        ManaRevertResult result;
        try
        {
            result = await backendClient.RevertPrAsync(pr);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException or JsonException)
        {
            result = new ManaRevertResult { Error = ex.Message };
        }
        if (result.PrUrl is null || result.MergeCommit is null)
        {
            ShowBalloon($"Mana couldn't revert #{pr}", result.Error ?? "No revert PR came back.", ToolTipIcon.Error);
            return;
        }
        chatLog.AppendManaMessage($"I opened {result.PrUrl} to revert #{pr}, and I'm rolling back to the previous build.");
        await RunLauncherScriptAsync("try-pr.ps1", ["-Previous", "-Without", result.MergeCommit], "Rolling back to the previous build", "Mana couldn't roll back", "try-pr.log");
    }

    private void PromptTryPr()
    {
        using var dialog = new TextPromptDialog("Try a PR", "PR number to run as the live Mana:", "");
        if (dialog.ShowDialog() == DialogResult.OK && int.TryParse(dialog.Value.Trim().TrimStart('#'), out var pr) && pr > 0)
        {
            _ = RunLauncherScriptAsync("try-pr.ps1", ["-Pr", pr.ToString()], $"Trying PR #{pr}", "Mana couldn't switch to the PR", "try-pr.log");
        }
    }

    // One of the launcher's scripts (update-mana.ps1, try-pr.ps1), one at a
    // time, with the running build's folder. Mana keeps running while it builds.
    private async Task RunLauncherScriptAsync(string scriptName, string[] args, string startingTitle, string failedTitle, string logName)
    {
        if (updateRunning)
        {
            return;
        }
        updateRunning = true;
        var launcherDir = Path.Combine(processManager.RootDirectory, "windows-native-launcher");
        try
        {
            var startInfo = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true };
            // #1010: a PR branched before try-pr.ps1 existed doesn't have it; its copy in bin\ does.
            var scriptPath = Path.Combine(launcherDir, scriptName);
            if (!File.Exists(scriptPath))
            {
                scriptPath = Path.Combine(launcherDir, "bin", scriptName);
            }
            string[] all = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, .. args, "-LiveDir", LauncherUpdate.LiveDir];
            foreach (var arg in all)
            {
                startInfo.ArgumentList.Add(arg);
            }
            ShowBalloon(startingTitle, "Building it. I'll keep running meanwhile.", ToolTipIcon.Info);
            using var script = Process.Start(startInfo) ?? throw new InvalidOperationException("powershell didn't start");
            await script.WaitForExitAsync();
            if (script.ExitCode != 0)
            {
                ShowBalloon(failedTitle, $"See {Path.Combine(launcherDir, "bin", logName)}.", ToolTipIcon.Error);
            }
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            ShowBalloon(failedTitle, ex.Message, ToolTipIcon.Error);
        }
        finally
        {
            updateRunning = false;
        }
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
        updateRequests.Dispose();
        updateNowRequests.Dispose();
        quitRequests.Dispose();
        visionCaptureClient.Dispose();
        captionOverlay.Close();
        chatBubbles.Close();
        voiceLoop.Dispose();
        dictationService.Dispose();
        audioPlayer.Dispose();
        sileroVad?.Dispose();
        wakeWordClassifier?.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        avatarOverlay.Close();
        partnerOverlay?.Close();
        browserAutomationPanel.Close();
        agentActivityPanel.Close();
        // Dispose, not Close -- OnFormClosing overrides UserClosing to
        // Hide-and-cancel for the reuse pattern, so a plain Close() here
        // would risk not actually tearing the window down.
        artifactViewer.Dispose();
        quickEntry.Close();
        miniMessageBox.Close();
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

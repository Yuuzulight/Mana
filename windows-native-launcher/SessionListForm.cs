using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #520/#521: ports windows-launcher/renderer/session-sidebar.js's list/
// switch/rename/delete/export surface, plus (#521) a chat pane sharing
// this same window. #586 later added the reference's "open memory" modal
// and goal editing, which #520/#521 had explicitly left out of scope.
//
// Layout ported from PR #538's own MainForm scaffold (sidebar | chat |
// a tool rail reaching Settings) rather than the tabbed Chat/Settings
// layout this window used before -- see the comparison review linked
// from this PR's description for why #538's own logic wasn't kept
// alongside its layout. One real, deliberate departure from #538's own
// version: no FormBorderStyle.None titlebar (that gave up the OS's native
// drag/resize/snap and keyboard/screen-reader behavior, and then needed a
// stateful AllowExit escape hatch to work around -- see DarkTheme.ApplyForm).
// The Mana preset's glass title strip (SessionListForm.Caption.cs) keeps the
// native frame and hands all of that back to Windows. Of #538's rail
// (Browser/Terminal/Artifacts/Tasks) Artifacts (#1120's panel) and
// Tasks (#1016's self-work window) exist in this app; the others are left
// off until they're built.
//
// A standalone window for now (windows-launcher's own version lives
// inside its main app window) -- created once and reused (Hide, not
// Close) by ManaApplicationContext, same lazy-create-and-reuse shape as
// QuickEntryForm.
internal sealed partial class SessionListForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly VoiceLoop voiceLoop;
    private readonly BackendLogBuffer backendLog;
    private readonly ListView list = new();
    private readonly Button newChatButton = new();
    private readonly ChatView chatView;
    // #687: filters the list by title as you type; from 3 characters on,
    // also by what was said (contentMatches, from the backend).
    private readonly TextBox searchBox = new();
    private HashSet<string> contentMatches = new();
    private int searchVersion;
    private System.Collections.Generic.IReadOnlyList<ManaSession> sessions = Array.Empty<ManaSession>();
    private readonly AvatarOverlayForm avatarOverlay;
    private readonly LiveAvatarPanel avatarVisual = new();
    private readonly Button avatarZoomButton = new();
    private readonly Label avatarNameLabel = new();
    private readonly Label avatarStatusLabel = new();
    private readonly Label contextMeterLabel = new();
    private readonly Label chatTitleLabel = new();
    private readonly ComboBox chatModelPicker = new() { Dock = DockStyle.Right, Width = 180, DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = "Chat model" };
    private bool loadingChatModels;
    private string? modelsForSession;
    private int modelLoadVersion;
    private readonly Font chatTitleFont = new("Segoe UI Semibold", 10.5f);
    private string? hearingText; // #619: live partial transcript, null when none
    private readonly Font avatarNameFont;
    private readonly Font avatarStatusFont;

    // One shared ToolTip serving every rail button -- SetToolTip(control,
    // caption) is the normal WinForms pattern for exactly this (a per-
    // control caption map on one native tooltip window), not one instance
    // per control.
    private readonly ToolTip railToolTip = new();
    private readonly Panel toolRail = new() { Dock = DockStyle.Right, Width = 44, BackColor = DarkTheme.Panel };
    // #1118: where rail tools open; see RegisterRailTool.
    private readonly ToolPanelHost toolPanel;

    // The chat list's row fonts (the #652 mockup's 13px title, semibold for
    // the open chat, and 12px time) -- built once, not per row painted.
    private readonly Font sessionTitleFont = new("Segoe UI", 9.75f);
    private readonly Font activeSessionFont = new("Segoe UI Semibold", 9.75f);
    private readonly Font sessionTimeFont = new("Segoe UI", 9f);
    private readonly ImageList sessionRowHeight = new();
    private readonly Font messageBoxFont;
    private readonly MessageQueueStrip messageQueue = new();
    private readonly ImageAttachmentStrip attachments = new();
    // ponytail: polls instead of hooking every path back to Idle in VoiceLoop; only runs while something is queued.
    private readonly System.Windows.Forms.Timer messageQueueTimer = new() { Interval = 300 };
    // Q11: flips Send to Stop while she's replying.
    // ponytail: polls VoiceLoop.IsIdle rather than an event on every mode change; 4 cheap reads a second.
    private readonly System.Windows.Forms.Timer sendButtonTimer = new() { Interval = 250 };
    private readonly System.Collections.Generic.HashSet<string> offeredProposalIds = new();

    // Mirrors VoiceLoop.CurrentSessionId -- null until something is
    // switched to or VoiceLoop auto-starts a session (see AutoSession),
    // which the ReplyEnded handler below picks up.
    private string? activeSessionId;

    // #1120: every artifact so far (ManaApplicationContext owns it), for the
    // rail's Artifacts panel, made when it first opens.
    private readonly ArtifactViewerForm artifacts;
    private ArtifactsPanel? artifactsPanel;

    // Under the search box: why the list couldn't load / a chat couldn't be
    // renamed or deleted (with Retry), or "No chats match" for a search.
    private readonly Panel listStatus = new() { Dock = DockStyle.Top, Height = 26, Visible = false, BackColor = Color.Transparent };
    private readonly Label listStatusLabel = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = DarkTheme.Muted, AutoEllipsis = true };
    private readonly Button listRetryButton = new() { Text = "Retry", Dock = DockStyle.Right, Width = 56 };
    private string? listError;
    private Func<Task>? listRetry;
    private int? pendingEditTurnIndex;
    private TextBox? messageInputBox;

    public SessionListForm(ManaBackendClient backendClient, VoiceLoop voiceLoop, ChatView chatLog, AvatarOverlayForm avatarOverlay, BackendLogBuffer backendLog, ArtifactViewerForm artifacts)
    {
        this.backendClient = backendClient;
        this.artifacts = artifacts;
        this.voiceLoop = voiceLoop;
        this.avatarOverlay = avatarOverlay;
        this.backendLog = backendLog;
        chatView = chatLog;
        // #1337: a sub-agent's or finished task's line in the chat.
        chatView.OpenTask = (id, title, running) =>
            new TaskTranscriptForm(backendClient, new ManaBackgroundTask { Id = id, Title = title }, running).Show(this);

        // #1322: Chat branching, message editing, reply regeneration, and version stepping
        chatView.OnEditMessage += (turnIndex, text) =>
        {
            if (messageInputBox != null)
            {
                messageInputBox.Text = text;
                messageInputBox.SelectionStart = messageInputBox.Text.Length;
                messageInputBox.Focus();
            }
            pendingEditTurnIndex = turnIndex;
        };

        chatView.OnRegenerateReply += async (turnIndex) =>
        {
            if (string.IsNullOrEmpty(activeSessionId)) return;
            var detail = await backendClient.GetSessionDetailAsync(activeSessionId, HistoryTurns);
            if (detail?.RecentTurns != null && turnIndex >= 0 && turnIndex < detail.RecentTurns.Count)
            {
                var userPrompt = detail.RecentTurns[turnIndex].User;
                if (!string.IsNullOrWhiteSpace(userPrompt))
                {
                    await backendClient.TruncateSessionTurnsAsync(activeSessionId, turnIndex);
                    await LoadHistoryAsync(activeSessionId);
                    await voiceLoop.SubmitTypedCommandAsync(userPrompt);
                }
            }
        };

        chatView.OnBranchFromMessage += async (turnIndex) =>
        {
            var targetSession = activeSessionId ?? "default";
            var forked = await backendClient.ForkSessionAsync(targetSession, turnIndex + 1);
            if (forked != null)
            {
                await RefreshAsync();
                SwitchTo(forked.SessionId);
            }
        };

        chatView.OnSwitchTurnVersion += async (turnIndex, versionIndex) =>
        {
            if (string.IsNullOrEmpty(activeSessionId)) return;
            var ok = await backendClient.SetTurnVersionAsync(activeSessionId, turnIndex, versionIndex);
            if (ok)
            {
                await LoadHistoryAsync(activeSessionId);
            }
        };
        messageBoxFont = new Font("Segoe UI", 10.5F);

        Text = "Mana";
        Width = 900;
        Height = 600;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        newChatButton.Text = "+ New chat";
        newChatButton.Dock = DockStyle.Top;
        newChatButton.Height = 36;
        newChatButton.TextAlign = ContentAlignment.MiddleLeft; // the #652 mockup's
        newChatButton.Padding = new Padding(6, 0, 0, 0);
        newChatButton.Click += async (_, _) => await StartNewChatAsync();
        // #538's own new-chat button is a solid accent CTA, not the
        // muted flat style DarkTheme.ApplyButton gives every other button
        // in this window -- matched here instead of through that shared
        // helper, which stays as-is for Settings' own buttons. The Mana
        // preset draws it as glass instead.
        newChatButton.FlatStyle = FlatStyle.Flat;
        newChatButton.BackColor = DarkTheme.Accent;
        newChatButton.ForeColor = DarkTheme.OnAccent;
        newChatButton.FlatAppearance.BorderSize = 0;
        GlassSurface.MakeGlassButton(newChatButton);

        searchBox.Dock = DockStyle.Top;
        searchBox.PlaceholderText = "Search chats";
        searchBox.AccessibleName = "Search chats";
        searchBox.BackColor = DarkTheme.IsLight ? Color.White : DarkTheme.Panel2;
        searchBox.ForeColor = DarkTheme.Text;
        searchBox.TextChanged += async (_, _) =>
        {
            ShowSessions();
            await SearchContentAsync();
        };

        list.Dock = DockStyle.Fill;
        list.View = View.Details;
        list.HeaderStyle = ColumnHeaderStyle.None; // sidebar look, not a data grid
        list.FullRowSelect = true;
        list.HideSelection = false;
        list.LabelEdit = true;
        // The #652 mockup's rows: title over a relative time, drawn here. One
        // column as wide as the list (so no sideways scroll bar), the row
        // height set through the usual image-list trick, the full time as
        // each row's tooltip.
        list.Columns.Add("Name", 200);
        list.OwnerDraw = true;
        list.DrawItem += OnDrawSessionItem;
        list.ClientSizeChanged += (_, _) => FitSessionColumn();
        list.ShowItemToolTips = true;
        sessionRowHeight.ImageSize = new Size(1, LogicalToDeviceUnits(SessionRowHeight));
        list.SmallImageList = sessionRowHeight;
        // WinForms convention (select on single click, activate on
        // double) rather than the reference's own single-click-switches
        // -- switching sessions from a stray selection click would be a
        // worse native experience than the sidebar's always-visible list
        // made single-click safe for.
        list.ItemActivate += (_, _) => SwitchToSelected(); // double-click or Enter
        list.AfterLabelEdit += OnAfterLabelEdit;

        var contextMenu = new ContextMenuStrip();
        AddMoveToProjectMenu(contextMenu);
        contextMenu.Items.Add("Switch to session", null, (_, _) => SwitchToSelected());
        contextMenu.Items.Add("Rename", null, (_, _) =>
        {
            if (list.SelectedItems.Count > 0)
            {
                list.SelectedItems[0].BeginEdit();
            }
        });
        contextMenu.Items.Add("Set goal...", null, async (_, _) => await SetGoalForSelectedAsync());
        contextMenu.Items.Add("Delete...", null, async (_, _) => await DeleteSelectedAsync());
        contextMenu.Items.Add("Export...", null, async (_, _) => await ExportSelectedAsync());
        contextMenu.Items.Add("Copy as Markdown", null, async (_, _) => await CopySelectedAsMarkdownAsync());
        contextMenu.Items.Add("Open memory...", null, async (_, _) => await OpenMemoryForSelectedAsync());
        list.ContextMenuStrip = contextMenu;
        DarkTheme.ApplyListView(list);
        // On the sidebar itself, not a boxed panel (the glass look puts it
        // straight on the window's glows).
        list.BackColor = DarkTheme.Background;
        list.BorderStyle = BorderStyle.None;

        // Sidebar avatar card design ported from the app's own reference
        // mock-up (the "Settings floats above the main window" artifact,
        // .sidebar-avatar-card) -- a bordered card holding a gradient
        // "visual" area standing in for the live Live2D render (drawn
        // abstractly on purpose, not real model art -- same reasoning as
        // the reference mock-up's own CSS gradient+silhouette, since the
        // real art is all-rights-reserved and not something to bake into
        // committed source), a zoom button that brings the real
        // always-on-top AvatarOverlayForm to the foreground, a name
        // label, and a live status row.
        avatarVisual.Height = 90;
        avatarVisual.Dock = DockStyle.Top;
        avatarVisual.Margin = new Padding(0, 0, 0, 8);
        avatarVisual.Paint += OnPaintAvatarVisual;

        avatarZoomButton.Text = "⤢";
        avatarZoomButton.AccessibleName = "Avatar framing"; // the tooltip says which
        avatarZoomButton.Size = new Size(20, 20);
        // Sidebar starts at 240px (see sidebar's own Width below) and is
        // now user-resizable via sidebarSplitter -- this is only the
        // initial position, computed directly rather than referencing
        // avatarCard here, which isn't declared yet at this point in the
        // constructor. Anchor (Top|Right) below keeps it glued to
        // avatarCard's right edge on every later resize.
        avatarZoomButton.Location = new Point(220 - 20 - 8, 8);
        avatarZoomButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        avatarZoomButton.FlatStyle = FlatStyle.Flat;
        avatarZoomButton.BackColor = DarkTheme.Panel2;
        avatarZoomButton.ForeColor = DarkTheme.Muted;
        avatarZoomButton.FlatAppearance.BorderColor = DarkTheme.Border;
        avatarZoomButton.FlatAppearance.BorderSize = 1;
        if (avatarOverlay.HasLiveModel)
        {
            // #685: the live avatar replaces the placeholder, drawn from the
            // overlay's own model; the zoom button cycles Electron's
            // full / waist / bust framing, remembered across launches.
            avatarVisual.Height = 200;
            avatarVisual.Framing = ManaSettingsStore.Load().AvatarFraming;
            railToolTip.SetToolTip(avatarZoomButton, LiveAvatarPanel.FramingTitle(avatarVisual.Framing));
            avatarZoomButton.Click += (_, _) => CycleAvatarFraming();
            avatarVisual.VisibleChanged += (_, _) => UpdateAvatarMirror();
            Resize += (_, _) => UpdateAvatarMirror(); // minimize/restore
        }
        else
        {
            railToolTip.SetToolTip(avatarZoomButton, "Bring the avatar overlay to the front");
            avatarZoomButton.AccessibleName = "Bring the avatar overlay to the front";
            avatarZoomButton.Click += (_, _) =>
            {
                avatarOverlay.Show();
                avatarOverlay.Activate();
            };
        }

        // Name and status centred under her, as in the #652 mockup (15px
        // semibold name, 12px status after a round status dot).
        avatarNameLabel.Text = "Mana";
        avatarNameLabel.Dock = DockStyle.Top;
        avatarNameLabel.Height = 24;
        avatarNameLabel.TextAlign = ContentAlignment.MiddleCenter;
        avatarNameLabel.ForeColor = DarkTheme.Text;
        avatarNameFont = new Font("Segoe UI Semibold", 11.25f);
        avatarNameLabel.Font = avatarNameFont;

        avatarStatusLabel.Dock = DockStyle.Top;
        avatarStatusLabel.Height = 18;
        avatarStatusLabel.AutoEllipsis = true; // #619: "Hearing: ..." can be long
        avatarStatusLabel.TextAlign = ContentAlignment.MiddleCenter;
        avatarStatusLabel.Padding = new Padding(StatusDotSpace, 0, 0, 0); // room for the status dot, see OnPaintAvatarStatusDot
        avatarStatusLabel.ForeColor = DarkTheme.Muted;
        avatarStatusFont = new Font(avatarStatusLabel.Font.FontFamily, 9f);
        avatarStatusLabel.Font = avatarStatusFont;
        avatarStatusLabel.Paint += OnPaintAvatarStatusDot;

        // Width matches the sidebar's starting width so avatarZoomButton's
        // right-edge anchor is measured against the width it's placed for
        // (a Panel starts 200 wide, which anchored the button off the card).
        var avatarCard = new Panel { Dock = DockStyle.Bottom, Width = 220, Height = 62 + avatarVisual.Height, BackColor = DarkTheme.Panel, Padding = new Padding(10) };
        avatarCard.Paint += OnPaintAvatarCardBorder;
        // WinForms docks the LAST-added child first (see the main
        // Controls.Add block below), so visual/name/status -- top to
        // bottom, the reference's own markup order -- go in reversed. The
        // zoom button isn't docked; it goes in first so it's frontmost in
        // z-order, over the visual it sits on.
        avatarCard.Controls.Add(avatarZoomButton);
        avatarCard.Controls.Add(avatarStatusLabel);
        avatarCard.Controls.Add(avatarNameLabel);
        avatarCard.Controls.Add(avatarVisual);
        RefreshAvatarCard(avatarOverlay.CurrentState);
        // Unsubscribed in Dispose -- avatarOverlay outlives this form
        // (owned separately by ManaApplicationContext), so a live
        // subscription left dangling past this form's own disposal would
        // fire into disposed controls on every future avatar state change.
        avatarOverlay.StateChanged += OnAvatarStateChanged;

        // 10px around and between everything, as in the #652 mockup.
        var sidebar = new Panel { Dock = DockStyle.Left, Width = 240, BackColor = DarkTheme.Background, Padding = new Padding(10) };
        var searchField = GlassSurface.Field(searchBox, new Padding(10, 8, 10, 0));
        searchField.Dock = DockStyle.Top;
        searchField.Height = 32;
        Panel Gap(DockStyle dock) => new() { Dock = dock, Height = 8, BackColor = Color.Transparent };
        // Reverse dock order again (last added docks first): the avatar
        // card (bottom) and new-chat button (top) stake their strips before
        // the list fills what's left.
        DarkTheme.ApplyButton(listRetryButton);
        listRetryButton.Click += async (_, _) =>
        {
            if (listRetry is { } retry)
            {
                SetListError(null);
                await retry();
            }
        };
        listStatus.Controls.Add(listStatusLabel);
        listStatus.Controls.Add(listRetryButton);
        sidebar.Controls.Add(list);
        sidebar.Controls.Add(listStatus);
        sidebar.Controls.Add(Gap(DockStyle.Top));
        sidebar.Controls.Add(searchField);
        sidebar.Controls.Add(Gap(DockStyle.Top));
        sidebar.Controls.Add(newChatButton);
        sidebar.Controls.Add(BuildProjectControls());
        sidebar.Controls.Add(Gap(DockStyle.Bottom));
        sidebar.Controls.Add(avatarCard);

        // Drag-resizable. MinSize (200) is the floor: below that the
        // avatar card's circle + name + status row start feeling
        // cramped, so this stops the drag there rather than letting it
        // keep shrinking. MinExtra (300) leaves enough width for the
        // rest of the window (tool rail/panel + chat) to stay usable.
        // Splitter has no built-in max, so SplitterMoved clamps the
        // other end (380) after each drag.
        var sidebarSplitter = new Splitter { Dock = DockStyle.Left, Width = 4, BackColor = DarkTheme.Border, MinSize = 200, MinExtra = 300 };
        sidebarSplitter.SplitterMoved += (_, _) =>
        {
            if (sidebar.Width > 380)
            {
                sidebar.Width = 380;
            }
        };

        // Before any RegisterRailTool.
        toolPanel = new ToolPanelHost(railToolTip);

        // #538's rail: Artifacts, Background tasks, Terminal and Browser on top,
        // Settings docked at the bottom.
        // #1426: Settings is its own window again, so its cog opens that
        // rather than a tool in the panel.
        var settingsButton = MakeRailButton("settings", "Settings");
        settingsButton.Dock = DockStyle.Bottom;
        settingsButton.Click += (_, _) => OpenSettings();
        toolRail.Controls.Add(settingsButton);
        // #1127: Mana's docs, opened from Settings (OpenDoc); no rail icon.
        toolPanel.Add("docs", "Docs", null, () => docsPanel = new DocsPanel(ManaApplicationContext.FindRootDirectory()));
        // #1120: the Artifacts panel. A new artifact in the chat selects
        // itself there when it's open, else puts a dot on the icon.
        RegisterRailTool("artifacts", "artifacts", "Artifacts", () =>
        {
            artifactsPanel = new ArtifactsPanel(artifacts, () => voiceLoop.CurrentSessionId);
            _ = ReadArtifactHistoryAsync();
            return artifactsPanel;
        });
        artifacts.Added += OnArtifactAdded;
        // #1125: its Self-work section opens the "What I'm working on" window (#1016).
        RegisterRailTool("background-tasks", "tasks", "Background tasks", () => new BackgroundTasksPanel(backendClient));
        // #1121: the commands Mana runs, and my own shells in the repo folder.
        RegisterRailTool("terminal", "terminal", "Terminal",
            () => new TerminalTool(backendClient, ManaApplicationContext.FindRootDirectory(), text => _ = SendToManaAsync(text)));
        // #1122: her browser automation, docked.
        RegisterRailTool("browser", "browser", "Browser", () => new BrowserTool(backendClient, () => voiceLoop.CurrentSessionId));
        // #1426 stage 3: everything waiting on my OK, just above Settings,
        // with how many on its icon.
        waitingButton = RegisterRailTool("waiting", "waiting", "Waiting for you", () =>
        {
            waitingPanel = new WaitingPanel(AnswerAsync, edit => new ProposalsForm(backendClient, edit.Id).Show(this), () => OpenSettings("permissions"));
            waitingPanel.Show(waiting, voiceLoop.CurrentSessionId);
            return waitingPanel;
        }, badge: () => waiting.Count);
        waitingButton.Dock = DockStyle.Bottom;

        var chatArea = new Panel { Dock = DockStyle.Fill, BackColor = DarkTheme.Background };
        // #1118: clicking back into the chat closes an unpinned tool panel.
        // (The chat takes focus on a click; MouseDown covers a click while
        // it already has it.)
        chatArea.Enter += (_, _) => toolPanel.CloseUnlessPinned();
        chatLog.MouseDown += (_, _) => toolPanel.CloseUnlessPinned();
        // Last added docks first: the message box claims the bottom strip,
        // its queue (#668) sits just above it, then the chat fills the rest.
        chatArea.Controls.Add(chatLog);
        // #1318: polls her tool steps; shows them inline in the chat, or here under it for an older backend.
        chatArea.Controls.Add(new ChatStepsStrip(backendClient, chatLog, () => !voiceLoop.IsIdle));
        chatArea.Controls.Add(messageQueue);
        chatArea.Controls.Add(attachments);
        chatArea.Controls.Add(BuildMessageBox());
        chatLog.ReplyEnded += () => _ = OfferPendingEditsAsync(chatLog);
        chatLog.ReplyEnded += () => _ = RefreshWaiting?.Invoke(); // #1426: this turn's requests as cards now, not on the next poll
        // Q62: VoiceLoop started a session on its own (launch, or 4 h idle);
        // its row exists once this first reply is saved, so list and bold it.
        chatLog.ReplyEnded += () =>
        {
            if (voiceLoop.CurrentSessionId != activeSessionId)
            {
                activeSessionId = voiceLoop.CurrentSessionId;
                _ = RefreshAsync();
            }
        };
        // #619: the live partial transcript takes over the status line while
        // the user is talking. chatLog is a child control, so it can't
        // outlive this subscription.
        chatLog.HearingChanged += text =>
        {
            hearingText = text;
            RefreshAvatarCard(avatarOverlay.CurrentState);
        };

        // Same collapse toggle as Claude's own UI, and the design
        // reference's own #sidebarToggleBtn -- in the chat header (not a
        // child of `sidebar` itself, which is what gets hidden; a button
        // that disappears along with the panel it opens would have no way
        // to bring it back).
        var sidebarToggleButton = MakeRailButton("sidebar", "Toggle sidebar");
        sidebarToggleButton.Dock = DockStyle.Left;
        sidebarToggleButton.Width = 34;
        sidebarToggleButton.Click += (_, _) =>
        {
            sidebar.Visible = !sidebar.Visible;
            sidebarSplitter.Visible = sidebar.Visible; // otherwise the splitter bar is left stranded when the sidebar is hidden
        };

        // #681: same toggle as the tray's Start/Stop listening item. Its
        // label follows VoiceLoop on the status timer, since the tray and the
        // mic button can flip it too.
        var listenButton = new Button { Dock = DockStyle.Right, Width = 120 };
        DarkTheme.ApplyButton(listenButton);
        GlassSurface.MakeGlassButton(listenButton);
        void RefreshListenButton() => listenButton.Text = voiceLoop.IsListening ? "Stop listening" : "Start listening";
        listenButton.Click += (_, _) =>
        {
            voiceLoop.ToggleListening();
            RefreshListenButton();
        };
        sendButtonTimer.Tick += (_, _) => RefreshListenButton();
        RefreshListenButton();

        // #642: the context meter, just left of the listen toggle. Hover for
        // the breakdown; held up to 30s since it's several lines to read.
        contextMeterLabel.Dock = DockStyle.Right;
        contextMeterLabel.AutoSize = true;
        contextMeterLabel.TextAlign = ContentAlignment.MiddleRight;
        contextMeterLabel.Padding = new Padding(8, 0, 8, 0);
        contextMeterLabel.ForeColor = DarkTheme.Muted;
        contextMeterLabel.AccessibleName = "Context window usage";
        railToolTip.AutoPopDelay = 30000;
        chatLog.ReplyEnded += () => _ = RefreshContextMeterAsync();

        // The #652 mockup's 36px chat header: the sidebar toggle and the open
        // chat's title, with the context meter and listen toggle on the right.
        chatTitleLabel.Dock = DockStyle.Fill;
        chatTitleLabel.TextAlign = ContentAlignment.MiddleLeft;
        chatTitleLabel.AutoEllipsis = true;
        chatTitleLabel.Padding = new Padding(10, 0, 0, 0);
        chatTitleLabel.Font = chatTitleFont;
        chatTitleLabel.ForeColor = DarkTheme.Text;
        chatTitleLabel.BackColor = DarkTheme.Background;
        chatTitleLabel.Text = "New chat";
        var chatHeader = new Panel { Dock = DockStyle.Top, Height = 36, BackColor = DarkTheme.Background, Padding = new Padding(12, 4, 12, 4) };
        chatHeader.Paint += (_, e) =>
        {
            using var line = new Pen(DarkTheme.IsGlass ? Color.FromArgb(36, 106, 95, 184) : DarkTheme.Border);
            e.Graphics.DrawLine(line, 0, chatHeader.Height - 1, chatHeader.Width, chatHeader.Height - 1);
        };
        // Last added docks first: toggle left, listen toggle outermost right.
        chatHeader.Controls.Add(chatTitleLabel);
        chatHeader.Controls.Add(chatModelPicker);
        chatModelPicker.BackColor = DarkTheme.Panel2;
        chatModelPicker.ForeColor = DarkTheme.Text;
        chatModelPicker.DropDown += async (_, _) => await RefreshChatModelsAsync();
        chatModelPicker.SelectedIndexChanged += async (_, _) =>
        {
            if (loadingChatModels || chatModelPicker.SelectedItem is not ManaChatModel model) return;
            var sessionId = voiceLoop.EnsureSessionId();
            chatModelPicker.Enabled = false;
            try { await backendClient.SetChatModelAsync(sessionId, model.Id); }
            catch (Exception ex) { if (!IsDisposed) MessageBox.Show(this, ex.Message, "Chat model", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            finally { if (!IsDisposed) { chatModelPicker.Enabled = true; await RefreshChatModelsAsync(); } }
        };
        chatHeader.Controls.Add(contextMeterLabel);
        chatHeader.Controls.Add(listenButton);
        chatHeader.Controls.Add(sidebarToggleButton);
        chatArea.Controls.Add(chatHeader);

        // Dock order matters, and WinForms docks in REVERSE of the Controls
        // collection: the last control added claims its edge first. So the
        // intended docking sequence -- sidebar, its splitter, toolRail
        // (outermost right), toolPanel, its splitter, then chatArea filling
        // what's left -- is added back to front.
        // (Adding them front to back docked chatArea first: it took the
        // whole window and the rest were laid over it, hiding the first
        // lines of chat and clipping both sides.) Each Splitter still sits
        // next to the control it resizes.
        Controls.Add(chatArea);
        Controls.Add(toolPanel.Splitter);
        Controls.Add(toolPanel);
        Controls.Add(toolRail);
        Controls.Add(sidebarSplitter);
        Controls.Add(sidebar);

        // Forces the native window handle to exist now, on this (the UI)
        // thread -- #524's toast "Open Chat" callback can fire on a
        // threadpool thread (ToastNotificationManagerCompat.OnActivated,
        // raised via Windows Shell/COM activation) before this window has
        // ever been shown, and InvokeRequired/BeginInvoke need a handle
        // that was genuinely created on the UI thread to marshal
        // correctly (InvokeRequired returns false, not throws, when no
        // handle exists yet, which would otherwise let that background
        // thread call ShowSessionList() -- and touch this form's controls
        // -- directly). Same pattern as ArtifactViewerForm/QuickEntryForm.
        _ = Handle;

        // The #652 mockup's shimmer and its delays: title strip, Mana's
        // bubbles, the open chat's card, the avatar card, the rail.
        GlassSurface.Shimmer(this, 0, () => new Rectangle(0, 0, ClientSize.Width, CaptionHeight));
        // ponytail: repaints the whole chat during its sweep; limit it to her visible bubbles if that ever shows up in CPU use.
        GlassSurface.Shimmer(chatLog, 1100);
        GlassSurface.Shimmer(list, 2200, () => list.Items.Cast<ListViewItem>().FirstOrDefault(i => (string?)i.Tag == activeSessionId)?.Bounds ?? Rectangle.Empty);
        GlassSurface.Shimmer(avatarCard, 4500);
        GlassSurface.Shimmer(toolRail, 5600);
    }

    // #652 part 5: a typed-message box under the chat, sending through the
    // same VoiceLoop entry point as Quick Entry (which also logs the message
    // in the chat). Enter sends, Shift+Enter adds a line. Like Quick Entry it
    // clears straight away while the turn runs. #668: if Mana is still busy
    // with the previous turn (the submit returns false at once), or earlier
    // messages are already waiting, the text joins the queue above the box
    // instead; the timer sends the queue once she's idle. Esc is a two-stage
    // stop: it clears the queue, or with nothing queued cuts off her reply
    // (same as the interrupt hotkey). Q11: while she's replying the Send
    // button is a Stop button doing the same cut-off; Enter still queues.
    private Panel BuildMessageBox()
    {
        var box = new TextBox
        {
            Multiline = true,
            AcceptsReturn = false,
            Dock = DockStyle.Fill,
            BackColor = DarkTheme.IsLight ? Color.White : DarkTheme.Panel2,
            ForeColor = DarkTheme.Text,
            Font = messageBoxFont,
            PlaceholderText = MessageBoxPlaceholder,
            AccessibleName = "Message Mana",
            AccessibleDescription = MessageBoxHint,
            ScrollBars = ScrollBars.None,
        };
        messageInputBox = box;
        railToolTip.SetToolTip(box, MessageBoxHint);
        var send = new Button
        {
            Text = "Send",
            Size = new Size(34, 34),
            FlatStyle = FlatStyle.Flat,
            BackColor = box.BackColor,
            ForeColor = DarkTheme.OnAccent,
            AccessibleName = "Send message",
            Cursor = Cursors.Hand,
        };
        send.FlatAppearance.BorderSize = 0;
        send.FlatAppearance.MouseOverBackColor = box.BackColor;
        send.FlatAppearance.MouseDownBackColor = box.BackColor;
        send.Paint += (_, e) => DrawSendButton(e.Graphics, send, box.BackColor);
        railToolTip.SetToolTip(send, MessageBoxHint);

        // The #652 mockup's push-to-talk button: counts as saying her name,
        // like clicking her on the overlay (listening comes on if it was off).
        var mic = ToolbarIconButton("Push to talk");
        mic.Paint += (_, e) => { ShrinkToolbarIcon(e.Graphics, mic); DrawMicIcon(e.Graphics, mic.ClientRectangle, mic.ForeColor); };
        mic.Click += (_, _) => voiceLoop.Wake();
        railToolTip.SetToolTip(mic, "Talk to Mana: the next thing you say is for her");

        // #1325: Attach button (paperclip) for documents and images
        var attach = ToolbarIconButton("Attach files");
        attach.Paint += (_, e) => { ShrinkToolbarIcon(e.Graphics, attach); DrawPaperclipIcon(e.Graphics, attach.ClientRectangle, attach.ForeColor); };
        attach.Click += (_, _) =>
        {
            using var dialog = new OpenFileDialog
            {
                Title = "Attach Files",
                Multiselect = true,
                Filter = "Supported Files (*.pdf;*.docx;*.xlsx;*.pptx;*.csv;*.txt;*.md;*.png;*.jpg;*.jpeg;*.webp;*.bmp)|*.pdf;*.docx;*.xlsx;*.pptx;*.csv;*.txt;*.md;*.png;*.jpg;*.jpeg;*.webp;*.bmp|" +
                         "Documents (*.pdf;*.docx;*.xlsx;*.pptx;*.csv;*.txt;*.md)|*.pdf;*.docx;*.xlsx;*.pptx;*.csv;*.txt;*.md|" +
                         "Images (*.png;*.jpg;*.jpeg;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.bmp|" +
                         "All Files (*.*)|*.*",
            };
            if (dialog.ShowDialog(this) == DialogResult.OK && dialog.FileNames is { Length: > 0 } selected)
            {
                AttachFiles(selected);
            }
        };
        railToolTip.SetToolTip(attach, "Attach documents or images (PDF, Word, Excel, PowerPoint, CSV, text, images)");

        // #1426: the thinking level, like Claude's effort control: a chip
        // saying the level, opening a card with a Faster <-> Smarter slider
        // (Off, Low, Medium, High, Max; Medium recommended). Not saved --
        // Medium at each launch, so a forgotten Max doesn't slow every reply.
        // Q12b: while Mana's own deep thinking is on (she turned it on when
        // asked) the chip says High; picking a level below that ends hers.
        var thinkingLevel = ThinkingLevelPicker.Recommended;
        var manaThinkingOn = false;
        var think = ToolbarChip("Thinking level");
        void ShowThinkingChip()
        {
            var shown = manaThinkingOn && ThinkingLevelPicker.IndexOf(thinkingLevel) < ThinkingLevelPicker.IndexOf("high") ? "high" : thinkingLevel;
            think.Text = $"Thinking: {ThinkingLevelPicker.LabelOf(shown)}";
            think.Width = TextRenderer.MeasureText(think.Text, think.Font).Width + 28;
            railToolTip.SetToolTip(think, manaThinkingOn ? "Mana turned deep thinking on; pick a lower level to end it" : "How hard she thinks before answering");
        }
        ShowThinkingChip();
        think.Click += (_, _) =>
        {
            var picker = new ThinkingLevelPicker(thinkingLevel);
            picker.LevelChanged += level =>
            {
                thinkingLevel = level;
                voiceLoop.SetThinkingLevel(level);
                if (ThinkingLevelPicker.IndexOf(level) < ThinkingLevelPicker.IndexOf("high"))
                {
                    manaThinkingOn = false;
                }
                ShowThinkingChip();
            };
            var host = new ToolStripControlHost(picker) { Margin = Padding.Empty, Padding = Padding.Empty, AutoSize = false, Size = picker.Size };
            var card = new ToolStripDropDown { Padding = new Padding(1), BackColor = DarkTheme.Border };
            card.Items.Add(host);
            card.Closed += (_, _) => card.Dispose();
            card.Show(think, new Point(0, -picker.Height - 6));
            picker.Focus();
        };
        voiceLoop.ManaDeepThinkingChanged += on =>
        {
            void Apply()
            {
                manaThinkingOn = on;
                ShowThinkingChip();
            }
            // The form's handle exists from construction (see the ctor), so
            // this also works while the window is hidden.
            if (IsDisposed || !IsHandleCreated)
            {
                return;
            }
            if (InvokeRequired)
            {
                BeginInvoke(Apply);
                return;
            }
            Apply();
        };

        // #1426: Deep research, moved here from the tray. While it's on, a
        // message starts a research job in this chat instead of a reply;
        // its progress shows beside the toggle, the round button stops it,
        // and the report arrives as her message. Not saved, like Think.
        var research = ToolbarToggle("Deep research", "Deep research");
        railToolTip.SetToolTip(research, "Deep research: your next message becomes a research job -- she reads the web and comes back with a cited report");
        var researchStatus = new Label { Dock = DockStyle.Left, AutoSize = true, ForeColor = DarkTheme.Muted, Padding = new Padding(8, 3, 0, 0), BackColor = Color.Transparent, Font = ToolbarFont };
        string? researchJobId = null;
        async Task ResearchAsync(string question)
        {
            chatView.AppendUserMessage(question);
            researchStatus.Text = "Starting research…";
            try
            {
                researchJobId = await backendClient.StartResearchAsync(question, voiceLoop.EnsureSessionId());
                while (true)
                {
                    var job = await backendClient.GetResearchJobAsync(researchJobId);
                    if (IsDisposed)
                    {
                        return;
                    }
                    if (job.Status == "done" && job.Result is not null)
                    {
                        chatView.AppendManaMessage(ResearchFormatter.FormatReply(job.Result));
                        break;
                    }
                    if (job.Status is "cancelled" or "error")
                    {
                        chatView.AppendManaMessage(job.Status == "cancelled" ? "Research stopped." : $"Research failed: {job.Error ?? "something went wrong"}.");
                        break;
                    }
                    researchStatus.Text = string.IsNullOrEmpty(job.ProgressLabel) ? "Researching…" : job.ProgressLabel;
                    await Task.Delay(600);
                }
            }
            catch (Exception ex)
            {
                chatView.AppendManaMessage($"Research failed: {BackendError.Describe(ex)}");
            }
            finally
            {
                researchJobId = null;
                if (!IsDisposed)
                {
                    researchStatus.Text = "";
                }
            }
        }

        async Task SendAsync()
        {
            var text = box.Text;
            if (pendingEditTurnIndex.HasValue)
            {
                var editTurn = pendingEditTurnIndex.Value;
                pendingEditTurnIndex = null;
                if (!string.IsNullOrEmpty(activeSessionId))
                {
                    await backendClient.TruncateSessionTurnsAsync(activeSessionId, editTurn);
                    await LoadHistoryAsync(activeSessionId);
                }
            }
            if (research.Checked && attachments.Count == 0)
            {
                if (text.Trim().Length == 0 || researchJobId is not null)
                {
                    return;
                }
                box.Clear();
                await ResearchAsync(text.Trim());
                return;
            }
            if (attachments.Count > 0)
            {
                // #679 / #1325: a message with attachments doesn't join the queue; while
                // Mana is busy (or messages are queued) it stays in the box
                // for another Send.
                if (messageQueue.Count > 0)
                {
                    return;
                }
                var sending = voiceLoop.SubmitTypedCommandAsync(text, attachments.Images, attachments.Documents);
                if (sending.IsCompleted && !sending.Result)
                {
                    return;
                }
                box.Clear();
                attachments.Clear();
                await sending;
                return;
            }
            if (text.Trim().Length == 0)
            {
                return;
            }
            box.Clear();
            if (messageQueue.Count > 0 || !await voiceLoop.SubmitTypedCommandAsync(text))
            {
                messageQueue.Add(text);
                messageQueueTimer.Start();
            }
        }
        // #679 / #1325: Ctrl+V with an image or document (or copied files) on the
        // clipboard, or files dropped on the box, attach them.
        void AttachFiles(IEnumerable<string> paths)
        {
            foreach (var path in paths.Where(ImageAttachmentStrip.IsSupportedFile))
            {
                if (attachments.Count >= ImageAttachmentStrip.MaxItems)
                {
                    break;
                }
                attachments.AddFile(path);
            }
        }
        static string[] DroppedFiles(IDataObject? data) =>
            data?.GetData(DataFormats.FileDrop) is string[] files ? files.Where(ImageAttachmentStrip.IsSupportedFile).ToArray() : Array.Empty<string>();
        box.AllowDrop = true;
        box.DragEnter += (_, e) => e.Effect = DroppedFiles(e.Data).Length > 0 ? DragDropEffects.Copy : DragDropEffects.None;
        box.DragDrop += (_, e) => AttachFiles(DroppedFiles(e.Data));
        // True if the clipboard held images or files (then the text box's own paste is
        // skipped). Another app holding the clipboard open makes it throw.
        bool PasteAttachments()
        {
            try
            {
                if (Clipboard.ContainsImage())
                {
                    using var image = Clipboard.GetImage();
                    if (image is not null)
                    {
                        attachments.Add(image);
                    }
                    return true;
                }
                var copied = DroppedFiles(Clipboard.GetDataObject());
                AttachFiles(copied);
                return copied.Length > 0;
            }
            catch (System.Runtime.InteropServices.ExternalException ex)
            {
                Console.WriteLine($"SessionListForm: couldn't read the clipboard. {ex.Message}");
                return false;
            }
        }
        box.KeyDown += async (_, e) =>
        {
            if (e.KeyCode == Keys.V && e.Control && !e.Alt && PasteAttachments())
            {
                e.SuppressKeyPress = true;
            }
            else if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true;
                await SendAsync();
            }
            else if (e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                box.SelectedText = Environment.NewLine;
            }
            else if (e.KeyCode == Keys.Escape)
            {
                e.SuppressKeyPress = true;
                if (!messageQueue.ClearAll())
                {
                    voiceLoop.InterruptSpeech();
                }
            }
        };
        send.Click += async (_, _) =>
        {
            if (researchJobId is { } job)
            {
                researchStatus.Text = "Stopping…";
                await backendClient.CancelResearchJobAsync(job);
            }
            else if (IsStopButton(send))
            {
                voiceLoop.InterruptSpeech();
            }
            else
            {
                await SendAsync();
            }
        };
        sendButtonTimer.Tick += (_, _) =>
        {
            ShowSendOrStop(send, replying: !voiceLoop.IsIdle || researchJobId is not null);
            // #687: the status line follows VoiceLoop between avatar state changes.
            var status = StatusLine(avatarOverlay.CurrentState);
            if (avatarStatusLabel.Text != status)
            {
                avatarStatusLabel.Text = status;
                avatarStatusLabel.Invalidate();
                railToolTip.SetToolTip(avatarStatusLabel, status); // an error can be longer than the card
            }
        };
        sendButtonTimer.Start();

        messageQueueTimer.Tick += async (_, _) =>
        {
            if (messageQueue.Count == 0)
            {
                messageQueueTimer.Stop();
                return;
            }
            var next = messageQueue.PeekReady();
            if (next is null || !voiceLoop.IsIdle)
            {
                return;
            }
            // A false comes back at once when a voice turn got in first; the
            // chip stays and the next tick tries again.
            var sending = voiceLoop.SubmitTypedCommandAsync(next);
            if (sending.IsCompleted && !sending.Result)
            {
                return;
            }
            messageQueue.RemoveFirst();
            await sending;
        };

        // #1426: like Claude's composer -- a rounded field holding the text
        // and the round send button, then a row of small controls under it.
        box.BorderStyle = BorderStyle.None;
        var sendHost = new Panel { Dock = DockStyle.Right, Width = 40, BackColor = Color.Transparent };
        sendHost.Controls.Add(send);
        sendHost.Resize += (_, _) => send.Location = new Point(sendHost.Width - send.Width, sendHost.Height - send.Height);
        var field = new Panel { Dock = DockStyle.Fill, Padding = new Padding(16, 12, 8, 8), BackColor = Color.Transparent };
        field.Paint += (_, e) =>
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var shape = RoundedRect(new RectangleF(0.5f, 0.5f, field.Width - 1.5f, field.Height - 1.5f), 14);
            using var fill = new SolidBrush(box.BackColor);
            e.Graphics.FillPath(fill, shape);
            using var edge = new Pen(DarkTheme.IsGlass ? Color.FromArgb(70, 106, 95, 184) : DarkTheme.Border);
            e.Graphics.DrawPath(edge, shape);
        };
        field.Resize += (_, _) => field.Invalidate();
        field.MouseDown += (_, _) => box.Focus();
        field.Controls.Add(box);
        field.Controls.Add(sendHost);
        box.BackColorChanged += (_, _) => field.Invalidate();

        Panel Gap() => new() { Dock = DockStyle.Left, Width = 6, BackColor = Color.Transparent };
        var toolbar = new Panel { Dock = DockStyle.Bottom, Height = 24, Padding = new Padding(4, 4, 4, 0), BackColor = Color.Transparent };
        // Docked last-added first: attach on the left, then mic, Think, Deep research and its progress.
        toolbar.Controls.Add(researchStatus);
        toolbar.Controls.Add(research);
        toolbar.Controls.Add(Gap());
        toolbar.Controls.Add(think);
        toolbar.Controls.Add(Gap());
        toolbar.Controls.Add(mic);
        toolbar.Controls.Add(attach);
        var panel = new Panel { Dock = DockStyle.Bottom, Height = ComposerHeight(1, box.Font.Height), Padding = new Padding(32, 10, 32, 10), BackColor = DarkTheme.Background };
        // Grows with what's typed up to MaxComposerLines, then scrolls.
        // (Changing ScrollBars recreates the box's handle, so only on a change.)
        void FitComposer()
        {
            var lines = box.GetLineFromCharIndex(box.TextLength) + 1;
            panel.Height = ComposerHeight(lines, box.Font.Height);
            var bars = lines > MaxComposerLines ? ScrollBars.Vertical : ScrollBars.None;
            if (box.ScrollBars != bars)
            {
                box.ScrollBars = bars;
            }
        }
        box.TextChanged += (_, _) => FitComposer();
        box.SizeChanged += (_, _) => FitComposer(); // wrapping follows the width
        panel.Controls.Add(field);
        panel.Controls.Add(toolbar);
        return panel;
    }

    // #1426: the round send button -- an up arrow on the accent, or a square
    // while she's replying (Text says which, for the logic and screen readers).
    private static void DrawSendButton(Graphics g, Button button, Color background)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var clear = new SolidBrush(background))
        {
            g.FillRectangle(clear, button.ClientRectangle);
        }
        var circle = new RectangleF(1, 1, button.Width - 3, button.Height - 3);
        using (var fill = new SolidBrush(DarkTheme.Accent))
        {
            g.FillEllipse(fill, circle);
        }
        var cx = circle.X + circle.Width / 2;
        var cy = circle.Y + circle.Height / 2;
        if (IsStopButton(button))
        {
            using var square = new SolidBrush(DarkTheme.OnAccent);
            g.FillRectangle(square, cx - 5, cy - 5, 10, 10);
            return;
        }
        using var pen = new Pen(DarkTheme.OnAccent, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        g.DrawLine(pen, cx, cy + 6, cx, cy - 6);
        g.DrawLines(pen, new[] { new PointF(cx - 5, cy - 1), new PointF(cx, cy - 6), new PointF(cx + 5, cy - 1) });
    }

    // #1426: the row under the field, a size smaller than the message box.
    private static readonly Font ToolbarFont = new("Segoe UI", 7.5f);

    // The mic and paperclip are drawn 18px; the row draws them 16px.
    private static void ShrinkToolbarIcon(Graphics g, Control button)
    {
        var cx = button.Width / 2f;
        var cy = button.Height / 2f;
        g.TranslateTransform(cx, cy);
        g.ScaleTransform(16f / 18, 16f / 18);
        g.TranslateTransform(-cx, -cy);
    }

    // ... small icon buttons, muted until hovered.
    private static Button ToolbarIconButton(string name)
    {
        var button = new Button
        {
            Dock = DockStyle.Left,
            Width = 24,
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Background,
            ForeColor = DarkTheme.Muted,
            AccessibleName = name,
            Cursor = Cursors.Hand,
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = DarkTheme.Panel2;
        return button;
    }

    // ... a chip that opens something: the toggles' pill with a chevron.
    private static CheckBox ToolbarChip(string name)
    {
        // A CheckBox that never checks: Button draws its own frame over this one.
        var chip = new CheckBox
        {
            Appearance = Appearance.Button,
            AutoCheck = false,
            AccessibleRole = AccessibleRole.PushButton,
            Dock = DockStyle.Left,
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Background,
            ForeColor = DarkTheme.Text,
            AccessibleName = name,
            Cursor = Cursors.Hand,
            UseMnemonic = false,
            Font = ToolbarFont,
        };
        chip.FlatAppearance.BorderSize = 0;
        var hovered = false;
        chip.MouseEnter += (_, _) => { hovered = true; chip.Invalidate(); };
        chip.MouseLeave += (_, _) => { hovered = false; chip.Invalidate(); };
        chip.Paint += (_, e) =>
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            if (DarkTheme.IsGlass)
            {
                GlassSurface.PaintGlowBehind(g, chip, chip.ClientRectangle);
            }
            else
            {
                using var clear = new SolidBrush(DarkTheme.Background);
                g.FillRectangle(clear, chip.ClientRectangle);
            }
            var pill = new RectangleF(0.5f, 2.5f, chip.Width - 1.5f, chip.Height - 5.5f);
            using var shape = RoundedRect(pill, pill.Height / 2);
            if (hovered)
            {
                using var fill = new SolidBrush(DarkTheme.Panel2);
                g.FillPath(fill, shape);
            }
            using var edge = new Pen(DarkTheme.Border);
            g.DrawPath(edge, shape);
            var text = Rectangle.Round(pill) with { Width = (int)pill.Width - 14 };
            TextRenderer.DrawText(g, chip.Text, chip.Font, text, DarkTheme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
            using var pen = new Pen(DarkTheme.Muted, 1.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            var cx = pill.Right - 14;
            var cy = pill.Top + pill.Height / 2;
            g.DrawLines(pen, new[] { new PointF(cx - 3, cy + 1.5f), new PointF(cx, cy - 1.5f), new PointF(cx + 3, cy + 1.5f) });
            if (chip.Focused && GlassSurface.ShowsFocusCues(chip))
            {
                ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(Rectangle.Round(pill), -3, -3));
            }
        };
        return chip;
    }

    // ... and its toggles: an outlined pill sized to its words, filled with
    // the accent while on.
    private static CheckBox ToolbarToggle(string text, string name)
    {
        var toggle = new CheckBox
        {
            Appearance = Appearance.Button,
            Text = text,
            Dock = DockStyle.Left,
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Background,
            ForeColor = DarkTheme.Muted,
            AccessibleName = name,
            Cursor = Cursors.Hand,
            Font = ToolbarFont,
        };
        toggle.FlatAppearance.BorderSize = 0;
        toggle.Width = TextRenderer.MeasureText(text, toggle.Font).Width + 16;
        var hovered = false;
        toggle.MouseEnter += (_, _) => { hovered = true; toggle.Invalidate(); };
        toggle.MouseLeave += (_, _) => { hovered = false; toggle.Invalidate(); };
        toggle.CheckedChanged += (_, _) => toggle.Invalidate();
        toggle.Paint += (_, e) =>
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            if (DarkTheme.IsGlass)
            {
                GlassSurface.PaintGlowBehind(g, toggle, toggle.ClientRectangle);
            }
            else
            {
                using var clear = new SolidBrush(DarkTheme.Background);
                g.FillRectangle(clear, toggle.ClientRectangle);
            }
            var pill = new RectangleF(0.5f, 2.5f, toggle.Width - 1.5f, toggle.Height - 5.5f);
            using var shape = RoundedRect(pill, pill.Height / 2);
            if (toggle.Checked || hovered)
            {
                using var fill = new SolidBrush(toggle.Checked ? DarkTheme.Accent : DarkTheme.Panel2);
                g.FillPath(fill, shape);
            }
            using var edge = new Pen(toggle.Checked ? DarkTheme.Accent : DarkTheme.Border);
            g.DrawPath(edge, shape);
            TextRenderer.DrawText(g, toggle.Text, toggle.Font, Rectangle.Round(pill), toggle.Checked ? DarkTheme.OnAccent : DarkTheme.Text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
            if (toggle.Focused && GlassSurface.ShowsFocusCues(toggle))
            {
                ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(Rectangle.Round(pill), -3, -3));
            }
        };
        return toggle;
    }

    private const int MaxComposerLines = 8;

    // #1426: 100px for one line (the field, the row under it and the
    // margins), a line taller per wrapped or typed line up to MaxComposerLines.
    internal static int ComposerHeight(int lines, int lineHeight) =>
        100 + ((Math.Clamp(lines, 1, MaxComposerLines) - 1) * lineHeight);


    // #652 part 6: when a reply finishes, any edits Mana proposed during
    // that turn get Approve / Review buttons on her message. "During that
    // turn" = still pending and created since the turn's user message (a
    // few seconds' slack for clock skew); each edit is offered only once.
    private async Task OfferPendingEditsAsync(ChatView chat)
    {
        var turnStart = chat.LastUserMessageAt;
        System.Collections.Generic.IReadOnlyList<ManaProposalSummary> proposals;
        try
        {
            proposals = await backendClient.GetProposalsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: couldn't check for pending edits. {ex.Message}");
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        var fresh = proposals.Where(p => p.Status == "pending" && !offeredProposalIds.Contains(p.Id) && CreatedSince(p, turnStart)).ToList();
        if (fresh.Count == 0)
        {
            return;
        }
        foreach (var proposal in fresh)
        {
            offeredProposalIds.Add(proposal.Id);
        }
        chat.AttachActions(new[]
        {
            new ChatView.ChatAction(fresh.Count == 1 ? "Approve" : $"Approve all ({fresh.Count})", true, () => ApproveAllAsync(fresh)),
            new ChatView.ChatAction(fresh.Count == 1 ? "Review" : "Review edits", false, () =>
            {
                new ProposalsForm(backendClient, fresh[0].Id).Show(this);
                return Task.FromResult<string?>(null);
            }),
        });
    }

    internal static bool CreatedSince(ManaProposalSummary proposal, DateTime? turnStartUtc) =>
        turnStartUtc is null
        || !DateTimeOffset.TryParse(proposal.CreatedAt, out var created)
        || created.UtcDateTime >= turnStartUtc.Value.AddSeconds(-5);

    // Approves every hunk of each edit; the returned note replaces the buttons.
    private async Task<string?> ApproveAllAsync(System.Collections.Generic.IReadOnlyList<ManaProposalSummary> proposals)
    {
        var approved = 0;
        string? problem = null;
        foreach (var proposal in proposals)
        {
            var detail = await backendClient.GetProposalDetailAsync(proposal.Id);
            if (detail is null || detail.Status != "pending")
            {
                problem ??= $"{proposal.RelativePath} was already handled.";
                continue;
            }
            // Q16: never batch-approve an edit Mana's review refuted.
            if (detail.RefutedCase is not null)
            {
                problem ??= $"{proposal.RelativePath}: Mana's review found a way it breaks, so it needs approving on its own (Review).";
                continue;
            }
            var result = await backendClient.ApproveProposalAsync(proposal.Id, detail.Hunks.Select(h => h.Id).ToList());
            if (result.Approved)
            {
                approved++;
            }
            else
            {
                problem ??= result.Error ?? "The backend refused the edit.";
            }
        }
        if (problem is null)
        {
            return approved == 1 ? $"Approved -- {proposals[0].RelativePath} updated." : $"Approved all {approved} edits.";
        }
        return approved == 0 ? $"Not approved: {problem}" : $"Approved {approved} of {proposals.Count}. {problem}";
    }

    // Q11: Send and Stop share one button; the label is the state, so a
    // click always does what the button said.
    internal static void ShowSendOrStop(Button button, bool replying)
    {
        var text = replying ? "Stop" : "Send";
        if (button.Text != text)
        {
            button.Text = text;
            button.AccessibleName = replying ? "Stop Mana's reply" : "Send message";
        }
    }

    internal static bool IsStopButton(Button button) => button.Text == "Stop";

    private const string MessageBoxPlaceholder = "Message Mana…";
    private const string MessageBoxHint = "Enter to send, Shift+Enter for a new line";

    // The mockup's mic: a capsule over a cradle and stand, 18px in 1.6px strokes.
    private static void DrawMicIcon(Graphics g, Rectangle bounds, Color color)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var x = bounds.Left + (bounds.Width - 18) / 2f;
        var y = bounds.Top + (bounds.Height - 18) / 2f;
        using var pen = new Pen(color, 1.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        using (var capsule = RoundedRect(new RectangleF(x + 6.5f, y + 1.5f, 5, 9), 2.5f))
        {
            g.DrawPath(pen, capsule);
        }
        g.DrawArc(pen, x + 3.5f, y + 3, 11, 11, 0, 180);
        g.DrawLine(pen, x + 9, y + 14, x + 9, y + 16.5f);
    }

    // #1325: Paperclip icon for attaching documents and images, centered in bounds.
    private static void DrawPaperclipIcon(Graphics g, Rectangle bounds, Color color)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var state = g.Save();
        var cx = bounds.Left + bounds.Width / 2f;
        var cy = bounds.Top + bounds.Height / 2f;
        g.TranslateTransform(cx, cy);
        g.RotateTransform(-45);
        using var pen = new Pen(color, 1.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        using var path = new GraphicsPath();
        path.AddLine(1f, -4f, 1f, 3.5f);
        path.AddArc(-2.5f, 1f, 3.5f, 5f, 0, 180);
        path.AddLine(-2.5f, 3.5f, -2.5f, -5.5f);
        path.AddArc(-2.5f, -8f, 6.5f, 5f, 180, 180);
        path.AddLine(4f, -5.5f, 4f, 5.5f);
        path.AddArc(-4.5f, 2.5f, 8.5f, 6f, 0, 180);
        path.AddLine(-4.5f, 5.5f, -4.5f, -3f);
        g.DrawPath(pen, path);
        g.Restore(state);
    }

    // #1121: My shell's "Send to Mana" and #844: mini message box under Mana --
    // a chat message from me, queued like a typed one while she's busy.
    internal async Task SendToManaAsync(string text)
    {
        if (messageQueue.Count > 0 || !await voiceLoop.SubmitTypedCommandAsync(text))
        {
            messageQueue.Add(text);
            messageQueueTimer.Start();
        }
    }

    // #1122: the floating browser window stays away while this is on screen.
    internal bool BrowserToolShowing => Visible && WindowState != FormWindowState.Minimized && toolPanel.IsOpen("browser");

    // #1426 stage 3: what's waiting on my OK (ManaApplicationContext's 5s
    // poll, and RefreshWaiting after each answer), shown in Waiting for you,
    // on its icon, and as cards in the chat it was asked from.
    private WaitingSnapshot waiting = WaitingSnapshot.Empty;
    private readonly Button waitingButton;
    private WaitingPanel? waitingPanel;
    // What I answered each request, for its card when it ends.
    private readonly Dictionary<string, string> answered = new();

    internal Func<Task>? RefreshWaiting { get; set; }

    internal int WaitingCount => waiting.Count; // tests

    internal void ShowWaiting(WaitingSnapshot snapshot)
    {
        if (IsDisposed)
        {
            return;
        }
        if (InvokeRequired)
        {
            BeginInvoke(() => ShowWaiting(snapshot));
            return;
        }
        waiting = snapshot;
        var label = snapshot.Count > 0 ? $"Waiting for you ({snapshot.Count})" : "Waiting for you";
        railToolTip.SetToolTip(waitingButton, label);
        waitingButton.AccessibleName = label;
        waitingButton.Invalidate();
        waitingPanel?.Show(snapshot, voiceLoop.CurrentSessionId);
        SyncApprovalCards(voiceLoop.CurrentSessionId);
    }

    // A card for each of this chat's requests; one answered elsewhere (or
    // gone) ends with what was said.
    private void SyncApprovalCards(string? sessionId)
    {
        var open = waiting.Approvals.Select(a => a.Id).ToHashSet();
        foreach (var gone in chatView.OpenApprovalCards.Where(id => !open.Contains(id)))
        {
            chatView.EndApprovalCard(gone, answered.GetValueOrDefault(gone) ?? "No longer waiting");
        }
        if (sessionId is null)
        {
            return;
        }
        foreach (var approval in waiting.Approvals.Where(a => a.SessionId == sessionId))
        {
            chatView.ShowApprovalCard(approval.Id, $"**Needs your OK** · {WaitingPanel.Kind(approval.ActionType)}\n\n{approval.Summary}", CardActions(approval));
        }
    }

    // Allow (its arrow: for this session, always) and Deny (its arrow: never).
    private IReadOnlyList<ChatView.ChatAction> CardActions(ManaPendingApproval approval)
    {
        ChatView.ChatAction Answer(string label, bool primary, string decision, params string[] more) =>
            new(label, primary, () => AnswerAsync(approval, decision),
                Menu: more.Length == 0 ? null : more.Select(d => new ChatView.ChatMenuItem(
                    WaitingPanel.ApprovalChoices.First(c => c.Decision == d).Name, true, () => AnswerAsync(approval, d))).ToList());
        return [Answer("Allow", true, "allow-once", "allow-session", "always-allow"), Answer("Deny", false, "deny", "never")];
    }

    // Answers an approval or the coding agent's write, then fetches what's
    // waiting again so both places clear. Gives back what happened.
    internal async Task<string?> AnswerAsync(object request, string decision)
    {
        switch (request)
        {
            case ManaPendingApproval approval:
                await backendClient.DecideApprovalAsync(approval.Id, decision);
                answered[approval.Id] = WaitingPanel.Answered(decision);
                break;
            case ManaPendingWrite write:
                await backendClient.DecidePendingWriteAsync(write.Id, decision == "allow-once");
                break;
            default:
                return null;
        }
        if (RefreshWaiting is { } refresh)
        {
            await refresh();
        }
        return WaitingPanel.Answered(decision);
    }

    // #1118: the host API every rail tool uses (see ToolPanelHost): adds its
    // icon below the ones before it and opens createContent's control in the
    // tool panel. Returns the icon, e.g. to dock it at the bottom.
    // badge: a count on the icon while it's above 0.
    internal Button RegisterRailTool(string id, string icon, string label, Func<Control> createContent, Func<int>? badge = null)
    {
        var button = MakeRailButton(icon, label, () => toolPanel.IsOpen(id), () => toolPanel.IsHighlighted(id), badge);
        toolRail.Controls.Add(button);
        button.BringToFront(); // docked last-added-first, so this keeps registration order
        toolPanel.Add(id, label, button, createContent);
        return button;
    }

    // Ctrl+1...Ctrl+5 open the rail tools; Esc in the panel or rail closes it unless pinned.
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (toolPanel.HandleShortcut(keyData)
            || (keyData == Keys.Escape && (toolPanel.ContainsFocus || toolRail.ContainsFocus) && toolPanel.CloseUnlessPinned()))
        {
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    private Button MakeRailButton(string icon, string tooltip, Func<bool>? active = null, Func<bool>? highlighted = null, Func<int>? badge = null)
    {
        var button = new Button
        {
            Dock = DockStyle.Top,
            Height = 44,
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Panel,
            ForeColor = DarkTheme.Muted,
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = DarkTheme.Panel2;
        // No Text -- these are line-icon glyphs drawn in the #652 mockup's
        // rail style rather than approximated with Unicode symbol
        // characters -- so the tooltip is also the screen reader's name. The
        // open tool's icon gets the mockup's lavender "active" fill (#988).
        button.Paint += (_, e) =>
        {
            var open = active?.Invoke() == true;
            if (open)
            {
                using var lit = new SolidBrush(DarkTheme.IsGlass ? Color.FromArgb(217, 238, 231, 248) : DarkTheme.Panel2);
                e.Graphics.FillRectangle(lit, button.ClientRectangle);
            }
            DrawRailIcon(e.Graphics, button.ClientRectangle, open ? DarkTheme.Accent : button.ForeColor, icon);
            if (highlighted?.Invoke() == true)
            {
                // #1120: something new inside -- an accent dot at the icon's top right.
                using var dot = new SolidBrush(DarkTheme.Accent);
                e.Graphics.FillEllipse(dot, (button.Width / 2f) + 6, (button.Height / 2f) - 11, 7, 7);
            }
            if (badge?.Invoke() is > 0 and var count)
            {
                DrawRailBadge(e.Graphics, button.ClientRectangle, count);
            }
        };
        railToolTip.SetToolTip(button, tooltip);
        button.AccessibleName = tooltip;
        return button;
    }

    // #1426: a count at the icon's top right, a pill in the accent.
    private static void DrawRailBadge(Graphics g, Rectangle bounds, int count)
    {
        var text = count > 9 ? "9+" : count.ToString(System.Globalization.CultureInfo.InvariantCulture);
        using var font = new Font("Segoe UI", 7f, FontStyle.Bold);
        var width = Math.Max(14, TextRenderer.MeasureText(text, font, Size.Empty, TextFormatFlags.NoPadding).Width + 7);
        var pill = new RectangleF(bounds.X + (bounds.Width / 2f) + 2, bounds.Y + (bounds.Height / 2f) - 15, width, 14);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var shape = SettingsRows.Rounded(pill, 7))
        {
            using var fill = new SolidBrush(DarkTheme.Accent);
            using var ring = new Pen(DarkTheme.Panel, 2f);
            g.DrawPath(ring, shape);
            g.FillPath(fill, shape);
        }
        TextRenderer.DrawText(g, text, font, Rectangle.Round(pill), DarkTheme.OnAccent,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    }

    // The #652 mockup's rail icons: 18px, 1.6px strokes, round caps,
    // square-cornered frames. Every Pen is `using`-scoped per call, same
    // discipline as the avatar card's Paint handlers.
    private static void DrawRailIcon(Graphics g, Rectangle bounds, Color color, string icon)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var x = bounds.Left + (bounds.Width - 18) / 2f;
        var y = bounds.Top + (bounds.Height - 18) / 2f;
        using var pen = new Pen(color, 1.6f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        void Frame() => g.DrawRectangle(pen, x + 1.5f, y + 2.5f, 15, 13);

        switch (icon)
        {
            case "browser": // the mockup's "Browser activity": a window with a title bar
                Frame();
                g.DrawLine(pen, x + 1.5f, y + 6, x + 16.5f, y + 6);
                break;

            case "terminal":
                Frame();
                g.DrawLines(pen, new[] { new PointF(x + 5, y + 6.5f), new PointF(x + 8, y + 9), new PointF(x + 5, y + 11.5f) });
                g.DrawLine(pen, x + 9.5f, y + 11.5f, x + 13, y + 11.5f);
                break;

            case "artifacts": // a panel on the right
                Frame();
                g.DrawLine(pen, x + 11.5f, y + 2.5f, x + 11.5f, y + 15.5f);
                break;

            case "sidebar": // the mockup's toggle: a panel on the left
                Frame();
                g.DrawLine(pen, x + 6.5f, y + 2.5f, x + 6.5f, y + 15.5f);
                break;

            case "waiting": // a bell: a dome flaring to its rim, the clapper under it
                using (var bell = new GraphicsPath())
                {
                    bell.AddArc(x + 4.5f, y + 2, 9, 9, 180, 180);
                    bell.AddLine(x + 13.5f, y + 6.5f, x + 14.5f, y + 12.5f);
                    bell.AddLine(x + 14.5f, y + 12.5f, x + 3.5f, y + 12.5f);
                    bell.AddLine(x + 3.5f, y + 12.5f, x + 4.5f, y + 6.5f);
                    g.DrawPath(pen, bell);
                }
                g.DrawArc(pen, x + 7, y + 13, 4, 3.5f, 0, 180);
                break;

            case "tasks":
                for (var i = 0; i < 3; i++)
                {
                    var lineY = y + 4.5f + i * 4.5f;
                    g.DrawLine(pen, x + 6, lineY, x + 16.5f, lineY);
                    g.DrawLine(pen, x + 2, lineY, x + 2.2f, lineY); // round caps make it a dot
                }
                break;

            case "settings": // a cog: eight teeth around a hub
                var cx = x + 9;
                var cy = y + 9;
                var outline = new PointF[32];
                for (var i = 0; i < 8; i++)
                {
                    var a = i * Math.PI / 4;
                    PointF At(double angle, float r) => new(cx + r * (float)Math.Cos(angle), cy + r * (float)Math.Sin(angle));
                    outline[i * 4] = At(a - 0.36, 5.4f);
                    outline[i * 4 + 1] = At(a - 0.2, 7.5f);
                    outline[i * 4 + 2] = At(a + 0.2, 7.5f);
                    outline[i * 4 + 3] = At(a + 0.36, 5.4f);
                }
                g.DrawPolygon(pen, outline);
                g.DrawEllipse(pen, cx - 2.5f, cy - 2.5f, 5, 5);
                break;
        }
    }

    private void OnAvatarStateChanged(AvatarState state)
    {
        // AvatarOverlayForm.SetState already marshals onto the UI thread
        // before raising StateChanged, but that's its own UI thread, not
        // necessarily this one -- both forms run on the same single
        // WinForms message loop in this app, so it's the same thread in
        // practice, but IsDisposed is still checked since the two forms'
        // lifetimes aren't tied together (this one can be disposed while
        // avatarOverlay keeps running).
        if (IsDisposed)
        {
            return;
        }
        RefreshAvatarCard(state);
    }

    // #685: renders into the card only while it's on screen -- not while
    // the window is hidden, minimized or the sidebar is collapsed.
    private void UpdateAvatarMirror()
    {
        avatarOverlay.Mirror = avatarVisual.Visible && WindowState != FormWindowState.Minimized ? avatarVisual : null;
    }

    private void CycleAvatarFraming()
    {
        avatarVisual.Framing = LiveAvatarPanel.NextFraming(avatarVisual.Framing);
        railToolTip.SetToolTip(avatarZoomButton, LiveAvatarPanel.FramingTitle(avatarVisual.Framing));
        try
        {
            var settings = ManaSettingsStore.Load();
            settings.AvatarFraming = avatarVisual.Framing;
            settings.Save();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.WriteLine($"SessionListForm: couldn't save the avatar framing. {ex.Message}");
        }
    }

    // #538's own card text was literally "Mana — idle" (em dash, no
    // colon) -- kept verbatim, just with the hardcoded "idle" replaced by
    // the real state.
    private void RefreshAvatarCard(AvatarState state)
    {
        avatarStatusLabel.Text = StatusLine(state);
        avatarStatusLabel.Invalidate(); // repaints the status dot too -- see OnPaintAvatarStatusDot
        avatarVisual.Invalidate();
    }

    // #687: VoiceLoop's status (waiting/awake/thinking/synthesizing, or the
    // last error), except while the avatar shows an activity it doesn't
    // track (dreaming, working, waiting, done). Sentence case ("Idle", not
    // "idle" or "IDLE") matches the reference mock-up's status text.
    private string StatusLine(AvatarState state)
    {
        if (hearingText is not null)
        {
            return $"Hearing: \"{hearingText}\"";
        }
        if (state is AvatarState.Dreaming or AvatarState.Working or AvatarState.Waiting or AvatarState.Done)
        {
            var text = state.ToString();
            return char.ToUpperInvariant(text[0]) + text[1..].ToLowerInvariant();
        }
        return voiceLoop.StatusText;
    }

    // Same abstract gradient + rounded "silhouette" the reference mock-up
    // uses in place of real Live2D art (see this card's own constructor
    // comment for why) -- a soft accent glow near the top, a bottom-
    // anchored rounded blob standing in for the avatar's silhouette.
    // Every GDI+ object here is created and disposed within this single
    // call (`using`), never cached across paints -- Paint fires often
    // enough (resize, restore-from-tray, overlapping-window redraw) that
    // caching would need its own invalidation logic for a control this
    // simple, not worth it for a once-per-frame allocation this small.
    private void OnPaintAvatarVisual(object? sender, PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = avatarVisual.ClientRectangle;
        if (rect.Width <= 0 || rect.Height <= 0)
        {
            return;
        }

        using (var bgBrush = new LinearGradientBrush(rect, DarkTheme.Panel2, DarkTheme.Panel, LinearGradientMode.Vertical))
        {
            g.FillRectangle(bgBrush, rect);
        }
        if (avatarVisual.HasFrame)
        {
            return; // #685: the live avatar is drawn over the gradient, not the placeholder
        }

        var glowRect = new RectangleF(rect.Width * 0.05f, -rect.Height * 0.5f, rect.Width * 0.9f, rect.Height * 1.1f);
        using (var glowPath = new GraphicsPath())
        {
            glowPath.AddEllipse(glowRect);
            using var glowBrush = new PathGradientBrush(glowPath)
            {
                CenterColor = Color.FromArgb(110, DarkTheme.Accent),
                SurroundColors = new[] { Color.FromArgb(0, DarkTheme.Accent) },
            };
            g.FillEllipse(glowBrush, glowRect);
        }

        var blobWidth = rect.Width * 0.5f;
        var blobHeight = rect.Height * 0.82f;
        var blobRect = new RectangleF((rect.Width - blobWidth) / 2f, rect.Height - blobHeight, blobWidth, blobHeight);
        var radius = Math.Min(blobWidth, blobHeight) * 0.32f;
        using var blobPath = RoundedRect(blobRect, radius);
        using var blobBrush = new LinearGradientBrush(blobRect, ControlPaint.Light(DarkTheme.Accent, 0.25f), DarkTheme.Accent, LinearGradientMode.Vertical);
        g.FillPath(blobBrush, blobPath);
    }

    private static GraphicsPath RoundedRect(RectangleF rect, float radius)
    {
        var d = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(rect.X, rect.Y, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private const int StatusDotSize = 8;
    private const int StatusDotSpace = StatusDotSize + 6;

    // Green while she's listening, muted when she isn't; sits just left of
    // the centred status text (at the left edge once the text fills the line).
    private void OnPaintAvatarStatusDot(object? sender, PaintEventArgs e)
    {
        var label = avatarStatusLabel;
        var textWidth = TextRenderer.MeasureText(e.Graphics, label.Text, label.Font).Width;
        var textLeft = StatusDotSpace + Math.Max(0, (label.ClientSize.Width - StatusDotSpace - textWidth) / 2);
        var listening = DarkTheme.IsGlass ? Color.FromArgb(0x3f, 0xb9, 0x6a) : DarkTheme.Green; // the mockup's green; the palette's reads on flat themes
        using var dotBrush = new SolidBrush(voiceLoop.IsListening ? listening : DarkTheme.Muted);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        e.Graphics.FillEllipse(dotBrush, textLeft - StatusDotSpace, (label.Height - StatusDotSize) / 2f, StatusDotSize, StatusDotSize);
    }

    private void OnPaintAvatarCardBorder(object? sender, PaintEventArgs e)
    {
        if (DarkTheme.IsGlass)
        {
            return; // the glass card has its own edges
        }
        var card = (Panel)sender!;
        using var pen = new Pen(DarkTheme.Border);
        e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
    }

    // #689: rebinds a global hotkey live (Settings > Hotkeys); returns why it
    // couldn't, or null. Set by ManaApplicationContext, which owns the hotkeys.
    public Func<HotkeyAction, Keys?, string?>? BindHotkey { get; set; }

    // #1426: Settings > Voice > Dictation, applied live. Set by ManaApplicationContext.
    public Action<bool>? DictateAnywhereChanged { get; set; }
    public Action? AvatarSettingsChanged { get; set; }

    // #1426: Settings > Memory > Characters' "Switch to her".
    public Func<string, Task>? SwitchCharacter { get; set; }
    public Action? RevertMergedPr { get; set; }

    // #1127: a Mana doc (a Markdown file in the repo) in the tool panel,
    // bringing this window up if it's hidden (Settings' own window).
    private DocsPanel? docsPanel;

    internal void OpenDoc(string path)
    {
        if (!Visible)
        {
            Show();
        }
        Activate();
        toolPanel.Open("docs");
        docsPanel?.Open(path);
        toolPanel.SelectNextControl(null, forward: true, tabStopOnly: true, nested: true, wrap: false);
    }

    // #1426: the rail's cog and the tray's Settings… -- one Settings window;
    // opening it again brings that window forward, on the group asked for.
    private SettingsDialog? settingsWindow;

    internal void OpenSettings(string? group = null)
    {
        if (settingsWindow is { IsDisposed: false })
        {
            if (group is not null)
            {
                settingsWindow.Panel.ShowGroup(group);
            }
            if (settingsWindow.WindowState == FormWindowState.Minimized)
            {
                settingsWindow.WindowState = FormWindowState.Normal;
            }
            settingsWindow.Activate();
            return;
        }
        settingsWindow = new SettingsDialog(NewSettingsPanel(), group);
        settingsWindow.Show();
    }

    private SettingsPanel NewSettingsPanel()
    {
        // BindHotkey is set after this form is made, and a pinned Settings
        // panel is made with it, so it's looked up when used.
        var panel = new SettingsPanel(backendClient, backendLog, () => voiceLoop.CurrentSessionId,
            (action, keys) => BindHotkey is { } bind ? bind(action, keys) : "Hotkeys aren't set up yet.",
            new ListeningPause(() => voiceLoop.IsListening, voiceLoop.ToggleListening));
        // #681: the active preset reaches the next reply as soon as it's chosen.
        panel.ActivePresetChanged = voiceLoop.SetPresetId;
        panel.OpenDoc = OpenDoc;
        panel.DictateAnywhereChanged = on => DictateAnywhereChanged?.Invoke(on);
        panel.AvatarSettingsChanged = () => AvatarSettingsChanged?.Invoke();
        panel.SwitchCharacter = id => SwitchCharacter?.Invoke(id) ?? Task.CompletedTask;
        panel.RevertMergedPr = () => RevertMergedPr?.Invoke();
        return panel;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }

    private void SwitchToSelected()
    {
        if (list.SelectedItems.Count > 0)
        {
            SwitchTo((string)list.SelectedItems[0].Tag!);
        }
    }

    private async Task StartNewChatAsync()
    {
        // No explicit "create session" call -- matches the reference:
        // node-bot's ensureSession lazily creates the row on the first
        // real turn sent with this id, not when the id is merely minted.
        var sessionId = Guid.NewGuid().ToString();
        newChatButton.Enabled = false;
        try
        {
            if (SelectedProject is { } project) await backendClient.SetSessionProjectAsync(sessionId, project.Id);
            if (!IsDisposed) SwitchTo(sessionId);
        }
        catch (Exception ex) { if (!IsDisposed) SetListError(ex.Message); }
        finally { if (!IsDisposed) newChatButton.Enabled = true; }
    }

    private void SwitchTo(string sessionId)
    {
        if (sessionId == activeSessionId)
        {
            return;
        }
        activeSessionId = sessionId;
        toolPanel.CloseUnlessPinned();
        voiceLoop.SetSessionId(sessionId);
        ShowChatTitle();
        _ = RefreshAsync();
        _ = RefreshContextMeterAsync();
        _ = LoadHistoryAsync(sessionId);
        _ = ReadArtifactHistoryAsync();
    }

    private const int HistoryTurns = 50;

    // #687: shows the session's stored conversation (empty for a new chat).
    // Returns its detail, or null when it isn't stored or couldn't be read.
    private async Task<ManaSessionDetail?> LoadHistoryAsync(string sessionId)
    {
        ManaSessionDetail? detail;
        try
        {
            detail = await backendClient.GetSessionDetailAsync(sessionId, HistoryTurns);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: couldn't load the session's history. {ex.Message}");
            return null;
        }
        if (IsDisposed || sessionId != activeSessionId)
        {
            return null; // switched again meanwhile
        }
        chatView.ShowHistory(detail?.RecentTurns ?? Array.Empty<ManaSessionTurn>());
        SyncApprovalCards(sessionId); // #1426: this chat's requests, as cards again
        return detail;
    }

    // #687: at launch (backend up, before listening starts), reopens the
    // session that was open last time with its history. One that's no longer
    // stored (deleted, or a new chat never used) is dropped, so the first turn
    // auto-starts a session as before (Q62).
    public async Task ReopenLastSessionAsync()
    {
        var saved = ManaSettingsStore.Load();
        if (saved.LastSessionId is not { } sessionId || activeSessionId is not null)
        {
            return;
        }
        activeSessionId = sessionId;
        var detail = await LoadHistoryAsync(sessionId);
        if (detail is null)
        {
            if (activeSessionId == sessionId)
            {
                activeSessionId = null;
            }
            return;
        }
        var lastTurn = detail.RecentTurns.Count > 0 ? detail.RecentTurns[^1].At : null;
        voiceLoop.RestoreSession(sessionId, saved.LastSessionAuto, SessionListFormatter.ParseTurnTime(lastTurn));
        activeSessionId = voiceLoop.CurrentSessionId; // a turn may have started its own meanwhile
        _ = RefreshAsync();
        _ = RefreshContextMeterAsync();
    }

    // #642: how full the model's context window was on this session's last
    // reply. The backend counts the tokens just after the reply returns
    // (without holding it up), so an uncounted record gets one more look a
    // moment later. On failure the meter keeps its last reading.
    private async Task RefreshContextMeterAsync()
    {
        var sessionId = activeSessionId ?? "default"; // node-bot's key for "no sessionId sent"
        ManaPromptComposition? composition;
        try
        {
            composition = await backendClient.GetPromptCompositionAsync(sessionId);
            if (composition is { CountedWith: null })
            {
                await Task.Delay(1500);
                composition = await backendClient.GetPromptCompositionAsync(sessionId);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: couldn't refresh the context meter. {ex.Message}");
            return;
        }
        if (IsDisposed || sessionId != (activeSessionId ?? "default"))
        {
            return; // switched sessions meanwhile -- that switch refreshes it
        }
        contextMeterLabel.Text = ContextMeterFormatter.FormatMeter(composition);
        contextMeterLabel.ForeColor = ContextMeterFormatter.MeterColor(composition?.PercentUsed);
        railToolTip.SetToolTip(contextMeterLabel, ContextMeterFormatter.FormatBreakdown(composition));
    }

    private async void OnAfterLabelEdit(object? sender, LabelEditEventArgs e)
    {
        // Always cancels the built-in label swap -- RefreshAsync (once
        // the PATCH round-trip actually completes) is what updates the
        // displayed name, so this never shows a name the backend hasn't
        // confirmed.
        e.CancelEdit = true;
        if (string.IsNullOrWhiteSpace(e.Label))
        {
            return;
        }

        await RenameAsync((string)list.Items[e.Item].Tag!, e.Label.Trim());
    }

    private async Task RenameAsync(string sessionId, string name)
    {
        var failed = false;
        try
        {
            await backendClient.RenameSessionAsync(sessionId, name);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: rename failed. {ex.Message}");
            failed = true;
        }

        if (IsDisposed)
        {
            return;
        }
        await RefreshAsync();
        if (failed && !IsDisposed)
        {
            SetListError("Couldn't rename the chat.", () => RenameAsync(sessionId, name));
        }
    }

    private async Task DeleteSelectedAsync()
    {
        if (list.SelectedItems.Count == 0)
        {
            return;
        }
        var sessionId = (string)list.SelectedItems[0].Tag!;

        var confirmed = MessageBox.Show(
            this,
            "Delete this session? Its stored memory cannot be recovered.",
            "Delete Session",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }
        await DeleteAsync(sessionId);
    }

    private async Task DeleteAsync(string sessionId)
    {
        try
        {
            await backendClient.DeleteSessionAsync(sessionId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: delete failed. {ex.Message}");
            if (!IsDisposed)
            {
                SetListError("Couldn't delete the chat.", () => DeleteAsync(sessionId));
            }
            return;
        }

        if (IsDisposed)
        {
            return;
        }

        // Q62: deleting the active session leaves none, so the next turn
        // auto-starts one (which, unlike "+ New chat", rotates after 4 h).
        if (sessionId == activeSessionId)
        {
            activeSessionId = null;
            voiceLoop.SetSessionId(null);
            _ = RefreshContextMeterAsync(); // #642: no session, no reading
        }
        await RefreshAsync();
    }

    // #586: pre-fills the prompt with whatever goal is already stored
    // (empty for a session that's never had one) rather than always
    // starting blank -- GetSessionDetailAsync's own 404-tolerance means a
    // brand new session (impossible to select here anyway, since only
    // rows RefreshAsync already listed can be selected) just shows blank.
    private async Task SetGoalForSelectedAsync()
    {
        if (list.SelectedItems.Count == 0)
        {
            return;
        }
        var sessionId = (string)list.SelectedItems[0].Tag!;

        var currentGoal = "";
        try
        {
            var detail = await backendClient.GetSessionDetailAsync(sessionId);
            currentGoal = detail?.Goal ?? "";
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: failed to load current goal. {ex.Message}");
        }

        if (IsDisposed)
        {
            return;
        }

        using var dialog = new TextPromptDialog("Set Session Goal", "Goal (leave blank to clear):", currentGoal);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.SetSessionGoalAsync(sessionId, dialog.Value.Trim());
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: failed to set goal. {ex.Message}");
        }
    }

    private async Task OpenMemoryForSelectedAsync()
    {
        if (list.SelectedItems.Count == 0)
        {
            return;
        }
        var sessionId = (string)list.SelectedItems[0].Tag!;

        ManaSessionDetail? detail = null;
        try
        {
            detail = await backendClient.GetSessionDetailAsync(sessionId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: failed to load session memory. {ex.Message}");
        }

        if (IsDisposed)
        {
            return;
        }

        using var memoryForm = new SessionMemoryForm(sessionId, detail);
        memoryForm.ShowDialog(this);
    }

    // #1323: copy a chat directly as Markdown to paste into another app or notes.
    private async Task CopySelectedAsMarkdownAsync()
    {
        if (list.SelectedItems.Count == 0)
        {
            return;
        }
        var sessionId = (string)list.SelectedItems[0].Tag!;
        try
        {
            var markdown = await backendClient.ExportSessionAsync(sessionId, "markdown");
            if (!string.IsNullOrEmpty(markdown))
            {
                Clipboard.SetText(markdown);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: copy as markdown failed. {ex.Message}");
        }
    }

    // #1323: export chat as Markdown, HTML (drawn with Folio) or JSONL,
    // with options to include tool calls and reasoning.
    private async Task ExportSelectedAsync()
    {
        if (list.SelectedItems.Count == 0)
        {
            return;
        }
        var sessionId = (string)list.SelectedItems[0].Tag!;

        using var optionsDialog = new ExportChatDialog();
        if (optionsDialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        var format = optionsDialog.SelectedFormat;
        var includeTools = optionsDialog.IncludeTools;
        var includeThoughts = optionsDialog.IncludeThoughts;

        var (ext, filter) = format switch
        {
            "html" => ("html", "HTML page (*.html)|*.html|All files (*.*)|*.*"),
            "jsonl" => ("jsonl", "JSON Lines (*.jsonl)|*.jsonl|All files (*.*)|*.*"),
            _ => ("md", "Markdown (*.md)|*.md|All files (*.*)|*.*"),
        };

        using var saveDialog = new SaveFileDialog
        {
            FileName = $"{sessionId}.{ext}",
            Filter = filter,
        };
        if (saveDialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            string content;
            if (format == "html")
            {
                var markdown = await backendClient.ExportSessionAsync(sessionId, "markdown", includeTools, includeThoughts);
                content = MarkdownHtml.ToHtml(markdown, src => src);
            }
            else
            {
                content = await backendClient.ExportSessionAsync(sessionId, format, includeTools, includeThoughts);
            }
            await File.WriteAllTextAsync(saveDialog.FileName, content);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: export failed. {ex.Message}");
            if (!IsDisposed)
            {
                MessageBox.Show(this, $"Export failed: {ex.Message}", "Export Chat", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    public async Task RefreshAsync()
    {
        try
        {
            sessions = await backendClient.GetSessionsAsync();
            var loadedProjects = await backendClient.GetProjectsAsync();
            if (!IsDisposed) UpdateProjects(loadedProjects);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: failed to load sessions. {ex.Message}");
            if (!IsDisposed)
            {
                SetListError("Couldn't load chats.", RefreshAsync);
            }
            return;
        }

        if (IsDisposed)
        {
            return;
        }
        listError = null; // loaded, so an earlier load error is stale
        ShowSessions();
        _ = ReadArtifactHistoryAsync();
    }

    private void SetListError(string? error, Func<Task>? retry = null)
    {
        listError = error;
        listRetry = retry;
        UpdateListStatus();
    }

    private void UpdateListStatus()
    {
        var text = ListStatus(listError, list.Items.Count, searchBox.Text);
        listStatusLabel.Text = text ?? "";
        listRetryButton.Visible = listError is not null;
        listStatus.Visible = text is not null;
    }

    // An error wins; otherwise "No chats match" for a search with no rows.
    internal static string? ListStatus(string? error, int rows, string search) =>
        error ?? (rows == 0 && search.Trim().Length > 0 ? "No chats match" : null);

    // #687 part 3: content matches for 3+ characters. Debounced, and a reply
    // for an older query is dropped. On failure the list stays title-only.
    private async Task SearchContentAsync()
    {
        var version = ++searchVersion;
        var query = searchBox.Text.Trim();
        if (query.Length < 3)
        {
            if (contentMatches.Count > 0)
            {
                contentMatches = new();
                ShowSessions();
            }
            return;
        }
        await Task.Delay(250);
        if (version != searchVersion)
        {
            return;
        }
        HashSet<string> ids;
        try
        {
            ids = await backendClient.SearchSessionIdsAsync(query);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: content search failed. {ex.Message}");
            if (!IsDisposed && version == searchVersion)
            {
                SetListError("Couldn't search what was said in chats.", SearchContentAsync);
            }
            return;
        }
        if (IsDisposed || version != searchVersion)
        {
            return;
        }
        contentMatches = ids;
        ShowSessions();
    }

    private void ShowSessions()
    {
        list.BeginUpdate();
        list.Items.Clear();
        list.Groups.Clear();
        foreach (var session in sessions.Where(s => MatchesProject(s) && (SessionListFormatter.MatchesSearch(s, searchBox.Text) || contentMatches.Contains(s.SessionId))))
        {
            var item = new ListViewItem(SessionListFormatter.FormatDisplayName(session))
            {
                Tag = session.SessionId,
                ToolTipText = SessionListFormatter.FormatUpdatedAt(session.UpdatedAt),
            };
            item.SubItems.Add(SessionListFormatter.FormatRelative(session.UpdatedAt, DateTimeOffset.Now));
            var groupKey = session.ProjectId is { } id ? $"project:{id}" : "ungrouped";
            var group = list.Groups[groupKey];
            if (group is null) { group = new ListViewGroup(groupKey, session.ProjectName ?? "Ungrouped"); list.Groups.Add(group); }
            item.Group = group;
            list.Items.Add(item);
        }
        list.EndUpdate();
        FitSessionColumn();
        UpdateListStatus();
        ShowChatTitle();
    }

    private void ShowChatTitle()
    {
        chatTitleLabel.Text = ChatTitle(sessions, activeSessionId);
        if (modelsForSession != activeSessionId || chatModelPicker.Items.Count == 0) _ = RefreshChatModelsAsync();
    }

    private async Task RefreshChatModelsAsync()
    {
        var version = ++modelLoadVersion;
        var sessionId = voiceLoop.CurrentSessionId;
        try
        {
            var result = await backendClient.GetChatModelsAsync(sessionId);
            if (IsDisposed || version != modelLoadVersion || sessionId != voiceLoop.CurrentSessionId) return;
            loadingChatModels = true;
            chatModelPicker.Items.Clear();
            foreach (var model in result.Models) chatModelPicker.Items.Add(model);
            chatModelPicker.SelectedItem = result.Models.FirstOrDefault(m => m.Id == result.Selected);
            modelsForSession = sessionId;
        }
        catch { if (!IsDisposed && version == modelLoadVersion) chatModelPicker.SelectedIndex = -1; }
        finally { loadingChatModels = false; }
    }

    // The open chat's name for the header; a chat not saved yet is "New chat".
    internal static string ChatTitle(System.Collections.Generic.IReadOnlyList<ManaSession> sessions, string? activeSessionId) =>
        sessions.FirstOrDefault(s => s.SessionId == activeSessionId) is { } open ? SessionListFormatter.FormatDisplayName(open) : "New chat";

    private const int SessionRowHeight = 52; // 8px padding, title, 2px, time, 8px padding, 2px between rows

    private void FitSessionColumn()
    {
        if (list.Columns.Count > 0 && list.Columns[0].Width != list.ClientSize.Width)
        {
            list.Columns[0].Width = list.ClientSize.Width;
        }
    }

    // A chat row: its title over the relative time. The open chat is a
    // bright glass card with a semibold title in the Mana preset (accent and
    // semibold in the others); a selected row gets a fainter fill.
    private void OnDrawSessionItem(object? sender, DrawListViewItemEventArgs e)
    {
        var g = e.Graphics;
        var bounds = e.Bounds with { Width = list.ClientSize.Width };
        var card = Rectangle.Inflate(bounds, 0, -1);
        var active = (string?)e.Item.Tag == activeSessionId;
        if (DarkTheme.IsGlass)
        {
            GlassSurface.PaintGlowBehind(g, list, bounds);
            if (active || e.Item.Selected)
            {
                using var fill = new SolidBrush(Color.FromArgb(active ? 179 : 90, 255, 255, 255));
                g.FillRectangle(fill, card);
            }
            if (active)
            {
                GlassSurface.PaintGlassEdges(g, card, GlassSurface.SheenProgress(list));
            }
        }
        else
        {
            using var back = new SolidBrush(list.BackColor);
            g.FillRectangle(back, bounds);
            if (e.Item.Selected)
            {
                using var tint = new SolidBrush(Color.FromArgb(56, DarkTheme.Accent)); // reads on every preset, High contrast too
                g.FillRectangle(tint, card);
            }
        }

        var pad = LogicalToDeviceUnits(10);
        var titleFont = active ? activeSessionFont : sessionTitleFont;
        var titleColor = active && !DarkTheme.IsGlass ? DarkTheme.Accent : DarkTheme.Text;
        var gap = LogicalToDeviceUnits(2);
        var top = card.Y + (card.Height - titleFont.Height - gap - sessionTimeFont.Height) / 2;
        const TextFormatFlags flags = TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
        TextRenderer.DrawText(g, e.Item.Text, titleFont, new Rectangle(card.X + pad, top, card.Width - pad * 2, titleFont.Height), titleColor, flags);
        var time = e.Item.SubItems.Count > 1 ? e.Item.SubItems[1].Text : "";
        TextRenderer.DrawText(g, time, sessionTimeFont, new Rectangle(card.X + pad, top + titleFont.Height + gap, card.Width - pad * 2, sessionTimeFont.Height), DarkTheme.Muted, flags);
        if (e.Item.Focused && list.Focused && GlassSurface.ShowsFocusCues(list))
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(card, -2, -1));
        }
    }

    // #1142: once the Artifacts panel exists, the open chat's and the ten
    // most recent chats' past artifacts are read back from the saved chats,
    // each chat once: titles and versions only, content when one is opened.
    private readonly HashSet<string> artifactHistoryRead = new();

    private async Task ReadArtifactHistoryAsync()
    {
        if (artifactsPanel is null)
        {
            return;
        }
        var ids = sessions.Select(s => s.SessionId).Take(10).Prepend(activeSessionId).OfType<string>().Where(artifactHistoryRead.Add).ToList();
        foreach (var id in ids)
        {
            IReadOnlyList<ManaSavedArtifact> saved;
            try
            {
                saved = await backendClient.GetSessionArtifactsAsync(id, artifacts.StartedAt);
            }
            catch (Exception ex)
            {
                artifactHistoryRead.Remove(id); // try again next time
                Console.WriteLine($"SessionListForm: couldn't read a chat's artifacts. {ex.Message}");
                continue;
            }
            if (IsDisposed)
            {
                return;
            }
            artifacts.AddHistory(saved.Select(a => new ArtifactEntry(
                new VersionedArtifact(a.Language, "", $"{id}/{a.ThreadId}", a.VersionIndex), id, SessionListFormatter.ParseTurnTime(a.At).ToLocalTime())
            {
                Title = a.Title,
                Load = () => backendClient.GetSessionArtifactContentAsync(id, a.Turn),
            }).ToList());
        }
    }

    private void OnArtifactAdded(ArtifactEntry entry)
    {
        if (toolPanel.IsOpen("artifacts") && artifactsPanel is not null)
        {
            artifactsPanel.Select(entry);
        }
        else
        {
            toolPanel.Highlight("artifacts");
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            artifacts.Added -= OnArtifactAdded; // the viewer outlives this form
            avatarOverlay.StateChanged -= OnAvatarStateChanged;
            avatarOverlay.Mirror = null; // #685: before avatarVisual is disposed
            sessionTitleFont.Dispose();
            activeSessionFont.Dispose();
            sessionTimeFont.Dispose();
            sessionRowHeight.Dispose();
            messageBoxFont.Dispose();
            chatTitleFont.Dispose();
            avatarNameFont.Dispose();
            avatarStatusFont.Dispose();
            railToolTip.Dispose();
            messageQueueTimer.Dispose();
            sendButtonTimer.Dispose();
        }
        base.Dispose(disposing);
    }
}

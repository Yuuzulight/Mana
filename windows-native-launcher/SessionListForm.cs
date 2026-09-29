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
// version: no FormBorderStyle.None/custom-drawn titlebar (this keeps the
// OS's native drag/resize/snap and keyboard/screen-reader behavior,
// which #538's version gave up and then needed a stateful AllowExit
// escape hatch to work around -- see DarkTheme.ApplyForm). The rail's
// Browser/Terminal/Artifacts/Tasks icons are kept as #538 had them --
// none of those tools exist in this app yet, so each opens the same
// slide-out panel saying so directly, rather than pretending to be a
// finished feature or being silently dead.
//
// A standalone window for now (windows-launcher's own version lives
// inside its main app window) -- created once and reused (Hide, not
// Close) by ManaApplicationContext, same lazy-create-and-reuse shape as
// QuickEntryForm.
internal sealed class SessionListForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly VoiceLoop voiceLoop;
    private readonly BackendLogBuffer backendLog;
    private readonly ListView list = new();
    private readonly Button newChatButton = new();
    private readonly AvatarOverlayForm avatarOverlay;
    private readonly Panel avatarVisual = new();
    private readonly Button avatarZoomButton = new();
    private readonly Label avatarNameLabel = new();
    private readonly Label avatarStatusLabel = new();
    private string? hearingText; // #619: live partial transcript, null when none
    private readonly Font avatarNameFont;
    private readonly Font avatarStatusFont;
    private readonly Font toolPanelTitleFont;

    // One shared ToolTip serving every rail button -- SetToolTip(control,
    // caption) is the normal WinForms pattern for exactly this (a per-
    // control caption map on one native tooltip window), not one instance
    // per control.
    private readonly ToolTip railToolTip = new();

    // Bolds the active session's row in RefreshAsync -- built once and
    // reused rather than a fresh Font per refresh, which leaked a GDI
    // handle every time the list reloaded (session switch/rename/delete/
    // new-chat) with no matching Dispose.
    private readonly Font activeSessionFont;
    private readonly Font messageBoxFont;
    private readonly System.Collections.Generic.HashSet<string> offeredProposalIds = new();

    // Mirrors VoiceLoop's own currentSessionId -- null (nothing switched
    // to yet) means node-bot's implicit "default" session, same starting
    // state VoiceLoop itself has.
    private string? activeSessionId;

    // Which rail placeholder (if any) the slide-out tool panel is
    // currently showing -- null means the panel is closed. See
    // ToggleToolPlaceholder.
    private string? openTool;

    // When pinned, re-clicking the rail icon that's already open no
    // longer closes the panel -- only the panel's own × does. See
    // SetToolPanelPinned/CloseToolPanel.
    private bool toolPanelPinned;

    public SessionListForm(ManaBackendClient backendClient, VoiceLoop voiceLoop, ChatView chatLog, AvatarOverlayForm avatarOverlay, BackendLogBuffer backendLog)
    {
        this.backendClient = backendClient;
        this.voiceLoop = voiceLoop;
        this.avatarOverlay = avatarOverlay;
        this.backendLog = backendLog;
        activeSessionFont = new Font(list.Font, FontStyle.Bold);
        messageBoxFont = new Font("Segoe UI", 10.5F);

        Text = "Mana";
        Width = 900;
        Height = 600;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        newChatButton.Text = "+ New chat";
        newChatButton.Dock = DockStyle.Top;
        newChatButton.Height = 32;
        newChatButton.Margin = new Padding(8);
        newChatButton.Click += (_, _) => StartNewChat();
        // #538's own new-chat button is a solid accent CTA, not the
        // muted flat style DarkTheme.ApplyButton gives every other button
        // in this window -- matched here instead of through that shared
        // helper, which stays as-is for Settings' own buttons.
        newChatButton.FlatStyle = FlatStyle.Flat;
        newChatButton.BackColor = DarkTheme.Accent;
        newChatButton.ForeColor = DarkTheme.OnAccent;
        newChatButton.FlatAppearance.BorderSize = 0;

        list.Dock = DockStyle.Fill;
        list.View = View.Details;
        list.HeaderStyle = ColumnHeaderStyle.None; // sidebar look, not a data grid
        list.FullRowSelect = true;
        list.HideSelection = false;
        list.LabelEdit = true;
        list.Columns.Add("Name", 170);
        list.Columns.Add("Updated", 90);
        // WinForms convention (select on single click, activate on
        // double) rather than the reference's own single-click-switches
        // -- switching sessions from a stray selection click would be a
        // worse native experience than the sidebar's always-visible list
        // made single-click safe for.
        list.MouseDoubleClick += OnListDoubleClick;
        list.AfterLabelEdit += OnAfterLabelEdit;

        var contextMenu = new ContextMenuStrip();
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
        contextMenu.Items.Add("Open memory...", null, async (_, _) => await OpenMemoryForSelectedAsync());
        list.ContextMenuStrip = contextMenu;
        DarkTheme.ApplyListView(list);

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
        avatarZoomButton.Size = new Size(20, 20);
        // Sidebar starts at 240px (see sidebar's own Width below) and is
        // now user-resizable via sidebarSplitter -- this is only the
        // initial position, computed directly rather than referencing
        // avatarCard here, which isn't declared yet at this point in the
        // constructor. Anchor (Top|Right) below keeps it glued to
        // avatarCard's right edge on every later resize.
        avatarZoomButton.Location = new Point(240 - 20 - 8, 8);
        avatarZoomButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        avatarZoomButton.FlatStyle = FlatStyle.Flat;
        avatarZoomButton.BackColor = DarkTheme.Panel2;
        avatarZoomButton.ForeColor = DarkTheme.Muted;
        avatarZoomButton.FlatAppearance.BorderColor = DarkTheme.Border;
        avatarZoomButton.FlatAppearance.BorderSize = 1;
        railToolTip.SetToolTip(avatarZoomButton, "Bring the avatar overlay to the front");
        avatarZoomButton.Click += (_, _) =>
        {
            avatarOverlay.Show();
            avatarOverlay.Activate();
        };

        avatarNameLabel.Text = "Mana";
        avatarNameLabel.Dock = DockStyle.Top;
        avatarNameLabel.Height = 18;
        avatarNameLabel.ForeColor = DarkTheme.Text;
        avatarNameFont = new Font(avatarStatusLabel.Font.FontFamily, 9.5f, FontStyle.Bold);
        avatarNameLabel.Font = avatarNameFont;

        avatarStatusLabel.Dock = DockStyle.Top;
        avatarStatusLabel.Height = 16;
        avatarStatusLabel.AutoEllipsis = true; // #619: "Hearing: ..." can be long
        avatarStatusLabel.Padding = new Padding(14, 0, 0, 0); // room for the status dot painted by OnPaintAvatarVisual's sibling below
        avatarStatusLabel.ForeColor = DarkTheme.Muted;
        avatarStatusFont = new Font(avatarStatusLabel.Font.FontFamily, 8.5f);
        avatarStatusLabel.Font = avatarStatusFont;
        avatarStatusLabel.Paint += OnPaintAvatarStatusDot;

        // Width matches the sidebar's starting width so avatarZoomButton's
        // right-edge anchor is measured against the width it's placed for
        // (a Panel starts 200 wide, which anchored the button off the card).
        var avatarCard = new Panel { Dock = DockStyle.Bottom, Width = 240, Height = 150, BackColor = DarkTheme.Panel, Padding = new Padding(10) };
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

        var sidebar = new Panel { Dock = DockStyle.Left, Width = 240, BackColor = DarkTheme.Background };
        // Reverse dock order again (last added docks first): the avatar
        // card (bottom) and new-chat button (top) stake their strips before
        // the list fills what's left.
        sidebar.Controls.Add(list);
        sidebar.Controls.Add(newChatButton);
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

        var toolPanelLabel = new Label
        {
            Dock = DockStyle.Fill,
            ForeColor = DarkTheme.Muted,
            Padding = new Padding(12),
            TextAlign = ContentAlignment.TopLeft,
        };
        toolPanelTitleFont = new Font(toolPanelLabel.Font, FontStyle.Bold);
        var toolPanelTitleLabel = new Label
        {
            Dock = DockStyle.Fill,
            ForeColor = DarkTheme.Text,
            Font = toolPanelTitleFont,
            TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(10, 0, 0, 0),
        };
        var toolCloseButton = new Button { Text = "×", Dock = DockStyle.Right, Width = 26, FlatStyle = FlatStyle.Flat, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Muted };
        toolCloseButton.FlatAppearance.BorderSize = 0;
        var toolPinButton = new Button { Text = "Pin", Dock = DockStyle.Right, Width = 40, FlatStyle = FlatStyle.Flat, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Muted };
        toolPinButton.FlatAppearance.BorderSize = 0;
        railToolTip.SetToolTip(toolPinButton, "Pin panel open");
        railToolTip.SetToolTip(toolCloseButton, "Close");
        var toolPanelHeader = new Panel { Dock = DockStyle.Top, Height = 28, BackColor = DarkTheme.Panel };
        // Last added docks first: close claims the outermost-right strip,
        // pin sits just inside it, and the title label fills what's left.
        toolPanelHeader.Controls.Add(toolPanelTitleLabel);
        toolPanelHeader.Controls.Add(toolPinButton);
        toolPanelHeader.Controls.Add(toolCloseButton);

        var toolPanel = new Panel
        {
            Dock = DockStyle.Right,
            Width = 220,
            Visible = false,
            BackColor = DarkTheme.Panel2,
        };
        // Header (Top) docks before the label (Fill), so it's added last.
        toolPanel.Controls.Add(toolPanelLabel);
        toolPanel.Controls.Add(toolPanelHeader);

        // Drag-resizable the same way as sidebarSplitter above (min 160,
        // max 420 clamped on SplitterMoved), and kept in step with
        // toolPanel's own Visible -- otherwise closing the panel would
        // leave this 4px bar stranded between the rail and the chat log.
        var toolPanelSplitter = new Splitter { Dock = DockStyle.Right, Width = 4, BackColor = DarkTheme.Border, MinSize = 160, MinExtra = 240, Visible = false };
        toolPanelSplitter.SplitterMoved += (_, _) =>
        {
            if (toolPanel.Width > 420)
            {
                toolPanel.Width = 420;
            }
        };

        var toolRail = new Panel { Dock = DockStyle.Right, Width = 44, BackColor = DarkTheme.Panel };
        // #538's own rail order (top to bottom): Browser, Terminal,
        // Artifacts, Tasks, then Settings. None of the first four exist
        // in this app yet -- kept as honest placeholders (clicking one
        // opens the same slide-out panel #538's own ToggleTool did,
        // saying so directly) rather than silently dead buttons.
        var railSettingsButton = MakeRailButton("settings", "Settings"); // the rail's one real, wired icon
        railSettingsButton.Dock = DockStyle.Bottom;
        railSettingsButton.Click += (_, _) => OpenSettings();
        toolRail.Controls.Add(railSettingsButton);
        // Reversed so Browser (docked last-added-first) ends up on top.
        foreach (var (icon, label) in new[] { ("tasks", "Background tasks"), ("artifacts", "Artifacts"), ("terminal", "Terminal"), ("browser", "Browser") })
        {
            var button = MakeRailButton(icon, label);
            button.Click += (_, _) => ToggleToolPlaceholder(label, toolPanel, toolPanelSplitter, toolPanelTitleLabel, toolPanelLabel);
            toolRail.Controls.Add(button);
        }

        toolCloseButton.Click += (_, _) => CloseToolPanel(toolPanel, toolPanelSplitter, toolPinButton);
        toolPinButton.Click += (_, _) => SetToolPanelPinned(toolPinButton, !toolPanelPinned);
        // Rail order matches #538's: Browser/Terminal/Artifacts/Tasks top
        // to bottom, Settings docked at the bottom.

        var chatArea = new Panel { Dock = DockStyle.Fill, BackColor = DarkTheme.Background };
        // Last added docks first: the message box claims the bottom strip,
        // then the chat fills the rest.
        chatArea.Controls.Add(chatLog);
        chatArea.Controls.Add(BuildMessageBox());
        chatLog.ReplyEnded += () => _ = OfferPendingEditsAsync(chatLog);
        // #619: the live partial transcript takes over the status line while
        // the user is talking. chatLog is a child control, so it can't
        // outlive this subscription.
        chatLog.HearingChanged += text =>
        {
            hearingText = text;
            RefreshAvatarCard(avatarOverlay.CurrentState);
        };

        // Same collapse toggle as Claude's own UI, and the design
        // reference's own #sidebarToggleBtn -- a persistent top strip
        // (not a child of `sidebar` itself, which is what gets hidden;
        // a button that disappears along with the panel it opens would
        // have no way to bring it back).
        var sidebarToggleButton = MakeRailButton("sidebar", "Toggle sidebar");
        sidebarToggleButton.Dock = DockStyle.Left;
        sidebarToggleButton.Width = 34;
        sidebarToggleButton.Height = 28;
        sidebarToggleButton.Click += (_, _) =>
        {
            sidebar.Visible = !sidebar.Visible;
            sidebarSplitter.Visible = sidebar.Visible; // otherwise the splitter bar is left stranded when the sidebar is hidden
        };

        // #681: same toggle as the tray's Start/Stop listening item. Its
        // label is refreshed on Activated since the tray can flip it while
        // this window is in the background.
        var listenButton = new Button { Dock = DockStyle.Right, Width = 120 };
        DarkTheme.ApplyButton(listenButton);
        void RefreshListenButton() => listenButton.Text = voiceLoop.IsListening ? "Stop listening" : "Start listening";
        listenButton.Click += (_, _) =>
        {
            voiceLoop.ToggleListening();
            RefreshListenButton();
        };
        Activated += (_, _) => RefreshListenButton();
        RefreshListenButton();

        var topBar = new Panel { Dock = DockStyle.Top, Height = 28, BackColor = DarkTheme.Background };
        topBar.Controls.Add(listenButton);
        topBar.Controls.Add(sidebarToggleButton);

        // Dock order matters, and WinForms docks in REVERSE of the Controls
        // collection: the last control added claims its edge first. So the
        // intended docking sequence -- topBar (full width), sidebar, its
        // splitter, toolRail (outermost right), toolPanel, its splitter,
        // then chatArea filling what's left -- is added back to front.
        // (Adding them front to back docked chatArea first: it took the
        // whole window and the rest were laid over it, hiding the first
        // lines of chat and clipping both sides.) Each Splitter still sits
        // next to the control it resizes.
        Controls.Add(chatArea);
        Controls.Add(toolPanelSplitter);
        Controls.Add(toolPanel);
        Controls.Add(toolRail);
        Controls.Add(sidebarSplitter);
        Controls.Add(sidebar);
        Controls.Add(topBar);

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
    }

    // #652 part 5: a typed-message box under the chat, sending through the
    // same VoiceLoop entry point as Quick Entry (which also logs the message
    // in the chat). Enter sends, Shift+Enter adds a line. Like Quick Entry it
    // clears straight away while the turn runs; if Mana is still busy with
    // the previous turn the submit returns false at once, and the text comes
    // back with a note instead of being lost.
    private Panel BuildMessageBox()
    {
        var box = new TextBox
        {
            Multiline = true,
            AcceptsReturn = false,
            Dock = DockStyle.Fill,
            BorderStyle = BorderStyle.FixedSingle,
            BackColor = DarkTheme.IsLight ? Color.White : DarkTheme.Panel2,
            ForeColor = DarkTheme.Text,
            Font = messageBoxFont,
            PlaceholderText = MessageBoxPlaceholder,
            AccessibleName = "Message Mana",
            ScrollBars = ScrollBars.None,
        };
        var send = new Button
        {
            Text = "Send",
            Dock = DockStyle.Right,
            Width = 72,
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Accent,
            ForeColor = DarkTheme.OnAccent,
        };
        send.FlatAppearance.BorderSize = 0;

        // #675: deep thinking, sticky until clicked off. While on, every
        // turn (typed or spoken) asks node-bot to think harder. A toggle
        // (CheckBox drawn as a button) so its on/off state is also exposed to
        // screen readers; not saved -- off at each launch, like the tool
        // panel's pin, since a forgotten "on" makes every reply slow.
        var think = new CheckBox
        {
            Appearance = Appearance.Button,
            Text = "Think",
            TextAlign = ContentAlignment.MiddleCenter,
            Dock = DockStyle.Right,
            Width = 72,
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Panel2,
            ForeColor = DarkTheme.Muted,
            AccessibleName = "Deep thinking",
        };
        think.FlatAppearance.BorderSize = 0;
        think.FlatAppearance.CheckedBackColor = DarkTheme.Accent;
        railToolTip.SetToolTip(think, DeepThinkingOffTooltip);
        think.CheckedChanged += (_, _) =>
        {
            voiceLoop.SetDeepThinking(think.Checked);
            think.ForeColor = think.Checked ? DarkTheme.OnAccent : DarkTheme.Muted;
            railToolTip.SetToolTip(think, think.Checked ? DeepThinkingOnTooltip : DeepThinkingOffTooltip);
        };

        async Task SendAsync()
        {
            var text = box.Text;
            if (text.Trim().Length == 0)
            {
                return;
            }
            box.Clear();
            var accepted = await voiceLoop.SubmitTypedCommandAsync(text);
            if (!accepted && !box.IsDisposed && box.TextLength == 0)
            {
                box.Text = text;
                box.SelectionStart = box.TextLength;
                box.PlaceholderText = "Mana's still replying -- press Enter again in a moment";
            }
        }
        box.KeyDown += async (_, e) =>
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true;
                await SendAsync();
            }
            else if (e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                box.SelectedText = Environment.NewLine;
            }
        };
        box.TextChanged += (_, _) => box.PlaceholderText = MessageBoxPlaceholder;
        send.Click += async (_, _) => await SendAsync();

        Panel Gap() => new() { Dock = DockStyle.Right, Width = 8, BackColor = Color.Transparent };
        var panel = new Panel { Dock = DockStyle.Bottom, Height = 58, Padding = new Padding(12, 10, 12, 10), BackColor = DarkTheme.Panel };
        // Docked last-added first: Send at the far right, then Think, then the box.
        panel.Controls.Add(box);
        panel.Controls.Add(Gap());
        panel.Controls.Add(think);
        panel.Controls.Add(Gap());
        panel.Controls.Add(send);
        return panel;
    }

    private const string DeepThinkingOnTooltip = "Deep thinking: on -- slower, more careful replies. Click to turn off.";
    private const string DeepThinkingOffTooltip = "Deep thinking: off -- click for slower, more careful replies";

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

    private const string MessageBoxPlaceholder = "Message Mana...  (Enter to send, Shift+Enter for a new line)";

    private Button MakeRailButton(string icon, string tooltip)
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
        // No Text -- these are line-icon glyphs (same set as the design
        // reference's rail: circle-globe/terminal/artifacts/list/gear),
        // drawn to match its stroke-width:2-on-24px-viewBox look rather
        // than approximated with Unicode symbol characters.
        button.Paint += (_, e) => DrawRailIcon(e.Graphics, button.ClientRectangle, button.ForeColor, icon);
        railToolTip.SetToolTip(button, tooltip);
        return button;
    }

    // Ported from the design reference's own rail SVGs (24x24 viewBox,
    // stroke-width 2, round caps/joins) -- redrawn in GDI+ rather than
    // embedded as image resources, matching this file's own avatar-card
    // precedent of procedural drawing over baked-in art assets. Every Pen
    // is `using`-scoped per call, same discipline as the avatar card's
    // Paint handlers.
    private static void DrawRailIcon(Graphics g, Rectangle bounds, Color color, string icon)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        const int size = 17;
        var x = bounds.Left + (bounds.Width - size) / 2f;
        var y = bounds.Top + (bounds.Height - size) / 2f;
        using var pen = new Pen(color, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };

        switch (icon)
        {
            case "browser":
                g.DrawEllipse(pen, x, y, size, size);
                g.DrawLine(pen, x, y + size / 2f, x + size, y + size / 2f);
                g.DrawArc(pen, x + size * 0.28f, y, size * 0.44f, size, 90, 180);
                break;

            case "terminal":
                using (var terminalPath = RoundedRect(new RectangleF(x, y, size, size * 0.82f), 2.5f))
                {
                    g.DrawPath(pen, terminalPath);
                }
                g.DrawLines(pen, new[]
                {
                    new PointF(x + size * 0.2f, y + size * 0.28f),
                    new PointF(x + size * 0.45f, y + size * 0.41f),
                    new PointF(x + size * 0.2f, y + size * 0.54f),
                });
                g.DrawLine(pen, x + size * 0.5f, y + size * 0.54f, x + size * 0.78f, y + size * 0.54f);
                break;

            case "artifacts":
                using (var artifactsPath = RoundedRect(new RectangleF(x, y, size, size), 2.5f))
                {
                    g.DrawPath(pen, artifactsPath);
                }
                g.DrawLine(pen, x + size * 0.62f, y, x + size * 0.62f, y + size);
                break;

            // Same shape as "artifacts", mirrored -- a panel divided near
            // its LEFT edge instead of its right, standing for the left
            // sidebar instead of the right tool panel.
            case "sidebar":
                using (var sidebarPath = RoundedRect(new RectangleF(x, y, size, size), 2.5f))
                {
                    g.DrawPath(pen, sidebarPath);
                }
                g.DrawLine(pen, x + size * 0.38f, y, x + size * 0.38f, y + size);
                break;

            case "tasks":
                using (var dotBrush = new SolidBrush(color))
                {
                    for (var i = 0; i < 3; i++)
                    {
                        var lineY = y + size * (0.2f + i * 0.3f);
                        g.DrawLine(pen, x + size * 0.28f, lineY, x + size, lineY);
                        g.FillEllipse(dotBrush, x, lineY - 1f, 2f, 2f);
                    }
                }
                break;

            case "settings":
                var center = new PointF(x + size / 2f, y + size / 2f);
                var outerR = size * 0.34f;
                var innerR = size * 0.14f;
                g.DrawEllipse(pen, center.X - innerR, center.Y - innerR, innerR * 2, innerR * 2);
                for (var i = 0; i < 8; i++)
                {
                    var angle = i * Math.PI / 4;
                    var toothInner = new PointF(center.X + (float)(outerR * 0.75 * Math.Cos(angle)), center.Y + (float)(outerR * 0.75 * Math.Sin(angle)));
                    var toothOuter = new PointF(center.X + (float)(outerR * Math.Cos(angle)), center.Y + (float)(outerR * Math.Sin(angle)));
                    g.DrawLine(pen, toothInner, toothOuter);
                }
                break;
        }
    }

    // #538's own ToggleTool: click the open tool's own icon again to
    // close the panel; click a different one to swap its content instead
    // of stacking a second panel. Pinning (toolPanelPinned) overrides the
    // first part -- see the early return below.
    private void ToggleToolPlaceholder(string tool, Panel toolPanel, Splitter toolPanelSplitter, Label toolPanelTitleLabel, Label toolPanelBodyLabel)
    {
        if (openTool == tool)
        {
            if (toolPanelPinned)
            {
                return; // pinned -- only the panel's own × (CloseToolPanel) closes it now
            }
            toolPanel.Visible = false;
            toolPanelSplitter.Visible = false;
            openTool = null;
            return;
        }
        openTool = tool;
        toolPanelTitleLabel.Text = tool;
        toolPanelBodyLabel.Text = "Not built yet.";
        toolPanel.Visible = true;
        toolPanelSplitter.Visible = true;
    }

    private void CloseToolPanel(Panel toolPanel, Splitter toolPanelSplitter, Button toolPinButton)
    {
        toolPanel.Visible = false;
        toolPanelSplitter.Visible = false;
        openTool = null;
        SetToolPanelPinned(toolPinButton, false);
    }

    private void SetToolPanelPinned(Button toolPinButton, bool pinned)
    {
        toolPanelPinned = pinned;
        toolPinButton.BackColor = pinned ? DarkTheme.Accent : DarkTheme.Panel2;
        toolPinButton.ForeColor = pinned ? DarkTheme.OnAccent : DarkTheme.Muted;
        railToolTip.SetToolTip(toolPinButton, pinned ? "Unpin panel" : "Pin panel open");
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

    // #538's own card text was literally "Mana — idle" (em dash, no
    // colon) -- kept verbatim, just with the hardcoded "idle" replaced by
    // the real state.
    private void RefreshAvatarCard(AvatarState state)
    {
        // Sentence case ("Idle", not "idle" or "IDLE") to match the
        // reference mock-up's own status text exactly.
        var text = state.ToString();
        avatarStatusLabel.Text = hearingText is not null
            ? $"Hearing: \"{hearingText}\""
            : text.Length > 0 ? char.ToUpperInvariant(text[0]) + text[1..].ToLowerInvariant() : text;
        avatarStatusLabel.Invalidate(); // repaints the status dot too -- see OnPaintAvatarStatusDot
        avatarVisual.Invalidate();
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

    private void OnPaintAvatarStatusDot(object? sender, PaintEventArgs e)
    {
        var idle = avatarOverlay.CurrentState == AvatarState.Idle;
        using var dotBrush = new SolidBrush(idle ? Color.FromArgb(0x8f, 0xd1, 0x9e) : DarkTheme.Accent);
        e.Graphics.FillEllipse(dotBrush, 0, (avatarStatusLabel.Height - 5) / 2, 5, 5);
    }

    private void OnPaintAvatarCardBorder(object? sender, PaintEventArgs e)
    {
        var card = (Panel)sender!;
        using var pen = new Pen(DarkTheme.Border);
        e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
    }

    private void OpenSettings()
    {
        using var dialog = new SettingsDialog(backendClient, backendLog, () => voiceLoop.CurrentSessionId);
        dialog.ShowDialog(this);
        // #681: Settings > Presets persists the active preset straight to
        // ManaSettingsStore; pick up whatever it left there.
        voiceLoop.SetPresetId(ManaSettingsStore.Load().ActivePresetId);
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

    private void OnListDoubleClick(object? sender, MouseEventArgs e)
    {
        var item = list.GetItemAt(e.X, e.Y);
        if (item is not null)
        {
            SwitchTo((string)item.Tag!);
        }
    }

    private void SwitchToSelected()
    {
        if (list.SelectedItems.Count > 0)
        {
            SwitchTo((string)list.SelectedItems[0].Tag!);
        }
    }

    private void StartNewChat()
    {
        // No explicit "create session" call -- matches the reference:
        // node-bot's ensureSession lazily creates the row on the first
        // real turn sent with this id, not when the id is merely minted.
        SwitchTo(Guid.NewGuid().ToString());
    }

    private void SwitchTo(string sessionId)
    {
        if (sessionId == activeSessionId)
        {
            return;
        }
        activeSessionId = sessionId;
        voiceLoop.SetSessionId(sessionId);
        _ = RefreshAsync();
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

        var sessionId = (string)list.Items[e.Item].Tag!;
        try
        {
            await backendClient.RenameSessionAsync(sessionId, e.Label.Trim());
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: rename failed. {ex.Message}");
        }

        if (IsDisposed)
        {
            return;
        }
        await RefreshAsync();
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

        try
        {
            await backendClient.DeleteSessionAsync(sessionId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: delete failed. {ex.Message}");
        }

        if (IsDisposed)
        {
            return;
        }

        if (sessionId == activeSessionId)
        {
            StartNewChat();
        }
        else
        {
            await RefreshAsync();
        }
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

    private async Task ExportSelectedAsync()
    {
        if (list.SelectedItems.Count == 0)
        {
            return;
        }
        var sessionId = (string)list.SelectedItems[0].Tag!;

        string jsonl;
        try
        {
            jsonl = await backendClient.ExportSessionAsync(sessionId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: export failed. {ex.Message}");
            return;
        }

        if (IsDisposed)
        {
            return;
        }

        using var dialog = new SaveFileDialog
        {
            FileName = $"{sessionId}.jsonl",
            Filter = "JSON Lines (*.jsonl)|*.jsonl|All files (*.*)|*.*",
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            await File.WriteAllTextAsync(dialog.FileName, jsonl);
        }
    }

    public async Task RefreshAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaSession> sessions;
        try
        {
            sessions = await backendClient.GetSessionsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SessionListForm: failed to load sessions. {ex.Message}");
            return;
        }

        if (IsDisposed)
        {
            return;
        }

        list.BeginUpdate();
        list.Items.Clear();
        foreach (var session in sessions)
        {
            var item = new ListViewItem(SessionListFormatter.FormatDisplayName(session))
            {
                Tag = session.SessionId,
            };
            item.SubItems.Add(SessionListFormatter.FormatUpdatedAt(session.UpdatedAt));
            if (session.SessionId == activeSessionId)
            {
                item.Font = activeSessionFont;
                item.ForeColor = DarkTheme.Accent;
            }
            list.Items.Add(item);
        }
        list.EndUpdate();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            avatarOverlay.StateChanged -= OnAvatarStateChanged;
            activeSessionFont.Dispose();
            messageBoxFont.Dispose();
            avatarNameFont.Dispose();
            avatarStatusFont.Dispose();
            toolPanelTitleFont.Dispose();
            railToolTip.Dispose();
        }
        base.Dispose(disposing);
    }
}

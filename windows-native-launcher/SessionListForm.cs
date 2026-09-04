using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #520/#521: ports windows-launcher/renderer/session-sidebar.js's list/
// switch/rename/delete/export surface, plus (#521) a chat pane sharing
// this same window -- not the reference's "open memory" modal or goal
// editing (out of scope for either issue).
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
    private readonly ListView list = new();
    private readonly Button newChatButton = new();
    private readonly AvatarOverlayForm avatarOverlay;
    private readonly Panel avatarVisual = new();
    private readonly Button avatarZoomButton = new();
    private readonly Label avatarNameLabel = new();
    private readonly Label avatarStatusLabel = new();
    private readonly Font avatarNameFont;
    private readonly Font avatarStatusFont;

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

    // Mirrors VoiceLoop's own currentSessionId -- null (nothing switched
    // to yet) means node-bot's implicit "default" session, same starting
    // state VoiceLoop itself has.
    private string? activeSessionId;

    // Which rail placeholder (if any) the slide-out tool panel is
    // currently showing -- null means the panel is closed. See
    // ToggleToolPlaceholder.
    private string? openTool;

    public SessionListForm(ManaBackendClient backendClient, VoiceLoop voiceLoop, ChatLogPanel chatLog, AvatarOverlayForm avatarOverlay)
    {
        this.backendClient = backendClient;
        this.voiceLoop = voiceLoop;
        this.avatarOverlay = avatarOverlay;
        activeSessionFont = new Font(list.Font, FontStyle.Bold);

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
        newChatButton.ForeColor = ColorTranslator.FromHtml("#171513");
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
        contextMenu.Items.Add("Delete...", null, async (_, _) => await DeleteSelectedAsync());
        contextMenu.Items.Add("Export...", null, async (_, _) => await ExportSelectedAsync());
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
        // Sidebar is a fixed 240px wide (see sidebar's own Width below),
        // so avatarCard's client width is fixed too -- computed directly
        // rather than referencing avatarCard here, which isn't declared
        // yet at this point in the constructor.
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
        avatarStatusLabel.Padding = new Padding(14, 0, 0, 0); // room for the status dot painted by OnPaintAvatarVisual's sibling below
        avatarStatusLabel.ForeColor = DarkTheme.Muted;
        avatarStatusFont = new Font(avatarStatusLabel.Font.FontFamily, 8.5f);
        avatarStatusLabel.Font = avatarStatusFont;
        avatarStatusLabel.Paint += OnPaintAvatarStatusDot;

        var avatarCard = new Panel { Dock = DockStyle.Bottom, Height = 150, BackColor = DarkTheme.Panel, Padding = new Padding(10) };
        avatarCard.Paint += OnPaintAvatarCardBorder;
        // Dock order within avatarCard: the FIRST Top-docked child added
        // ends up at the very top (each subsequent one claims the
        // topmost strip of whatever's left, per this file's other
        // dock-order comments) -- so visual is added first to land on
        // top, then name, then status last so it lands at the bottom,
        // matching the reference's own visual/name/status markup order.
        avatarCard.Controls.Add(avatarVisual);
        avatarCard.Controls.Add(avatarNameLabel);
        avatarCard.Controls.Add(avatarStatusLabel);
        avatarCard.Controls.Add(avatarZoomButton);
        RefreshAvatarCard(avatarOverlay.CurrentState);
        // Unsubscribed in Dispose -- avatarOverlay outlives this form
        // (owned separately by ManaApplicationContext), so a live
        // subscription left dangling past this form's own disposal would
        // fire into disposed controls on every future avatar state change.
        avatarOverlay.StateChanged += OnAvatarStateChanged;

        var sidebar = new Panel { Dock = DockStyle.Left, Width = 240, BackColor = DarkTheme.Background };
        // Dock order matters here too (see MainForm's own comment on this
        // in #538): controls are added bottom-strip, top-strip, then the
        // list last so it gets whatever's left, rather than the list
        // (Dock.Fill) claiming all the space before the others get a
        // chance to stake theirs.
        sidebar.Controls.Add(avatarCard);
        sidebar.Controls.Add(newChatButton);
        sidebar.Controls.Add(list);

        var toolPanelLabel = new Label
        {
            Dock = DockStyle.Fill,
            ForeColor = DarkTheme.Muted,
            Padding = new Padding(12),
            TextAlign = ContentAlignment.TopLeft,
        };
        var toolPanel = new Panel
        {
            Dock = DockStyle.Right,
            Width = 220,
            Visible = false,
            BackColor = DarkTheme.Panel2,
        };
        toolPanel.Controls.Add(toolPanelLabel);

        var toolRail = new Panel { Dock = DockStyle.Right, Width = 44, BackColor = DarkTheme.Panel };
        // #538's own rail order (top to bottom): Browser, Terminal,
        // Artifacts, Tasks, then Settings. None of the first four exist
        // in this app yet -- kept as honest placeholders (clicking one
        // opens the same slide-out panel #538's own ToggleTool did,
        // saying so directly) rather than silently dead buttons.
        foreach (var (icon, label) in new[] { ("browser", "Browser"), ("terminal", "Terminal"), ("artifacts", "Artifacts"), ("tasks", "Background tasks") })
        {
            var button = MakeRailButton(icon, label);
            button.Click += (_, _) => ToggleToolPlaceholder(label, toolPanel, toolPanelLabel);
            toolRail.Controls.Add(button);
        }
        var railSettingsButton = MakeRailButton("settings", "Settings"); // the rail's one real, wired icon
        railSettingsButton.Click += (_, _) => OpenSettings();
        toolRail.Controls.Add(railSettingsButton);
        // Each Dock.Top control claims the topmost strip of whatever's
        // still unclaimed, in the order added -- so the four placeholders
        // (added by the loop above) land Browser/Terminal/Artifacts/Tasks
        // top-to-bottom, and Settings, added last, ends up at the bottom
        // of the rail. Matches #538's own top-to-bottom rail order.

        var chatArea = new Panel { Dock = DockStyle.Fill, BackColor = DarkTheme.Background };
        chatArea.Controls.Add(chatLog);

        // Same collapse toggle as Claude's own UI, and the design
        // reference's own #sidebarToggleBtn -- a persistent top strip
        // (not a child of `sidebar` itself, which is what gets hidden;
        // a button that disappears along with the panel it opens would
        // have no way to bring it back).
        var sidebarToggleButton = MakeRailButton("sidebar", "Toggle sidebar");
        sidebarToggleButton.Dock = DockStyle.Left;
        sidebarToggleButton.Width = 34;
        sidebarToggleButton.Height = 28;
        sidebarToggleButton.Click += (_, _) => sidebar.Visible = !sidebar.Visible;

        var topBar = new Panel { Dock = DockStyle.Top, Height = 28, BackColor = DarkTheme.Background };
        topBar.Controls.Add(sidebarToggleButton);

        // Dock order matters: a control added earlier claims its edge
        // first, so Fill has to go in last, once topBar/sidebar/toolRail/
        // toolPanel have already staked their strips (same rule #538's
        // own MainForm comment on this notes). topBar goes in before the
        // Left/Right ones specifically so it spans the FULL window width
        // at the top rather than just the strip between them -- claiming
        // its horizontal slice off the whole client area before sidebar/
        // toolRail have narrowed what's left. toolRail before toolPanel
        // so the icon strip stays outermost (nearest the window edge)
        // and the slide-out panel opens on its inner side.
        Controls.Add(topBar);
        Controls.Add(sidebar);
        Controls.Add(toolRail);
        Controls.Add(toolPanel);
        Controls.Add(chatArea);

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
    // of stacking a second panel.
    private void ToggleToolPlaceholder(string tool, Panel toolPanel, Label toolPanelLabel)
    {
        if (openTool == tool)
        {
            toolPanel.Visible = false;
            openTool = null;
            return;
        }
        openTool = tool;
        toolPanelLabel.Text = $"{tool}\n\nNot built yet.";
        toolPanel.Visible = true;
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
        avatarStatusLabel.Text = text.Length > 0 ? char.ToUpperInvariant(text[0]) + text[1..].ToLowerInvariant() : text;
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
        using var dialog = new SettingsDialog(backendClient);
        dialog.ShowDialog(this);
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
            avatarNameFont.Dispose();
            avatarStatusFont.Dispose();
            railToolTip.Dispose();
        }
        base.Dispose(disposing);
    }
}

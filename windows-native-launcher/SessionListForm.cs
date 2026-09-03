using System;
using System.Drawing;
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
    private readonly Label avatarStatusLabel = new();
    private readonly PictureBox avatarThumbnail = new();
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
        DarkTheme.ApplyButton(newChatButton);

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

        avatarThumbnail.Dock = DockStyle.Left;
        avatarThumbnail.Width = 40;
        avatarThumbnail.SizeMode = PictureBoxSizeMode.Zoom;

        avatarStatusLabel.Dock = DockStyle.Fill;
        avatarStatusLabel.TextAlign = ContentAlignment.MiddleLeft;
        avatarStatusLabel.Padding = new Padding(8, 0, 0, 0);
        avatarStatusLabel.ForeColor = DarkTheme.Muted;
        avatarStatusFont = new Font(avatarStatusLabel.Font.FontFamily, 8.5f);
        avatarStatusLabel.Font = avatarStatusFont;

        // Padding on the Panel itself, not Margin on the docked
        // thumbnail -- a plain Panel's layout only honors the parent's
        // own Padding for Dock-ed children, not a child's Margin.
        var avatarCard = new Panel { Dock = DockStyle.Bottom, Height = 52, BackColor = DarkTheme.Panel, Padding = new Padding(10, 8, 8, 8) };
        // #538's own sidebar card was a static "Avatar: idle" box; this
        // shows the same real idle/talking art AvatarOverlayForm's own
        // PNG-swap fallback path already loads (GetStaticImagePath),
        // plus the live status text, both kept in sync by
        // RefreshAvatarCard whenever the real overlay's state changes.
        avatarCard.Controls.Add(avatarThumbnail);
        avatarCard.Controls.Add(avatarStatusLabel);
        RefreshAvatarCard(avatarOverlay.CurrentState);
        // Unsubscribed in Dispose -- avatarOverlay outlives this form
        // (owned separately by ManaApplicationContext), so a live
        // subscription left dangling past this form's own disposal would
        // fire into disposed controls on every future avatar state change.
        avatarOverlay.StateChanged += OnAvatarStateChanged;

        var sidebar = new Panel { Dock = DockStyle.Left, Width = 240, BackColor = DarkTheme.Panel };
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
        foreach (var (glyph, label) in new[] { ("B", "Browser"), ("T", "Terminal"), ("A", "Artifacts"), ("…", "Background tasks") })
        {
            var button = MakeRailButton(glyph, label);
            button.Click += (_, _) => ToggleToolPlaceholder(label, toolPanel, toolPanelLabel);
            toolRail.Controls.Add(button);
        }
        var railSettingsButton = MakeRailButton("⚙", "Settings"); // gear -- the rail's one real, wired icon
        railSettingsButton.Click += (_, _) => OpenSettings();
        toolRail.Controls.Add(railSettingsButton);
        // Each Dock.Top control claims the topmost strip of whatever's
        // still unclaimed, in the order added -- so the four placeholders
        // (added by the loop above) land Browser/Terminal/Artifacts/Tasks
        // top-to-bottom, and Settings, added last, ends up at the bottom
        // of the rail. Matches #538's own top-to-bottom rail order.

        var chatArea = new Panel { Dock = DockStyle.Fill, BackColor = DarkTheme.Background };
        chatArea.Controls.Add(chatLog);

        // Dock order matters: a control added earlier claims its edge
        // first, so Fill has to go in last, once sidebar/toolRail/
        // toolPanel have already staked their strips (same rule #538's
        // own MainForm comment on this notes). toolRail before toolPanel
        // so the icon strip stays outermost (nearest the window edge)
        // and the slide-out panel opens on its inner side.
        Controls.Add(sidebar);
        Controls.Add(toolRail);
        Controls.Add(toolPanel);
        Controls.Add(chatArea);
    }

    private Button MakeRailButton(string glyph, string tooltip)
    {
        var button = new Button
        {
            Text = glyph,
            Dock = DockStyle.Top,
            Height = 44,
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Panel,
            ForeColor = DarkTheme.Muted,
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = DarkTheme.Panel2;
        railToolTip.SetToolTip(button, tooltip);
        return button;
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

    private void RefreshAvatarCard(AvatarState state)
    {
        avatarStatusLabel.Text = $"Avatar: {state.ToString().ToLowerInvariant()}";

        var imagePath = avatarOverlay.GetStaticImagePath(state);
        if (!File.Exists(imagePath))
        {
            return;
        }
        // Same leak-avoidance as AvatarOverlayForm's own PNG-swap path --
        // the previous Image isn't released just because a new one gets
        // assigned to PictureBox.Image.
        var previous = avatarThumbnail.Image;
        avatarThumbnail.Image = Image.FromFile(imagePath);
        previous?.Dispose();
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
            avatarStatusFont.Dispose();
            railToolTip.Dispose();
        }
        base.Dispose(disposing);
    }
}

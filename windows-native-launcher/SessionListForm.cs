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
// alongside its layout. Two real, deliberate departures from #538's own
// version: no FormBorderStyle.None/custom-drawn titlebar (this keeps the
// OS's native drag/resize/snap and keyboard/screen-reader behavior,
// which #538's version gave up and then needed a stateful AllowExit
// escape hatch to work around -- see DarkTheme.ApplyForm), and the rail
// only has a Settings icon, not #538's Browser/Terminal/Artifacts/Tasks
// icons -- none of those tools exist yet in this app; shipping dead
// buttons for them would be worse than #538's own "explicitly a
// scaffold" excuse, since this is the real, merged window.
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

    // Bolds the active session's row in RefreshAsync -- built once and
    // reused rather than a fresh Font per refresh, which leaked a GDI
    // handle every time the list reloaded (session switch/rename/delete/
    // new-chat) with no matching Dispose.
    private readonly Font activeSessionFont;

    // Mirrors VoiceLoop's own currentSessionId -- null (nothing switched
    // to yet) means node-bot's implicit "default" session, same starting
    // state VoiceLoop itself has.
    private string? activeSessionId;

    public SessionListForm(ManaBackendClient backendClient, VoiceLoop voiceLoop, ChatLogPanel chatLog)
    {
        this.backendClient = backendClient;
        this.voiceLoop = voiceLoop;
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

        var sidebar = new Panel { Dock = DockStyle.Left, Width = 240, BackColor = DarkTheme.Panel };
        // Dock order matters here too (see MainForm's own comment on this
        // in #538): the button has to be added first to claim the top
        // strip, so the list -- added second, Dock.Fill -- gets whatever
        // sidebar has left rather than the button trying to claim Top
        // out of space the list already filled.
        sidebar.Controls.Add(newChatButton);
        sidebar.Controls.Add(list);

        var railSettingsButton = new Button
        {
            Text = "⚙", // gear glyph -- the rail's one real, wired icon
            Dock = DockStyle.Top,
            Height = 44,
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Panel,
            ForeColor = DarkTheme.Muted,
        };
        railSettingsButton.FlatAppearance.BorderSize = 0;
        railSettingsButton.FlatAppearance.MouseOverBackColor = DarkTheme.Panel2;
        railSettingsButton.Click += (_, _) => OpenSettings();
        var toolRail = new Panel { Dock = DockStyle.Right, Width = 44, BackColor = DarkTheme.Panel };
        toolRail.Controls.Add(railSettingsButton);

        var chatArea = new Panel { Dock = DockStyle.Fill, BackColor = DarkTheme.Background };
        chatArea.Controls.Add(chatLog);

        // Dock order matters: a control added earlier claims its edge
        // first, so Fill has to go in last, once sidebar/toolRail have
        // already staked their strips (same rule #538's own MainForm
        // comment on this notes).
        Controls.Add(sidebar);
        Controls.Add(toolRail);
        Controls.Add(chatArea);
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
            activeSessionFont.Dispose();
        }
        base.Dispose(disposing);
    }
}

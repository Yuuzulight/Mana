using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #520: ports windows-launcher/renderer/session-sidebar.js's list/switch/
// rename/delete/export surface -- not its "open memory" modal or goal
// editing (both explicitly out of this issue's scope), and not message
// rendering (#521's chat window doesn't exist yet, so switching sessions
// here only changes which session VoiceLoop appends new turns to; it
// can't replay history into a chat log that doesn't exist yet either).
//
// A standalone window for now (windows-launcher's own version lives
// inside its main chat window's sidebar) -- created once and reused
// (Hide, not Close) by ManaApplicationContext, same lazy-create-and-
// reuse shape as QuickEntryForm.
internal sealed class SessionListForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly VoiceLoop voiceLoop;
    private readonly ListView list = new();
    private readonly Button newChatButton = new();

    // Mirrors VoiceLoop's own currentSessionId -- null (nothing switched
    // to yet) means node-bot's implicit "default" session, same starting
    // state VoiceLoop itself has.
    private string? activeSessionId;

    public SessionListForm(ManaBackendClient backendClient, VoiceLoop voiceLoop)
    {
        this.backendClient = backendClient;
        this.voiceLoop = voiceLoop;

        Text = "Mana Sessions";
        Width = 460;
        Height = 520;
        StartPosition = FormStartPosition.CenterScreen;

        newChatButton.Text = "New Chat";
        newChatButton.Dock = DockStyle.Top;
        newChatButton.Height = 32;
        newChatButton.Click += (_, _) => StartNewChat();

        list.Dock = DockStyle.Fill;
        list.View = View.Details;
        list.FullRowSelect = true;
        list.HideSelection = false;
        list.LabelEdit = true;
        list.Columns.Add("Name", 260);
        list.Columns.Add("Updated", 150);
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

        Controls.Add(list);
        Controls.Add(newChatButton);
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
                item.Font = new Font(list.Font, FontStyle.Bold);
            }
            list.Items.Add(item);
        }
        list.EndUpdate();
    }
}

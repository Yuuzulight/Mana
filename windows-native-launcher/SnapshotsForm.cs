using System;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #579: no Electron equivalent exists for this (node-bot's own
// /editors/workspace/snapshots routes have never had a consuming UI) --
// built directly from the API contract (zed-integration.js's
// listEditSnapshots/restoreEditSnapshot), same "orphaned-but-real backend
// capability" situation as the Hooks/MCP-registry tabs this batch already
// shipped. Standalone, non-modal, fresh-per-open -- same shape as
// CompareModeForm, since restoring a snapshot shouldn't block the rest
// of the app.
internal sealed class SnapshotsForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly ListView list = new();
    private readonly Button restoreButton = new();
    private readonly Label statusLabel = new();

    public SnapshotsForm(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        Text = "Mana Edit Snapshots";
        Width = 720;
        Height = 480;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        list.Dock = DockStyle.Fill;
        list.View = View.Details;
        list.FullRowSelect = true;
        list.Columns.Add("File", 260);
        list.Columns.Add("Summary", 280);
        list.Columns.Add("Recorded", 140);
        DarkTheme.ApplyListView(list);

        statusLabel.Dock = DockStyle.Bottom;
        statusLabel.Height = 20;
        statusLabel.ForeColor = DarkTheme.Muted;
        statusLabel.Padding = new Padding(4, 0, 0, 0);

        restoreButton.Text = "Restore Selected";
        restoreButton.Dock = DockStyle.Bottom;
        restoreButton.Height = 30;
        restoreButton.Click += async (_, _) => await RestoreSelectedAsync();
        DarkTheme.ApplyButton(restoreButton);

        Controls.Add(list);
        Controls.Add(statusLabel);
        Controls.Add(restoreButton);

        Load += async (_, _) => await RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaEditSnapshot> snapshots;
        try
        {
            snapshots = await backendClient.GetEditSnapshotsAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                statusLabel.Text = $"Could not reach the backend: {ex.Message}";
            }
            return;
        }

        if (IsDisposed)
        {
            return;
        }

        list.Items.Clear();
        foreach (var snapshot in snapshots)
        {
            var item = new ListViewItem(snapshot.RelativePath) { Tag = snapshot.Id };
            item.SubItems.Add(snapshot.Summary ?? "");
            item.SubItems.Add(snapshot.AppliedAt ?? "");
            list.Items.Add(item);
        }
        statusLabel.Text = snapshots.Count == 0 ? "No snapshots recorded yet." : "";
    }

    // Deliberately no conflict check against the file's current content
    // client-side -- restoreEditSnapshot's own stale check (comparing
    // against whatever the latest snapshot for that same file is) is the
    // real safety net; this just surfaces its 409 as a confirm prompt
    // instead of a dead end, then retries with confirmStale:true.
    private async Task RestoreSelectedAsync()
    {
        if (list.SelectedItems.Count == 0)
        {
            return;
        }
        var item = list.SelectedItems[0];
        var id = (string)item.Tag!;
        var relativePath = item.Text;

        restoreButton.Enabled = false;
        statusLabel.Text = "Restoring...";
        try
        {
            var result = await backendClient.RestoreEditSnapshotAsync(id);
            if (IsDisposed)
            {
                return;
            }

            if (result.Stale)
            {
                var confirmed = MessageBox.Show(
                    this,
                    $"{relativePath} has been written to again since this snapshot was recorded" +
                        (result.NewerAppliedAt is not null ? $" (a newer snapshot exists from {result.NewerAppliedAt})" : "") +
                        ".\n\nRestore this older snapshot anyway?",
                    "Snapshot Is Stale",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning) == DialogResult.Yes;
                if (!confirmed)
                {
                    statusLabel.Text = "Restore cancelled.";
                    return;
                }

                result = await backendClient.RestoreEditSnapshotAsync(id, confirmStale: true);
                if (IsDisposed)
                {
                    return;
                }
            }

            statusLabel.Text = result.Restored ? $"Restored {relativePath}." : $"Restore failed: {result.Error ?? "unknown error"}";
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                statusLabel.Text = $"Restore failed: {ex.Message}";
            }
        }
        finally
        {
            if (!IsDisposed)
            {
                restoreButton.Enabled = true;
            }
        }
    }
}

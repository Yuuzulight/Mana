using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #580: no Electron equivalent exists for this (node-bot's own
// /editors/workspace/proposals routes have never had a consuming UI) --
// built directly from the API contract (zed-integration.js's
// listEditProposals/getEditProposal/approveEditProposal), same
// orphaned-but-real-backend-capability situation as #579's SnapshotsForm.
// "Default all checked" (every hunk's checkbox starts checked, matching
// the server's own "omitted acceptedHunkIds approves every hunk" default
// behavior) is the one UI convention explicitly called out by this
// issue's own text. Standalone, non-modal, fresh-per-open, same shape as
// CompareModeForm/SnapshotsForm.
internal sealed class ProposalsForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly ListView list = new();
    private readonly FlowLayoutPanel hunksPanel = new();
    private readonly Button approveButton = new();
    private readonly Label statusLabel = new();

    private string? selectedProposalId;
    private readonly Dictionary<string, CheckBox> hunkCheckboxes = new();

    // Bumped at the start of every LoadSelectedDetailAsync call and
    // captured locally -- rapidly changing the list selection (arrow-key
    // held down, fast clicking) can start a second load before the
    // first's GetProposalDetailAsync await resolves; without this guard,
    // the first call's stale response could land after the second one
    // already cleared and repopulated the panel, showing the wrong
    // proposal's hunks.
    private int loadGeneration;

    public ProposalsForm(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        Text = "Mana Pending Edits";
        Width = 900;
        Height = 600;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        list.Dock = DockStyle.Left;
        list.Width = 300;
        list.View = View.Details;
        list.FullRowSelect = true;
        list.Columns.Add("File", 180);
        list.Columns.Add("Summary", 200);
        list.Columns.Add("Hunks", 50);
        list.SelectedIndexChanged += async (_, _) => await LoadSelectedDetailAsync();
        DarkTheme.ApplyListView(list);

        hunksPanel.Dock = DockStyle.Fill;
        hunksPanel.FlowDirection = FlowDirection.TopDown;
        hunksPanel.WrapContents = false;
        hunksPanel.AutoScroll = true;
        hunksPanel.BackColor = DarkTheme.Background;
        hunksPanel.Padding = new Padding(8);

        statusLabel.Dock = DockStyle.Bottom;
        statusLabel.Height = 20;
        statusLabel.ForeColor = DarkTheme.Muted;
        statusLabel.Padding = new Padding(4, 0, 0, 0);

        approveButton.Text = "Approve Selected Hunks";
        approveButton.Dock = DockStyle.Bottom;
        approveButton.Height = 30;
        approveButton.Enabled = false;
        approveButton.Click += async (_, _) => await ApproveAsync();
        DarkTheme.ApplyButton(approveButton);

        var detailPanel = new Panel { Dock = DockStyle.Fill, BackColor = DarkTheme.Background };
        detailPanel.Controls.Add(hunksPanel);
        detailPanel.Controls.Add(statusLabel);
        detailPanel.Controls.Add(approveButton);

        Controls.Add(detailPanel);
        Controls.Add(list);

        Load += async (_, _) => await RefreshListAsync();
    }

    private async Task RefreshListAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaProposalSummary> proposals;
        try
        {
            proposals = await backendClient.GetProposalsAsync();
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
        foreach (var proposal in proposals)
        {
            var item = new ListViewItem(proposal.RelativePath) { Tag = proposal.Id };
            item.SubItems.Add(proposal.Summary ?? "");
            item.SubItems.Add(proposal.HunkCount.ToString());
            list.Items.Add(item);
        }
        statusLabel.Text = proposals.Count == 0 ? "No pending edits." : "";
    }

    private async Task LoadSelectedDetailAsync()
    {
        var generation = ++loadGeneration;
        ClearHunks();
        approveButton.Enabled = false;
        selectedProposalId = null;

        if (list.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)list.SelectedItems[0].Tag!;

        ManaProposalDetail? detail;
        try
        {
            detail = await backendClient.GetProposalDetailAsync(id);
        }
        catch (Exception ex)
        {
            if (!IsDisposed && generation == loadGeneration)
            {
                statusLabel.Text = $"Could not load this proposal: {ex.Message}";
            }
            return;
        }

        if (IsDisposed || generation != loadGeneration)
        {
            return;
        }

        if (detail is null)
        {
            statusLabel.Text = "This proposal no longer exists.";
            return;
        }

        selectedProposalId = detail.Id;
        foreach (var hunk in detail.Hunks)
        {
            hunksPanel.Controls.Add(BuildHunkPanel(hunk));
        }
        approveButton.Enabled = detail.Hunks.Count > 0;
        statusLabel.Text = "";
    }

    private void ClearHunks()
    {
        foreach (Control control in hunksPanel.Controls)
        {
            control.Dispose();
        }
        hunksPanel.Controls.Clear();
        hunkCheckboxes.Clear();
    }

    private Panel BuildHunkPanel(ManaProposalHunk hunk)
    {
        var checkBox = new CheckBox
        {
            Text = $"@@ -{hunk.OldStart},{hunk.OldLines} +{hunk.NewStart},{hunk.NewLines} @@",
            Checked = true,
            AutoSize = true,
            ForeColor = DarkTheme.Text,
            Dock = DockStyle.Top,
        };
        hunkCheckboxes[hunk.Id] = checkBox;

        var diffText = new TextBox
        {
            Text = string.Join(Environment.NewLine, hunk.Lines),
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.None,
            Font = new Font("Consolas", 9F),
            BackColor = DarkTheme.Panel,
            ForeColor = DarkTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            Dock = DockStyle.Top,
            Height = Math.Max(24, (hunk.Lines.Count + 1) * 16),
        };

        var container = new Panel
        {
            Width = hunksPanel.ClientSize.Width - hunksPanel.Padding.Horizontal - 24,
            Height = checkBox.Height + diffText.Height + 28,
            BackColor = DarkTheme.Background,
            Margin = new Padding(0, 0, 0, 12),
        };
        // Dock order: checkBox added first claims the top strip, diffText
        // (added second) claims the strip immediately below it -- same
        // dock-order convention this codebase uses everywhere else.
        container.Controls.Add(checkBox);
        container.Controls.Add(diffText);
        return container;
    }

    private async Task ApproveAsync()
    {
        if (selectedProposalId is null)
        {
            return;
        }
        var acceptedHunkIds = hunkCheckboxes.Where(kv => kv.Value.Checked).Select(kv => kv.Key).ToList();

        approveButton.Enabled = false;
        statusLabel.Text = "Approving...";
        try
        {
            var result = await backendClient.ApproveProposalAsync(selectedProposalId, acceptedHunkIds);
            if (IsDisposed)
            {
                return;
            }

            if (result.Approved)
            {
                statusLabel.Text = "Approved.";
                ClearHunks();
                await RefreshListAsync();
            }
            else
            {
                statusLabel.Text = $"Approve failed: {result.Error ?? "unknown error"}";
                approveButton.Enabled = true;
            }
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                statusLabel.Text = $"Approve failed: {ex.Message}";
                approveButton.Enabled = true;
            }
        }
    }
}

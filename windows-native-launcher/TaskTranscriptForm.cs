using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1318: a background task's step log (GET /background-tasks/:id/transcript),
// opened from its card's "View transcript". One line per step (description,
// status, duration); expanding a step shows its file, command and result
// preview. Refreshes every 2 s while the task is still running, keeping
// which steps are expanded.
internal sealed class TaskTranscriptForm : Form
{
    private const int RefreshMs = 2000;

    private readonly ManaBackendClient client;
    private readonly string taskId;
    private readonly Func<bool> stillRunning;
    private readonly Func<DateTimeOffset> now;
    private readonly System.Windows.Forms.Timer refreshTimer = new() { Interval = RefreshMs };
    private readonly Label statusLabel = new() { Dock = DockStyle.Top, Height = 24, Padding = new Padding(8, 4, 8, 0), AutoEllipsis = true };
    private readonly TreeView steps = new() { Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, ShowLines = false, FullRowSelect = true, HideSelection = false, AccessibleName = "Steps" };
    private readonly Dictionary<string, TreeNode> nodes = new();
    private bool refreshing;

    // stillRunning: whether to keep polling (the panel's latest status).
    public TaskTranscriptForm(ManaBackendClient client, ManaBackgroundTask task, Func<bool> stillRunning, Func<DateTimeOffset>? now = null)
    {
        this.client = client;
        taskId = task.Id;
        this.stillRunning = stillRunning;
        this.now = now ?? (() => DateTimeOffset.Now);
        Text = $"Transcript: {task.Title}";
        AccessibleName = Text;
        Size = new Size(560, 420);
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9F);
        DarkTheme.ApplyForm(this);
        steps.BackColor = DarkTheme.Panel;
        steps.ForeColor = DarkTheme.Text;
        statusLabel.ForeColor = DarkTheme.Muted;
        Controls.Add(steps);
        Controls.Add(statusLabel);
        refreshTimer.Tick += async (_, _) => await RefreshAsync();
    }

    internal TreeView Steps => steps;
    internal Label StatusLabel => statusLabel;
    internal bool Polling => refreshTimer.Enabled;

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        await RefreshAsync();
    }

    internal async Task RefreshAsync()
    {
        if (refreshing)
        {
            return;
        }
        refreshing = true;
        ManaTaskTranscript? transcript = null;
        string? error = null;
        try
        {
            transcript = await client.GetBackgroundTaskTranscriptAsync(taskId);
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }
        finally
        {
            refreshing = false;
        }
        if (IsDisposed)
        {
            return;
        }
        refreshTimer.Enabled = stillRunning();
        if (error is not null)
        {
            statusLabel.Text = $"Couldn't load the transcript: {error}";
            return;
        }
        var list = transcript?.Steps ?? [];
        statusLabel.Text = list.Count == 0 ? "No steps yet." : $"{list.Count} {(list.Count == 1 ? "step" : "steps")}{(refreshTimer.Enabled ? ", still running" : "")}";
        statusLabel.AccessibleName = statusLabel.Text;
        ShowSteps(list);
    }

    private void ShowSteps(IReadOnlyList<ManaTaskStep> list)
    {
        var at = now();
        steps.BeginUpdate();
        for (var i = 0; i < list.Count; i++)
        {
            var step = list[i];
            // Keyed by id so an expanded step stays expanded across refreshes.
            var key = string.IsNullOrEmpty(step.Id) ? $"#{i}" : step.Id;
            if (!nodes.TryGetValue(key, out var node))
            {
                node = new TreeNode();
                nodes[key] = node;
                steps.Nodes.Add(node);
            }
            node.Text = BackgroundTaskText.StepLine(step, at);
            node.ForeColor = step.Status switch
            {
                "failed" => DarkTheme.Warn,
                "awaiting_approval" => DarkTheme.Warn,
                "running" => DarkTheme.Accent,
                _ => DarkTheme.Text,
            };
            var detail = BackgroundTaskText.StepDetail(step);
            var joined = string.Join("\n", detail);
            if (!Equals(node.Tag, joined))
            {
                node.Tag = joined;
                node.Nodes.Clear();
                foreach (var line in detail)
                {
                    node.Nodes.Add(new TreeNode(line) { ForeColor = DarkTheme.Muted });
                }
            }
        }
        steps.EndUpdate();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            refreshTimer.Dispose();
        }
        base.Dispose(disposing);
    }
}

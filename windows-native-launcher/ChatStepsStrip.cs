using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1318: the fallback for steps without a segment (an older backend): the
// tool steps of the reply in progress, one compact grey line per
// group ("Ran a command, used 4 tools... Run the tests  +19 -0 >"), each
// expanding into its steps and each step into its command and result.
// Polls GET /agent/activity once a second, only while she's replying (plus
// one last poll for the final statuses); the lines stay until the next
// reply's run replaces them. The wording lives in ChatStepGroups. Steps
// with a segment go to ChatView.ShowSteps instead, inline in the chat.
internal sealed class ChatStepsStrip : FlowLayoutPanel
{
    // Not a theme token: no preset has a red yet.
    internal static readonly Color RemovedColor = Color.IndianRed;

    private readonly ManaBackendClient backendClient;
    private readonly Func<bool> isReplying;
    private readonly ChatView chatView;
    private readonly System.Windows.Forms.Timer pollTimer = new() { Interval = 500 };
    private readonly HashSet<int> openGroups = new();
    private readonly HashSet<string> openSteps = new();
    private readonly Font font = new("Segoe UI", 9F);
    private readonly Font detailFont = new("Consolas", 8.5F);

    private AgentSteps? activity;
    private string? shownSignature;
    private bool wasReplying;
    private bool polling;

    public ChatStepsStrip(ManaBackendClient backendClient, ChatView chatView, Func<bool> isReplying)
    {
        this.backendClient = backendClient;
        this.isReplying = isReplying;
        this.chatView = chatView;
        Dock = DockStyle.Bottom;
        FlowDirection = FlowDirection.TopDown;
        WrapContents = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16, 2, 12, 2);
        BackColor = DarkTheme.Background;
        AccessibleName = "Mana's steps";
        Visible = false;
        pollTimer.Tick += async (_, _) => await TickAsync();
        pollTimer.Start();
    }

    private async Task TickAsync()
    {
        var replying = isReplying();
        // One more poll after the reply ends, for the final statuses.
        if ((!replying && !wasReplying) || polling)
        {
            return;
        }
        wasReplying = replying;
        polling = true;
        try
        {
            var fresh = await backendClient.GetAgentStepsAsync();
            if (fresh.RunId != activity?.RunId)
            {
                openGroups.Clear();
                openSteps.Clear();
            }
            activity = fresh;
            chatView.ShowSteps(fresh);
        }
        catch
        {
            // Ambient and best-effort, like AgentActivityPanel.
        }
        finally
        {
            polling = false;
        }
        if (!IsDisposed)
        {
            Render();
        }
    }

    private void Render()
    {
        var now = DateTimeOffset.UtcNow;
        var groups = activity is null ? new List<StepGroup>() : ChatStepGroups.Group(activity).Where(g => g.Segment is null).ToList();
        var signature = string.Join("\n", groups.Select((g, i) =>
            g.Line + g.Added + g.Removed + (openGroups.Contains(i)
                ? string.Concat(g.Steps.Select(s => ChatStepGroups.StepLine(s, now) + openSteps.Contains(s.Id)))
                : "")));
        if (signature == shownSignature)
        {
            return;
        }
        shownSignature = signature;

        SuspendLayout();
        while (Controls.Count > 0)
        {
            Controls[0].Dispose();
        }
        for (var i = 0; i < groups.Count; i++)
        {
            AddGroup(groups[i], i, now);
        }
        Visible = groups.Count > 0;
        ResumeLayout();
    }

    private void AddGroup(StepGroup group, int index, DateTimeOffset now)
    {
        var open = openGroups.Contains(index);
        var row = Row(new Padding(0, 2, 0, 2));
        row.Controls.Add(MakeLabel(group.Line, DarkTheme.Muted));
        if (group.ChangedFiles)
        {
            row.Controls.Add(MakeLabel($"+{group.Added}", DarkTheme.Green));
            row.Controls.Add(MakeLabel($"−{group.Removed}", RemovedColor));
        }
        MakeToggle(row, open, $"{group.Summary}, {(open ? "collapse" : "expand")} steps", () => Toggle(openGroups, index));
        Controls.Add(row);
        if (!open)
        {
            return;
        }
        foreach (var step in group.Steps)
        {
            var hasDetail = !string.IsNullOrWhiteSpace(step.Command) || !string.IsNullOrWhiteSpace(step.ResultPreview);
            var stepOpen = openSteps.Contains(step.Id);
            var stepRow = Row(new Padding(16, 0, 0, 0));
            stepRow.Controls.Add(MakeLabel(ChatStepGroups.StepLine(step, now), step.Status == "failed" ? RemovedColor : DarkTheme.Muted));
            if (hasDetail)
            {
                MakeToggle(stepRow, stepOpen, $"{step.Description}, {(stepOpen ? "hide" : "show")} command and result", () => Toggle(openSteps, step.Id));
            }
            Controls.Add(stepRow);
            if (hasDetail && stepOpen)
            {
                var detail = string.Join(Environment.NewLine + Environment.NewLine,
                    new[] { step.Command is { Length: > 0 } c ? "$ " + c : null, step.ResultPreview }.Where(t => !string.IsNullOrWhiteSpace(t)));
                Controls.Add(new TextBox
                {
                    Text = detail.ReplaceLineEndings(Environment.NewLine),
                    ReadOnly = true,
                    Multiline = true,
                    ScrollBars = ScrollBars.Vertical,
                    BorderStyle = BorderStyle.None,
                    Font = detailFont,
                    BackColor = DarkTheme.Panel2,
                    ForeColor = DarkTheme.Text,
                    Size = new Size(Math.Max(240, Width - 64), 96),
                    Margin = new Padding(32, 2, 0, 4),
                    AccessibleName = "Step command and result",
                });
            }
        }
    }

    private void Toggle<T>(HashSet<T> open, T key)
    {
        if (!open.Remove(key))
        {
            open.Add(key);
        }
        shownSignature = null;
        // Not inside the click: Render disposes the control being clicked.
        BeginInvoke(Render);
    }

    private static FlowLayoutPanel Row(Padding margin) => new()
    {
        FlowDirection = FlowDirection.LeftToRight,
        WrapContents = false,
        AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        Margin = margin,
        Cursor = Cursors.Hand,
    };

    private Label MakeLabel(string text, Color color) => new()
    {
        Text = text,
        AutoSize = true,
        ForeColor = color,
        Font = font,
        Margin = new Padding(0, 0, 6, 0),
        UseMnemonic = false,
    };

    // The whole row toggles on a click; its chevron is a real button, so
    // the keyboard and screen readers get it too.
    private void MakeToggle(FlowLayoutPanel row, bool open, string name, Action toggle)
    {
        var chevron = new Button
        {
            Text = open ? "⌄" : "›",
            FlatStyle = FlatStyle.Flat,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = Padding.Empty,
            Margin = Padding.Empty,
            Font = font,
            ForeColor = DarkTheme.Muted,
            BackColor = DarkTheme.Background,
            AccessibleName = name,
        };
        chevron.FlatAppearance.BorderSize = 0;
        row.Controls.Add(chevron);
        row.Click += (_, _) => toggle();
        foreach (Control child in row.Controls)
        {
            child.Click += (_, _) => toggle();
            child.Cursor = Cursors.Hand;
        }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            pollTimer.Dispose();
            font.Dispose();
            detailFont.Dispose();
        }
        base.Dispose(disposing);
    }
}

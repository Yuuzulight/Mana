using System;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #646: what the chat tool loop is doing right now -- the running tool and
// for how long -- with a Stop button. Same ambient shape as
// BrowserAutomationPanel: borderless, always on top, polls GET
// /agent/activity every second and only shows while a run has called a
// tool. Top-right so it never covers that panel (bottom-right), and it
// never takes focus from whatever the user is doing.
internal sealed class AgentActivityPanel : Form
{
    private const int PollIntervalMs = 1000;

    private readonly ManaBackendClient backendClient;
    private readonly System.Windows.Forms.Timer pollTimer;
    private readonly Label statusLabel = new();
    private readonly Button stopButton = new();

    private string? runId;
    private bool polling;

    public AgentActivityPanel(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = DarkTheme.Panel;
        Width = 280;
        Height = 56;
        Visible = false;

        statusLabel.Dock = DockStyle.Fill;
        statusLabel.ForeColor = DarkTheme.Text;
        statusLabel.Font = new Font("Segoe UI", 8.5F);
        statusLabel.Padding = new Padding(8, 6, 4, 6);

        stopButton.Dock = DockStyle.Right;
        stopButton.Width = 64;
        stopButton.Text = "Stop";
        DarkTheme.ApplyButton(stopButton);
        stopButton.Click += async (_, _) => await StopAsync();

        Controls.Add(statusLabel);
        Controls.Add(stopButton);

        // Same constructor-time handle as BrowserAutomationPanel -- the
        // timer can tick before the form is ever shown.
        _ = Handle;
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(area.Right - Width - 16, area.Top + 16);

        pollTimer = new System.Windows.Forms.Timer { Interval = PollIntervalMs };
        pollTimer.Tick += async (_, _) => await PollAsync();
        pollTimer.Start();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExToolWindow = 0x80;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExToolWindow | wsExNoActivate;
            return cp;
        }
    }

    private async Task PollAsync()
    {
        // A slow backend mustn't pile up a request per tick.
        if (polling)
        {
            return;
        }
        polling = true;
        ManaAgentRun? run;
        try
        {
            // ponytail: shows the first live run only; a roster when
            // parallel runs (the coding hub, #702) actually exist.
            run = (await backendClient.GetAgentActivityAsync()).FirstOrDefault();
        }
        catch
        {
            // Ambient and best-effort, like BrowserAutomationPanel.
            run = null;
        }
        finally
        {
            polling = false;
        }

        if (IsDisposed)
        {
            return;
        }

        if (run is null)
        {
            runId = null;
            Visible = false;
            return;
        }

        if (run.Id != runId)
        {
            runId = run.Id;
            stopButton.Enabled = true;
        }
        stopButton.Enabled &= !run.Stopping;
        statusLabel.Text = Describe(run);
        Visible = true;
    }

    private async Task StopAsync()
    {
        if (runId is null)
        {
            return;
        }
        stopButton.Enabled = false;
        try
        {
            await backendClient.StopAgentRunAsync(runId);
        }
        catch
        {
            if (!IsDisposed)
            {
                stopButton.Enabled = true;
            }
        }
    }

    internal static string Describe(ManaAgentRun run)
    {
        var now = run.Stopping
            ? "Stopping..."
            : run.Tool is not null
                ? $"Running {run.Tool} ({FormatElapsed(run.ToolElapsedMs ?? 0)})"
                : $"Thinking (last: {run.LastTool})";
        var calls = run.ToolCount == 1 ? "1 tool call" : $"{run.ToolCount} tool calls";
        return $"{now}{Environment.NewLine}{FormatElapsed(run.ElapsedMs)} so far, {calls}";
    }

    private static string FormatElapsed(long ms) =>
        ms < 60_000 ? $"{ms / 1000}s" : $"{ms / 60_000}m {ms / 1000 % 60:00}s";

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            pollTimer.Dispose();
        }
        base.Dispose(disposing);
    }
}

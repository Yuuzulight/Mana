using System;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #577: ports windows-launcher/renderer.js's own deep-research UI (the
// deepResearchBtn/researchProgress/researchCancelBtn markup) into its own
// standalone window -- the reference embeds this in its single chat
// panel's composer; this launcher has no equivalent "current session's
// composer" outside SessionListForm/QuickEntryForm, so a dedicated
// window is the natural fit instead, non-modal and fresh-per-open, same
// shape as CompareModeForm.
internal sealed class ResearchForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly Func<string?> getSessionId;
    private readonly TextBox questionBox = new();
    private readonly Button startButton = new();
    private readonly Button cancelButton = new();
    private readonly Label progressLabel = new();
    private readonly TextBox reportBox = new();

    // Non-null only while a job is running -- also this form's re-entrancy
    // guard (StartAsync no-ops if one is already in flight), same role
    // CompareModeForm's own runCts plays.
    private string? currentJobId;

    public ResearchForm(ManaBackendClient backendClient, Func<string?> getSessionId)
    {
        this.backendClient = backendClient;
        this.getSessionId = getSessionId;

        Text = "Mana Deep Research";
        Width = 720;
        Height = 560;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        var topRow = new TableLayoutPanel { Dock = DockStyle.Top, Height = 32, ColumnCount = 3, BackColor = DarkTheme.Background };
        questionBox.Dock = DockStyle.Fill;
        questionBox.BackColor = DarkTheme.Panel;
        questionBox.ForeColor = DarkTheme.Text;
        questionBox.BorderStyle = BorderStyle.FixedSingle;
        startButton.Text = "Research";
        startButton.Dock = DockStyle.Fill;
        startButton.Click += async (_, _) => await StartAsync();
        DarkTheme.ApplyButton(startButton);
        cancelButton.Text = "Cancel";
        cancelButton.Dock = DockStyle.Fill;
        cancelButton.Enabled = false;
        cancelButton.Click += async (_, _) => await CancelAsync();
        DarkTheme.ApplyButton(cancelButton);
        topRow.Controls.Add(questionBox, 0, 0);
        topRow.Controls.Add(startButton, 1, 0);
        topRow.Controls.Add(cancelButton, 2, 0);
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 70));
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 15));
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 15));

        progressLabel.Dock = DockStyle.Top;
        progressLabel.Height = 24;
        progressLabel.ForeColor = DarkTheme.Muted;
        progressLabel.Padding = new Padding(4, 4, 0, 0);

        reportBox.Multiline = true;
        reportBox.ReadOnly = true;
        reportBox.ScrollBars = ScrollBars.Vertical;
        reportBox.Dock = DockStyle.Fill;
        reportBox.BackColor = DarkTheme.Panel;
        reportBox.ForeColor = DarkTheme.Text;
        reportBox.BorderStyle = BorderStyle.FixedSingle;

        Controls.Add(reportBox);
        Controls.Add(progressLabel);
        Controls.Add(topRow);
    }

    private async Task StartAsync()
    {
        var question = questionBox.Text.Trim();
        if (question.Length == 0 || currentJobId is not null)
        {
            return;
        }

        reportBox.Text = "";
        progressLabel.Text = "Starting research...";
        startButton.Enabled = false;
        cancelButton.Enabled = true;

        try
        {
            currentJobId = await backendClient.StartResearchAsync(question, getSessionId());
            await PollAsync(currentJobId);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                reportBox.Text = $"Research failed: {ex.Message}";
            }
        }
        finally
        {
            currentJobId = null;
            if (!IsDisposed)
            {
                startButton.Enabled = true;
                cancelButton.Enabled = false;
                progressLabel.Text = "";
            }
        }
    }

    // Polls every 600ms, matching windows-launcher's own pollResearchJob
    // exactly -- deep research runs for tens of seconds to a few minutes
    // (see tools/deep-research.js's own clamps), so this isn't a tight
    // loop.
    private async Task PollAsync(string jobId)
    {
        while (true)
        {
            var job = await backendClient.GetResearchJobAsync(jobId);
            if (IsDisposed)
            {
                return;
            }

            if (job.Status == "done" && job.Result is not null)
            {
                reportBox.Text = ResearchFormatter.FormatReply(job.Result);
                return;
            }
            if (job.Status == "cancelled")
            {
                reportBox.Text = "Research cancelled.";
                return;
            }
            if (job.Status == "error")
            {
                reportBox.Text = $"Research failed: {job.Error ?? "unknown error"}";
                return;
            }

            progressLabel.Text = string.IsNullOrEmpty(job.ProgressLabel) ? "Researching..." : job.ProgressLabel;
            await Task.Delay(600);
        }
    }

    private async Task CancelAsync()
    {
        if (currentJobId is null)
        {
            return;
        }
        progressLabel.Text = "Cancelling...";
        try
        {
            await backendClient.CancelResearchJobAsync(currentJobId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"ResearchForm: cancel request failed. {ex.Message}");
        }
    }
}

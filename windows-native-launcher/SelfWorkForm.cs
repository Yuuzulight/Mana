using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1008: "What I'm working on" -- Mana's work on her own code (node-bot's
// /self-work routes, self-work.js). Refreshes every 3 s while open. The
// issue box hands her one of my issues; Stop ends her run at her next
// step, leaving the work in her worktree. Standalone and fresh per open,
// like ResearchForm.
internal sealed class SelfWorkForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly TextBox issueBox = new();
    private readonly Button startButton = new();
    private readonly Button stopButton = new();
    private readonly Label summaryLabel = new();
    private readonly LinkLabel prLink = new();
    private readonly TextBox stepsBox = new();
    private readonly Label noteLabel = new();
    private readonly System.Windows.Forms.Timer refreshTimer = new() { Interval = 3000 };

    public SelfWorkForm(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        Text = "What I'm working on";
        Width = 640;
        Height = 460;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        var topRow = new TableLayoutPanel { Dock = DockStyle.Top, Height = 32, ColumnCount = 3, BackColor = DarkTheme.Background };
        issueBox.Dock = DockStyle.Fill;
        issueBox.PlaceholderText = "Issue number for her to work on";
        issueBox.BackColor = DarkTheme.Panel;
        issueBox.ForeColor = DarkTheme.Text;
        issueBox.BorderStyle = BorderStyle.FixedSingle;
        startButton.Text = "Start";
        startButton.Dock = DockStyle.Fill;
        startButton.Click += async (_, _) => await StartAsync();
        DarkTheme.ApplyButton(startButton);
        stopButton.Text = "Stop";
        stopButton.Dock = DockStyle.Fill;
        stopButton.Enabled = false;
        stopButton.Click += async (_, _) => await StopAsync();
        DarkTheme.ApplyButton(stopButton);
        topRow.Controls.Add(issueBox, 0, 0);
        topRow.Controls.Add(startButton, 1, 0);
        topRow.Controls.Add(stopButton, 2, 0);
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 60));
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20));
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20));

        noteLabel.Dock = DockStyle.Top;
        noteLabel.Height = 22;
        noteLabel.ForeColor = DarkTheme.Muted;
        noteLabel.Padding = new Padding(4, 4, 0, 0);

        summaryLabel.Dock = DockStyle.Top;
        summaryLabel.Height = 64;
        summaryLabel.ForeColor = DarkTheme.Text;
        summaryLabel.Padding = new Padding(4, 6, 0, 0);

        prLink.Dock = DockStyle.Top;
        prLink.Height = 22;
        prLink.Padding = new Padding(4, 0, 0, 0);
        prLink.LinkColor = DarkTheme.Accent;
        prLink.LinkClicked += (_, _) => OpenPr(prLink.Tag as string);

        stepsBox.Multiline = true;
        stepsBox.ReadOnly = true;
        stepsBox.ScrollBars = ScrollBars.Vertical;
        stepsBox.Dock = DockStyle.Fill;
        stepsBox.BackColor = DarkTheme.Panel;
        stepsBox.ForeColor = DarkTheme.Text;
        stepsBox.BorderStyle = BorderStyle.FixedSingle;

        Controls.Add(stepsBox);
        Controls.Add(prLink);
        Controls.Add(summaryLabel);
        Controls.Add(noteLabel);
        Controls.Add(topRow);

        refreshTimer.Tick += async (_, _) => await RefreshAsync();
        Load += async (_, _) =>
        {
            refreshTimer.Start();
            await RefreshAsync();
        };
        FormClosed += (_, _) => refreshTimer.Dispose();
    }

    private static readonly Dictionary<string, string> StateWords = new()
    {
        ["running"] = "working on it",
        ["pr-open"] = "PR ready for your review",
        ["needs-you"] = "needs you",
        ["paused"] = "paused",
        ["stuck"] = "stuck, stopped",
        ["stopped"] = "stopped",
        ["not-done"] = "couldn't finish",
        ["tests-failing"] = "tests failing, no PR",
        ["no-change"] = "nothing to change",
        ["failed"] = "failed",
    };

    internal static string Describe(ManaSelfWorkStatus status)
    {
        if (status.Issue is null)
        {
            return "I'm not working on my own code right now.";
        }
        var state = StateWords.TryGetValue(status.State, out var words) ? words : status.State;
        return $"#{status.Issue}: {status.Title}{Environment.NewLine}" +
            $"{char.ToUpperInvariant(state[0])}{state[1..]} -- {status.Step}{Environment.NewLine}" +
            $"{status.Branch} in {status.Worktree}";
    }

    // Only a GitHub page opens from here.
    internal static bool IsPrUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && uri.Host == "github.com";

    internal static void OpenPr(string? url)
    {
        if (IsPrUrl(url))
        {
            Process.Start(new ProcessStartInfo(url!) { UseShellExecute = true })?.Dispose();
        }
    }

    private async Task RefreshAsync()
    {
        ManaSelfWorkStatus status;
        try
        {
            status = await backendClient.GetSelfWorkAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                summaryLabel.Text = $"Could not reach the backend: {ex.Message}";
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        summaryLabel.Text = Describe(status);
        stepsBox.Text = string.Join(Environment.NewLine, status.Log);
        prLink.Text = status.PrUrl ?? "";
        prLink.Tag = status.PrUrl;
        var running = status.State == "running";
        stopButton.Enabled = running;
        startButton.Enabled = !running;
    }

    private async Task StartAsync()
    {
        if (!int.TryParse(issueBox.Text.Trim().TrimStart('#'), out var issue) || issue <= 0)
        {
            noteLabel.Text = "Give me an issue number.";
            return;
        }
        startButton.Enabled = false;
        noteLabel.Text = "";
        try
        {
            var refused = await backendClient.StartSelfWorkAsync(issue);
            if (refused is not null && !IsDisposed)
            {
                noteLabel.Text = refused;
                startButton.Enabled = true;
                return;
            }
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                noteLabel.Text = $"Couldn't start: {ex.Message}";
                startButton.Enabled = true;
            }
            return;
        }
        await RefreshAsync();
    }

    private async Task StopAsync()
    {
        stopButton.Enabled = false;
        try
        {
            await backendClient.StopSelfWorkAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                noteLabel.Text = $"Couldn't stop: {ex.Message}";
            }
        }
        await RefreshAsync();
    }
}

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1121: the chat rail's Terminal tool, "Mana's runs": every command she
// runs (node-bot/terminal-feed.js) with its output, exit code and time.
// Read-only. It polls GET /terminal/runs once a second while it's on
// screen. Stop goes through the stop path of whatever ran the command (the
// chat tool loop's Stop, self-work's stop); nothing can be started here.
internal sealed class TerminalTool : Panel
{
    private const int PollIntervalMs = 1000;

    // What the filter shows -> the run's source ("" = all of them).
    internal static readonly (string Label, string Source)[] Filters =
    [
        ("All", ""),
        ("Chat", "chat"),
        ("Self-work", "self-work"),
        ("Hooks", "hook"),
        ("MCP servers", "mcp"),
        ("Editor", "editor"),
    ];

    private readonly ManaBackendClient client;
    private readonly System.Windows.Forms.Timer pollTimer = new() { Interval = PollIntervalMs };
    private readonly ComboBox filterBox = new() { Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = "Show runs from" };
    private readonly ListView runList = new() { Dock = DockStyle.Top, Height = 150, View = View.Details, FullRowSelect = true, HideSelection = false, MultiSelect = false, AccessibleName = "Commands Mana ran" };
    private readonly Label detailLabel = new() { Dock = DockStyle.Top, Height = 34, ForeColor = DarkTheme.Muted, Padding = new Padding(4, 2, 4, 0), AutoEllipsis = true };
    private readonly TextBox outputBox = new() { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, WordWrap = false, ScrollBars = ScrollBars.Both, BorderStyle = BorderStyle.None, AccessibleName = "Output" };
    private readonly Button copyButton = new() { Text = "Copy output", Dock = DockStyle.Left, Width = 96, AccessibleName = "Copy output" };
    private readonly Button stopButton = new() { Text = "Stop", Dock = DockStyle.Right, Width = 64, AccessibleName = "Stop this command" };
    private readonly Font outputFont = new("Consolas", 9F);

    private IReadOnlyList<ManaTerminalRun> runs = Array.Empty<ManaTerminalRun>();
    private string? selectedId;
    private ManaTerminalRun? selected;
    private string? error;
    private bool polling;
    private bool again;
    private bool rendering;

    // Tests swap this out so they never touch the real clipboard.
    internal Action<string> CopyText { get; set; } = Clipboard.SetText;

    public TerminalTool(ManaBackendClient client)
    {
        this.client = client;
        BackColor = DarkTheme.Panel2;
        Padding = new Padding(6);

        foreach (var (label, _) in Filters)
        {
            filterBox.Items.Add(label);
        }
        filterBox.SelectedIndex = 0;
        filterBox.SelectedIndexChanged += (_, _) =>
        {
            selectedId = null;
            Render();
            _ = RefreshAsync();
        };

        runList.Columns.Add("Command", 150);
        runList.Columns.Add("Source", 64);
        runList.Columns.Add("Result", 60);
        runList.Columns.Add("Time", 52);
        DarkTheme.ApplyListView(runList);
        runList.SelectedIndexChanged += (_, _) =>
        {
            if (rendering || runList.SelectedItems.Count == 0)
            {
                return;
            }
            selectedId = (string)runList.SelectedItems[0].Tag!;
            selected = null;
            Render();
            _ = RefreshAsync();
        };

        outputBox.Font = outputFont;
        outputBox.BackColor = DarkTheme.Background;
        outputBox.ForeColor = DarkTheme.Text;

        DarkTheme.ApplyButton(copyButton);
        DarkTheme.ApplyButton(stopButton);
        copyButton.Click += (_, _) =>
        {
            if (!string.IsNullOrEmpty(selected?.Output))
            {
                CopyText(selected.Output);
            }
        };
        stopButton.Click += async (_, _) => await StopAsync();
        var buttonRow = new Panel { Dock = DockStyle.Bottom, Height = 32, Padding = new Padding(0, 4, 0, 0) };
        buttonRow.Controls.Add(copyButton);
        buttonRow.Controls.Add(stopButton);

        // Last added docks first: the filter on top, then the list and the
        // run's details, the buttons at the bottom, the output fills the rest.
        Controls.Add(outputBox);
        Controls.Add(buttonRow);
        Controls.Add(detailLabel);
        Controls.Add(runList);
        Controls.Add(filterBox);

        pollTimer.Tick += async (_, _) => await RefreshAsync();
        VisibleChanged += (_, _) =>
        {
            pollTimer.Enabled = Visible;
            if (Visible)
            {
                _ = RefreshAsync();
            }
        };
        Render();
    }

    internal string Filter => Filters[Math.Max(0, filterBox.SelectedIndex)].Source;

    internal IEnumerable<ManaTerminalRun> ShownRuns => runs.Where(r => Filter.Length == 0 || r.Source == Filter);

    // One poll: the list, and the selected run with its output.
    internal async Task RefreshAsync()
    {
        // A slow backend mustn't pile up a request per tick; a click during
        // a poll (a filter, a run) gets one more poll after it.
        if (polling)
        {
            again = true;
            return;
        }
        polling = true;
        do
        {
            again = false;
            try
            {
                runs = await client.GetTerminalRunsAsync();
                // Dropped off the feed: the newest one is picked instead.
                if (runs.All(r => r.Id != selectedId))
                {
                    selectedId = null;
                }
                selectedId ??= ShownRuns.FirstOrDefault()?.Id;
                // Its output once, then again only while it runs: every poll
                // counts against the backend's app-wide rate limit.
                if (selectedId is null)
                {
                    selected = null;
                }
                else if (selected?.Id != selectedId || selected.Running)
                {
                    selected = await client.GetTerminalRunAsync(selectedId);
                }
                error = null;
            }
            catch (Exception ex)
            {
                error = $"Couldn't read her runs: {ex.Message}";
            }
        }
        while (again && !IsDisposed);
        polling = false;
        if (!IsDisposed)
        {
            Render();
        }
    }

    private async Task StopAsync()
    {
        if (selected is not { Stoppable: true })
        {
            return;
        }
        stopButton.Enabled = false;
        try
        {
            if (!await client.StopTerminalRunAsync(selected.Id))
            {
                error = "It had already finished.";
            }
        }
        catch (Exception ex)
        {
            error = $"Couldn't stop it: {ex.Message}";
        }
        if (!IsDisposed)
        {
            await RefreshAsync();
        }
    }

    private void Render()
    {
        rendering = true;
        runList.BeginUpdate();
        var top = runList.IsHandleCreated ? runList.TopItem?.Index ?? 0 : 0;
        runList.Items.Clear();
        foreach (var run in ShownRuns)
        {
            var item = new ListViewItem([run.Command, run.Source, Result(run), FormatTime(run)]) { Tag = run.Id };
            item.Selected = run.Id == selectedId;
            runList.Items.Add(item);
        }
        if (top > 0 && top < runList.Items.Count)
        {
            runList.TopItem = runList.Items[top];
        }
        runList.EndUpdate();
        rendering = false;

        var output = selected is null ? "" : selected.Output.ReplaceLineEndings("\r\n");
        if (outputBox.Text != output)
        {
            outputBox.Text = output;
            outputBox.SelectionStart = output.Length;
            outputBox.ScrollToCaret();
        }
        detailLabel.Text = error ?? (selected is null ? (runs.Count == 0 ? "She hasn't run any commands yet." : "") : Describe(selected));
        copyButton.Enabled = !string.IsNullOrEmpty(selected?.Output);
        stopButton.Enabled = selected is { Stoppable: true };
    }

    internal static string Result(ManaTerminalRun run) =>
        run.Running ? "running" : run.ExitCode is int code ? $"exit {code}" : "ended";

    internal static string FormatTime(ManaTerminalRun run)
    {
        var ms = run.DurationMs ?? Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - run.StartedAt);
        return ms < 1000 ? $"{ms}ms" : ms < 60_000 ? $"{ms / 1000.0:0.#}s" : $"{ms / 60_000}m {ms / 1000 % 60:00}s";
    }

    internal static string Describe(ManaTerminalRun run)
    {
        var started = DateTimeOffset.FromUnixTimeMilliseconds(run.StartedAt).ToLocalTime().ToString("HH:mm:ss");
        var cut = run.DroppedChars > 0 ? " (earlier output cut)" : "";
        return $"In {run.Cwd}, started {started}{cut}";
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            pollTimer.Dispose();
            outputFont.Dispose();
        }
        base.Dispose(disposing);
    }
}

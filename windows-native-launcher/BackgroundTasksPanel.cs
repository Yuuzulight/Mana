using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1125: the chat rail's Background tasks tool, opened in #1118's tool
// panel. Everything Mana is doing or has scheduled (GET /background-tasks,
// #1124), grouped by kind: a status chip, when it runs ("next in 12 min",
// "running 3 min"), a thin progress bar and Cancel where the backend has a
// real stop. Self-work has its own section with a button to the "What I'm
// working on" window. Refreshes every 3 s, only while visible.
//
// The bar: determinate where the backend counts progress (with "about N
// min left" when it sends an ETA); an animated sweep for running work it
// can't measure, still when Windows' animation effects are off, and
// stopped while the panel is hidden.
//
// #1318: running work leads as a "Running" section of cards (title, "Agent
// 38s", model, tokens, tool uses, what it's doing now, View transcript and
// Stop); finished tasks sit last in a compact "Finished" list.
internal sealed class BackgroundTasksPanel : Panel
{
    private const int RefreshMs = 3000;
    private const int FrameMs = 50;

    // Group order and titles; an unknown kind goes last under its own name.
    private static readonly (string Kind, string Title)[] Groups =
    [
        ("agent", "Chat"),
        ("research", "Research"),
        ("model", "Models"),
        ("memory", "Memory"),
        ("reminder", "Reminders"),
        ("cron", "Scheduled jobs"),
        ("heartbeat", "Heartbeat checks"),
        ("briefing", "Briefing"),
        ("proactive", "Waiting to tell you"),
    ];

    internal const string RunningTitle = "Running";
    internal const string FinishedTitle = "Finished";

    private static readonly string[] StatusOrder = ["running", "waiting", "scheduled", "paused", "failed", "done"];

    private readonly ManaBackendClient client;
    private readonly Action openSelfWork;
    private readonly Func<DateTimeOffset> now;
    private readonly bool animate = GlassShimmer.AnimationsEnabled();
    private readonly System.Windows.Forms.Timer refreshTimer = new() { Interval = RefreshMs };
    private readonly System.Windows.Forms.Timer frameTimer = new() { Interval = FrameMs };

    private readonly Panel errorRow = new() { Dock = DockStyle.Top, Height = 40, Visible = false, Padding = new Padding(8, 6, 8, 6), AccessibleName = "Error" };
    private readonly Label errorLabel = new() { Dock = DockStyle.Fill, ForeColor = DarkTheme.Warn, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly Button retryButton = new() { Text = "Retry", Dock = DockStyle.Right, Width = 60, AccessibleName = "Retry loading background tasks" };
    private readonly Panel list = new() { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(8, 4, 8, 4), AccessibleName = "Background tasks", AccessibleRole = AccessibleRole.List };
    private readonly Label emptyLabel = new() { Dock = DockStyle.Top, Height = 40, Text = "Nothing running right now", TextAlign = ContentAlignment.MiddleCenter, ForeColor = DarkTheme.Muted, AccessibleName = "Nothing running right now" };
    private readonly Panel selfWorkSection = new() { Dock = DockStyle.Bottom, Padding = new Padding(8, 4, 8, 8), AccessibleName = "Self-work" };
    private readonly Label selfWorkIdle = new() { Dock = DockStyle.Top, Height = 22, Text = "I'm not working on my own code right now.", ForeColor = DarkTheme.Muted, AccessibleName = "I'm not working on my own code right now." };
    private readonly TaskRow selfWorkRow;
    private readonly Button openSelfWorkButton = new() { Text = "Open What I'm working on", Dock = DockStyle.Top, Height = 28, AccessibleName = "Open What I'm working on" };

    private readonly Dictionary<string, TaskRow> rows = new();
    private readonly Dictionary<string, TaskCard> cards = new();
    private readonly Dictionary<string, ManaBackgroundTask> latest = new();
    private readonly Dictionary<string, TaskTranscriptForm> transcripts = new();
    private readonly Action<ManaBackgroundTask> openTranscript;
    private readonly Dictionary<string, Label> headers = new();
    private static readonly Font HeaderFont = new("Segoe UI", 8.5F, FontStyle.Bold);
    private bool refreshing;
    private bool selfWorkShown;
    private double phase = 0.5;

    // openSelfWork/now/openTranscript: tests pass fakes; by default the
    // self-work window, the clock and the transcript window.
    public BackgroundTasksPanel(ManaBackendClient client, Action? openSelfWork = null, Func<DateTimeOffset>? now = null, Action<ManaBackgroundTask>? openTranscript = null)
    {
        this.client = client;
        this.openSelfWork = openSelfWork ?? (() => new SelfWorkForm(client).Show());
        this.now = now ?? (() => DateTimeOffset.Now);
        this.openTranscript = openTranscript ?? OpenTranscript;
        Dock = DockStyle.Fill;
        BackColor = DarkTheme.Panel2;
        AccessibleName = "Background tasks";

        DarkTheme.ApplyButton(retryButton);
        retryButton.Click += async (_, _) => await RefreshAsync();
        errorLabel.AccessibleName = "Error";
        errorRow.Controls.Add(errorLabel);
        errorRow.Controls.Add(retryButton);

        selfWorkRow = new TaskRow(CancelAsync) { Visible = false };
        DarkTheme.ApplyButton(openSelfWorkButton);
        openSelfWorkButton.Click += (_, _) => this.openSelfWork();
        var selfWorkTitle = new Label { Dock = DockStyle.Top, Height = 24, Text = "Self-work", Font = HeaderFont, ForeColor = DarkTheme.Muted, TextAlign = ContentAlignment.BottomLeft, AccessibleName = "Self-work" };
        // Docked last-added-first: title, then the run (or idle), then the button.
        selfWorkSection.Controls.AddRange([openSelfWorkButton, selfWorkIdle, selfWorkRow, selfWorkTitle]);
        selfWorkSection.Height = SelfWorkHeight();

        list.Controls.Add(emptyLabel);
        Controls.Add(list);
        Controls.Add(selfWorkSection);
        Controls.Add(errorRow);
        errorRow.TabIndex = 0;
        list.TabIndex = 1;
        selfWorkSection.TabIndex = 2;

        refreshTimer.Tick += async (_, _) => await RefreshAsync();
        frameTimer.Tick += (_, _) =>
        {
            phase = (phase + FrameMs / 1400.0) % 1;
            foreach (var row in AllRows().Where(r => r.Indeterminate))
            {
                row.Phase = phase;
            }
            foreach (var card in cards.Values)
            {
                card.Phase = phase;
            }
        };
    }

    internal bool Polling => refreshTimer.Enabled;
    internal bool Animating => frameTimer.Enabled;
    internal Label EmptyLabel => emptyLabel;
    internal Panel ErrorRow => errorRow;
    internal Label ErrorLabel => errorLabel;
    internal Button RetryButton => retryButton;
    internal Button OpenSelfWorkButton => openSelfWorkButton;
    internal TaskRow SelfWorkRow => selfWorkRow;

    // The rows and group headers top to bottom, as shown.
    internal IReadOnlyList<Control> ListItems => list.Controls.Cast<Control>().Reverse().Where(c => c != emptyLabel).ToList();

    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        SetActive(Visible);
    }

    // Added to an already-open tool panel: no VisibleChanged for that.
    protected override void OnParentChanged(EventArgs e)
    {
        base.OnParentChanged(e);
        SetActive(Visible);
    }

    // Polls (and animates) only while the panel is on screen; showing it
    // refreshes straight away.
    internal void SetActive(bool active)
    {
        if (active != refreshTimer.Enabled)
        {
            refreshTimer.Enabled = active;
            if (active)
            {
                _ = RefreshAsync();
            }
        }
        UpdateAnimation();
    }

    internal async Task RefreshAsync()
    {
        // A slow backend mustn't pile up a request per tick.
        if (refreshing)
        {
            return;
        }
        refreshing = true;
        IReadOnlyList<ManaBackgroundTask>? tasks = null;
        string? error = null;
        try
        {
            tasks = await client.GetBackgroundTasksAsync();
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
        if (tasks is null)
        {
            ShowError($"Couldn't reach Mana: {error}");
            return;
        }
        errorRow.Visible = false;
        ShowTasks(tasks);
    }

    private void ShowError(string text)
    {
        errorLabel.Text = text;
        errorLabel.AccessibleName = text;
        errorRow.Visible = true;
        // Not "nothing running": I just can't tell.
        emptyLabel.Visible = false;
    }

    private void ShowTasks(IReadOnlyList<ManaBackgroundTask> tasks)
    {
        var at = now();
        var ordered = new List<Control>();
        var keptRows = new HashSet<string>();
        var keptHeaders = new HashSet<string>();
        latest.Clear();
        foreach (var task in tasks)
        {
            latest[task.Id] = task;
        }
        void AddHeader(string title)
        {
            if (!headers.TryGetValue(title, out var header))
            {
                header = new Label { Dock = DockStyle.Top, Height = 26, Text = title, Font = HeaderFont, ForeColor = DarkTheme.Muted, TextAlign = ContentAlignment.BottomLeft, AccessibleName = title, AccessibleRole = AccessibleRole.Grouping };
                headers[title] = header;
            }
            keptHeaders.Add(title);
            ordered.Add(header);
        }

        var others = tasks.Where(t => t.Kind != "self-work").ToList();
        var running = Group(others.Where(t => t.Status == "running")).SelectMany(g => g.Tasks).ToList();
        if (running.Count > 0)
        {
            AddHeader(RunningTitle);
        }
        var keptCards = new HashSet<string>();
        foreach (var task in running)
        {
            if (!cards.TryGetValue(task.Id, out var card))
            {
                card = new TaskCard(CancelAsync, openTranscript);
                cards[task.Id] = card;
            }
            card.SetTask(task, at);
            keptCards.Add(task.Id);
            ordered.Add(card);
        }
        // Scheduled/waiting work by kind as before, then finished, newest first.
        var finished = others.Where(t => t.Status is "done" or "failed").OrderByDescending(t => t.EndedAt ?? t.StartedAt ?? DateTimeOffset.MinValue).ToList();
        var groups = Group(others.Where(t => t.Status != "running" && !finished.Contains(t))).ToList();
        if (finished.Count > 0)
        {
            groups.Add((FinishedTitle, finished));
        }
        foreach (var (title, items) in groups)
        {
            AddHeader(title);
            foreach (var task in items)
            {
                if (!rows.TryGetValue(task.Id, out var row))
                {
                    row = new TaskRow(CancelAsync);
                    rows[task.Id] = row;
                }
                row.SetTask(task, at);
                keptRows.Add(task.Id);
                ordered.Add(row);
            }
        }

        // Rebuilt only when the order changes, so focus stays on a row that's still there.
        if (!ordered.SequenceEqual(ListItems))
        {
            list.SuspendLayout();
            list.Controls.Clear();
            list.Controls.Add(emptyLabel);
            // Docked last-added-first.
            for (var i = ordered.Count - 1; i >= 0; i--)
            {
                list.Controls.Add(ordered[i]);
            }
            for (var i = 0; i < ordered.Count; i++)
            {
                ordered[i].TabIndex = i;
            }
            list.ResumeLayout();
        }
        foreach (var id in rows.Keys.Where(id => !keptRows.Contains(id)).ToList())
        {
            rows[id].Dispose();
            rows.Remove(id);
        }
        foreach (var id in cards.Keys.Where(id => !keptCards.Contains(id)).ToList())
        {
            cards[id].Dispose();
            cards.Remove(id);
        }
        foreach (var title in headers.Keys.Where(t => !keptHeaders.Contains(t)).ToList())
        {
            headers[title].Dispose();
            headers.Remove(title);
        }
        emptyLabel.Visible = ordered.Count == 0;

        var selfWork = tasks.FirstOrDefault(t => t.Kind == "self-work");
        if (selfWork is not null)
        {
            selfWorkRow.SetTask(selfWork, at);
        }
        selfWorkShown = selfWork is not null;
        selfWorkRow.Visible = selfWorkShown;
        selfWorkIdle.Visible = !selfWorkShown;
        selfWorkSection.Height = SelfWorkHeight();
        UpdateAnimation();
    }

    private int SelfWorkHeight() =>
        selfWorkSection.Padding.Vertical + 24 + openSelfWorkButton.Height
        + (selfWorkShown ? selfWorkRow.Height : selfWorkIdle.Height);

    private IEnumerable<TaskRow> AllRows() => selfWorkShown ? rows.Values.Append(selfWorkRow) : rows.Values;

    private void UpdateAnimation() =>
        frameTimer.Enabled = animate && refreshTimer.Enabled && (AllRows().Any(r => r.Indeterminate) || cards.Values.Any(c => c.Indeterminate));

    // One transcript window per task; opening it again brings it forward.
    private void OpenTranscript(ManaBackgroundTask task)
    {
        if (transcripts.TryGetValue(task.Id, out var open) && !open.IsDisposed)
        {
            open.Activate();
            return;
        }
        var form = new TaskTranscriptForm(client, task, () => latest.TryGetValue(task.Id, out var t) && t.Status == "running", now);
        transcripts[task.Id] = form;
        form.FormClosed += (_, _) => transcripts.Remove(task.Id);
        form.Show(FindForm());
    }

    private Task CancelAsync(TaskRow row) => CancelAsync(row.Task, enabled => row.CancelEnabled = enabled);

    private Task CancelAsync(TaskCard card) => CancelAsync(card.Task, enabled => card.StopEnabled = enabled);

    private async Task CancelAsync(ManaBackgroundTask? task, Action<bool> setEnabled)
    {
        if (task is null)
        {
            return;
        }
        setEnabled(false);
        try
        {
            // False: it ended (or can't stop) meanwhile; the refresh shows which.
            await client.CancelBackgroundTaskAsync(task.Id);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                ShowError($"Couldn't cancel {task.Title}: {ex.Message}");
                setEnabled(true);
            }
            return;
        }
        await RefreshAsync();
    }

    // Grouped in Groups' order; inside a group, running first, then the
    // soonest next run.
    internal static IReadOnlyList<(string Title, IReadOnlyList<ManaBackgroundTask> Tasks)> Group(IEnumerable<ManaBackgroundTask> tasks)
    {
        int GroupRank(string kind)
        {
            var i = Array.FindIndex(Groups, g => g.Kind == kind);
            return i < 0 ? Groups.Length : i;
        }
        int StatusRank(string status)
        {
            var i = Array.IndexOf(StatusOrder, status);
            return i < 0 ? StatusOrder.Length : i;
        }
        return tasks
            .GroupBy(t => t.Kind)
            .OrderBy(g => GroupRank(g.Key))
            .ThenBy(g => g.Key, StringComparer.Ordinal)
            .Select(g => (
                GroupRank(g.Key) < Groups.Length ? Groups[GroupRank(g.Key)].Title : g.Key,
                (IReadOnlyList<ManaBackgroundTask>)g.OrderBy(t => StatusRank(t.Status)).ThenBy(t => t.NextRunAt ?? DateTimeOffset.MaxValue).ToList()))
            .ToList();
    }

    internal static string StatusLabel(string status) => status switch
    {
        "running" => "Running",
        "scheduled" => "Scheduled",
        "waiting" => "Waiting",
        "paused" => "Paused",
        "done" => "Done",
        "failed" => "Failed",
        _ => status,
    };

    // "running 3 min", "next in 12 min", "due now"; "" when there's no time to say.
    internal static string When(ManaBackgroundTask task, DateTimeOffset now) => task.Status switch
    {
        "running" => task.StartedAt is { } started ? $"running {Span(now - started)}" : "running",
        "scheduled" when task.NextRunAt is { } next => next <= now ? "due now" : $"next in {Span(next - now)}",
        "done" or "failed" when task.StartedAt is { } started => $"started {Span(now - started)} ago",
        _ => "",
    };

    internal static string Span(TimeSpan span)
    {
        if (span < TimeSpan.Zero)
        {
            span = TimeSpan.Zero;
        }
        if (span.TotalMinutes < 1)
        {
            return $"{(int)span.TotalSeconds} s";
        }
        if (span.TotalHours < 1)
        {
            return $"{(int)span.TotalMinutes} min";
        }
        if (span.TotalDays < 2)
        {
            return span.Minutes == 0 ? $"{(int)span.TotalHours} h" : $"{(int)span.TotalHours} h {span.Minutes} min";
        }
        return $"{(int)span.TotalDays} days";
    }

    // Only for running work the backend measures: "40%", "5 of 20 rounds",
    // and "about 3 min left" when there's an ETA. A countdown (unit "ms")
    // on a scheduled task is just its bar; the time is in When.
    internal static string ProgressText(ManaBackgroundTask task)
    {
        if (task.Status != "running" || task.Progress is not { } progress)
        {
            return "";
        }
        var text = progress.Unit is "rounds" or "sources" or "files"
            ? $"{progress.Done:0} of {progress.Total:0} {progress.Unit}"
            : $"{(int)Math.Floor(progress.Fraction * 100)}%";
        return task.EtaSeconds is { } eta ? $"{text}, {Eta(eta)}" : text;
    }

    internal static string Eta(double seconds) =>
        seconds < 60 ? "less than a minute left"
        : seconds < 3600 ? $"about {(int)Math.Ceiling(seconds / 60)} min left"
        : $"about {Math.Round(seconds / 3600, 1):0.#} h left";

    internal enum BarKind { None, Determinate, Indeterminate }

    // No made-up percentages: a running task without measured progress
    // gets the sweep, never a guessed fill.
    internal static BarKind Bar(ManaBackgroundTask task) =>
        task.Progress is not null && task.Status is "running" or "scheduled" ? BarKind.Determinate
        : task.Status == "running" ? BarKind.Indeterminate
        : BarKind.None;

    internal static string Describe(ManaBackgroundTask task, DateTimeOffset now) =>
        string.Join(", ", new[] { task.Title, StatusLabel(task.Status), When(task, now), ProgressText(task), task.Detail }.Where(s => !string.IsNullOrEmpty(s)));

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            refreshTimer.Dispose();
            frameTimer.Dispose();
        }
        base.Dispose(disposing);
    }

    // #1318: one running task. Title, then "Agent 38s · model · tokens ·
    // tool uses", then what it's doing now, then View transcript and the
    // bar; Stop where the backend can really stop it. Words come from
    // BackgroundTaskText; colours from DarkTheme at paint time.
    internal sealed class TaskCard : Control
    {
        private static readonly Font TitleFont = new("Segoe UI", 9F, FontStyle.Bold);
        private static readonly Font SmallFont = new("Segoe UI", 8F);
        private readonly Button stopButton = new() { Text = "Stop", Width = 60, Height = 22, Visible = false };
        private readonly LinkLabel transcriptLink = new() { Text = "View transcript", AutoSize = true, Location = new Point(6, 64), Visible = false };
        private string meta = "";
        private string action = "";
        private double phase = 0.5;

        public TaskCard(Func<TaskCard, Task> stop, Action<ManaBackgroundTask> openTranscript)
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = true;
            Dock = DockStyle.Top;
            Height = 92;
            AccessibleRole = AccessibleRole.ListItem;
            DarkTheme.ApplyButton(stopButton);
            stopButton.Font = SmallFont;
            stopButton.Click += async (_, _) => await stop(this);
            transcriptLink.Font = SmallFont;
            transcriptLink.LinkClicked += (_, _) =>
            {
                if (Task is { } task)
                {
                    openTranscript(task);
                }
            };
            Controls.Add(stopButton);
            Controls.Add(transcriptLink);
        }

        public ManaBackgroundTask? Task { get; private set; }
        public Button StopButton => stopButton;
        public LinkLabel TranscriptLink => transcriptLink;
        public string MetaText => meta;
        public string ActionText => action;
        public bool Indeterminate => Task is { } t && Bar(t) == BarKind.Indeterminate;

        public bool StopEnabled
        {
            get => stopButton.Enabled;
            set => stopButton.Enabled = value;
        }

        public double Phase
        {
            get => phase;
            set
            {
                phase = value;
                if (Indeterminate)
                {
                    Invalidate();
                }
            }
        }

        public void SetTask(ManaBackgroundTask task, DateTimeOffset now)
        {
            var newTask = Task?.Id != task.Id;
            Task = task;
            Text = task.Title;
            meta = BackgroundTaskText.Meta(task, now);
            action = BackgroundTaskText.Action(task);
            AccessibleName = BackgroundTaskText.CardName(task, now);
            stopButton.Visible = task.Stoppable;
            stopButton.AccessibleName = $"Stop {task.Title}";
            if (newTask || !task.Stoppable)
            {
                stopButton.Enabled = true;
            }
            // No link until the backend keeps a step log for it.
            transcriptLink.Visible = !string.IsNullOrEmpty(task.TranscriptUrl);
            transcriptLink.AccessibleName = $"View transcript of {task.Title}";
            transcriptLink.BackColor = DarkTheme.Panel;
            transcriptLink.LinkColor = transcriptLink.ActiveLinkColor = transcriptLink.VisitedLinkColor = DarkTheme.Accent;
            Invalidate();
        }

        protected override void OnGotFocus(EventArgs e)
        {
            base.OnGotFocus(e);
            Invalidate();
        }

        protected override void OnLostFocus(EventArgs e)
        {
            base.OnLostFocus(e);
            Invalidate();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            stopButton.Location = new Point(Width - stopButton.Width - 6, 5);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(DarkTheme.Panel);
            using (var line = new Pen(DarkTheme.Border))
            {
                g.DrawLine(line, 0, Height - 1, Width, Height - 1);
            }
            if (Task is null)
            {
                return;
            }
            const int x = 8;
            var right = Width - 8 - (stopButton.Visible ? stopButton.Width + 6 : 0);
            var flags = TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter;
            TextRenderer.DrawText(g, Task.Title, TitleFont, new Rectangle(x, 5, Math.Max(0, right - x), 20), DarkTheme.Text, flags);
            TextRenderer.DrawText(g, meta, SmallFont, new Rectangle(x, 26, Math.Max(0, Width - 2 * x), 16), DarkTheme.Muted, flags);
            TextRenderer.DrawText(g, action, SmallFont, new Rectangle(x, 43, Math.Max(0, Width - 2 * x), 18), DarkTheme.Text, flags);

            // Same bar as TaskRow's: measured fill, else the sweep.
            var track = new Rectangle(x, Height - 9, Math.Max(0, Width - 2 * x), 3);
            using var trackBrush = new SolidBrush(DarkTheme.Border);
            using var fill = new SolidBrush(DarkTheme.Accent);
            g.FillRectangle(trackBrush, track);
            if (Task.Progress is { } progress)
            {
                g.FillRectangle(fill, track.X, track.Y, (int)(track.Width * progress.Fraction), track.Height);
            }
            else
            {
                var band = (int)(track.Width * 0.3);
                var left = track.X + (int)((track.Width + band) * phase) - band;
                var visible = Rectangle.Intersect(track, new Rectangle(left, track.Y, band, track.Height));
                if (!visible.IsEmpty)
                {
                    g.FillRectangle(fill, visible);
                }
            }
            if (Focused)
            {
                ControlPaint.DrawFocusRectangle(g, new Rectangle(1, 1, Width - 2, Height - 3), DarkTheme.Text, DarkTheme.Panel);
            }
        }
    }

    // One task: chip and title, then when/progress/detail, then the bar,
    // painted from DarkTheme at paint time so a live theme switch applies.
    // Focusable, and named for screen readers; Cancel is its own button.
    internal sealed class TaskRow : Control
    {
        private static readonly Font TitleFont = new("Segoe UI", 9F);
        private static readonly Font SmallFont = new("Segoe UI", 8F);
        private readonly Button cancelButton = new() { Text = "Cancel", Width = 60, Height = 22, Visible = false };
        private string meta = "";
        // The middle: where the sweep rests when animations are off.
        private double phase = 0.5;

        public TaskRow(Func<TaskRow, Task> cancel)
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = true;
            Dock = DockStyle.Top;
            Height = 46;
            AccessibleRole = AccessibleRole.ListItem;
            DarkTheme.ApplyButton(cancelButton);
            cancelButton.Font = SmallFont;
            cancelButton.Click += async (_, _) => await cancel(this);
            Controls.Add(cancelButton);
        }

        public ManaBackgroundTask? Task { get; private set; }
        public Button CancelButton => cancelButton;
        public string MetaText => meta;
        public BarKind BarKind { get; private set; }
        public bool Indeterminate => BarKind == BarKind.Indeterminate;

        public bool CancelEnabled
        {
            get => cancelButton.Enabled;
            set => cancelButton.Enabled = value;
        }

        public double Phase
        {
            get => phase;
            set
            {
                phase = value;
                Invalidate();
            }
        }

        public void SetTask(ManaBackgroundTask task, DateTimeOffset now)
        {
            var newTask = Task?.Id != task.Id;
            Task = task;
            meta = string.Join(" · ", new[] { When(task, now), ProgressText(task), task.Detail }.Where(s => !string.IsNullOrEmpty(s)));
            BarKind = Bar(task);
            Height = BarKind == BarKind.None ? 46 : 54;
            AccessibleName = Describe(task, now);
            cancelButton.Visible = task.CanCancel;
            cancelButton.AccessibleName = $"Cancel {task.Title}";
            if (newTask || !task.CanCancel)
            {
                cancelButton.Enabled = true;
            }
            Invalidate();
        }

        protected override void OnGotFocus(EventArgs e)
        {
            base.OnGotFocus(e);
            Invalidate();
        }

        protected override void OnLostFocus(EventArgs e)
        {
            base.OnLostFocus(e);
            Invalidate();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            cancelButton.Location = new Point(Width - cancelButton.Width - 6, 5);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(DarkTheme.Panel);
            using (var line = new Pen(DarkTheme.Border))
            {
                g.DrawLine(line, 0, Height - 1, Width, Height - 1);
            }
            if (Task is null)
            {
                return;
            }
            const int x = 8;
            var right = Width - 8 - (cancelButton.Visible ? cancelButton.Width + 6 : 0);

            var chipText = StatusLabel(Task.Status);
            var chipWidth = TextRenderer.MeasureText(g, chipText, SmallFont, Size.Empty, TextFormatFlags.NoPadding).Width + 12;
            var chip = new Rectangle(x, 7, chipWidth, 16);
            var (chipBack, chipFore) = ChipColors(Task.Status);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Pill(chip))
            using (var brush = new SolidBrush(chipBack))
            {
                g.FillPath(brush, path);
            }
            g.SmoothingMode = SmoothingMode.None;
            TextRenderer.DrawText(g, chipText, SmallFont, chip, chipFore, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);

            var flags = TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter;
            TextRenderer.DrawText(g, Task.Title, TitleFont, new Rectangle(chip.Right + 6, 5, Math.Max(0, right - chip.Right - 6), 20), DarkTheme.Text, flags);
            TextRenderer.DrawText(g, meta, SmallFont, new Rectangle(x, 26, Math.Max(0, Width - 2 * x), 16), DarkTheme.Muted, flags);

            if (BarKind != BarKind.None)
            {
                var track = new Rectangle(x, 45, Math.Max(0, Width - 2 * x), 3);
                using var trackBrush = new SolidBrush(DarkTheme.Border);
                using var fill = new SolidBrush(DarkTheme.Accent);
                g.FillRectangle(trackBrush, track);
                if (BarKind == BarKind.Determinate && Task.Progress is { } progress)
                {
                    g.FillRectangle(fill, track.X, track.Y, (int)(track.Width * progress.Fraction), track.Height);
                }
                else
                {
                    // A 30% band sweeping across; parked in the middle when animations are off.
                    var band = (int)(track.Width * 0.3);
                    var left = track.X + (int)((track.Width + band) * phase) - band;
                    var visible = Rectangle.Intersect(track, new Rectangle(left, track.Y, band, track.Height));
                    if (!visible.IsEmpty)
                    {
                        g.FillRectangle(fill, visible);
                    }
                }
            }
            if (Focused)
            {
                ControlPaint.DrawFocusRectangle(g, new Rectangle(1, 1, Width - 2, Height - 3), DarkTheme.Text, DarkTheme.Panel);
            }
        }

        private static (Color Back, Color Fore) ChipColors(string status) => status switch
        {
            "running" => (DarkTheme.Accent, DarkTheme.OnAccent),
            "failed" => (DarkTheme.Warn, DarkTheme.Background),
            "done" => (DarkTheme.Border, DarkTheme.Green),
            "waiting" => (DarkTheme.Border, DarkTheme.Warn),
            "paused" => (DarkTheme.Border, DarkTheme.Muted),
            _ => (DarkTheme.Border, DarkTheme.Text),
        };

        private static GraphicsPath Pill(Rectangle r)
        {
            var path = new GraphicsPath();
            var d = r.Height;
            path.AddArc(r.X, r.Y, d, d, 90, 180);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 180);
            path.CloseFigure();
            return path;
        }
    }
}

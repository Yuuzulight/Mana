using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1406: Settings > API Spending -- switching on her DeepSeek escalation
// with its key, and what her API use has cost: today, this month and all
// time as figures, the last 30 days as a chart by model, where the money
// went by token kind, and the same numbers as tables. The charts take their
// colours from the theme in use (SpendingCharts.cs).
internal sealed class ApiSpendingPanel : FlowLayoutPanel
{
    private static readonly string[] Columns = ["", "Spent", "Requests", "Input (cached)", "Input (not cached)", "Output", "of which reasoning"];
    private readonly ManaBackendClient backendClient;
    private bool clearingKey;

    internal CheckBox UseDeepSeek { get; } = new() { Text = "Use DeepSeek when my own attempts at an issue fail", AutoSize = true, ForeColor = DarkTheme.Text };
    internal TextBox Key { get; } = new() { Width = 320, UseSystemPasswordChar = true, AccessibleName = "DeepSeek API key", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal Label KeyStatus { get; } = new() { AutoSize = true, ForeColor = DarkTheme.Muted, MaximumSize = new Size(560, 0) };
    internal ListView Totals { get; } = new() { Width = 760, Height = 96, AccessibleName = "Spending totals" };
    internal ComboBox SplitPeriod { get; } = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 140, AccessibleName = "Split period", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
    internal ListView Split { get; } = new() { Width = 760, Height = 200, AccessibleName = "Spending split" };
    internal Label SpendingStatus { get; } = new() { AutoSize = true, ForeColor = DarkTheme.Muted, MaximumSize = new Size(760, 0) };
    internal Label[] Figures { get; } = [NewFigure(), NewFigure(), NewFigure()];
    internal Label[] FigureNotes { get; } = [NewNote(), NewNote(), NewNote()];
    internal DailySpendChart Daily { get; } = new() { Width = 760, Height = 240, Margin = new Padding(3, 6, 3, 8) };
    internal KindSpendBar Kinds { get; } = new() { Width = 760, Height = 140, Margin = new Padding(3, 0, 3, 8) };
    internal Label Balance { get; } = new() { AutoSize = true, ForeColor = DarkTheme.Text, MaximumSize = new Size(760, 0), Margin = new Padding(3, 2, 3, 4) };
    internal Label Insights { get; } = new() { AutoSize = true, ForeColor = DarkTheme.Muted, MaximumSize = new Size(760, 0), Margin = new Padding(3, 0, 3, 6) };
    internal ComboBox Range { get; } = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 110, AccessibleName = "Chart range", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
    internal ComboBox ShowBy { get; } = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 110, AccessibleName = "Show by", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
    internal Label DayTitle { get; } = new() { AutoSize = true, ForeColor = DarkTheme.Muted, Text = "Click a day in the chart to see the issues it paid for.", Margin = new Padding(3, 0, 3, 4) };
    internal ListView DayIssues { get; } = new() { Width = 760, Height = 110, AccessibleName = "Issues the chosen day paid for" };
    internal Label ResultsSummary { get; } = new() { AutoSize = true, ForeColor = DarkTheme.Text, MaximumSize = new Size(760, 0), Margin = new Padding(3, 0, 3, 6) };
    internal ListView TopIssues { get; } = new() { Width = 760, Height = 170, AccessibleName = "What each issue cost" };
    // Opens an issue or PR; tests swap it out.
    internal Action<string> OpenUrl { get; set; } = url => System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();
    // ponytail: her own repository; take it from the backend if she ever works on another.
    private const string RepoUrl = "https://github.com/Yuuzulight/Mana";

    private static Label NewFigure() => new() { AutoSize = true, ForeColor = DarkTheme.Text, Font = new Font(SystemFonts.MessageBoxFont!.FontFamily, 17f, FontStyle.Bold), Margin = new Padding(0, 2, 0, 0) };
    private static Label NewNote() => new() { AutoSize = true, ForeColor = DarkTheme.Muted, Margin = new Padding(0) };
    private ManaApiSpending? spending;

    // loadNow: false in tests, which call ReloadAsync themselves.
    public ApiSpendingPanel(ManaBackendClient backendClient, bool loadNow = true)
    {
        this.backendClient = backendClient;
        Dock = DockStyle.Fill;
        FlowDirection = FlowDirection.TopDown;
        WrapContents = false;
        AutoScroll = true;
        BackColor = DarkTheme.Background;

        Button NewButton(string text, Func<Task> click)
        {
            var button = new Button { Text = text, AutoSize = true };
            DarkTheme.ApplyButton(button);
            button.Click += async (_, _) => await click();
            return button;
        }
        FlowLayoutPanel Row(params Control[] controls)
        {
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
            row.Controls.AddRange(controls);
            return row;
        }
        Label Heading(string text) => new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Text, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(3, 12, 3, 3) };

        foreach (var list in new[] { Totals, Split })
        {
            DarkTheme.ApplyListView(list);
            list.View = View.Details;
            list.FullRowSelect = true;
            list.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            foreach (var column in Columns) list.Columns.Add(column, column == "" ? 150 : 100);
        }
        Split.Columns[0].Text = "Model or use";
        foreach (var list in new[] { DayIssues, TopIssues })
        {
            DarkTheme.ApplyListView(list);
            list.View = View.Details;
            list.FullRowSelect = true;
            list.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            list.Columns.Add("Issue", 70);
            list.Columns.Add("Title", 340);
            list.Columns.Add("Outcome", 140);
            list.Columns.Add("Cost", 90, HorizontalAlignment.Right);
            list.Columns.Add("Requests", 90, HorizontalAlignment.Right);
            list.ItemActivate += (_, _) => { if (list.SelectedItems.Count > 0 && list.SelectedItems[0].Tag is string url) OpenUrl(url); };
        }
        Range.Items.AddRange(["7 days", "30 days", "90 days"]);
        Range.SelectedIndex = 1;
        Range.SelectedIndexChanged += (_, _) => Daily.RangeDays = Range.SelectedIndex switch { 0 => 7, 2 => 90, _ => 30 };
        ShowBy.Items.AddRange(["Model", "Use"]);
        ShowBy.SelectedIndex = 0;
        ShowBy.SelectedIndexChanged += (_, _) => Daily.ByUse = ShowBy.SelectedIndex == 1;
        Daily.DayClicked += ShowDay;
        SplitPeriod.Items.AddRange(["Today", "This month", "All time"]);
        SplitPeriod.SelectedIndex = 1;
        SplitPeriod.SelectedIndexChanged += (_, _) => ShowSplit();

        Controls.Add(Heading("DeepSeek"));
        Controls.Add(UseDeepSeek);
        Controls.Add(Row(new Label { Text = "API key", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left }, Key,
            NewButton("Save", SaveAsync),
            NewButton("Clear key", () => { clearingKey = true; Key.Clear(); Key.PlaceholderText = "Key will be cleared on Save"; return Task.CompletedTask; })));
        Controls.Add(KeyStatus);
        Controls.Add(Row(Heading("API spending"), NewButton("Refresh", ReloadAsync)));
        Controls.Add(Balance);
        // Today, this month and all time: the figure, then requests and tokens.
        var figures = new TableLayoutPanel { ColumnCount = 3, AutoSize = true, BackColor = DarkTheme.Background, Margin = new Padding(3, 4, 3, 6) };
        string[] periods = ["TODAY", "THIS MONTH", "ALL TIME"];
        for (var i = 0; i < 3; i++)
        {
            figures.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 250));
            var cell = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = DarkTheme.Background, Margin = new Padding(0) };
            cell.Controls.Add(new Label { Text = periods[i], AutoSize = true, ForeColor = DarkTheme.Muted, Margin = new Padding(0) });
            cell.Controls.Add(Figures[i]);
            cell.Controls.Add(FigureNotes[i]);
            figures.Controls.Add(cell, i, 0);
        }
        Controls.Add(figures);
        Controls.Add(Insights);
        Controls.Add(Row(new Label { Text = "Range", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left }, Range,
            new Label { Text = "Show by", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(12, 3, 3, 3) }, ShowBy));
        Controls.Add(Daily);
        Controls.Add(DayTitle);
        Controls.Add(DayIssues);
        Controls.Add(Row(new Label { Text = "Period", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left }, SplitPeriod));
        Controls.Add(Kinds);
        Controls.Add(Heading("Cost of results"));
        Controls.Add(ResultsSummary);
        Controls.Add(TopIssues);
        Controls.Add(Heading("The numbers"));
        Controls.Add(Totals);
        Controls.Add(Split);
        Controls.Add(SpendingStatus);
        if (loadNow) _ = ReloadAsync();
    }

    internal async Task ReloadAsync()
    {
        try
        {
            var settings = await backendClient.GetEscalationAsync();
            spending = await backendClient.GetApiSpendingAsync();
            if (IsDisposed) return;
            UseDeepSeek.Checked = settings.Enabled && !settings.LocalOnly;
            UseDeepSeek.Enabled = !settings.LocalOnly;
            Key.PlaceholderText = settings.HasKey ? "(configured -- leave blank to keep it)" : "";
            KeyStatus.Text = settings.LocalOnly
                ? "Local-only mode is on, so DeepSeek is off."
                : !settings.HasKey ? "No key yet: DeepSeek escalation stays off until you add one."
                : settings.Enabled ? "On: one run per tier per issue, 5 a day, held at peak price unless you say go ahead."
                : "Off.";
            ShowTotals();
            ShowSplit();
        }
        catch (Exception ex)
        {
            if (!IsDisposed) SpendingStatus.Text = $"Couldn't load API spending: {ex.Message}";
        }
    }

    private async Task SaveAsync()
    {
        if (UseDeepSeek.Checked && MessageBox.Show(this, "Let Mana send her failed self-work issues (the issue, what failed, and the code she reads) to DeepSeek? It costs money; spending shows here.", "DeepSeek", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        try
        {
            var key = clearingKey ? "" : string.IsNullOrWhiteSpace(Key.Text) ? null : Key.Text.Trim();
            await backendClient.SetEscalationAsync(UseDeepSeek.Checked, key);
            clearingKey = false;
            Key.Clear();
            await ReloadAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed) KeyStatus.Text = ex.Message;
        }
    }

    private void ShowTotals()
    {
        if (spending is null) return;
        Totals.Items.Clear();
        Totals.Items.Add(RowOf("Today", spending.Today.All));
        Totals.Items.Add(RowOf("This month", spending.Month.All));
        Totals.Items.Add(RowOf("All time", spending.Total.All));
        ManaSpendingTotals[] periods = [spending.Today.All, spending.Month.All, spending.Total.All];
        for (var i = 0; i < 3; i++)
        {
            Figures[i].Text = Dollars(periods[i].Usd);
            FigureNotes[i].Text = $"{periods[i].Requests} requests · {Tokens(periods[i].CacheHit + periods[i].CacheMiss + periods[i].Output)} tokens";
        }
        // This month: where it's heading, against last month.
        if (spending.Month.Projected is double projected && spending.LastMonth is { } last)
            FigureNotes[1].Text += $"\nOn pace for {Dollars(projected)} · last month {Dollars(last.All.Usd)}";
        ShowBalance();
        ShowInsights();
        ShowResults();
        Daily.SetDays(spending.Daily ?? []);
        DayIssues.Items.Clear();
        DayTitle.Text = "Click a day in the chart to see the issues it paid for.";
        var unpriced = spending.Total.All.UnpricedRequests;
        SpendingStatus.Text = (spending.PeakNow ? "DeepSeek is at peak price right now (double). " : "")
            + (unpriced > 0 ? $"{unpriced} request(s) went to a model without known prices, so they show tokens only." : "");
    }

    internal void ShowSplit()
    {
        if (spending is null) return;
        var period = SplitPeriod.SelectedIndex switch { 0 => spending.Today, 2 => spending.Total, _ => spending.Month };
        Kinds.SetTotals(period.All, SplitPeriod.SelectedIndex switch { 0 => "today", 2 => "all time", _ => "this month" });
        Split.Items.Clear();
        foreach (var (name, totals) in period.ByModel.OrderByDescending(p => p.Value.Usd)) Split.Items.Add(RowOf(name, totals));
        foreach (var (name, totals) in period.ByUse.OrderByDescending(p => p.Value.Usd)) Split.Items.Add(RowOf(UseName(name), totals));
        if (Split.Items.Count == 0) Split.Items.Add(new ListViewItem("Nothing yet") { ForeColor = DarkTheme.Muted });
    }

    private void ShowBalance()
    {
        var b = spending?.Balance;
        var runway = spending?.Runway;
        Balance.ForeColor = runway?.Low == true ? DarkTheme.Warn : DarkTheme.Text;
        if (b is null)
        {
            Balance.Text = "Add your DeepSeek key above to see your balance.";
            Balance.ForeColor = DarkTheme.Muted;
            return;
        }
        if (b.Error is not null)
        {
            Balance.Text = $"Couldn't read your DeepSeek balance: {b.Error}";
            Balance.ForeColor = DarkTheme.Muted;
            return;
        }
        var amount = b.Currency == "USD" ? Dollars(b.Total) : $"{b.Total.ToString("0.00", CultureInfo.InvariantCulture)} {b.Currency}";
        var lasts = runway?.DaysLeft is double days
            ? days >= 60 ? $", about {Math.Round(days / 30)} months at this pace" : days >= 14 ? $", about {Math.Round(days / 7)} weeks at this pace" : $", about {Math.Max(1, Math.Round(days))} days at this pace"
            : "";
        Balance.Text = (runway?.Low == true ? "Running low: " : "") + $"DeepSeek balance {amount}{lasts}." + (b.Available ? "" : " DeepSeek says it's too low to make calls.");
    }

    private void ShowInsights()
    {
        var month = spending!.Month.All;
        var parts = new List<string>();
        if (month.UsdPeakExtra > 0) parts.Add($"Peak hours added {Dollars(month.UsdPeakExtra)} this month.");
        if (month.CacheHitRate is double rate) parts.Add($"{Math.Round(rate * 100)}% of input came from cache this month; cached input costs about 2% as much.");
        Insights.Text = string.Join(" ", parts);
    }

    private void ShowResults()
    {
        var r = spending?.Results;
        TopIssues.Items.Clear();
        if (r is null || r.Top.Count == 0)
        {
            ResultsSummary.Text = "No self-work issue has cost anything yet.";
            return;
        }
        ResultsSummary.Text = (r.CostPerMergedPr is double each ? $"{Dollars(each)} per merged PR ({r.MergedPrs} merged, {Dollars(r.UsdOnMerged)} in all). " : "Nothing has merged yet. ")
            + (r.UsdOnHeld > 0 ? $"{Dollars(r.UsdOnHeld)} went on issues now waiting on you." : "");
        foreach (var issue in r.Top) TopIssues.Items.Add(IssueRow(issue));
    }

    internal void ShowDay(ManaSpendingDay day)
    {
        DayIssues.Items.Clear();
        var issues = day.Issues ?? [];
        DayTitle.Text = issues.Count == 0
            ? $"{DailySpendChart.DayLabel(day.Day, true)}: {Dollars(day.Usd)}, none of it on a self-work issue."
            : $"{DailySpendChart.DayLabel(day.Day, true)}: {Dollars(day.Usd)}. Double-click an issue to open it.";
        foreach (var issue in issues) DayIssues.Items.Add(IssueRow(issue));
    }

    private static ListViewItem IssueRow(ManaIssueCost issue)
    {
        var item = new ListViewItem($"#{issue.Issue}") { ForeColor = DarkTheme.Text, Tag = issue.Prs.Count > 0 ? $"{RepoUrl}/pull/{issue.Prs[^1]}" : $"{RepoUrl}/issues/{issue.Issue}" };
        item.SubItems.AddRange([issue.Title ?? "", Outcome(issue.State), Dollars(issue.Usd), issue.Requests > 0 ? issue.Requests.ToString(CultureInfo.InvariantCulture) : ""]);
        return item;
    }

    internal static string Outcome(string? state) => state switch
    {
        "merged" => "Merged",
        "verified" => "Merged, verified",
        "regressed" => "Regressed",
        "needs-you" => "Needs you",
        "exhausted" => "Out of tries",
        "retry" => "Will try again",
        "pr-open" => "PR open",
        "waiting" => "Waiting",
        "no-change" => "No change",
        null or "" => "No record",
        _ => state,
    };

    private static string UseName(string use) => use switch
    {
        "self-work" => "Self-work escalation",
        "chat" => "Chat requests",
        "bench" => "Bench",
        _ => use,
    };

    private static ListViewItem RowOf(string name, ManaSpendingTotals t)
    {
        var item = new ListViewItem(name) { ForeColor = DarkTheme.Text };
        item.SubItems.AddRange([Dollars(t.Usd), t.Requests.ToString(CultureInfo.InvariantCulture), Tokens(t.CacheHit), Tokens(t.CacheMiss), Tokens(t.Output), Tokens(t.Reasoning)]);
        return item;
    }

    internal static string Dollars(double usd) => usd > 0 && usd < 0.01 ? "< $0.01" : usd.ToString("$0.00", CultureInfo.InvariantCulture);

    internal static string Tokens(long n) => n switch
    {
        >= 1_000_000 => (n / 1_000_000.0).ToString("0.0", CultureInfo.InvariantCulture) + "M",
        >= 1_000 => (n / 1_000.0).ToString("0.#", CultureInfo.InvariantCulture) + "k",
        _ => n.ToString(CultureInfo.InvariantCulture),
    };
}

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
// time, and the split by token kind, model and use.
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
        Controls.Add(Totals);
        Controls.Add(Row(new Label { Text = "Split for", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left }, SplitPeriod));
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
        var unpriced = spending.Total.All.UnpricedRequests;
        SpendingStatus.Text = (spending.PeakNow ? "DeepSeek is at peak price right now (double). " : "")
            + (unpriced > 0 ? $"{unpriced} request(s) went to a model without known prices, so they show tokens only." : "");
    }

    internal void ShowSplit()
    {
        if (spending is null) return;
        var period = SplitPeriod.SelectedIndex switch { 0 => spending.Today, 2 => spending.Total, _ => spending.Month };
        Split.Items.Clear();
        foreach (var (name, totals) in period.ByModel.OrderByDescending(p => p.Value.Usd)) Split.Items.Add(RowOf(name, totals));
        foreach (var (name, totals) in period.ByUse.OrderByDescending(p => p.Value.Usd)) Split.Items.Add(RowOf(UseName(name), totals));
        if (Split.Items.Count == 0) Split.Items.Add(new ListViewItem("Nothing yet") { ForeColor = DarkTheme.Muted });
    }

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

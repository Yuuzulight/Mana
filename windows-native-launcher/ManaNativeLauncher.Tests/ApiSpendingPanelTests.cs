using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1406: Settings > API Spending. Real controls on an STA thread, never
// shown; the backend is a fake handler, so nothing is saved.
[Collection("DarkTheme palette")]
public sealed class ApiSpendingPanelTests
{
    private const string Spending =
        "{\"peakNow\":true," +
        "\"today\":{\"usd\":0.004,\"requests\":3,\"cacheHit\":1500,\"cacheMiss\":500,\"output\":300,\"reasoning\":120,\"unpricedRequests\":0," +
        "\"byModel\":{\"deepseek-flash\":{\"usd\":0.004,\"requests\":3,\"cacheHit\":1500,\"cacheMiss\":500,\"output\":300,\"reasoning\":120}},\"byUse\":{\"chat\":{\"usd\":0.004,\"requests\":3}}}," +
        "\"lastMonth\":{\"usd\":2.25,\"requests\":50,\"byModel\":{},\"byUse\":{}},\"results\":{\"mergedPrs\":1,\"usdOnMerged\":0.5,\"costPerMergedPr\":0.5,\"usdOnHeld\":0.2,\"top\":[{\"issue\":12,\"usd\":0.5,\"requests\":3,\"title\":\"Fix the tray\",\"state\":\"merged\",\"prs\":[900]},{\"issue\":13,\"usd\":0.2,\"requests\":2,\"title\":\"Speed up recall\",\"state\":\"exhausted\",\"prs\":[]}]},\"balance\":{\"currency\":\"USD\",\"total\":1.2,\"granted\":0,\"toppedUp\":1.2,\"available\":true},\"runway\":{\"daysLeft\":4,\"low\":true}," +
        "\"daily\":[{\"day\":\"2026-10-05\",\"usd\":0,\"byModel\":{}},{\"day\":\"2026-10-06\",\"usd\":0.6,\"peakExtra\":0.1,\"byModel\":{\"deepseek-flash\":0.2,\"deepseek-v4-pro\":0.4},\"byUse\":{\"self-work\":0.5,\"chat\":0.1},\"issues\":[{\"issue\":12,\"usd\":0.5,\"requests\":3,\"title\":\"Fix the tray\",\"state\":\"merged\",\"prs\":[900]}]},{\"day\":\"2026-10-07\",\"usd\":0.004,\"byModel\":{\"deepseek-flash\":0.004}}]," +
        "\"month\":{\"usd\":1.25,\"projected\":5.5,\"usdPeakExtra\":0.38,\"cacheHitRate\":0.82,\"usdCacheHit\":0.05,\"usdCacheMiss\":0.45,\"usdOutput\":0.5,\"usdReasoning\":0.25,\"requests\":40,\"cacheHit\":2500000,\"cacheMiss\":400000,\"output\":90000,\"reasoning\":30000,\"unpricedRequests\":0," +
        "\"byModel\":{\"deepseek-flash\":{\"usd\":0.25,\"requests\":30},\"deepseek-v4-pro\":{\"usd\":1.0,\"requests\":10}},\"byUse\":{\"self-work\":{\"usd\":1.2,\"requests\":38},\"chat\":{\"usd\":0.05,\"requests\":2}}}," +
        "\"total\":{\"usd\":3.5,\"requests\":90,\"cacheHit\":6000000,\"cacheMiss\":900000,\"output\":200000,\"reasoning\":70000,\"unpricedRequests\":2,\"byModel\":{},\"byUse\":{}}}";

    private static ManaBackendClient Client(List<string> requests, string escalation = "{\"enabled\":true,\"hasKey\":true,\"localOnly\":false}") =>
        new(new FakeHttpMessageHandler(request =>
        {
            requests.Add($"{request.Method} {request.RequestUri!.AbsolutePath} {request.Content?.ReadAsStringAsync().GetAwaiter().GetResult()}".TrimEnd());
            var json = request.RequestUri!.AbsolutePath switch
            {
                "/api-spending" => Spending,
                "/self-work/escalation" => request.Method == HttpMethod.Get ? escalation : "{}",
                _ => "{}",
            };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }));

    [Fact]
    public void ShowsTotals_AndTheSplitForThePeriodChosen()
    {
        var requests = new List<string>();
        var client = Client(requests);
        RunSta(() =>
        {
            using var panel = new ApiSpendingPanel(client, loadNow: false);
            panel.ReloadAsync().GetAwaiter().GetResult();
            var rows = panel.Totals.Items.Cast<ListViewItem>().Select(i => string.Join(" | ", i.SubItems.Cast<ListViewItem.ListViewSubItem>().Select(s => s.Text))).ToList();
            Assert.Equal(new[]
            {
                "Today | < $0.01 | 3 | 1.5k | 500 | 300 | 120",
                "This month | $1.25 | 40 | 2.5M | 400k | 90k | 30k",
                "All time | $3.50 | 90 | 6.0M | 900k | 200k | 70k",
            }, rows);
            Assert.Contains("peak price right now", panel.SpendingStatus.Text);
            Assert.Contains("2 request(s) went to a model without known prices", panel.SpendingStatus.Text);

            // This month by default: models, then uses, most spent first.
            Assert.Equal(new[] { "deepseek-v4-pro", "deepseek-flash", "Self-work escalation", "Chat requests" }, panel.Split.Items.Cast<ListViewItem>().Select(i => i.Text));
            panel.SplitPeriod.SelectedIndex = 2;
            Assert.Equal(new[] { "Nothing yet" }, panel.Split.Items.Cast<ListViewItem>().Select(i => i.Text));
            Assert.True(panel.UseDeepSeek.Checked);

            // The figures, the daily chart and where the money went.
            Assert.Equal(new[] { "< $0.01", "$1.25", "$3.50" }, panel.Figures.Select(l => l.Text));
            Assert.Equal("40 requests · 3.0M tokens\nOn pace for $5.50 · last month $2.25", panel.FigureNotes[1].Text);

            // The balance, how long it lasts, and the low warning.
            Assert.Equal("Running low: DeepSeek balance $1.20, about 4 days at this pace.", panel.Balance.Text);
            Assert.Contains("Peak hours added $0.38 this month.", panel.Insights.Text);
            Assert.Contains("82% of input came from cache this month", panel.Insights.Text);

            // The cost of results, each issue linked to its PR (or the issue).
            Assert.Equal("$0.50 per merged PR (1 merged, $0.50 in all). $0.20 went on issues now waiting on you.", panel.ResultsSummary.Text);
            var issues = panel.TopIssues.Items.Cast<ListViewItem>().ToList();
            Assert.Equal("#12 | Fix the tray | Merged | $0.50 | 3", string.Join(" | ", issues[0].SubItems.Cast<ListViewItem.ListViewSubItem>().Select(x => x.Text)));
            Assert.Equal("https://github.com/Yuuzulight/Mana/pull/900", issues[0].Tag);
            Assert.Equal("https://github.com/Yuuzulight/Mana/issues/13", issues[1].Tag);
            Assert.Equal("Out of tries", issues[1].SubItems[2].Text);

            // A day in the chart: its issues; and the range and show-by pickers.
            panel.Daily.PickDay(1);
            Assert.StartsWith("Tue 6 Oct: $0.60.", panel.DayTitle.Text);
            Assert.Equal(new[] { "#12" }, panel.DayIssues.Items.Cast<ListViewItem>().Select(i => i.Text));
            panel.Daily.PickDay(0);
            Assert.Contains("none of it on a self-work issue", panel.DayTitle.Text);
            panel.Range.SelectedIndex = 0;
            Assert.Equal(7, panel.Daily.RangeDays);
            panel.ShowBy.SelectedIndex = 1;
            Assert.True(panel.Daily.ByUse);
            Assert.Contains("Self-work $0.50", panel.Daily.AccessibleDescription);
            panel.ShowBy.SelectedIndex = 0;
            panel.SplitPeriod.SelectedIndex = 1;
            Assert.Equal(new[] { 0.05, 0.45, 0.5, 0.25 }, panel.Kinds.Parts.Select(p => p.Usd));
            Assert.Equal(new[] { 2_500_000L, 400_000L, 60_000L, 30_000L }, panel.Kinds.Parts.Select(p => p.Tokens));
            Assert.Contains("DeepSeek Pro $0.40", panel.Daily.AccessibleDescription);
            Assert.Equal(2, panel.Daily.IndexAt(panel.Daily.Width - 20));
            Assert.Equal(-1, panel.Daily.IndexAt(5));
            Assert.Contains("configured", panel.Key.PlaceholderText);
        });
    }

    [Fact]
    public void LocalOnly_TurnsTheSwitchOff()
    {
        var client = Client([], "{\"enabled\":true,\"hasKey\":true,\"localOnly\":true}");
        RunSta(() =>
        {
            using var panel = new ApiSpendingPanel(client, loadNow: false);
            panel.ReloadAsync().GetAwaiter().GetResult();
            Assert.False(panel.UseDeepSeek.Checked);
            Assert.False(panel.UseDeepSeek.Enabled);
            Assert.Contains("Local-only", panel.KeyStatus.Text);
        });
    }

    [Fact]
    public async System.Threading.Tasks.Task SetEscalationAsync_SendsTheKeyOnlyWhenGiven()
    {
        var requests = new List<string>();
        var client = Client(requests);
        await client.SetEscalationAsync(false, null);
        await client.SetEscalationAsync(true, "sk-new");
        Assert.Equal("POST /self-work/escalation {\"enabled\":false}", requests[0]);
        Assert.Equal("POST /self-work/escalation {\"enabled\":true,\"apiKey\":\"sk-new\"}", requests[1]);
    }

    // Every preset's chart colours: Pro and Flash at 3:1 on the chart surface
    // and well apart in OKLab, and the token-kind ramp stepping steadily away
    // from the surface. Both charts paint on light and dark themes.
    [Theory]
    [InlineData("violet")]
    [InlineData("neutral")]
    [InlineData("light")]
    [InlineData("highContrast")]
    [InlineData("mana")]
    public void ChartColoursFollowTheTheme(string preset)
    {
        RunSta(() =>
        {
            try
            {
                DarkTheme.ApplyPreset(preset, null);
                var surface = ChartPalette.Surface;
                Assert.True(Contrast(ChartPalette.Pro, surface) >= 3, $"Pro {ChartPalette.Pro} on {surface}");
                Assert.True(Contrast(ChartPalette.Flash, surface) >= 3, $"Flash {ChartPalette.Flash} on {surface}");
                Assert.True(Distance(ChartPalette.Pro, ChartPalette.Flash) >= 0.15, $"{ChartPalette.Pro} vs {ChartPalette.Flash}");
                var steps = Enumerable.Range(0, 4).Select(i => Distance(ChartPalette.Kind(i), surface)).ToList();
                Assert.True(steps.Zip(steps.Skip(1)).All(p => p.Second - p.First >= 0.05), string.Join(", ", steps));

                using var daily = new DailySpendChart { Width = 760, Height = 240 };
                daily.SetDays([new("2026-10-06", 0.6, new Dictionary<string, double> { ["deepseek-flash"] = 0.2, ["deepseek-v4-pro"] = 0.4 }), new("2026-10-07", 0, new Dictionary<string, double>())]);
                using var kinds = new KindSpendBar { Width = 760, Height = 120 };
                kinds.SetTotals(new ManaSpendingTotals(1, 1, 10, 10, 10, 2, 0, 0.1, 0.3, 0.4, 0.2), "this month");
                using var bitmap = new System.Drawing.Bitmap(760, 240);
                daily.DrawToBitmap(bitmap, new System.Drawing.Rectangle(0, 0, 760, 240));
                kinds.DrawToBitmap(bitmap, new System.Drawing.Rectangle(0, 0, 760, 120));
            }
            finally
            {
                DarkTheme.ApplyPreset("violet", null);
            }
        });
    }

    private static double Contrast(System.Drawing.Color a, System.Drawing.Color b)
    {
        static double Lum(System.Drawing.Color c)
        {
            static double L(int v) { var s = v / 255.0; return s <= 0.03928 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4); }
            return 0.2126 * L(c.R) + 0.7152 * L(c.G) + 0.0722 * L(c.B);
        }
        var (x, y) = (Lum(a), Lum(b));
        return (Math.Max(x, y) + 0.05) / (Math.Min(x, y) + 0.05);
    }

    private static double Distance(System.Drawing.Color a, System.Drawing.Color b)
    {
        var (l1, a1, b1) = ChartPalette.ToOklab(a);
        var (l2, a2, b2) = ChartPalette.ToOklab(b);
        return Math.Sqrt((l1 - l2) * (l1 - l2) + (a1 - a2) * (a1 - a2) + (b1 - b2) * (b1 - b2));
    }

    [Fact]
    public void Formats()
    {
        Assert.Equal("$0.00", ApiSpendingPanel.Dollars(0));
        Assert.Equal("< $0.01", ApiSpendingPanel.Dollars(0.004));
        Assert.Equal("$12.34", ApiSpendingPanel.Dollars(12.344));
        Assert.Equal("999", ApiSpendingPanel.Tokens(999));
        Assert.Equal("1.5k", ApiSpendingPanel.Tokens(1500));
        Assert.Equal("2.5M", ApiSpendingPanel.Tokens(2_500_000));
    }

    private static void RunSta(Action body)
    {
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                body();
            }
            catch (Exception ex)
            {
                error = ex;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (error is not null)
        {
            ExceptionDispatchInfo.Capture(error).Throw();
        }
    }
}

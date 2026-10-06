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
        "\"month\":{\"usd\":1.25,\"requests\":40,\"cacheHit\":2500000,\"cacheMiss\":400000,\"output\":90000,\"reasoning\":30000,\"unpricedRequests\":0," +
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

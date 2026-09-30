using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1154: Settings > Approvals lists the remembered always/never answers
// (her per-site browser permissions among them) and forgets one. #1191:
// its "Git and GitHub" section, one choice per tier. STA, never shown.
public class RememberedApprovalsTests
{
    private const string Remembered = """
        {"remembered":[{"key":"browser-site:shop.test","answer":"always"},{"key":"browser-site:bad.test","answer":"never"},{"key":"memory-write","answer":"always"}]}
        """;

    private static ManaBackendClient Backend(List<string> requests) =>
        new(new FakeHttpMessageHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            var body = request.Content?.ReadAsStringAsync().Result;
            requests.Add(body is null ? $"{request.Method} {path}" : $"{request.Method} {path} {body}");
            var json = path switch
            {
                "/approvals/remembered" => Remembered,
                "/approvals/remembered/forget" => """{"forgotten":true}""",
                "/approvals/req-1/decide" => """{"status":"denied"}""",
                "/approvals/git-mode" => """{"modes":{"local":"once","github":"ask","danger":"ask"}}""",
                _ => null,
            };
            return json is null
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }));

    [Fact]
    public async Task Client_ReadsAndForgetsRememberedAnswers_AndSendsNever()
    {
        var requests = new List<string>();
        var client = Backend(requests);
        var remembered = await client.GetRememberedApprovalsAsync();
        Assert.Equal(["Browser: shop.test", "Browser: bad.test", "memory-write"], remembered.Select(r => r.Label));
        Assert.Equal(["always", "never", "always"], remembered.Select(r => r.Answer));

        await client.ForgetApprovalAsync("browser-site:bad.test");
        await client.DecideApprovalAsync("req-1", "never");
        Assert.Contains("""POST /approvals/remembered/forget {"key":"browser-site:bad.test"}""", requests);
        Assert.Contains("""POST /approvals/req-1/decide {"decision":"never"}""", requests);
    }

    [Fact]
    public void Settings_ListsRememberedAnswers_AndForgetsTheSelectedOne()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var requests = new List<string>();
            using var panel = new SettingsPanel(Backend(requests), new BackendLogBuffer());
            Pump(panel.RefreshRememberedAsync());
            var list = All<ListView>(panel).Single(l => l.AccessibleName == "Remembered answers");
            Assert.Equal(["Browser: shop.test|Always", "Browser: bad.test|Never", "memory-write|Always"],
                list.Items.Cast<ListViewItem>().Select(i => $"{i.Text}|{i.SubItems[1].Text}"));
            Assert.Contains(All<Button>(panel), b => b.Text == "Never");

            _ = list.Handle; // SelectedItems needs the native list
            list.Items[1].Selected = true;
            var forget = All<Button>(panel).Single(b => b.Text == "Forget");
            forget.GetType().GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(forget, [EventArgs.Empty]);
            Pump(() => requests.Count(r => r == "GET /approvals/remembered") == 2);
            Assert.Contains("""POST /approvals/remembered/forget {"key":"browser-site:bad.test"}""", requests);
        });
    }

    [Fact]
    public async Task Client_ReadsAndSavesGitApprovalModesPerTier()
    {
        var requests = new List<string>();
        var client = Backend(requests);
        var modes = await client.GetGitApprovalModesAsync();
        Assert.Equal("once", modes["local"]);
        Assert.Equal("ask", modes["danger"]);
        await client.SetGitApprovalModeAsync("danger", "off");
        Assert.Contains("""POST /approvals/git-mode {"tier":"danger","mode":"off"}""", requests);
        Assert.Equal("Git local changes: d:/mana", new ManaRememberedApproval { Key = "git-local:d:/mana" }.Label);
        Assert.Equal("Git repo: d:/other", new ManaRememberedApproval { Key = "git-repo:d:/other" }.Label);
    }

    [Fact]
    public void Settings_ShowsEachGitTier_AndWarnsWhenTheDangerousOneNeedsNoApproval()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var requests = new List<string>();
            using var panel = new SettingsPanel(Backend(requests), new BackendLogBuffer());
            Pump(panel.RefreshGitApprovalModesAsync());
            ComboBox Combo(string tier) => All<ComboBox>(panel).Single(c => c.AccessibleName == $"Git approval: {tier}");
            Assert.Equal("Ask once, then always allow", Combo("local").SelectedItem);
            Assert.Equal("Ask every time", Combo("github").SelectedItem);
            var warning = All<Label>(panel).Single(l => l.AccessibleName == "Git danger warning");
            Assert.Equal("", warning.Text);

            var danger = Combo("danger");
            danger.SelectedIndex = 2; // No approval
            danger.GetType().GetMethod("OnSelectionChangeCommitted", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(danger, [EventArgs.Empty]);
            Pump(() => requests.Any(r => r.StartsWith("POST /approvals/git-mode", StringComparison.Ordinal)));
            Assert.Contains("""POST /approvals/git-mode {"tier":"danger","mode":"off"}""", requests);
            Assert.StartsWith("Warning:", warning.Text);
        });
    }

    private static IEnumerable<T> All<T>(Control root) where T : Control =>
        root.Controls.Cast<Control>().SelectMany(c => (c is T t ? new[] { t } : Enumerable.Empty<T>()).Concat(All<T>(c)));

    private static void Pump(Task task) => Pump(() => task.IsCompleted);

    private static void Pump(Func<bool> done)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!done())
        {
            Assert.True(DateTime.UtcNow < deadline, "timed out");
            Application.DoEvents();
            Thread.Sleep(1);
        }
    }
}

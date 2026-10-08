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
[Collection("DarkTheme palette")] // builds SettingsPanels: see SettingsPanelLayoutTests
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
                "/folio-update" => """{"enabled":false,"tried":{}}""",
                "/folio-update/run" => """{"status":"waiting","sha":"abc","pr":71}""",
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
            var list = panel.RememberedList;
            Assert.Equal(["Always: Browser: shop.test", "Never: Browser: bad.test", "Always: memory-write"],
                list.Items.Cast<ListViewItem>().Select(i => i.Text));
            Assert.Contains(panel.ApprovalsList.ActionsFor!("req-1"), a => a.Name == "Never"); // a request can be answered "never"

            _ = list.Handle; // SelectedItems needs the native list
            list.Items[1].Selected = true;
            _ = list.SelectedActions.Single(a => a.Name.StartsWith("Forget", StringComparison.Ordinal)).Run();
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
            ComboBox Combo(string name) => All<ComboBox>(panel).Single(c => c.AccessibleName == name);
            Assert.Equal("Ask once, then allow", Combo("Local changes").SelectedItem);
            Assert.Equal("Ask every time", Combo("GitHub writes").SelectedItem);
            var warning = panel.GitDangerWarning; // shown on the merging row's own line
            Assert.Equal("", warning.Text);

            var danger = Combo("Merging and force-pushing");
            danger.SelectedIndex = 2; // without asking
            Pump(() => requests.Any(r => r.StartsWith("POST /approvals/git-mode", StringComparison.Ordinal)));
            Assert.Contains("""POST /approvals/git-mode {"tier":"danger","mode":"off"}""", requests);
            Assert.StartsWith("Warning:", warning.Text);
        });
    }

    // #1265: "Keep Folio up to date" next to them, and "Check now".
    [Fact]
    public void Settings_KeepFolioUpToDate_LoadsSavesAndChecksNow()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var requests = new List<string>();
            using var panel = new SettingsPanel(Backend(requests), new BackendLogBuffer());
            Pump(panel.RefreshGitApprovalModesAsync());
            var keep = All<CheckBox>(panel).Single(c => c.AccessibleName == "Keep Folio up to date");
            Assert.False(keep.Checked);

            keep.GetType().GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(keep, [EventArgs.Empty]);
            Pump(() => requests.Any(r => r.StartsWith("POST /folio-update ", StringComparison.Ordinal)));
            Assert.Contains("""POST /folio-update {"enabled":true}""", requests);

            var check = All<Button>(panel).Single(b => b.AccessibleName == "Check Folio now");
            check.GetType().GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(check, [EventArgs.Empty]);
            var result = All<Label>(panel).Single(l => l.AccessibleName == "Folio check result");
            Pump(() => result.Text == "Folio update #71 is still open.");
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

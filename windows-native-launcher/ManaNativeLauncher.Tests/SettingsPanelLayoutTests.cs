using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1426: Settings as its own window, grouped. STA.
// Every class that builds a SettingsPanel shares one collection: built in
// parallel, WinForms' KeysConverter fills its static key-name table twice.
[Collection("DarkTheme palette")]
public class SettingsPanelLayoutTests
{
    private static SettingsPanel NewPanel() =>
        new(new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable))), new BackendLogBuffer())
        {
            Dock = DockStyle.None,
            Size = new System.Drawing.Size(900, 640),
        };

    // #1426: nine groups, in order, each holding the pages that were tabs.
    [Fact]
    public void Groups_HoldEveryPageInTheirOrder()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var panel = NewPanel();
            Assert.Equal(new[] { "General", "Voice", "Check-ins", "Memory", "Models", "Permissions", "Privacy", "Connections", "Advanced" },
                panel.Groups.Select(g => g.Label));
            string Pages(string id) => string.Join(", ", panel.Groups.Single(g => g.Id == id).Tabs.TabPages.Cast<TabPage>().Select(p => p.Text));
            Assert.Equal("Startup, Theme, Hotkeys, Gaming", Pages("general"));
            Assert.Equal("Voice, Dictation", Pages("voice"));
            Assert.Equal("Proactive, Briefing, Heartbeat", Pages("checkins"));
            Assert.Equal("Facts, Characters, Group mode, Skills, Presets", Pages("memory"));
            Assert.Equal("Model, API Spending, Coding mode", Pages("models"));
            Assert.Equal("Approvals, Desktop folders", Pages("permissions"));
            Assert.Equal("Local-only, Your data", Pages("privacy"));
            Assert.Equal("Calendar & Email, Mobile Devices, Accounts, Plugins, MCP Clients", Pages("connections"));
            Assert.Equal("Backend, Hooks, Logs, Timings", Pages("advanced"));
            // Every page that used to be a tab is still somewhere: 27, as Connection and Performance split into five,
            // plus Coding mode, Dictation and Group mode from the tray.
            Assert.Equal(30, panel.Groups.Sum(g => g.Tabs.TabCount));
        });
    }

    [Fact]
    public void ShowGroup_ShowsOnlyThatGroup_AndSaysWhichWasLeft()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var panel = NewPanel();
            var left = new System.Collections.Generic.List<string>();
            panel.GroupChanged += left.Add;
            Assert.Equal("general", panel.CurrentGroup);
            panel.ShowGroup("voice");
            panel.ShowGroup("models");
            Assert.Equal("models", panel.CurrentGroup);
            Assert.Equal(new[] { "models" }, panel.Groups.Where(g => g.Tabs.Visible).Select(g => g.Id));
            Assert.Equal(new[] { "general", "voice" }, left);
            // Pills pick the page, so no group shows a tab strip; a one-page group shows no pills either.
            Assert.All(panel.Groups, g => Assert.Equal(1, g.Tabs.ItemSize.Height));
            Assert.Equal(new[] { "Model", "API Spending", "Coding mode" }, panel.PagePills.Controls.Cast<Control>().Select(c => c.Text));
            panel.ShowGroup("privacy");
            panel.PagePills.Controls.Cast<Button>().Single(b => b.Text == "Your data").PerformClick();
            Assert.Equal("Your data", panel.Groups.Single(g => g.Id == "privacy").Tabs.SelectedTab!.Text);
            panel.ShowGroup("advanced");
            Assert.Equal("Backend", panel.Groups.Single(g => g.Id == "advanced").Tabs.SelectedTab!.Text);
            Assert.Equal(new[] { "advanced" }, panel.Nav.SelectedItems.Cast<ListViewItem>().Select(i => (string)i.Tag!));
            panel.ShowGroup("nope");
            Assert.Equal("general", panel.CurrentGroup);
        });
    }

    [Fact]
    public void Search_FindsWordsOnEveryPage_AndOpensWhereTheyAre()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var panel = NewPanel();
            panel.SearchBox.Text = "deepseek";
            Assert.True(panel.SearchResults.Visible);
            var hit = panel.SearchResults.Items.Cast<ListViewItem>().First();
            Assert.Equal("Models › API Spending", hit.SubItems[1].Text);

            panel.SearchBox.Text = "admin token";
            var token = panel.SearchResults.Items.Cast<ListViewItem>().First(i => i.Text == "Admin token");
            Assert.Equal("Advanced › Backend", token.SubItems[1].Text);
            panel.OpenResult(token);
            Assert.Equal("advanced", panel.CurrentGroup);
            Assert.Equal("Backend", panel.Groups.Single(g => g.Id == "advanced").Tabs.SelectedTab!.Text);
            Assert.False(panel.SearchResults.Visible);
            Assert.Equal("", panel.SearchBox.Text);

            panel.SearchBox.Text = "zzzz";
            Assert.StartsWith("Nothing matches", panel.SearchResults.Items[0].Text);
        });
    }

    // #1426: the window comes back where it was, unless that's off every screen.
    [Fact]
    public void RestoredBounds_KeepsAWindowThatIsStillOnAScreen()
    {
        var screen = new[] { new System.Drawing.Rectangle(0, 0, 1920, 1040) };
        Assert.Equal(new System.Drawing.Rectangle(100, 50, 960, 680), SettingsDialog.RestoredBounds("100,50,960,680", screen));
        Assert.Null(SettingsDialog.RestoredBounds("3000,50,960,680", screen)); // a screen that's gone
        Assert.Null(SettingsDialog.RestoredBounds("100,50,300,200", screen)); // smaller than it can be
        Assert.Null(SettingsDialog.RestoredBounds("garbage", screen));
        Assert.Null(SettingsDialog.RestoredBounds(null, screen));
    }

    [Fact]
    public void SettingsWindow_RemembersItsBoundsAndGroup()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var path = Path.Combine(Path.GetTempPath(), $"mana-settings-{Guid.NewGuid():N}.json");
            try
            {
                using (var window = new SettingsDialog(NewPanel(), "privacy", path))
                {
                    window.Bounds = new System.Drawing.Rectangle(40, 40, 1000, 700);
                    window.Panel.ShowGroup("models");
                    window.SaveState();
                }
                var saved = ManaSettingsStore.Load(path);
                Assert.Equal("40,40,1000,700", saved.SettingsWindowBounds);
                Assert.Equal("models", saved.SettingsGroup);
                using var again = new SettingsDialog(NewPanel(), settingsPath: path);
                Assert.Equal("models", again.Panel.CurrentGroup);
            }
            finally
            {
                File.Delete(path);
            }
        });
    }

    // #1426: group mode lives in Settings > Memory > Group mode now.
    [Fact]
    public void GroupMode_ShowsThePartner_AndSwitchesFromSettings()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var posts = new System.Collections.Generic.List<string>();
            var groupOn = true;
            var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
            {
                if (request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/characters/group")
                {
                    var body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                    posts.Add(body);
                    groupOn = body.Contains("\"on\":true");
                }
                if (request.RequestUri!.AbsolutePath == "/characters")
                {
                    var json = "{\"active\":\"mana\",\"characters\":[{\"id\":\"mana\",\"name\":\"Mana\"},{\"id\":\"evil-mana\",\"name\":\"Evil Mana\"}]," +
                        $"\"group\":{{\"on\":{(groupOn ? "true" : "false")},\"partner\":\"evil-mana\",\"paused\":false}}}}";
                    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
                }
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json") };
            }));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Width = 900 };
            panel.RefreshGroupModeAsync().GetAwaiter().GetResult();
            Assert.True(panel.GroupModeCheck.Checked);
            Assert.Equal("Evil Mana", panel.GroupPartnerCombo.Text);
            Assert.Equal("On: Evil Mana replies too.", panel.GroupModeStatus.Text);

            panel.GroupModeCheck.Checked = false;
            for (var i = 0; i < 50 && panel.GroupModeStatus.Text != "Off."; i++)
            {
                Application.DoEvents();
                System.Threading.Thread.Sleep(20);
            }
            Assert.Equal("{\"on\":false,\"partner\":\"evil-mana\"}", posts.Single());
            Assert.Equal("Off.", panel.GroupModeStatus.Text);
        });
    }

    // #1336: Settings > Privacy tab verification
    [Fact]
    public void PrivacyTab_IsRegisteredWithExportAndDeleteControls()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Width = 800 };
            var privacyTab = panel.Groups.Single(g => g.Id == "privacy").Tabs.TabPages.Cast<TabPage>().FirstOrDefault(p => p.Text == "Your data");
            Assert.NotNull(privacyTab);

            var buttons = GetAllDescendants(privacyTab)
                .OfType<Button>()
                .ToList();

            Assert.Contains(buttons, b => b.AccessibleName == "Export everything");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete everything");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Voice Data");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Chat History");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Memory Facts");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Vault Sync State");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Caches & Logs");
        });
    }

    [Fact]
    public void CloudFallback_HasOptInAndAllTimingOptions_OffByDefault()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Size = new System.Drawing.Size(800, 900) };
            var group = GetAllDescendants(panel).OfType<GroupBox>().Single(g => g.Text == "Chat Cloud Fallback");
            var toggle = GetAllDescendants(group).OfType<CheckBox>().Single();
            Assert.False(toggle.Checked);
            var timing = GetAllDescendants(group).OfType<ComboBox>().Single();
            Assert.Equal(new[] { "30 seconds", "60 seconds", "No timeout" }, timing.Items.Cast<string>());
            Assert.Equal("No timeout", timing.SelectedItem);
            Assert.Contains(GetAllDescendants(group).OfType<TextBox>(), box => box.UseSystemPasswordChar);
            if (Environment.GetEnvironmentVariable("MANA_CHAT_MODEL_SNAPSHOT_DIR") is { } output)
            {
                using var host = new Panel { Size = new System.Drawing.Size(500, 300), BackColor = DarkTheme.Background };
                host.Controls.Add(group);
                group.Location = System.Drawing.Point.Empty;
                host.CreateControl();
                group.CreateControl();
                foreach (var child in GetAllDescendants(group)) { child.CreateControl(); _ = child.Handle; }
                group.PerformLayout();
                foreach (var box in GetAllDescendants(group).OfType<TextBox>())
                {
                    Assert.True(box.Visible);
                    Assert.True(box.Width >= 180 && box.Height >= 20);
                    box.Text = box.UseSystemPasswordChar ? "test-key" : "configured-endpoint-model";
                }
                using var bitmap = new System.Drawing.Bitmap(group.Width, group.Height);
                group.DrawToBitmap(bitmap, group.ClientRectangle);
                Directory.CreateDirectory(output);
                bitmap.Save(Path.Combine(output, "cloud-fallback-settings.png"));
            }
        });
    }

    private static System.Collections.Generic.IEnumerable<Control> GetAllDescendants(Control control)
    {
        yield return control;
        foreach (Control child in control.Controls)
        {
            foreach (var descendant in GetAllDescendants(child))
            {
                yield return descendant;
            }
        }
    }
}


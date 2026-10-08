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
            Assert.Equal("General", Pages("general")); // stage 2: one page of rows
            Assert.Equal("Voice", Pages("voice"));
            Assert.Equal("Check-ins", Pages("checkins"));
            Assert.Equal("Memory", Pages("memory"));
            Assert.Equal("Model, API Spending, Coding mode, Model tools", Pages("models"));
            Assert.Equal("Approvals, Desktop folders, Pending edits", Pages("permissions"));
            Assert.Equal("Local-only, Your data", Pages("privacy"));
            Assert.Equal("Calendar & Email, Mobile Devices, Accounts, Plugins, MCP Clients", Pages("connections"));
            Assert.Equal("Backend, Hooks, Logs, Timings, Developer", Pages("advanced"));
            // Every page that used to be a tab is still somewhere: 27, as Connection and Performance split into five,
            // plus what came from the tray: Coding mode, Dictation, Group mode, Avatar and the tool windows' pages --
            // less General's five, Voice's two, Check-ins' three and Memory's six, each now one page.
            Assert.Equal(23, panel.Groups.Sum(g => g.Tabs.TabCount));
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
            Assert.Equal(new[] { "Model", "API Spending", "Coding mode", "Model tools" }, panel.PagePills.Controls.Cast<Control>().Select(c => c.Text));
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

    // #1426 stage 2: a row is one result, named for its setting, found by its explanation and keywords too.
    [Fact]
    public void Search_FindsARowByItsWords_AndFlashesIt()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var panel = NewPanel();
            panel.SearchBox.Text = "tray";
            var hit = panel.SearchResults.Items.Cast<ListViewItem>().Single(i => i.Text == "Start with Windows");
            Assert.Equal("General", hit.SubItems[1].Text);
            panel.SearchBox.Text = "subtitles";
            var captions = panel.SearchResults.Items.Cast<ListViewItem>().Single();
            Assert.Equal("Captions", captions.Text);
            panel.OpenResult(captions);
            Assert.True(((SettingsRow)((System.ValueTuple<string, TabPage, Control>)captions.Tag!).Item3).Highlighted);
        });
    }

    // #1426 stage 2: each change says it saved; Undo and Ctrl+Z step back through them all.
    [Fact]
    public void Changes_CanBeUndoneOneByOne()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var panel = NewPanel();
            var undone = new System.Collections.Generic.List<string>();
            panel.Changed("First", () => undone.Add("First"));
            panel.Changed("Second", () => undone.Add("Second"));
            Assert.Equal("Saved · Second", panel.UndoText.Text);
            panel.Undo();
            Assert.Equal("Undone: Second", panel.UndoText.Text);
            panel.Undo();
            Assert.Equal("Undone: First. Nothing else to undo.", panel.UndoText.Text);
            panel.Undo(); // nothing left
            Assert.Equal(new[] { "Second", "First" }, undone);
        });
    }

    // #1426 stage 2: a slider saves as it moves; Default is one change, and Undo puts back where it was.
    [Fact]
    public void SliderRow_SavesAsItMoves_AndDefaultCanBeUndone()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var panel = NewPanel();
            var saved = new System.Collections.Generic.List<double>();
            using var row = panel.SliderRow("Pause", "How long", "", 0, 1, 0.1, 0.5, 0.3, "Quick", "Slow", v => v.ToString("0.0 s", System.Globalization.CultureInfo.InvariantCulture), saved.Add);
            var slider = GetAllDescendants(row).OfType<TrackBar>().Single();
            Assert.Equal(5, slider.Value);
            slider.Value = 8;
            Assert.Contains(GetAllDescendants(row).OfType<Label>(), l => l.Text == "0.8 s");
            GetAllDescendants(row).OfType<Button>().Single(b => b.Text == "Default").PerformClick();
            Assert.Equal("Saved · Pause 0.3 s", panel.UndoText.Text);
            panel.Undo();
            Assert.Equal(5, slider.Value);
            Assert.Equal(new[] { 0.8, 0.3, 0.5 }, saved);
        });
    }

    // #1426 stage 2: facts filter by state with counts, and the actions follow the fact picked.
    [Fact]
    public void Facts_FilterByState_AndOfferWhatFitsTheFact()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var posts = new System.Collections.Generic.List<string>();
            var today = DateTimeOffset.Now.ToString("o");
            var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
            {
                if (request.Method == HttpMethod.Post)
                {
                    posts.Add(request.RequestUri!.AbsolutePath);
                }
                if (request.RequestUri!.AbsolutePath == "/admin/memory/facts")
                {
                    var json = "{\"facts\":[" +
                        $"{{\"key\":\"editor\",\"text\":\"VS Code\",\"status\":\"active\",\"pinned\":true,\"category\":\"about-you\",\"updatedAt\":\"{today}\"}}," +
                        "{\"key\":\"pet\",\"text\":\"a cat\",\"status\":\"pending\"}," +
                        "{\"key\":\"old\",\"text\":\"was here\",\"status\":\"archived\"}]}";
                    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
                }
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json") };
            }));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Width = 900 };
            panel.ShowGroup("memory"); // its buttons only click while showing
            _ = panel.FactsList.Handle; // selection needs the list's window
            panel.RefreshMemoryFactsAsync().GetAwaiter().GetResult();
            Assert.Equal(new[] { "Active 1", "Waiting 1", "Archived 1" }, panel.FactChips.Select(c => c.Text));
            // #1426: grouped by what it's about, each group under its own header.
            Assert.True(RowList.IsHeader(panel.FactsList.Items[0]));
            Assert.Equal("About you", panel.FactsList.Items[0].Text);
            var editor = panel.FactsList.Items[1];
            Assert.Equal("editor: VS Code", editor.Text);
            Assert.Equal("Today", panel.FactsList.EntryOf(editor)!.Right);
            string[] Actions() => panel.FactsList.SelectedActions.Select(a => a.Name).ToArray();
            editor.Selected = true;
            Assert.Equal(new[] { "Edit", "Unpin", "Move to…", "Archive", "Delete" }, Actions());

            panel.FactChips[1].Checked = true;
            Assert.Equal("Other", panel.FactsList.Items[0].Text); // no category yet
            panel.FactsList.Items[1].Selected = true;
            Assert.Equal(new[] { "Confirm", "Edit", "Move to…", "Not true" }, Actions());

            panel.FactChips[2].Checked = true;
            panel.FactsList.Items[1].Selected = true;
            Assert.Equal(new[] { "Restore", "Delete" }, Actions()); // archived facts stay where they were
            panel.FactsList.SelectedActions[0].Run().GetAwaiter().GetResult();
            Assert.Equal("/admin/memory/facts/old/restore", posts.Single());
        });
    }

    [Fact]
    public void UpdatedText_SaysTodayOrTheDate()
    {
        var now = new DateTimeOffset(2026, 10, 8, 15, 0, 0, TimeSpan.FromHours(8));
        Assert.Equal("Today", SettingsPanel.UpdatedText("2026-10-08T01:00:00Z", now));
        Assert.Equal("3 Oct", SettingsPanel.UpdatedText("2026-10-03T09:00:00+08:00", now));
        Assert.Equal("3 Oct 2025", SettingsPanel.UpdatedText("2025-10-03T09:00:00+08:00", now));
        Assert.Equal("", SettingsPanel.UpdatedText(null, now));
    }

    // #1426: "Tell Mana what to remember or change": her suggestion first, written only by Save it.
    [Fact]
    public void AskBox_ShowsHerSuggestion_AndSavesItOnlyWhenAsked()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var posts = new System.Collections.Generic.List<string>();
            var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
            {
                var path = request.RequestUri!.AbsolutePath;
                if (request.Method == HttpMethod.Post)
                {
                    posts.Add($"{path} {request.Content!.ReadAsStringAsync().GetAwaiter().GetResult()}");
                }
                var json = path == "/admin/memory/ask"
                    ? "{\"ok\":true,\"reply\":\"I'll change editor from VS Code to Cursor. Okay?\",\"changes\":[{\"action\":\"change\",\"key\":\"editor\",\"text\":\"Uses Cursor\",\"was\":\"Uses VS Code\"}]}"
                    : "{\"ok\":true,\"facts\":[]}";
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
            }));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Width = 900 };
            panel.AskBox.Text = "I switched to Cursor";
            panel.AskMemoryAsync().GetAwaiter().GetResult();
            Assert.Equal("I'll change editor from VS Code to Cursor. Okay?", panel.AnswerReply.Text);
            Assert.Equal(new[] { "Change", "editor", "Uses VS Code", "→", "Uses Cursor" },
                panel.AnswerChanges.Controls[0].Controls.Cast<Control>().Select(c => c.Text)); // the old words struck through, the new after the arrow
            Assert.Equal(new[] { "/admin/memory/ask {\"text\":\"I switched to Cursor\"}" }, posts); // nothing applied yet

            panel.SaveAnswerAsync().GetAwaiter().GetResult();
            Assert.StartsWith("/admin/memory/ask/apply {\"changes\":[{\"action\":\"change\"", posts[1]);
            Assert.Equal("", panel.AskBox.Text);
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


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
            Assert.Equal("Models", Pages("models"));
            Assert.Equal("Permissions", Pages("permissions"));
            Assert.Equal("Privacy", Pages("privacy"));
            Assert.Equal("Connections", Pages("connections"));
            Assert.Equal("Advanced", Pages("advanced"));
            // Every page that used to be a tab is still somewhere: 27, as Connection and Performance split into five,
            // plus what came from the tray: Coding mode, Dictation, Group mode, Avatar and the tool windows' pages --
            // less General's five, Voice's two, Check-ins' three, Memory's six, Models' four, Permissions' three, Privacy's two, Connections' five and Advanced's five: every group is one page now.
            Assert.Equal(9, panel.Groups.Sum(g => g.Tabs.TabCount));
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
            Assert.Empty(panel.PagePills.Controls); // Models is one page now
            panel.ShowGroup("advanced");
            Assert.Empty(panel.PagePills.Controls); // every group is one page now, so no pills anywhere
            Assert.False(panel.PagePills.Visible);
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
            Assert.Equal("Models", hit.SubItems[1].Text); // the Providers row

            panel.SearchBox.Text = "admin token";
            var token = panel.SearchResults.Items.Cast<ListViewItem>().First(i => i.Text == "Admin token");
            Assert.Equal("Advanced", token.SubItems[1].Text);
            panel.OpenResult(token);
            Assert.Equal("advanced", panel.CurrentGroup);
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
            var slider = GetAllDescendants(row).OfType<SettingsSlider>().Single();
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

    // #1426 stage 2: plugins grouped by category, an add-on marked, and a pairing code on its row.
    [Fact]
    public void Connections_GroupsPlugins_AndShowsThePairingCode()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
            {
                var json = request.RequestUri!.AbsolutePath switch
                {
                    "/plugins" => "{\"plugins\":{\"Core\":[{\"key\":\"cron\",\"name\":\"Cron Scheduler\",\"enabled\":true}],\"User Installed\":[{\"key\":\"mine\",\"name\":\"My plugin\",\"enabled\":false}]}}",
                    _ => null,
                };
                return json is null
                    ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
            }));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Width = 900 };
            panel.RefreshAllAsync().GetAwaiter().GetResult();
            var items = panel.PluginsList.Items.Cast<ListViewItem>().ToList();
            Assert.Equal(new[] { "Core", "Cron Scheduler", "User Installed", "My plugin" }, items.Select(i => RowList.IsHeader(i) ? i.Text : panel.PluginsList.EntryOf(i)!.Name));
            Assert.Equal("Add-on", panel.PluginsList.EntryOf(items[3])!.Tag);
            Assert.Equal("Off", panel.PluginsList.EntryOf(items[3])!.Right);
            Assert.Equal("Turn on", panel.PluginsList.ActionsFor!(items[3].Tag!).Single().Name);
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
            var privacyTab = panel.Groups.Single(g => g.Id == "privacy").Tabs.TabPages.Cast<TabPage>().FirstOrDefault(p => p.Text == "Privacy");
            Assert.NotNull(privacyTab);

            var buttons = GetAllDescendants(privacyTab)
                .OfType<Button>()
                .ToList();

            Assert.Contains(buttons, b => b.AccessibleName == "Export everything");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete everything");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Voice data");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Chat history");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Memory facts");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Vault sync");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Caches and logs");
        });
    }

    // #1426 stage 2: Models' uses pick from the providers added; every preset not added yet is offered (#1441).
    [Fact]
    public void Models_UsesPickFromTheProviders_AndTheRestAreOffered()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
            {
                var json = request.RequestUri!.AbsolutePath switch
                {
                    "/models/status" => "{\"activeProfile\":\"default\",\"profiles\":{\"default\":{}},\"brain\":{\"type\":\"local\"},\"fallback\":{\"enabled\":false,\"timeoutSeconds\":0},\"loadIntoVram\":true}",
                    "/self-work/escalation" => "{\"enabled\":false,\"hasKey\":true,\"localOnly\":false,\"providerId\":\"deepseek\"}",
                    "/models/providers" => "{\"presets\":[{\"id\":\"deepseek\",\"label\":\"DeepSeek\",\"baseUrl\":\"https://api.deepseek.com\",\"needsKey\":true},{\"id\":\"openai\",\"label\":\"OpenAI\",\"baseUrl\":\"https://api.openai.com/v1\",\"needsKey\":true}]," +
                        "\"providers\":[{\"id\":\"deepseek\",\"preset\":\"deepseek\",\"label\":\"DeepSeek\",\"baseUrl\":\"https://api.deepseek.com\",\"hasKey\":true,\"keyHint\":\"…9876\",\"lastCheck\":{\"at\":\"2026-10-09T00:00:00Z\",\"ok\":true},\"usedBy\":[]}]}",
                    _ => null,
                };
                return json is null
                    ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
            }));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Size = new System.Drawing.Size(900, 900) };
            panel.RefreshModelTabAsync().GetAwaiter().GetResult();
            string[] Items(ComboBox combo) => combo.Items.Cast<object>().Select(i => i.ToString()!).ToArray();
            Assert.Equal(new[] { "This PC's model", "DeepSeek" }, Items(panel.MainSource));
            Assert.Equal("This PC's model", panel.MainSource.Text);
            Assert.Equal(new[] { "Off", "DeepSeek" }, Items(panel.FallbackSource));
            Assert.Equal("Off", panel.FallbackSource.Text); // off until I pick one
            Assert.Equal(new[] { "Off", "DeepSeek" }, Items(panel.EscalationSource));
            var chip = panel.ProvidersPanel!.Summary.Controls.OfType<ProviderChip>().Single();
            Assert.Equal("✓", chip.Mark); // the last check reached it
            Assert.Equal(new[] { "OpenAI" }, Items(panel.ProvidersPanel.AddPreset)); // DeepSeek is already added
        });
    }

    // #1441: escalation on any provider, its two models picked from that
    // provider's list, each with how it has done.
    [Fact]
    public void Models_EscalationModelsArePickedFromTheProvidersList()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            string? posted = null;
            var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
            {
                if (request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/self-work/escalation")
                {
                    posted = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                }
                var json = request.RequestUri!.AbsolutePath switch
                {
                    "/models/status" => "{\"activeProfile\":\"default\",\"profiles\":{\"default\":{}},\"brain\":{\"type\":\"local\"},\"fallback\":{\"enabled\":false,\"timeoutSeconds\":0},\"loadIntoVram\":true}",
                    "/self-work/escalation" => "{\"enabled\":true,\"hasKey\":true,\"localOnly\":false,\"providerId\":\"openrouter\",\"preset\":\"openrouter\",\"models\":[\"qwen/qwen3-coder\"]," +
                        "\"stats\":[{\"model\":\"qwen/qwen3-coder\",\"runs\":4,\"passed\":1,\"usd\":0.2}]}",
                    "/models/providers/openrouter/models" => "{\"models\":[\"openai/gpt-5\",\"qwen/qwen3-coder\"]}",
                    "/models/providers" => "{\"presets\":[],\"providers\":[{\"id\":\"openrouter\",\"preset\":\"openrouter\",\"label\":\"OpenRouter\",\"baseUrl\":\"https://openrouter.ai/api/v1\",\"hasKey\":true,\"usedBy\":[]}]}",
                    _ => null,
                };
                return json is null
                    ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
            }));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Size = new System.Drawing.Size(900, 900) };
            panel.RefreshModelTabAsync().GetAwaiter().GetResult();
            string[] Items(ComboBox combo) => combo.Items.Cast<object>().Select(i => i.ToString()!).ToArray();
            Assert.Equal("OpenRouter", panel.EscalationSource.Text);
            Assert.Equal(new[] { "Pick a model", "qwen/qwen3-coder", "openai/gpt-5" }, Items(panel.EscalationFirst));
            Assert.Equal("qwen/qwen3-coder", panel.EscalationFirst.Text);
            Assert.Equal("Nothing, stop there", panel.EscalationSecond.Text);
            Assert.Equal("Fixed 1 of 4 issues · about $0.05 a run", panel.EscalationFirstSaid);
        });
    }

    [Fact]
    public void EscalationSaid_NotRunYet_OrFixedAndCost()
    {
        Assert.Equal("Not run yet", SettingsPanel.EscalationSaid("m", []));
        Assert.Equal("Fixed 1 of 1 issue · cost unknown", SettingsPanel.EscalationSaid("m", [new("m", 1, 1, null)]));
        Assert.Equal("Fixed 0 of 2 issues · about $0.15 a run", SettingsPanel.EscalationSaid("m", [new("m", 2, 0, 0.3)]));
    }

    // #1441: a provider line says which of her tool loop's steps worked.
    [Fact]
    public void ProviderLight_SaysWhichStepsWorked()
    {
        var now = DateTimeOffset.Parse("2026-10-09T12:00:00Z");
        ManaProvider With(ManaProviderCheck? check) => new() { Label = "Groq", LastCheck = check };
        var at = now.AddMinutes(-5);
        Assert.Equal("not checked yet", ProvidersPanel.Light(With(null), now).Said);
        Assert.Equal("checked 5 min ago", ProvidersPanel.Light(With(new() { At = at, Ok = true }), now).Said); // a check from before #1441
        Assert.Equal("chat, tools and streaming work on llama-3 · checked 5 min ago",
            ProvidersPanel.Light(With(new() { At = at, Ok = true, Model = "llama-3", Chat = true, Tools = true, Stream = true }), now).Said);
        var partial = ProvidersPanel.Light(With(new() { At = at, Ok = false, Model = "llama-3", Chat = true, Tools = false, Stream = true, Error = "Tool call: it didn't call the tool" }), now);
        Assert.Equal(DarkTheme.Warn, partial.Light);
        Assert.Equal("chat ✓ · tools ✗ · streaming ✓ on llama-3 · Tool call: it didn't call the tool", partial.Said);
        Assert.Equal("didn't answer: Chat: answered 401", ProvidersPanel.Light(With(new() { At = at, Ok = false, Chat = false, Error = "Chat: answered 401" }), now).Said);
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


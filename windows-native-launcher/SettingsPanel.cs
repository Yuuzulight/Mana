using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #529/#581/#582: a lean settings surface -- plugins (enable/disable),
// memory facts (view/archive), skills (view/edit/create/delete via
// SkillEditorDialog, #581), the approval-gate queue (approve/deny), and
// (#582) a live backend log tail. Most tabs are still a plain ListView
// with the one or two actions that matter most, not a full editor --
// see each feature issue's own PR description for the full reasoning.
internal sealed class SettingsPanel : UserControl
{
    private readonly ManaBackendClient backendClient;
    private readonly BackendLogBuffer backendLog;
    // Optional: lets the Perf tab request session-scoped token-budget data
    // (see RefreshPerfTabAsync) -- null in the one caller that doesn't have
    // a session concept (there isn't one today; kept optional so a future
    // caller isn't forced to plumb a session id it may not have).
    private readonly Func<string?>? getCurrentSessionId;
    private readonly ListeningPause? listeningPause; // #922
    private CancellationTokenSource? enrolmentCancel; // #922: set while teaching Mana my voice
    private readonly ListView pluginsList = new();
    private readonly ListView factsList = new();
    // #688: search boxes over the last-loaded plugins/facts.
    private readonly TextBox pluginsSearch = new() { Dock = DockStyle.Fill, PlaceholderText = "Search plugins", AccessibleName = "Search plugins" };
    private readonly TextBox factsSearch = new() { Dock = DockStyle.Top, PlaceholderText = "Search memory", AccessibleName = "Search memory" };
    private System.Collections.Generic.IReadOnlyList<ManaPlugin> plugins = Array.Empty<ManaPlugin>();
    private System.Collections.Generic.IReadOnlyList<ManaMemoryFact> facts = Array.Empty<ManaMemoryFact>();
    private readonly ListView skillsList = new();
    // Q20: Settings > Skills' "Imported skills" choice, in node-bot's order.
    private static readonly string[] ImportedSkillUseModes = { "free", "each", "first" };
    private readonly ComboBox importedSkillUseBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 180 };
    private readonly ListView approvalsList = new();
    // #669: index-aligned with ToolApprovalModes below.
    private readonly ComboBox toolApprovalModeCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 320 };
    private static readonly string[] ToolApprovalModes = { "smart", "ask", "off" };
    private readonly ComboBox voiceProviderCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private readonly TextBox logsTextBox = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer logRefreshTimer = new() { Interval = 1000 };
    private readonly ComboBox themePresetCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private readonly TextBox themeAccentBox = new() { Width = 100 };
    private readonly Label perfSummaryLabel = new() { AutoSize = true };
    private readonly Label gamingStatusLabel = new() { AutoSize = true, Anchor = AnchorStyles.Left };
    private readonly CheckBox gamingModeCheck = new() { Text = "Gaming mode detection", AutoSize = true };
    private readonly ListView perfOperationsList = new();
    private readonly ListView presetsList = new();
    // #681: which preset replies actually use ("None" = index 0).
    private readonly ComboBox activePresetCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private bool populatingPresets;
    private readonly ListView mobileDevicesList = new();
    private readonly ListView accountsList = new();
    private readonly ListView mcpServersList = new();
    private readonly ListView hooksList = new();
    private bool populatingPlugins;
    private bool populatingHooks;

    // #572: Model tab controls -- kept as fields (unlike most other tabs'
    // plain local variables in their Build*Tab methods) because Refresh
    // needs to repopulate them from a fresh GetModelStatusAsync call, the
    // same reason pluginsList/factsList/etc. above are fields too.
    private readonly ComboBox modelProfileCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private readonly Label selectedModelLabel = new() { AutoSize = true };
    private readonly Label recommendationLabel = new() { AutoSize = true };
    private readonly ListBox scanResultsList = new() { Height = 100, Width = 400 };
    private readonly CheckBox useRemoteAiCheckBox = new() { Text = "Use Remote AI (OpenAI-compatible endpoint)" };
    private readonly ComboBox brainPresetCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private readonly TextBox brainBaseUrlBox = new() { Width = 300 };
    private readonly TextBox brainApiKeyBox = new() { Width = 300, UseSystemPasswordChar = true };
    private readonly TextBox brainModelBox = new() { Width = 300 };
    private readonly Label brainStatusLabel = new() { AutoSize = true };
    private readonly TextBox visionModelPathBox = new() { Width = 300 };
    private readonly TextBox visionMmprojPathBox = new() { Width = 300 };
    private readonly CheckBox loadIntoVramCheckBox = new() { Text = "Load the model straight into VRAM (saves ~4 GB RAM)", AutoSize = true };
    private System.Collections.Generic.IReadOnlyList<ManaBrainProviderPreset> brainPresets = System.Array.Empty<ManaBrainProviderPreset>();
    // #693: llama.cpp build group. Update stays disabled until a check
    // finds a newer build -- nothing downloads without that click.
    private readonly Label llamaBuildLabel = new() { AutoSize = true, MaximumSize = new Size(560, 0) };
    private readonly Button llamaUpdateButton = new() { Text = "Update", Enabled = false };
    private readonly Button llamaRollbackButton = new() { Text = "Roll back", Enabled = false };
    private bool llamaUpdateAvailable;
    private string? llamaCheckNote;

    public SettingsPanel(ManaBackendClient backendClient, BackendLogBuffer backendLog, Func<string?>? getCurrentSessionId = null, Func<HotkeyAction, Keys?, string?>? bindHotkey = null, ListeningPause? listeningPause = null)
    {
        this.bindHotkey = bindHotkey;
        this.listeningPause = listeningPause;
        this.backendClient = backendClient;
        this.backendLog = backendLog;
        this.getCurrentSessionId = getCurrentSessionId;
        Dock = DockStyle.Fill;
        BackColor = DarkTheme.Background;
        ForeColor = DarkTheme.Text;

        var tabs = new TabControl { Dock = DockStyle.Fill };
        DarkTheme.ApplyTabControl(tabs);
        tabs.TabPages.Add(BuildConnectionTab());
        tabs.TabPages.Add(BuildPluginsTab());
        tabs.TabPages.Add(BuildMemoryFactsTab());
        tabs.TabPages.Add(BuildSkillsTab());
        tabs.TabPages.Add(BuildApprovalsTab());
        var voiceTab = BuildVoiceTab();
        tabs.TabPages.Add(voiceTab);
        tabs.TabPages.Add(BuildBriefingTab());
        tabs.TabPages.Add(new TabPage("Desktop") { Controls = { new DesktopFoldersPanel() } }); // #997
        tabs.TabPages.Add(BuildHotkeysTab());
        tabs.TabPages.Add(BuildLogsTab());
        tabs.TabPages.Add(BuildThemeTab());
        tabs.TabPages.Add(BuildPerfTab());
        tabs.TabPages.Add(BuildPresetsTab());
        tabs.TabPages.Add(BuildModelTab());
        tabs.TabPages.Add(BuildMobileDevicesTab());
        tabs.TabPages.Add(BuildAccountsTab());
        tabs.TabPages.Add(BuildMailCalendarTab());
        tabs.TabPages.Add(BuildMcpServersTab());
        tabs.TabPages.Add(BuildHooksTab());
        foreach (TabPage page in tabs.TabPages)
        {
            page.BackColor = DarkTheme.Background;
        }
        // #922: leaving the Voice tab mid-enrolment cancels it, like closing Settings.
        tabs.Deselected += (_, e) =>
        {
            if (e.TabPage == voiceTab)
            {
                enrolmentCancel?.Cancel();
            }
        };
        Controls.Add(tabs);
    }

    public async Task RefreshAllAsync()
    {
        await RefreshPluginsAsync();
        await RefreshMemoryFactsAsync();
        await RefreshSkillsAsync();
        await RefreshApprovalsAsync();
        await RefreshToolApprovalModeAsync();
        await RefreshVoiceTabAsync();
        await (refreshSpeechWords?.Invoke() ?? Task.CompletedTask);
        await (refreshBriefing?.Invoke() ?? Task.CompletedTask);
        await RefreshPerfTabAsync();
        await RefreshPresetsAsync();
        await RefreshModelTabAsync();
        await RefreshLlamaBuildAsync();
        await RefreshMobileDevicesAsync();
        await RefreshAccountsAsync();
        await RefreshMailCalendarAsync();
        await RefreshMcpServersAsync();
        await RefreshHooksAsync();
    }

    // #529 review: a failed load left its list untouched -- on first
    // open that renders as an empty list indistinguishable from "really
    // nothing here" (e.g. the memory-facts endpoint requires an admin
    // token when node-bot has MANA_ADMIN_SECRET configured, which this
    // client doesn't send -- there's no settings UI yet to enter one).
    // One visible placeholder row beats a silent, misleading empty state.
    private static void ShowLoadFailure(ListView list, string message)
    {
        list.Items.Clear();
        list.Items.Add(new ListViewItem($"Failed to load: {message}") { ForeColor = Color.Firebrick });
    }

    // #565: the backend URL and admin token are read straight from
    // ManaSettingsStore rather than threaded in through SessionListForm/
    // SettingsDialog's constructors -- both ManaBackendClient and
    // TrayNotificationClient only read this file once, at app startup,
    // so a change here can't take effect live regardless; reading/writing
    // the same small file directly here is simpler than plumbing a store
    // reference through two more constructors for a value nothing else
    // needs mid-session.
    private TabPage BuildConnectionTab()
    {
        var settings = ManaSettingsStore.Load();

        var urlLabel = new Label { Text = "Backend URL", AutoSize = true, ForeColor = DarkTheme.Text };
        var urlBox = new TextBox { Text = settings.BackendBaseUrl, Width = 320, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
        var tokenLabel = new Label { Text = "Admin token (optional)", AutoSize = true, ForeColor = DarkTheme.Text };
        var tokenBox = new TextBox { Text = settings.AdminToken ?? "", Width = 320, UseSystemPasswordChar = true, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
        var statusLabel = new Label { AutoSize = true, ForeColor = DarkTheme.Muted };

        var saveButton = new Button { Text = "Save" };
        DarkTheme.ApplyButton(saveButton);
        saveButton.Click += (_, _) =>
        {
            var url = urlBox.Text.Trim();
            // A malformed value saved here would throw on the *next*
            // launch (ManaBackendClient's constructor does `new Uri(...)`
            // with no try/catch of its own) -- rejecting it here, before
            // it's ever persisted, is cheaper than a crash-on-startup bug
            // report from a single typo.
            if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || (parsed.Scheme != "http" && parsed.Scheme != "https"))
            {
                statusLabel.ForeColor = Color.Firebrick;
                statusLabel.Text = "Backend URL must be a valid http:// or https:// address.";
                return;
            }

            // #681: reload rather than save the copy read when this tab was
            // built -- the Presets tab may have changed ActivePresetId since.
            var latest = ManaSettingsStore.Load();
            latest.BackendBaseUrl = url;
            latest.AdminToken = string.IsNullOrWhiteSpace(tokenBox.Text) ? null : tokenBox.Text.Trim();
            latest.Save();
            statusLabel.ForeColor = DarkTheme.Muted;
            statusLabel.Text = "Saved -- restart Mana for this to take effect.";
        };

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            AutoSize = true,
            Padding = new Padding(12),
        };
        layout.Controls.Add(urlLabel);
        layout.Controls.Add(urlBox);
        layout.Controls.Add(tokenLabel);
        layout.Controls.Add(tokenBox);
        layout.Controls.Add(saveButton);
        layout.Controls.Add(statusLabel);
        layout.Controls.Add(BuildLocalOnlyRow(settings.LocalOnly));

        return new TabPage("Connection") { Controls = { layout } };
    }

    // #670: saved at once like the Voice tab's checkboxes; the backend
    // reads it when the launcher next starts it.
    private static FlowLayoutPanel BuildLocalOnlyRow(bool localOnly)
    {
        var check = new CheckBox
        {
            Text = "Local-only mode (nothing leaves this PC and your local network)",
            AutoSize = true,
            ForeColor = DarkTheme.Text,
            Checked = localOnly,
        };
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
        check.CheckedChanged += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.LocalOnly = check.Checked;
            latest.Save();
            status.Text = "Saved -- restart Mana for this to take effect. MANA_LOCAL_ONLY=1 in node-bot/.env keeps it on.";
        };

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(check);
        row.Controls.Add(status);
        return row;
    }

    private TabPage BuildPluginsTab()
    {
        pluginsList.Dock = DockStyle.Fill;
        pluginsList.View = View.Details;
        pluginsList.CheckBoxes = true;
        pluginsList.FullRowSelect = true;
        pluginsList.Columns.Add("Plugin", 220);
        pluginsList.Columns.Add("Description", 300);
        pluginsList.ItemChecked += OnPluginChecked;
        DarkTheme.ApplyListView(pluginsList);

        // #688: search, and "+ Add" -> the guide listing plugins and how to
        // add one (no installer, same as Electron).
        StyleSearchBox(pluginsSearch);
        pluginsSearch.TextChanged += (_, _) => ShowPlugins();
        var addButton = new Button { Text = "+ Add", Dock = DockStyle.Right, Width = 70 };
        DarkTheme.ApplyButton(addButton);
        addButton.Click += (_, _) => OpenPluginGuide();
        var searchRow = new Panel { Dock = DockStyle.Top, Height = 26, BackColor = DarkTheme.Background };
        searchRow.Controls.Add(pluginsSearch);
        searchRow.Controls.Add(addButton);

        var page = new TabPage("Plugins");
        page.Controls.Add(pluginsList);
        page.Controls.Add(searchRow);
        return page;
    }

    private static void StyleSearchBox(TextBox box)
    {
        box.BorderStyle = BorderStyle.FixedSingle;
        box.BackColor = DarkTheme.Panel2;
        box.ForeColor = DarkTheme.Text;
    }

    // #688: case-insensitive match of the search text in any field; blank matches all.
    internal static bool MatchesSearch(string query, params string?[] fields) =>
        string.IsNullOrWhiteSpace(query) || fields.Any(f => f?.Contains(query.Trim(), StringComparison.OrdinalIgnoreCase) == true);

    private void OpenPluginGuide()
    {
        var guide = Path.Combine(ManaApplicationContext.FindRootDirectory(), "plugins", "README.md");
        try
        {
            Process.Start(new ProcessStartInfo(guide) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            MessageBox.Show(this, $"Couldn't open {guide}: {ex.Message}", "Plugins", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async void OnPluginChecked(object? sender, ItemCheckedEventArgs e)
    {
        // Suppressed while RefreshPluginsAsync is setting each item's
        // initial Checked state from the server's own value -- without
        // this, populating the list would fire one spurious
        // SetPluginEnabledAsync call per plugin, re-sending the value
        // that was just read.
        if (populatingPlugins)
        {
            return;
        }
        var key = (string)e.Item.Tag!;
        try
        {
            await backendClient.SetPluginEnabledAsync(key, e.Item.Checked);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to toggle plugin '{key}'. {ex.Message}");
        }
    }

    private async Task RefreshPluginsAsync()
    {
        try
        {
            plugins = await backendClient.GetPluginsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load plugins. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(pluginsList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        ShowPlugins();
    }

    private void ShowPlugins()
    {
        populatingPlugins = true;
        try
        {
            pluginsList.Items.Clear();
            foreach (var plugin in plugins.Where(p => MatchesSearch(pluginsSearch.Text, p.Name, p.Description, p.Key)))
            {
                var item = new ListViewItem(plugin.Name) { Tag = plugin.Key, Checked = plugin.Enabled };
                item.SubItems.Add(plugin.Description ?? "");
                pluginsList.Items.Add(item);
            }
        }
        finally
        {
            populatingPlugins = false;
        }
    }

    private TabPage BuildMemoryFactsTab()
    {
        factsList.Dock = DockStyle.Fill;
        factsList.View = View.Details;
        factsList.FullRowSelect = true;
        factsList.Columns.Add("Key", 150);
        factsList.Columns.Add("Fact", 300);
        factsList.Columns.Add("Status", 80);
        factsList.Columns.Add("Pinned", 60);
        factsList.Columns.Add("Trust", 80);
        DarkTheme.ApplyListView(factsList);

        // #674: pinned facts go into every reply's prompt (up to 5).
        var pinButton = new Button { Text = "Pin / Unpin", Dock = DockStyle.Bottom, Height = 28 };
        DarkTheme.ApplyButton(pinButton);
        pinButton.Click += async (_, _) =>
        {
            pinButton.Enabled = false;
            try
            {
                await TogglePinSelectedFactAsync();
            }
            finally
            {
                if (!IsDisposed)
                {
                    pinButton.Enabled = true;
                }
            }
        };

        var archiveButton = new Button { Text = "Archive", Dock = DockStyle.Bottom, Height = 28 };
        DarkTheme.ApplyButton(archiveButton);
        archiveButton.Click += async (_, _) =>
        {
            // Guards against a rapid double-click firing two overlapping
            // archive calls for the same fact -- harmless server-side
            // (archive is idempotent) but not worth even attempting.
            archiveButton.Enabled = false;
            try
            {
                await ArchiveSelectedFactAsync();
            }
            finally
            {
                if (!IsDisposed)
                {
                    archiveButton.Enabled = true;
                }
            }
        };

        // #663: a pending fact is one Mana picked up without being asked.
        var confirmButton = new Button { Text = "Confirm (pending)", Dock = DockStyle.Bottom, Height = 28 };
        DarkTheme.ApplyButton(confirmButton);
        confirmButton.Click += async (_, _) =>
        {
            confirmButton.Enabled = false;
            try
            {
                await ConfirmSelectedFactAsync();
            }
            finally
            {
                if (!IsDisposed)
                {
                    confirmButton.Enabled = true;
                }
            }
        };

        // #698: a paused standing reminder ("When ...") never fires.
        var pauseButton = new Button { Text = "Pause / Resume reminder", Dock = DockStyle.Bottom, Height = 28 };
        DarkTheme.ApplyButton(pauseButton);
        pauseButton.Click += async (_, _) =>
        {
            pauseButton.Enabled = false;
            try
            {
                await TogglePauseSelectedFactAsync();
            }
            finally
            {
                if (!IsDisposed)
                {
                    pauseButton.Enabled = true;
                }
            }
        };

        // Q29: edit a fact's text (and a reminder's "when" part) in place;
        // chat edits ("move the raid reminder to Friday") work too.
        var editButton = new Button { Text = "Edit", Dock = DockStyle.Bottom, Height = 28 };
        DarkTheme.ApplyButton(editButton);
        editButton.Click += async (_, _) =>
        {
            editButton.Enabled = false;
            try
            {
                await EditSelectedFactAsync();
            }
            finally
            {
                if (!IsDisposed)
                {
                    editButton.Enabled = true;
                }
            }
        };

        StyleSearchBox(factsSearch);
        factsSearch.TextChanged += (_, _) => ShowFacts();

        var page = new TabPage("Memory Facts");
        page.Controls.Add(factsList);
        page.Controls.Add(factsSearch);
        page.Controls.Add(editButton);
        page.Controls.Add(pinButton);
        page.Controls.Add(archiveButton);
        page.Controls.Add(confirmButton);
        page.Controls.Add(pauseButton);
        return page;
    }

    private async Task TogglePinSelectedFactAsync()
    {
        // The "Failed to load" row has no fact behind it.
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        try
        {
            await backendClient.SetMemoryFactPinnedAsync(fact.Key, !fact.Pinned);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to pin fact '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task EditSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        string? trigger = null;
        if (fact.Trigger != "")
        {
            using var whenDialog = new TextPromptDialog("Edit reminder", "When this comes up:", fact.Trigger);
            if (whenDialog.ShowDialog(this) != DialogResult.OK || whenDialog.Value.Trim() == "")
            {
                return;
            }
            trigger = whenDialog.Value.Trim();
        }
        using var textDialog = new TextPromptDialog("Edit fact", fact.Trigger == "" ? "Fact:" : "Mention:", fact.Text);
        if (textDialog.ShowDialog(this) != DialogResult.OK || textDialog.Value.Trim() == "")
        {
            return;
        }
        try
        {
            await backendClient.UpdateMemoryFactAsync(fact.Key, textDialog.Value.Trim(), trigger);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to edit fact '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task TogglePauseSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact || fact.Trigger == "")
        {
            return;
        }
        try
        {
            await backendClient.SetMemoryFactPausedAsync(fact.Key, !fact.Paused);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to pause reminder '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task ConfirmSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        try
        {
            await backendClient.ConfirmMemoryFactAsync(fact.Key);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to confirm fact '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task ArchiveSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        var key = fact.Key;
        try
        {
            await backendClient.ArchiveMemoryFactAsync(key);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to archive fact '{key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task RefreshMemoryFactsAsync()
    {
        try
        {
            facts = await backendClient.GetMemoryFactsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load memory facts. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(factsList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        ShowFacts();
    }

    private void ShowFacts()
    {
        factsList.Items.Clear();
        foreach (var fact in facts.Where(f => MatchesSearch(factsSearch.Text, f.Key, f.Text, f.Trigger)))
        {
            var item = new ListViewItem(fact.Key) { Tag = fact };
            item.SubItems.Add(fact.Trigger == "" ? fact.Text : $"When {fact.Trigger} comes up: {fact.Text}");
            item.SubItems.Add(fact.Paused ? $"{fact.Status}, paused" : fact.Status);
            item.SubItems.Add(fact.Pinned ? "yes" : "");
            item.SubItems.Add(fact.Trust);
            factsList.Items.Add(item);
        }
    }

    private TabPage BuildSkillsTab()
    {
        skillsList.Dock = DockStyle.Fill;
        skillsList.View = View.Details;
        skillsList.FullRowSelect = true;
        skillsList.Columns.Add("Skill", 150);
        skillsList.Columns.Add("Description", 260);
        skillsList.Columns.Add("Status", 80);
        DarkTheme.ApplyListView(skillsList);

        var newButton = new Button { Text = "New..." };
        var editButton = new Button { Text = "Edit..." };
        var deleteButton = new Button { Text = "Delete" };
        DarkTheme.ApplyButton(newButton);
        DarkTheme.ApplyButton(editButton);
        DarkTheme.ApplyButton(deleteButton);
        newButton.Click += async (_, _) => await CreateSkillAsync();
        editButton.Click += async (_, _) => await EditSelectedSkillAsync();
        deleteButton.Click += async (_, _) => await DeleteSelectedSkillAsync();
        // #664 (Q21): import an OpenClaw/AgentSkills SKILL.md folder, or a zip of one.
        var importButton = new Button { Text = "Import folder...", AutoSize = true };
        DarkTheme.ApplyButton(importButton);
        importButton.Click += async (_, _) => await ImportSkillFolderAsync();
        var importZipButton = new Button { Text = "Import zip...", AutoSize = true };
        DarkTheme.ApplyButton(importZipButton);
        importZipButton.Click += async (_, _) => await ImportSkillZipAsync();
        var importLinkButton = new Button { Text = "Import link...", AutoSize = true };
        DarkTheme.ApplyButton(importLinkButton);
        importLinkButton.Click += async (_, _) => await ImportSkillLinkAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(newButton);
        buttonRow.Controls.Add(editButton);
        buttonRow.Controls.Add(deleteButton);
        buttonRow.Controls.Add(importButton);
        buttonRow.Controls.Add(importZipButton);
        buttonRow.Controls.Add(importLinkButton);

        // Q20: how Mana may use imported skills (default: ask the first time).
        importedSkillUseBox.Items.AddRange(new object[] { "Use freely", "Ask each time", "Ask the first time" });
        importedSkillUseBox.SelectedIndex = 2;
        importedSkillUseBox.BackColor = DarkTheme.Panel2;
        importedSkillUseBox.ForeColor = DarkTheme.Text;
        importedSkillUseBox.SelectionChangeCommitted += async (_, _) =>
        {
            try
            {
                await backendClient.SetImportedSkillUseAsync(ImportedSkillUseModes[importedSkillUseBox.SelectedIndex]);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"SettingsPanel: failed to save the imported-skills setting. {ex.Message}");
            }
        };
        var settingRow = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        settingRow.Controls.Add(new Label { Text = "Imported skills:", AutoSize = true, ForeColor = DarkTheme.Text, Padding = new Padding(0, 6, 0, 0) });
        settingRow.Controls.Add(importedSkillUseBox);

        var page = new TabPage("Skills");
        page.Controls.Add(skillsList);
        page.Controls.Add(settingRow);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async Task ImportSkillFolderAsync()
    {
        using var dialog = new FolderBrowserDialog { Description = "Pick a skill folder (one with a SKILL.md in it)", UseDescriptionForTitle = true };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            await SubmitSkillImportAsync(dialog.SelectedPath);
        }
    }

    private async Task ImportSkillZipAsync()
    {
        using var dialog = new OpenFileDialog { Title = "Pick a zipped skill (a SKILL.md folder)", Filter = "Zip files (*.zip)|*.zip" };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            await SubmitSkillImportAsync(dialog.FileName);
        }
    }

    private async Task ImportSkillLinkAsync()
    {
        using var dialog = new TextPromptDialog("Import Skill", "Link (github.com or clawhub.ai):", "");
        if (dialog.ShowDialog(this) == DialogResult.OK && !string.IsNullOrWhiteSpace(dialog.Value))
        {
            await SubmitSkillImportAsync(dialog.Value.Trim());
        }
    }

    private async Task SubmitSkillImportAsync(string path)
    {
        string? error;
        try
        {
            error = await backendClient.ImportSkillAsync(path);
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }
        if (IsDisposed)
        {
            return;
        }
        if (error is null)
        {
            MessageBox.Show(this, "Import submitted -- review and approve it from the Approvals tab. Nothing in it runs.", "Import Skill", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        else
        {
            MessageBox.Show(this, $"Couldn't import that skill: {error}", "Import Skill", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task CreateSkillAsync()
    {
        using var dialog = new SkillEditorDialog("New Skill", isNew: true);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        // #688: a skill you typed in yourself that neither the content scan
        // nor Guardian flagged is approved straight away; a flagged one
        // waits in Approvals.
        string? note = null;
        try
        {
            var result = await backendClient.CreateSkillAsync(dialog.SkillName, dialog.Description, dialog.Body, dialog.Category);
            if (!result.Created && result.PendingId is { } id && result.Flags.Count == 0)
            {
                try
                {
                    await backendClient.DecideApprovalAsync(id, "allow-once");
                }
                catch (Exception ex)
                {
                    note = $"Skill submitted, but approving it failed ({ex.Message}) -- approve it from the Approvals tab.";
                }
            }
            else if (!result.Created)
            {
                note = result.Flags.Count > 0
                    ? $"Flagged: {string.Join(", ", result.Flags)}. Review and approve it from the Approvals tab."
                    : "Skill submitted -- approve it from the Approvals tab.";
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to create skill: {ex.Message}", "New Skill", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        if (note is not null)
        {
            MessageBox.Show(this, note, "New Skill", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        await RefreshSkillsAsync();
    }

    private async Task EditSelectedSkillAsync()
    {
        if (skillsList.SelectedItems.Count == 0)
        {
            return;
        }
        var name = (string)skillsList.SelectedItems[0].Tag!;

        ManaSkillDetail detail;
        try
        {
            detail = await backendClient.GetSkillDetailAsync(name);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to load skill: {ex.Message}", "Edit Skill", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        using var dialog = new SkillEditorDialog("Edit Skill", isNew: false, detail.Name, detail.Description, detail.Body, detail.Category);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.UpdateSkillAsync(name, dialog.Description, dialog.Body, dialog.Category);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to update skill: {ex.Message}", "Edit Skill", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshSkillsAsync();
        }
    }

    private async Task DeleteSelectedSkillAsync()
    {
        if (skillsList.SelectedItems.Count == 0)
        {
            return;
        }
        var name = (string)skillsList.SelectedItems[0].Tag!;
        var confirmed = MessageBox.Show(
            this,
            $"Delete skill \"{name}\"? This cannot be undone.",
            "Delete Skill",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        try
        {
            await backendClient.DeleteSkillAsync(name);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to delete skill '{name}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshSkillsAsync();
        }
    }

    private async Task RefreshSkillsAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaSkill> skills;
        try
        {
            skills = await backendClient.GetSkillsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load skills. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(skillsList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        try
        {
            var mode = Array.IndexOf(ImportedSkillUseModes, await backendClient.GetImportedSkillUseAsync());
            if (!IsDisposed && mode >= 0)
            {
                importedSkillUseBox.SelectedIndex = mode;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load the imported-skills setting. {ex.Message}");
        }
        if (IsDisposed)
        {
            return;
        }

        skillsList.Items.Clear();
        foreach (var skill in skills)
        {
            var item = new ListViewItem(skill.Name) { Tag = skill.Name };
            item.SubItems.Add(skill.Description ?? "");
            item.SubItems.Add(skill.Status ?? "");
            skillsList.Items.Add(item);
        }
    }

    private TabPage BuildApprovalsTab()
    {
        approvalsList.Dock = DockStyle.Fill;
        approvalsList.View = View.Details;
        approvalsList.FullRowSelect = true;
        approvalsList.Columns.Add("Type", 120);
        approvalsList.Columns.Add("Summary", 300);
        DarkTheme.ApplyListView(approvalsList);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        var allowButton = new Button { Text = "Allow once" };
        // #669: an in-memory grant that ends when Mana restarts.
        var sessionButton = new Button { Text = "Allow for session", AutoSize = true };
        var alwaysAllowButton = new Button { Text = "Always allow" };
        var denyButton = new Button { Text = "Deny" };
        DarkTheme.ApplyButton(allowButton);
        DarkTheme.ApplyButton(sessionButton);
        DarkTheme.ApplyButton(alwaysAllowButton);
        DarkTheme.ApplyButton(denyButton);

        // All four share one guard -- a decision resolves the request
        // server-side, so a second click (this button or a different
        // one) while the first is still in flight would just 404 there
        // instead of doing anything useful.
        async Task DecideAsync(string decision)
        {
            allowButton.Enabled = false;
            sessionButton.Enabled = false;
            alwaysAllowButton.Enabled = false;
            denyButton.Enabled = false;
            try
            {
                await DecideSelectedApprovalAsync(decision);
            }
            finally
            {
                if (!IsDisposed)
                {
                    allowButton.Enabled = true;
                    sessionButton.Enabled = true;
                    alwaysAllowButton.Enabled = true;
                    denyButton.Enabled = true;
                }
            }
        }
        allowButton.Click += async (_, _) => await DecideAsync("allow-once");
        sessionButton.Click += async (_, _) => await DecideAsync("allow-session");
        alwaysAllowButton.Click += async (_, _) => await DecideAsync("always-allow");
        denyButton.Click += async (_, _) => await DecideAsync("deny");
        buttonRow.Controls.Add(allowButton);
        buttonRow.Controls.Add(sessionButton);
        buttonRow.Controls.Add(alwaysAllowButton);
        buttonRow.Controls.Add(denyButton);

        toolApprovalModeCombo.Items.AddRange(new object[]
        {
            "Smart -- ask unless it's read-only or a small change like the volume",
            "Ask for every tool call",
            "Only destructive commands",
        });
        toolApprovalModeCombo.BackColor = DarkTheme.Panel2;
        toolApprovalModeCombo.ForeColor = DarkTheme.Text;
        // SelectionChangeCommitted: user picks only, not Refresh's.
        toolApprovalModeCombo.SelectionChangeCommitted += async (_, _) => await SaveToolApprovalModeAsync();
        var modeRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        modeRow.Controls.Add(new Label { Text = "Ask before tool calls:", AutoSize = true, ForeColor = DarkTheme.Text, Margin = new Padding(3, 6, 3, 3) });
        modeRow.Controls.Add(toolApprovalModeCombo);
        var modePanel = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = DarkTheme.Background };
        modePanel.Controls.Add(modeRow);
        modePanel.Controls.Add(new Label { Text = "Destructive commands (rm -rf, registry edits, download-and-run...) always ask, in every mode.", AutoSize = true, ForeColor = DarkTheme.Muted });

        var page = new TabPage("Approvals");
        page.Controls.Add(approvalsList);
        page.Controls.Add(buttonRow);
        page.Controls.Add(modePanel);
        return page;
    }

    private async Task RefreshToolApprovalModeAsync()
    {
        string? mode;
        try
        {
            mode = await backendClient.GetToolApprovalModeAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load the tool approval mode. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            toolApprovalModeCombo.SelectedIndex = Array.IndexOf(ToolApprovalModes, mode);
        }
    }

    private async Task SaveToolApprovalModeAsync()
    {
        if (toolApprovalModeCombo.SelectedIndex < 0)
        {
            return;
        }
        try
        {
            await backendClient.SetToolApprovalModeAsync(ToolApprovalModes[toolApprovalModeCombo.SelectedIndex]);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                MessageBox.Show(this, $"Failed to save the approval mode: {ex.Message}", "Approvals", MessageBoxButtons.OK, MessageBoxIcon.Error);
                await RefreshToolApprovalModeAsync();
            }
        }
    }

    private async Task DecideSelectedApprovalAsync(string decision)
    {
        if (approvalsList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)approvalsList.SelectedItems[0].Tag!;
        try
        {
            // #838: an ACP agent request is decided once; there are no
            // session or standing grants for it.
            if (id.StartsWith(PendingWriteTag, StringComparison.Ordinal))
            {
                if (decision is not ("allow-once" or "deny"))
                {
                    MessageBox.Show(this, "This request from the coding agent can only be allowed once or denied.", "Approvals", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                await backendClient.DecidePendingWriteAsync(id[PendingWriteTag.Length..], decision == "allow-once");
            }
            else
            {
                await backendClient.DecideApprovalAsync(id, decision);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to decide approval '{id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshApprovalsAsync();
        }
    }

    private async Task RefreshApprovalsAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaPendingApproval> pending;
        try
        {
            pending = await backendClient.GetPendingApprovalsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load pending approvals. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(approvalsList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        IReadOnlyList<ManaPendingWrite> writes = [];
        try
        {
            writes = await backendClient.GetPendingWritesAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load pending agent writes. {ex.Message}");
        }
        if (IsDisposed)
        {
            return;
        }

        approvalsList.Items.Clear();
        foreach (var approval in pending)
        {
            var item = new ListViewItem(approval.ActionType) { Tag = approval.Id };
            item.SubItems.Add(approval.Summary);
            approvalsList.Items.Add(item);
        }
        foreach (var write in writes)
        {
            var item = new ListViewItem(write.Kind) { Tag = PendingWriteTag + write.Id };
            item.SubItems.Add(write.Summary);
            approvalsList.Items.Add(item);
        }
    }

    // Marks an approvals-list row as an ACP agent pending write (#838).
    private const string PendingWriteTag = "write:";

    // #583: "Auto" (null override) plus the 4 providers server.js's
    // TTS_OVERRIDE_PROVIDERS allow-lists -- selecting it clears the
    // override rather than sending an invalid 5th value.
    private const string AutoProviderLabel = "Auto (gaming-based)";
    private static readonly string[] TtsProviders = { AutoProviderLabel, "fish", "kokoro", "gpt_sovits", "cli" };

    private readonly Func<HotkeyAction, Keys?, string?>? bindHotkey;

    // #689: each global hotkey's combination -- click the box and press the
    // new one (Backspace turns it off). A combination another Mana hotkey
    // or another app already uses is refused. Rebinds live when the
    // launcher wired bindHotkey; saved either way.
    private TabPage BuildHotkeysTab()
    {
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, BackColor = DarkTheme.Background, AutoScroll = true };
        layout.Controls.Add(new Label { Text = "Click a box and press the new keys (Ctrl or Alt plus a key). Backspace turns a hotkey off.", AutoSize = true, ForeColor = DarkTheme.Muted, Margin = new Padding(3, 6, 3, 6) });
        foreach (var action in HotkeyBindings.Actions)
        {
            layout.Controls.Add(BuildHotkeyRow(action));
        }
        return new TabPage("Hotkeys") { Controls = { layout } };
    }

    private FlowLayoutPanel BuildHotkeyRow(HotkeyAction action)
    {
        var label = new Label { Text = action.Label, Width = 200, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left };
        var box = new TextBox { ReadOnly = true, Width = 150, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, AccessibleName = $"{action.Label} hotkey", ShortcutsEnabled = false };
        var reset = new Button { Text = "Default", AutoSize = true };
        DarkTheme.ApplyButton(reset);
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
        box.Text = HotkeyBindings.Format(HotkeyBindings.Resolve(ManaSettingsStore.Load().Hotkeys, action));

        void Apply(Keys? keys)
        {
            var settings = ManaSettingsStore.Load();
            if (keys is Keys k && HotkeyBindings.ConflictFor(settings.Hotkeys, action, k) is { } other)
            {
                status.Text = $"Already used for \"{other.Label}\".";
                return;
            }
            if (bindHotkey?.Invoke(action, keys) is { } error)
            {
                // The old combination is off now too; put it back.
                bindHotkey(action, HotkeyBindings.Resolve(settings.Hotkeys, action));
                status.Text = error;
                return;
            }
            settings.Hotkeys ??= new();
            settings.Hotkeys[action.Key] = keys is Keys set ? HotkeyBindings.Format(set) : "";
            settings.Save();
            box.Text = HotkeyBindings.Format(keys);
            status.Text = bindHotkey is null ? "Saved -- applies next launch." : "Saved.";
        }

        box.KeyDown += (_, e) =>
        {
            e.SuppressKeyPress = true;
            e.Handled = true;
            if (e.KeyData is Keys.Back or Keys.Delete)
            {
                Apply(null);
            }
            else if (HotkeyBindings.IsValid(e.KeyData))
            {
                Apply(e.KeyData);
            }
            else if ((e.KeyCode & Keys.KeyCode) is not (Keys.ControlKey or Keys.ShiftKey or Keys.Menu))
            {
                status.Text = "Use Ctrl or Alt plus a key.";
            }
        };
        reset.Click += (_, _) => Apply(action.Default);

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(label);
        row.Controls.Add(box);
        row.Controls.Add(reset);
        row.Controls.Add(status);
        return row;
    }

    private TabPage BuildVoiceTab()
    {
        voiceProviderCombo.BackColor = DarkTheme.Panel2;
        voiceProviderCombo.ForeColor = DarkTheme.Text;
        voiceProviderCombo.Items.AddRange(TtsProviders);

        var saveButton = new Button { Text = "Save" };
        DarkTheme.ApplyButton(saveButton);
        saveButton.Click += async (_, _) => await SaveVoiceProviderAsync();

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(voiceProviderCombo);
        row.Controls.Add(saveButton);

        // Scrolls rather than wrapping into a second column once the rows
        // outgrow the dialog.
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, BackColor = DarkTheme.Background };
        layout.Controls.Add(row);
        layout.Controls.Add(BuildWakePrefilterRow());
        layout.Controls.Add(BuildEchoCancellationRow());
        layout.Controls.Add(BuildVoiceTuningRow());
        layout.Controls.Add(BuildBargeInRow());
        layout.Controls.Add(BuildVoiceprintRow());
        layout.Controls.Add(BuildSpeakerThresholdRow());
        layout.Controls.Add(BuildCameraRow());
        layout.Controls.Add(BuildSpeechWordsSection());
        return new TabPage("Voice") { Controls = { layout } };
    }

    // #907: node-bot's daily briefing (GET/POST /briefing). "Brief me" in
    // chat gives it on demand whatever's set here.
    private static readonly (string Key, string Label)[] BriefingSections =
    {
        ("reminders", "Today's reminders"),
        ("memory", "What's coming up (memory)"),
        ("news", "News on my topics"),
        ("games", "Game patch and maintenance news"),
        ("calendar", "Calendar and mail (once connected)"),
    };
    private Func<Task>? refreshBriefing;

    private TabPage BuildBriefingTab()
    {
        Label Caption(string text) => new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left };
        TextBox Box(string name, int width) => new() { Width = width, AccessibleName = name, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
        FlowLayoutPanel Row(params Control[] controls)
        {
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
            row.Controls.AddRange(controls);
            return row;
        }

        var enabled = new CheckBox { Text = "Give me a daily briefing, the first time I'm at the PC after", AutoSize = true, ForeColor = DarkTheme.Text };
        var time = Box("Briefing time", 60);
        var sections = BriefingSections.Select(s => new CheckBox { Text = s.Label, Tag = s.Key, AutoSize = true, ForeColor = DarkTheme.Text }).ToArray();
        var topics = Box("News topics", 300);
        var games = Box("Games", 300);
        var save = new Button { Text = "Save", AutoSize = true };
        DarkTheme.ApplyButton(save);
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };

        void Render(ManaBriefingSettings settings)
        {
            if (enabled.IsDisposed)
            {
                return;
            }
            enabled.Checked = settings.Enabled;
            time.Text = settings.Time;
            foreach (var check in sections)
            {
                check.Checked = settings.Sections.Contains((string)check.Tag!);
            }
            topics.Text = settings.Topics;
            games.Text = settings.Games;
        }

        save.Click += async (_, _) =>
        {
            try
            {
                Render(await backendClient.UpdateBriefingAsync(new ManaBriefingSettings
                {
                    Enabled = enabled.Checked,
                    Time = time.Text,
                    Sections = sections.Where(c => c.Checked).Select(c => (string)c.Tag!).ToList(),
                    Topics = topics.Text,
                    Games = games.Text,
                }));
                status.Text = "Saved.";
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                if (!status.IsDisposed)
                {
                    status.Text = $"Couldn't save: {ex.Message}";
                }
            }
        };
        refreshBriefing = async () =>
        {
            try
            {
                Render(await backendClient.GetBriefingAsync());
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                Console.WriteLine($"SettingsPanel: failed to load the briefing settings. {ex.Message}");
            }
        };

        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, BackColor = DarkTheme.Background };
        layout.Controls.Add(Row(enabled, time, Caption("(HH:MM)")));
        layout.Controls.Add(Caption("It's a toast and Mana says it; while I'm playing it waits for a break. Say \"brief me\" any time for it on demand."));
        layout.Controls.AddRange(sections);
        layout.Controls.Add(Row(Caption("News topics (comma-separated)"), topics));
        layout.Controls.Add(Row(Caption("Games"), games));
        layout.Controls.Add(Row(save, status));
        return new TabPage("Briefing") { Controls = { layout } };
    }

    // #923/#925/#926: node-bot's speech words (whisper listens for them),
    // mishearing fixes (applied to every transcript) and whisper's language,
    // through GET/POST /speech. Each change is saved at once and applies to
    // the next thing I say.
    private Func<Task>? refreshSpeechWords;

    private FlowLayoutPanel BuildSpeechWordsSection()
    {
        Label Caption(string text) => new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left };
        TextBox Box(string placeholder) => new() { Width = 160, PlaceholderText = placeholder, AccessibleName = placeholder, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
        ListBox NewList(string name) => new() { Width = 300, Height = 80, AccessibleName = name, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
        Button NewButton(string text)
        {
            var button = new Button { Text = text, AutoSize = true };
            DarkTheme.ApplyButton(button);
            return button;
        }
        FlowLayoutPanel Row(params Control[] controls)
        {
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
            row.Controls.AddRange(controls);
            return row;
        }

        var words = NewList("Speech words");
        var word = Box("Word or name");
        var addWord = NewButton("Add word");
        var removeWord = NewButton("Remove");
        var fixes = NewList("Mishearing fixes");
        var fixKeys = new List<string>();
        var heard = Box("Mana heard");
        var meant = Box("I said");
        var addFix = NewButton("Add fix");
        var removeFix = NewButton("Remove");
        var language = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200, AccessibleName = "Speech language", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
        language.Items.AddRange(new object[] { "English only (default)", "Auto-detect" });
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };

        void Render(ManaSpeechVocabulary speech)
        {
            if (words.IsDisposed)
            {
                return;
            }
            words.Items.Clear();
            words.Items.AddRange(speech.Words.ToArray<object>());
            fixes.Items.Clear();
            fixKeys.Clear();
            foreach (var (from, to) in speech.Corrections)
            {
                fixes.Items.Add($"{from} -> {to}");
                fixKeys.Add(from);
            }
            language.SelectedIndex = speech.Language == "auto" ? 1 : 0;
            language.Enabled = speech.EnvLanguage is null;
            status.Text = speech.EnvLanguage is null ? "" : $"WHISPER_LANGUAGE={speech.EnvLanguage} is set, and wins over this.";
        }

        // confirmed: the same change with confirm = true, offered when
        // node-bot says heard may be an ordinary word.
        async Task<bool> Save(object change, object? confirmed = null)
        {
            try
            {
                Render(await backendClient.UpdateSpeechAsync(change));
                if (!status.IsDisposed && language.Enabled)
                {
                    status.Text = "Saved -- applies to the next thing you say.";
                }
                return true;
            }
            catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.Conflict && confirmed is not null)
            {
                return !IsDisposed
                    && MessageBox.Show(this, $"{ex.Message}.\n\nAdd the fix anyway?", "Mishearing fixes", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes
                    && await Save(confirmed);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                if (!status.IsDisposed)
                {
                    status.Text = $"Couldn't save: {ex.Message}";
                }
                return false;
            }
        }

        addWord.Click += async (_, _) =>
        {
            if (await Save(new { addWord = word.Text }))
            {
                word.Clear();
            }
        };
        removeWord.Click += async (_, _) =>
        {
            if (words.SelectedItem is string selected)
            {
                await Save(new { removeWord = selected });
            }
        };
        addFix.Click += async (_, _) =>
        {
            if (await Save(new { heard = heard.Text, term = meant.Text }, new { heard = heard.Text, term = meant.Text, confirm = true }))
            {
                heard.Clear();
                meant.Clear();
            }
        };
        removeFix.Click += async (_, _) =>
        {
            if (fixes.SelectedIndex >= 0)
            {
                await Save(new { removeCorrection = fixKeys[fixes.SelectedIndex] });
            }
        };
        language.SelectionChangeCommitted += async (_, _) => await Save(new { language = language.SelectedIndex == 1 ? "auto" : "en" });
        refreshSpeechWords = async () =>
        {
            try
            {
                Render(await backendClient.GetSpeechAsync());
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                Console.WriteLine($"SettingsPanel: failed to load speech words. {ex.Message}");
            }
        };

        var section = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = DarkTheme.Background };
        section.Controls.Add(Caption("Words Mana should know (for names she mishears):"));
        section.Controls.Add(Row(words, word, addWord, removeWord));
        section.Controls.Add(Caption("Mishearing fixes (what she keeps hearing -> what I said):"));
        section.Controls.Add(Row(fixes, heard, meant, addFix, removeFix));
        section.Controls.Add(Row(Caption("Speech language"), language, status));
        return section;
    }

    // #678: which speech has to be my voice (SpeakerGate), and teaching Mana
    // my voice: each prompt is recorded for EnrollClipMs from the default
    // mic, embedded, and the average saved as ManaSettingsStore.Voiceprint.
    // Read each time listening starts; MANA_SPEAKER_GATE overrides the mode.
    // #922: listening pauses while it records, until it ends, I leave the
    // Voice tab (which cancels it, nothing saved) or Settings closes.
    private static readonly string[] EnrollPrompts =
    {
        "The quick brown fox jumps over the lazy dog.",
        "Could you remind me about the meeting tomorrow morning?",
        "I'd like a cup of tea and some toast, please.",
        "Seven silver swans swam slowly down the river.",
        "Let's put some music on and check the weather later.",
    };
    private const int EnrollClipMs = 5000;

    private FlowLayoutPanel BuildVoiceprintRow()
    {
        var label = new Label { Text = "Only my voice can", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left };
        var combo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 260, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
        combo.Items.AddRange(new object[] { "Off (anyone, default)", "Wake her", "Wake her or talk over her", "Wake her, talk over her or give commands" });
        combo.SelectedIndex = (int)SpeakerGate.ResolveMode(null, ManaSettingsStore.Load().VoiceprintGate);
        var teach = new Button { Text = "Teach Mana your voice", AutoSize = true };
        var forget = new Button { Text = "Delete my voiceprint", AutoSize = true };
        DarkTheme.ApplyButton(teach);
        DarkTheme.ApplyButton(forget);
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
        void ShowEnrolled() => status.Text = ManaSettingsStore.Load().Voiceprint is null ? "Not taught yet -- the setting does nothing until you do." : "Your voice is saved on this PC.";
        ShowEnrolled();

        combo.SelectionChangeCommitted += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.VoiceprintGate = combo.SelectedIndex == 0 ? null : SpeakerGate.ModeNames[combo.SelectedIndex];
            latest.Save();
            status.Text = "Saved -- applies next time listening starts.";
        };
        forget.Click += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.Voiceprint = null;
            latest.Save();
            status.Text = "Deleted -- applies next time listening starts.";
        };
        teach.Click += async (_, _) =>
        {
            var modelPath = SpeakerEmbedder.ResolveModelPath(ManaApplicationContext.FindRootDirectory());
            if (!File.Exists(modelPath))
            {
                status.Text = $"Speaker model not found: {modelPath}";
                return;
            }
            using var cancel = new CancellationTokenSource();
            enrolmentCancel = cancel;
            bool Stopped()
            {
                if (status.IsDisposed)
                {
                    return true; // Settings closed mid-way: nothing saved
                }
                if (cancel.IsCancellationRequested)
                {
                    status.Text = "Stopped when you left the Voice tab -- nothing saved.";
                }
                return cancel.IsCancellationRequested;
            }
            teach.Enabled = forget.Enabled = false;
            try
            {
                listeningPause?.Pause();
                using var embedder = await Task.Run(() => new SpeakerEmbedder(modelPath));
                var embeddings = new List<float[]>();
                for (var i = 0; i < EnrollPrompts.Length; i++)
                {
                    status.Text = $"{i + 1}/{EnrollPrompts.Length} -- read aloud now: \"{EnrollPrompts[i]}\"";
                    var clip = await RecordAsync(EnrollClipMs, cancel.Token);
                    if (Stopped())
                    {
                        return;
                    }
                    var (boosted, _) = SpeechFilters.ApplySpeechGain(clip, SpeechFilters.GainTargetPeak, SpeechFilters.GainMaxBoost);
                    if (SpeechFilters.GetSpeechRejectReason(boosted, SpeechFilters.MinSpeechRms, SpeechFilters.MinSpeechPeak, SpeechFilters.MaxClickyZcr) is { } reason)
                    {
                        status.Text = $"I couldn't hear you clearly ({reason}). Check the mic and try again.";
                        return;
                    }
                    embeddings.Add(await Task.Run(() => embedder.Embed(SpeakerGate.SpeechSpan(clip))));
                }
                if (Stopped())
                {
                    return;
                }
                var latest = ManaSettingsStore.Load();
                latest.Voiceprint = SpeakerGate.Voiceprint(embeddings);
                latest.Save();
                status.Text = "Learned your voice -- applies next time listening starts.";
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                status.Text = $"Couldn't learn your voice: {ex.Message}";
            }
            finally
            {
                enrolmentCancel = null;
                listeningPause?.Resume();
                if (!teach.IsDisposed)
                {
                    teach.Enabled = forget.Enabled = true;
                }
            }
        };

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(label);
        row.Controls.Add(combo);
        row.Controls.Add(teach);
        row.Controls.Add(forget);
        row.Controls.Add(status);
        row.Disposed += (_, _) =>
        {
            enrolmentCancel?.Cancel();
            listeningPause?.Resume();
        };
        return row;
    }

    // 16kHz mono from the default mic, like VoiceLoop's segments.
    private static async Task<short[]> RecordAsync(int ms, CancellationToken cancel)
    {
        var samples = new List<short>();
        using var waveIn = new NAudio.Wave.WaveInEvent { DeviceNumber = -1, WaveFormat = new NAudio.Wave.WaveFormat(SileroVadRunner.SampleRate, 16, 1) };
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        waveIn.DataAvailable += (_, e) =>
        {
            lock (samples)
            {
                for (var i = 0; i + 1 < e.BytesRecorded; i += 2)
                {
                    samples.Add(BitConverter.ToInt16(e.Buffer, i));
                }
            }
        };
        waveIn.RecordingStopped += (_, e) =>
        {
            if (e.Exception is { } ex)
            {
                stopped.TrySetException(ex);
            }
            else
            {
                stopped.TrySetResult();
            }
        };
        waveIn.StartRecording();
        try
        {
            await Task.Delay(ms, cancel);
        }
        catch (OperationCanceledException)
        {
            // #922: cut short; the caller discards the clip.
        }
        waveIn.StopRecording();
        await stopped.Task;
        lock (samples)
        {
            return samples.ToArray();
        }
    }

    // #858: the end-of-turn silence and Silero's speech threshold, read each
    // time listening starts. MANA_SILENCE_BUFFER_MS / MANA_VAD_THRESHOLD
    // still win, so the row says when one is set.
    private static FlowLayoutPanel BuildVoiceTuningRow()
    {
        var settings = ManaSettingsStore.Load();
        var silence = new NumericUpDown
        {
            Minimum = 300,
            Maximum = 10000,
            Increment = 100,
            Width = 80,
            Value = RecordingSegmenter.ResolveSilenceBufferMs(null, settings.SilenceBufferMs),
            BackColor = DarkTheme.Panel2,
            ForeColor = DarkTheme.Text,
        };
        var threshold = new NumericUpDown
        {
            Minimum = 0.05M,
            Maximum = 0.95M,
            Increment = 0.05M,
            DecimalPlaces = 2,
            Width = 70,
            Value = Math.Clamp(Math.Round((decimal)SileroVadRunner.ResolveThreshold(null, settings.VadThreshold), 2), 0.05M, 0.95M),
            BackColor = DarkTheme.Panel2,
            ForeColor = DarkTheme.Text,
        };
        var overridden = new[] { "MANA_SILENCE_BUFFER_MS", "MANA_VAD_THRESHOLD" }
            .Where(name => !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name)))
            .ToList();
        var status = new Label
        {
            AutoSize = true,
            ForeColor = DarkTheme.Muted,
            Anchor = AnchorStyles.Left,
            Text = overridden.Count > 0 ? $"Set in the environment, which wins: {string.Join(", ", overridden)}" : "",
        };
        void Save(Action<ManaSettingsStore> change)
        {
            var latest = ManaSettingsStore.Load();
            change(latest);
            latest.Save();
            status.Text = "Saved -- applies next time listening starts.";
        }
        silence.ValueChanged += (_, _) => Save(s => s.SilenceBufferMs = (long)silence.Value);
        threshold.ValueChanged += (_, _) => Save(s => s.VadThreshold = (float)threshold.Value);

        Label Caption(string text) => new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left };
        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(Caption("Pause before Mana answers (ms)"));
        row.Controls.Add(silence);
        row.Controls.Add(Caption("Speech detection threshold (higher = stricter)"));
        row.Controls.Add(threshold);
        row.Controls.Add(status);
        return row;
    }

    // #665: what talking over Mana does (BargeInPolicy), read each time
    // listening starts; MANA_BARGE_IN_MODE overrides it.
    private static readonly string[] BargeInModes = { "minWords", "always", "notWhileSpeaking" };

    private static FlowLayoutPanel BuildBargeInRow()
    {
        var label = new Label { Text = "When I talk over Mana", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left };
        var combo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 300, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
        combo.Items.AddRange(new object[] { "Stop her for two words or more (default)", "Stop her for any speech", "Never stop her; answer when she's done" });
        combo.SelectedIndex = (int)BargeInPolicy.Resolve(null, ManaSettingsStore.Load().BargeInMode);
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
        combo.SelectionChangeCommitted += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.BargeInMode = combo.SelectedIndex == 0 ? null : BargeInModes[combo.SelectedIndex];
            latest.Save();
            status.Text = "Saved -- applies next time listening starts.";
        };

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(label);
        row.Controls.Add(combo);
        row.Controls.Add(status);
        return row;
    }

    // #965: how close to my voiceprint speech has to be (SpeakerGate), read
    // each time listening starts; MANA_SPEAKER_THRESHOLD still wins. The
    // recent speaker= scores from speech-debug.log are there to pick it by,
    // re-read each second while the Voice tab is showing.
    private FlowLayoutPanel BuildSpeakerThresholdRow()
    {
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        var threshold = SpeakerGate.ResolveThreshold(null, ManaSettingsStore.Load().SpeakerThreshold);
        var slider = new TrackBar
        {
            Minimum = 10,
            Maximum = 90,
            TickFrequency = 10,
            LargeChange = 5,
            Width = 200,
            Value = Math.Clamp((int)Math.Round(threshold * 100), 10, 90),
            BackColor = DarkTheme.Background,
        };
        var value = new Label { AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Text = (slider.Value / 100f).ToString("F2", inv) };
        var status = new Label
        {
            AutoSize = true,
            ForeColor = DarkTheme.Muted,
            Anchor = AnchorStyles.Left,
            Text = string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("MANA_SPEAKER_THRESHOLD")) ? "" : "Set in the environment, which wins: MANA_SPEAKER_THRESHOLD",
        };
        var recent = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left, Text = SpeakerScoresText() };
        logRefreshTimer.Tick += (_, _) =>
        {
            if (recent.Visible)
            {
                recent.Text = SpeakerScoresText();
            }
        };
        slider.ValueChanged += (_, _) =>
        {
            value.Text = (slider.Value / 100f).ToString("F2", inv);
            var latest = ManaSettingsStore.Load();
            latest.SpeakerThreshold = slider.Value / 100f;
            latest.Save();
            status.Text = "Saved -- applies next time listening starts.";
        };

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(new Label { Text = "Voice match needed (higher = stricter)", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left });
        row.Controls.Add(slider);
        row.Controls.Add(value);
        row.Controls.Add(recent);
        row.Controls.Add(status);
        return row;
    }

    internal static string SpeakerScoresText(string? logPath = null)
    {
        var scores = VoiceDebugLog.RecentSpeakerScores(path: logPath);
        return scores.Count == 0
            ? "No voice match scores yet (speech-debug.log has them when MANA_SPEECH_DEBUG=1 and the setting above is on)."
            : $"Recent match scores: {string.Join(", ", scores.Select(s => s.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)))}";
    }

    // #912: off by default; read at each snapshot (the camera hotkey, or
    // Mana's vision__camera when I ask her to look at something).
    private static FlowLayoutPanel BuildCameraRow()
    {
        var check = new CheckBox
        {
            Text = "Let Mana take camera snapshots when I ask (\"look at this\", or the camera hotkey)",
            AutoSize = true,
            ForeColor = DarkTheme.Text,
            Checked = ManaSettingsStore.Load().CameraSnapshots,
        };
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
        check.CheckedChanged += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.CameraSnapshots = check.Checked;
            latest.Save();
            status.Text = "Saved.";
        };

        // #962: where "save that" puts a snapshot; blank = Pictures\Mana.
        var folder = new TextBox
        {
            Width = 260,
            PlaceholderText = @"Pictures\Mana",
            Text = ManaSettingsStore.Load().CameraSnapshotFolder ?? "",
            BackColor = DarkTheme.Panel2,
            ForeColor = DarkTheme.Text,
        };
        void SaveFolder()
        {
            var latest = ManaSettingsStore.Load();
            latest.CameraSnapshotFolder = string.IsNullOrWhiteSpace(folder.Text) ? null : folder.Text.Trim();
            latest.Save();
            status.Text = "Saved.";
        }
        folder.TextChanged += (_, _) => SaveFolder();
        var browse = new Button { Text = "Browse...", AutoSize = true };
        DarkTheme.ApplyButton(browse);
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { Description = "Where Mana saves snapshots you ask her to keep", UseDescriptionForTitle = true };
            if (dialog.ShowDialog() == DialogResult.OK)
            {
                folder.Text = dialog.SelectedPath;
            }
        };

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(check);
        row.Controls.Add(new Label { Text = "Save snapshots I ask to keep in", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left });
        row.Controls.Add(folder);
        row.Controls.Add(browse);
        row.Controls.Add(status);
        return row;
    }

    // #619: EchoCancellation on the mic, read each time listening starts;
    // MANA_VOICE_AEC overrides it. speech-debug.log says what Windows applied.
    private static FlowLayoutPanel BuildEchoCancellationRow()
    {
        var check = new CheckBox
        {
            Text = "Echo cancellation (stops Mana hearing herself through speakers)",
            AutoSize = true,
            ForeColor = DarkTheme.Text,
            Checked = ManaSettingsStore.Load().EchoCancellation ?? true,
        };
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
        check.CheckedChanged += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.EchoCancellation = check.Checked;
            latest.Save();
            status.Text = "Saved -- applies next time listening starts.";
        };

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(check);
        row.Controls.Add(status);
        return row;
    }

    // #682: the #342 acoustic wake-word pre-filter (read once at startup,
    // so it applies on next launch; MANA_WAKE_PREFILTER overrides it) and
    // a shortcut to speech-debug.log, which shows what it decided.
    private static readonly string[] WakePrefilterModes = { "off", "loose", "normal" };

    private static FlowLayoutPanel BuildWakePrefilterRow()
    {
        var label = new Label { Text = "Wake-word pre-filter", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left };
        var combo = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
        combo.Items.AddRange(new object[] { "Off (default)", "Loose", "Normal" });
        combo.SelectedIndex = Math.Max(0, Array.IndexOf(WakePrefilterModes, ManaSettingsStore.Load().WakePrefilter));
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
        combo.SelectionChangeCommitted += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.WakePrefilter = combo.SelectedIndex == 0 ? null : WakePrefilterModes[combo.SelectedIndex];
            latest.Save();
            status.Text = "Saved -- applies next launch.";
        };

        var openLog = new Button { Text = "Open speech log", AutoSize = true };
        DarkTheme.ApplyButton(openLog);
        openLog.Click += (_, _) =>
        {
            if (!File.Exists(VoiceDebugLog.DefaultPath))
            {
                status.Text = $"No speech log yet ({VoiceDebugLog.DefaultPath}). It's off unless MANA_SPEECH_DEBUG=1.";
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(VoiceDebugLog.DefaultPath) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                status.Text = $"Couldn't open {VoiceDebugLog.DefaultPath}: {ex.Message}";
            }
        };

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(label);
        row.Controls.Add(combo);
        row.Controls.Add(openLog);
        row.Controls.Add(status);
        return row;
    }

    private async Task SaveVoiceProviderAsync()
    {
        // A null SelectedItem means nothing is selected (e.g. the initial
        // GetTtsOverrideAsync load failed) -- not the same as the user
        // actually choosing "Auto", so this must not fall through to
        // treating it as "clear the override" below.
        if (voiceProviderCombo.SelectedItem is not string selected)
        {
            return;
        }
        var provider = selected == AutoProviderLabel ? null : selected;
        try
        {
            await backendClient.SetTtsOverrideAsync(provider);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to save voice provider: {ex.Message}", "Voice", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task RefreshVoiceTabAsync()
    {
        string? overrideProvider;
        try
        {
            overrideProvider = await backendClient.GetTtsOverrideAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load voice provider override. {ex.Message}");
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        voiceProviderCombo.SelectedItem = overrideProvider ?? AutoProviderLabel;
    }

    // #582: "live" -- a self-driving 1s timer, not just a refresh-on-open
    // snapshot like every other tab here, since the whole point of a log
    // tail is watching it update while the dialog stays open. The buffer
    // itself (BackendLogBuffer, fed by ManaProcessManager) only has
    // content when this launcher actually spawned the backend process --
    // an externally-already-running backend has nothing to redirect from.
    private TabPage BuildLogsTab()
    {
        logsTextBox.BackColor = DarkTheme.Panel2;
        logsTextBox.ForeColor = DarkTheme.Text;
        logsTextBox.Font = new Font(FontFamily.GenericMonospace, 9);

        RefreshLogsTab();
        logRefreshTimer.Tick += (_, _) => RefreshLogsTab();
        logRefreshTimer.Start();

        return new TabPage("Logs") { Controls = { logsTextBox } };
    }

    private void RefreshLogsTab()
    {
        if (IsDisposed)
        {
            return;
        }
        var lines = backendLog.Snapshot();
        logsTextBox.Text = lines.Count == 0
            ? "(no backend log output captured -- the backend may already have been running before Mana started it)"
            : string.Join(Environment.NewLine, lines);
        logsTextBox.SelectionStart = logsTextBox.Text.Length;
        logsTextBox.ScrollToCaret();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            logRefreshTimer.Stop();
            logRefreshTimer.Dispose();
        }
        base.Dispose(disposing);
    }

    // #576: reads/writes ManaThemeSettings' own file directly, same
    // reasoning as #565's Connection tab. #688: Save also applies it live
    // (DarkTheme.ApplyPresetLive).
    private TabPage BuildThemeTab()
    {
        var settings = ManaThemeSettings.Load();

        ThemePresetInfo? current = null;
        foreach (var preset in DarkTheme.Presets)
        {
            themePresetCombo.Items.Add(preset);
            if (preset.Id == settings.Preset)
            {
                current = preset;
            }
        }
        themePresetCombo.SelectedItem = current ?? DarkTheme.Presets[0];
        themePresetCombo.BackColor = DarkTheme.Panel2;
        themePresetCombo.ForeColor = DarkTheme.Text;

        themeAccentBox.Text = settings.AccentHex ?? "";
        themeAccentBox.BackColor = DarkTheme.Panel2;
        themeAccentBox.ForeColor = DarkTheme.Text;

        var statusLabel = new Label { AutoSize = true, ForeColor = DarkTheme.Muted };
        var saveButton = new Button { Text = "Save" };
        DarkTheme.ApplyButton(saveButton);

        // #688: Electron's colour picker and reset, beside the hex box.
        var pickButton = new Button { Text = "Pick...", AutoSize = true };
        DarkTheme.ApplyButton(pickButton);
        pickButton.Click += (_, _) =>
        {
            using var picker = new ColorDialog { FullOpen = true, Color = DarkTheme.Accent };
            if (picker.ShowDialog(this) == DialogResult.OK)
            {
                themeAccentBox.Text = $"#{picker.Color.R:x2}{picker.Color.G:x2}{picker.Color.B:x2}";
            }
        };
        var resetButton = new Button { Text = "Reset", AutoSize = true };
        DarkTheme.ApplyButton(resetButton);
        resetButton.Click += (_, _) =>
        {
            themePresetCombo.SelectedItem = DarkTheme.Presets.First(p => p.Id == new ManaThemeSettings().Preset);
            themeAccentBox.Text = "";
            saveButton.PerformClick();
        };

        saveButton.Click += (_, _) =>
        {
            var accentText = themeAccentBox.Text.Trim();
            if (accentText.Length > 0 && !System.Text.RegularExpressions.Regex.IsMatch(accentText, "^#[0-9a-fA-F]{6}$"))
            {
                statusLabel.ForeColor = Color.Firebrick;
                statusLabel.Text = "Accent must be a #rrggbb hex color, or blank to use the preset's own accent.";
                return;
            }

            settings.Preset = themePresetCombo.SelectedItem is ThemePresetInfo preset ? preset.Id : "mana";
            settings.AccentHex = accentText.Length == 0 ? null : accentText;
            settings.Save();
            // #688: every open window restyles now, no restart.
            DarkTheme.ApplyPresetLive(settings.Preset, settings.AccentHex);
            statusLabel.ForeColor = DarkTheme.Muted;
            statusLabel.Text = "Saved and applied.";
        };

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, AutoSize = true, Padding = new Padding(12), BackColor = DarkTheme.Background };
        layout.Controls.Add(new Label { Text = "Theme", AutoSize = true, ForeColor = DarkTheme.Text });
        layout.Controls.Add(themePresetCombo);
        layout.Controls.Add(new Label { Text = "Accent color override (optional, #rrggbb)", AutoSize = true, ForeColor = DarkTheme.Text });
        var accentRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background, Margin = Padding.Empty };
        accentRow.Controls.Add(themeAccentBox);
        accentRow.Controls.Add(pickButton);
        layout.Controls.Add(accentRow);
        var buttonRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background, Margin = Padding.Empty };
        buttonRow.Controls.Add(saveButton);
        buttonRow.Controls.Add(resetButton);
        layout.Controls.Add(buttonRow);
        layout.Controls.Add(statusLabel);

        return new TabPage("Theme") { Controls = { layout } };
    }

    // #575: Operations is free-form per node-bot's own perfMetrics.operations
    // (see GetPerformanceStatusAsync's own comment) -- shown as raw JSON per
    // row rather than parsed into specific fields, since this tab only
    // needs to display it, not act on it.
    private TabPage BuildPerfTab()
    {
        perfSummaryLabel.Dock = DockStyle.Top;
        perfSummaryLabel.Padding = new Padding(8);
        perfSummaryLabel.ForeColor = DarkTheme.Text;

        perfOperationsList.Dock = DockStyle.Fill;
        perfOperationsList.View = View.Details;
        perfOperationsList.FullRowSelect = true;
        perfOperationsList.Columns.Add("Operation", 180);
        perfOperationsList.Columns.Add("Details", 340);
        DarkTheme.ApplyListView(perfOperationsList);

        // #688: Electron's gaming-mode setting and what triggered it. Saved
        // straight away; the launcher's 5s poll picks it up.
        gamingModeCheck.ForeColor = DarkTheme.Text;
        gamingModeCheck.Checked = ManaSettingsStore.Load().GamingModeDetection;
        gamingModeCheck.CheckedChanged += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.GamingModeDetection = gamingModeCheck.Checked;
            latest.Save();
            _ = RefreshPerfTabAsync();
        };
        gamingStatusLabel.ForeColor = DarkTheme.Muted;
        var gamingRow = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(4, 4, 4, 0), BackColor = DarkTheme.Background };
        gamingRow.Controls.Add(gamingModeCheck);
        gamingRow.Controls.Add(gamingStatusLabel);

        var page = new TabPage("Performance");
        page.Controls.Add(perfOperationsList);
        page.Controls.Add(perfSummaryLabel);
        page.Controls.Add(gamingRow);
        return page;
    }

    // #688: like Electron's gaming status line.
    internal static string GamingStatusText(bool enabled, bool running, IReadOnlyList<string> processes) =>
        !enabled ? "Off"
        : running ? $"Active: {string.Join(", ", processes)}"
        : "No watched game running";

    private async Task RefreshPerfTabAsync()
    {
        ManaPerformanceStatus status;
        try
        {
            status = await backendClient.GetPerformanceStatusAsync(getCurrentSessionId?.Invoke());
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load performance status. {ex.Message}");
            if (!IsDisposed)
            {
                perfSummaryLabel.Text = $"Failed to load: {ex.Message}";
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        var uptime = TimeSpan.FromSeconds(status.UptimeSeconds);
        var summary =
            $"Uptime: {uptime:d\\.hh\\:mm\\:ss}\n" +
            $"Memory: {status.TotalMemoryMb} MB    TTS: {status.TtsProvider}    Game detected: {status.GamingAppRunning}\n" +
            $"Whisper threads: {status.WhisperThreads}    Llama threads: {status.LlamaThreads}    Llama max tokens: {status.LlamaMaxTokens}\n" +
            $"Screen context: {(status.ScreenContextEnabled ? "enabled" : "disabled")}";

        // Issue #421 (backend): only present when remote AI is on for a
        // real session -- a local-only session has no cost to meter, so
        // the backend omits "tokenUsage" entirely rather than sending
        // zeros, and this line stays omitted here too rather than showing
        // a misleading "0 tokens".
        if (status.TokenUsage is { } usage)
        {
            var thresholdText = usage.WarnThreshold is { } warn || usage.StopThreshold is { } stop
                ? $" (warn at {usage.WarnThreshold?.ToString() ?? "-"}, stop at {usage.StopThreshold?.ToString() ?? "-"})"
                : "";
            var exceededText = usage.StopExceeded ? " -- STOP THRESHOLD EXCEEDED"
                : usage.WarnExceeded ? " -- warn threshold exceeded"
                : "";
            summary +=
                $"\nSession tokens: {usage.TotalTokens} total ({usage.PromptTokens} prompt + {usage.CompletionTokens} completion, {usage.Calls} calls){thresholdText}{exceededText}";
        }

        perfSummaryLabel.Text = summary;
        gamingStatusLabel.Text = GamingStatusText(gamingModeCheck.Checked, status.GamingAppRunning, status.MatchedProcesses);

        perfOperationsList.Items.Clear();
        foreach (var (name, details) in status.Operations)
        {
            var item = new ListViewItem(name);
            item.SubItems.Add(details);
            perfOperationsList.Items.Add(item);
        }
    }

    // #573: full CRUD, unlike the Skills tab above (view/delete only,
    // per its own documented scope cut) -- presets-capability.js exposes
    // a real PATCH route, so Edit reuses the same PresetDialog New does,
    // pre-filled from the selected item's full ManaPreset (kept as the
    // item's Tag so Edit doesn't need a round-trip just to get the
    // current instructions text back).
    private TabPage BuildPresetsTab()
    {
        presetsList.Dock = DockStyle.Fill;
        presetsList.View = View.Details;
        presetsList.FullRowSelect = true;
        presetsList.Columns.Add("Name", 200);
        DarkTheme.ApplyListView(presetsList);

        var newButton = new Button { Text = "New..." };
        var editButton = new Button { Text = "Edit..." };
        var deleteButton = new Button { Text = "Delete" };
        DarkTheme.ApplyButton(newButton);
        DarkTheme.ApplyButton(editButton);
        DarkTheme.ApplyButton(deleteButton);
        newButton.Click += async (_, _) => await CreatePresetAsync();
        editButton.Click += async (_, _) => await EditSelectedPresetAsync();
        deleteButton.Click += async (_, _) => await DeleteSelectedPresetAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(newButton);
        buttonRow.Controls.Add(editButton);
        buttonRow.Controls.Add(deleteButton);

        // #681: without an active choice no preset ever reached a reply.
        activePresetCombo.BackColor = DarkTheme.Panel2;
        activePresetCombo.ForeColor = DarkTheme.Text;
        activePresetCombo.SelectedIndexChanged += (_, _) =>
        {
            if (!populatingPresets)
            {
                SaveActivePresetId((activePresetCombo.SelectedItem as ManaPreset)?.Id);
            }
        };
        var activeRow = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        activeRow.Controls.Add(new Label { Text = "Active preset", AutoSize = true, ForeColor = DarkTheme.Text, Padding = new Padding(0, 6, 0, 0) });
        activeRow.Controls.Add(activePresetCombo);

        var page = new TabPage("Presets");
        page.Controls.Add(presetsList);
        page.Controls.Add(activeRow);
        page.Controls.Add(buttonRow);
        return page;
    }

    private static void SaveActivePresetId(string? presetId)
    {
        var settings = ManaSettingsStore.Load();
        if (settings.ActivePresetId == presetId)
        {
            return;
        }
        settings.ActivePresetId = presetId;
        settings.Save();
    }

    private async Task CreatePresetAsync()
    {
        using var dialog = new PresetDialog("New Preset");
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.CreatePresetAsync(dialog.PresetName, dialog.Instructions);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to create preset: {ex.Message}", "New Preset", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshPresetsAsync();
        }
    }

    private async Task EditSelectedPresetAsync()
    {
        if (presetsList.SelectedItems.Count == 0)
        {
            return;
        }
        var preset = (ManaPreset)presetsList.SelectedItems[0].Tag!;
        using var dialog = new PresetDialog("Edit Preset", preset.Name, preset.Instructions);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.UpdatePresetAsync(preset.Id, dialog.PresetName, dialog.Instructions);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to update preset: {ex.Message}", "Edit Preset", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshPresetsAsync();
        }
    }

    private async Task DeleteSelectedPresetAsync()
    {
        if (presetsList.SelectedItems.Count == 0)
        {
            return;
        }
        var preset = (ManaPreset)presetsList.SelectedItems[0].Tag!;
        var confirmed = MessageBox.Show(
            this,
            $"Delete preset \"{preset.Name}\"? This cannot be undone.",
            "Delete Preset",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        try
        {
            await backendClient.DeletePresetAsync(preset.Id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to delete preset '{preset.Id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshPresetsAsync();
        }
    }

    private async Task RefreshPresetsAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaPreset> presets;
        try
        {
            presets = await backendClient.GetPresetsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load presets. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(presetsList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        presetsList.Items.Clear();
        foreach (var preset in presets)
        {
            presetsList.Items.Add(new ListViewItem(preset.Name) { Tag = preset });
        }

        // #681: a stored id that no longer exists (deleted) falls back to
        // None and is cleared, same as windows-launcher's renderPresetSelect.
        var activeId = ManaSettingsStore.Load().ActivePresetId;
        populatingPresets = true;
        try
        {
            activePresetCombo.Items.Clear();
            activePresetCombo.Items.Add("None");
            object selected = "None";
            foreach (var preset in presets)
            {
                activePresetCombo.Items.Add(preset);
                if (preset.Id == activeId)
                {
                    selected = preset;
                }
            }
            activePresetCombo.SelectedItem = selected;
        }
        finally
        {
            populatingPresets = false;
        }
        SaveActivePresetId((activePresetCombo.SelectedItem as ManaPreset)?.Id);
    }

    // #572: the largest tab in this batch -- 4 grouped sections
    // (profile/local model/brain provider/vision) in one AutoScroll
    // panel rather than sub-tabs, keeping this a single Settings tab per
    // the issue's own scope, matching windows-launcher's own single
    // "Model" settings panel covering the same 4 concerns.
    private TabPage BuildModelTab()
    {
        var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true, BackColor = DarkTheme.Background };
        var stack = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = false,
            BackColor = DarkTheme.Background,
        };
        stack.Controls.Add(BuildActiveProfileGroup());
        stack.Controls.Add(BuildLocalModelGroup());
        stack.Controls.Add(BuildBrainProviderGroup());
        stack.Controls.Add(BuildVisionModelGroup());
        stack.Controls.Add(BuildLlamaBuildGroup());
        scroll.Controls.Add(stack);
        return new TabPage("Model") { Controls = { scroll } };
    }

    private static GroupBox NewGroup(string title)
    {
        var group = new GroupBox { Text = title, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(8), Margin = new Padding(8), BackColor = DarkTheme.Background, ForeColor = DarkTheme.Text };
        return group;
    }

    private static void StyleTextBox(TextBox box)
    {
        box.BackColor = DarkTheme.Panel2;
        box.ForeColor = DarkTheme.Text;
    }

    private GroupBox BuildActiveProfileGroup()
    {
        var group = NewGroup("Active Model Profile");
        modelProfileCombo.BackColor = DarkTheme.Panel2;
        modelProfileCombo.ForeColor = DarkTheme.Text;

        var switchButton = new Button { Text = "Switch" };
        DarkTheme.ApplyButton(switchButton);
        switchButton.Click += async (_, _) => await SwitchProfileAsync();

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(modelProfileCombo);
        row.Controls.Add(switchButton);
        recommendationLabel.ForeColor = DarkTheme.Muted;
        var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = DarkTheme.Background };
        stack.Controls.Add(row);
        stack.Controls.Add(recommendationLabel);
        group.Controls.Add(stack);
        return group;
    }

    private async Task SwitchProfileAsync()
    {
        if (modelProfileCombo.SelectedItem is not string profile)
        {
            return;
        }
        try
        {
            await backendClient.SetActiveProfileAsync(profile);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to switch profile: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshModelTabAsync();
        }
    }

    private GroupBox BuildLocalModelGroup()
    {
        var group = NewGroup("Local Model File");
        selectedModelLabel.ForeColor = DarkTheme.Muted;

        var browseButton = new Button { Text = "Browse..." };
        var clearButton = new Button { Text = "Clear" };
        var scanButton = new Button { Text = "Scan Storage" };
        var useSelectedButton = new Button { Text = "Use Selected" };
        DarkTheme.ApplyButton(browseButton);
        DarkTheme.ApplyButton(clearButton);
        DarkTheme.ApplyButton(scanButton);
        DarkTheme.ApplyButton(useSelectedButton);
        browseButton.Click += async (_, _) => await BrowseForModelAsync();
        clearButton.Click += async (_, _) => await SetModelPathAsync(null);
        scanButton.Click += async (_, _) => await ScanForModelsAsync();
        useSelectedButton.Click += async (_, _) => await UseScanResultAsync();
        loadIntoVramCheckBox.ForeColor = DarkTheme.Text;
        // Click, not CheckedChanged: only a user toggle saves, not Refresh.
        loadIntoVramCheckBox.Click += async (_, _) => await SaveLoadIntoVramAsync();

        scanResultsList.BackColor = DarkTheme.Panel2;
        scanResultsList.ForeColor = DarkTheme.Text;
        // ManaGgufFile doesn't override ToString() -- without this, the
        // list would show "Mana.NativeLauncher.ManaGgufFile" for every
        // row instead of a usable path.
        scanResultsList.DisplayMember = nameof(ManaGgufFile.Path);
        // #625: owner-drawn so each row can lead with its hardware-fit pill.
        scanResultsList.DrawMode = DrawMode.OwnerDrawFixed;
        scanResultsList.ItemHeight = scanResultsList.Font.Height + 6;
        scanResultsList.DrawItem += DrawScanResult;

        var buttonRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(browseButton);
        buttonRow.Controls.Add(clearButton);
        buttonRow.Controls.Add(scanButton);

        var scanRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        scanRow.Controls.Add(scanResultsList);
        scanRow.Controls.Add(useSelectedButton);

        var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = DarkTheme.Background };
        stack.Controls.Add(selectedModelLabel);
        stack.Controls.Add(buttonRow);
        stack.Controls.Add(scanRow);
        stack.Controls.Add(loadIntoVramCheckBox);
        stack.Controls.Add(new Label { Text = "Applies the next time the model loads (after 10 idle minutes, a model switch, or restarting Mana).", AutoSize = true, ForeColor = DarkTheme.Muted });
        group.Controls.Add(stack);
        return group;
    }

    private async Task SaveLoadIntoVramAsync()
    {
        var loadIntoVram = loadIntoVramCheckBox.Checked;
        try
        {
            await backendClient.SetLoadIntoVramAsync(loadIntoVram);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                loadIntoVramCheckBox.Checked = !loadIntoVram;
                MessageBox.Show(this, $"Failed to save the model loading setting: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    private async Task BrowseForModelAsync()
    {
        using var dialog = new OpenFileDialog { Filter = "GGUF models (*.gguf)|*.gguf", CheckFileExists = true };
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }
        await SetModelPathAsync(dialog.FileName);
    }

    private async Task ScanForModelsAsync()
    {
        ManaGgufScanResult result;
        try
        {
            result = await backendClient.ScanForModelsAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Scan failed: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        scanResultsList.Items.Clear();
        foreach (var file in result.Files)
        {
            scanResultsList.Items.Add(file);
        }
        if (result.Truncated)
        {
            MessageBox.Show(this, "The scan hit its time/directory budget and may not have covered everything.", "Model", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    // #625: node-bot's estimateModelFit value -> pill text/color; null
    // (unknown size or hardware) draws no pill rather than guessing.
    internal static (string Text, Color Color)? ModelFitPill(string? fit) => fit switch
    {
        "fits" => ("Fits", DarkTheme.Green),
        "slow" => ("May be slow", DarkTheme.Warn),
        "wont_fit" => ("Won't fit", Color.Firebrick),
        _ => null,
    };

    private void DrawScanResult(object? sender, DrawItemEventArgs e)
    {
        e.DrawBackground();
        if (e.Index < 0 || e.Index >= scanResultsList.Items.Count || scanResultsList.Items[e.Index] is not ManaGgufFile file)
        {
            return;
        }
        var font = e.Font ?? scanResultsList.Font;
        var x = e.Bounds.X + 4;
        if (ModelFitPill(file.Fit) is { } pill)
        {
            var textSize = TextRenderer.MeasureText(pill.Text, font);
            var rect = new Rectangle(x, e.Bounds.Y + 2, textSize.Width + 8, e.Bounds.Height - 4);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (var path = MermaidRenderer.RoundedRect(rect, rect.Height / 2f))
            using (var pen = new Pen(pill.Color))
            {
                e.Graphics.DrawPath(pen, path);
            }
            TextRenderer.DrawText(e.Graphics, pill.Text, font, rect, pill.Color, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            x = rect.Right + 6;
        }
        var pathRect = new Rectangle(x, e.Bounds.Y, e.Bounds.Right - x, e.Bounds.Height);
        TextRenderer.DrawText(e.Graphics, file.Path, font, pathRect, e.ForeColor, TextFormatFlags.VerticalCenter | TextFormatFlags.PathEllipsis);
    }

    private async Task UseScanResultAsync()
    {
        if (scanResultsList.SelectedItem is not ManaGgufFile file)
        {
            return;
        }
        await SetModelPathAsync(file.Path);
    }

    private async Task SetModelPathAsync(string? path)
    {
        try
        {
            await backendClient.SetModelPathAsync(path);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to set model path: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshModelTabAsync();
        }
    }

    private GroupBox BuildBrainProviderGroup()
    {
        var group = NewGroup("Brain Provider (Remote AI)");
        useRemoteAiCheckBox.ForeColor = DarkTheme.Text;
        brainPresetCombo.BackColor = DarkTheme.Panel2;
        brainPresetCombo.ForeColor = DarkTheme.Text;
        StyleTextBox(brainBaseUrlBox);
        StyleTextBox(brainApiKeyBox);
        StyleTextBox(brainModelBox);
        brainStatusLabel.ForeColor = DarkTheme.Muted;

        brainPresetCombo.SelectedIndexChanged += (_, _) => OnBrainPresetChanged();

        var testButton = new Button { Text = "Test Connection" };
        var saveButton = new Button { Text = "Save" };
        DarkTheme.ApplyButton(testButton);
        DarkTheme.ApplyButton(saveButton);
        testButton.Click += async (_, _) => await TestBrainConnectionAsync();
        saveButton.Click += async (_, _) => await SaveBrainSettingsAsync();

        var layout = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, BackColor = DarkTheme.Background };
        void AddRow(string label, Control control)
        {
            layout.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(3, 6, 3, 3) });
            layout.Controls.Add(control);
        }
        AddRow("Preset", brainPresetCombo);
        AddRow("Base URL", brainBaseUrlBox);
        AddRow("API key", brainApiKeyBox);
        AddRow("Model", brainModelBox);

        var buttonRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(testButton);
        buttonRow.Controls.Add(saveButton);

        var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = DarkTheme.Background };
        stack.Controls.Add(useRemoteAiCheckBox);
        stack.Controls.Add(layout);
        stack.Controls.Add(buttonRow);
        stack.Controls.Add(brainStatusLabel);
        group.Controls.Add(stack);
        return group;
    }

    private void OnBrainPresetChanged()
    {
        if (brainPresetCombo.SelectedItem is not ManaBrainProviderPreset preset)
        {
            return;
        }
        if (!string.IsNullOrEmpty(preset.BaseUrl))
        {
            brainBaseUrlBox.Text = preset.BaseUrl;
        }
    }

    private async Task TestBrainConnectionAsync()
    {
        try
        {
            var (ok, error) = await backendClient.TestBrainConnectionAsync(brainBaseUrlBox.Text.Trim(), string.IsNullOrWhiteSpace(brainApiKeyBox.Text) ? null : brainApiKeyBox.Text.Trim());
            if (!IsDisposed)
            {
                brainStatusLabel.ForeColor = ok ? DarkTheme.Green : Color.Firebrick;
                brainStatusLabel.Text = ok ? "Connected." : $"Failed: {error}";
            }
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                brainStatusLabel.ForeColor = Color.Firebrick;
                brainStatusLabel.Text = $"Failed: {ex.Message}";
            }
        }
    }

    private async Task SaveBrainSettingsAsync()
    {
        var type = useRemoteAiCheckBox.Checked ? "openai_compatible" : "local";
        // Leaves the currently-configured key untouched when the box is
        // blank (SetBrainSettingsAsync's own null-means-unchanged
        // contract) -- otherwise reopening this tab (which never echoes
        // the real key back, only BrainHasApiKey) and clicking Save would
        // silently wipe a previously-saved key.
        var apiKey = string.IsNullOrWhiteSpace(brainApiKeyBox.Text) ? null : brainApiKeyBox.Text.Trim();
        try
        {
            await backendClient.SetBrainSettingsAsync(type, brainBaseUrlBox.Text.Trim(), apiKey, brainModelBox.Text.Trim());
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to save brain provider settings: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshModelTabAsync();
        }
    }

    private GroupBox BuildVisionModelGroup()
    {
        var group = NewGroup("Vision Model");
        StyleTextBox(visionModelPathBox);
        StyleTextBox(visionMmprojPathBox);

        var browseModelButton = new Button { Text = "Browse..." };
        var browseMmprojButton = new Button { Text = "Browse..." };
        var saveButton = new Button { Text = "Save" };
        DarkTheme.ApplyButton(browseModelButton);
        DarkTheme.ApplyButton(browseMmprojButton);
        DarkTheme.ApplyButton(saveButton);
        browseModelButton.Click += (_, _) => BrowseInto(visionModelPathBox);
        browseMmprojButton.Click += (_, _) => BrowseInto(visionMmprojPathBox);
        saveButton.Click += async (_, _) => await SaveVisionSettingsAsync();

        var layout = new TableLayoutPanel { ColumnCount = 3, AutoSize = true, BackColor = DarkTheme.Background };
        layout.Controls.Add(new Label { Text = "Model path", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(3, 6, 3, 3) });
        layout.Controls.Add(visionModelPathBox);
        layout.Controls.Add(browseModelButton);
        layout.Controls.Add(new Label { Text = "mmproj path", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(3, 6, 3, 3) });
        layout.Controls.Add(visionMmprojPathBox);
        layout.Controls.Add(browseMmprojButton);

        var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = DarkTheme.Background };
        stack.Controls.Add(layout);
        stack.Controls.Add(saveButton);
        group.Controls.Add(stack);
        return group;
    }

    private void BrowseInto(TextBox target)
    {
        using var dialog = new OpenFileDialog { Filter = "GGUF models (*.gguf)|*.gguf", CheckFileExists = true };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            target.Text = dialog.FileName;
        }
    }

    private async Task SaveVisionSettingsAsync()
    {
        try
        {
            await backendClient.SetVisionSettingsAsync(visionModelPathBox.Text.Trim(), visionMmprojPathBox.Text.Trim());
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to save vision settings: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshModelTabAsync();
        }
    }

    private GroupBox BuildLlamaBuildGroup()
    {
        var group = NewGroup("llama.cpp Build");
        llamaBuildLabel.ForeColor = DarkTheme.Muted;
        var checkButton = new Button { Text = "Check for update", AutoSize = true };
        llamaUpdateButton.AutoSize = true;
        llamaRollbackButton.AutoSize = true;
        DarkTheme.ApplyButton(checkButton);
        DarkTheme.ApplyButton(llamaUpdateButton);
        DarkTheme.ApplyButton(llamaRollbackButton);
        checkButton.Click += async (_, _) => await CheckLlamaBuildAsync();
        llamaUpdateButton.Click += async (_, _) => await UpdateLlamaBuildAsync(allowMissingDigest: false);
        llamaRollbackButton.Click += async (_, _) => await RollBackLlamaBuildAsync();

        var buttonRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(checkButton);
        buttonRow.Controls.Add(llamaUpdateButton);
        buttonRow.Controls.Add(llamaRollbackButton);
        var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = DarkTheme.Background };
        stack.Controls.Add(llamaBuildLabel);
        stack.Controls.Add(buttonRow);
        group.Controls.Add(stack);
        return group;
    }

    // #693: the group's text -- current build, then the one most relevant
    // thing that happened: an update in progress, a failed update, an
    // automatic rollback, or a finished update.
    internal static string DescribeLlamaBuild(ManaLlamaBuildStatus status)
    {
        var current = status.CurrentBuild is int build
            ? $"Current build: b{build} ({status.CurrentVariant})"
            : $"Current build: unknown. {status.CurrentError}";
        var detail = status.JobState switch
        {
            "running" => $"Updating to {status.JobTag}: {status.JobStep}...",
            "failed" => $"Update to {status.JobTag} failed: {status.JobError}",
            _ when status.LastRollbackFrom is not null =>
                $"Rolled back automatically: {System.IO.Path.GetFileName(status.LastRollbackFrom)} failed to start ({status.LastRollbackReason}).",
            "done" => $"Updated to {status.JobTag}. llama-server restarts on it with the next reply.",
            _ => null,
        };
        return detail is null ? current : current + Environment.NewLine + detail;
    }

    // Returns null when the status couldn't be loaded (or the panel closed).
    private async Task<ManaLlamaBuildStatus?> RefreshLlamaBuildAsync()
    {
        ManaLlamaBuildStatus status;
        try
        {
            status = await backendClient.GetLlamaBuildStatusAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                llamaBuildLabel.Text = $"Failed to load: {ex.Message}";
            }
            return null;
        }
        if (IsDisposed)
        {
            return null;
        }
        var running = status.JobState == "running";
        llamaBuildLabel.Text = DescribeLlamaBuild(status) + (llamaCheckNote is null ? "" : Environment.NewLine + llamaCheckNote);
        llamaUpdateButton.Enabled = llamaUpdateAvailable && !running;
        llamaRollbackButton.Enabled = status.Previous is not null && !running;
        return status;
    }

    private async Task CheckLlamaBuildAsync()
    {
        llamaBuildLabel.Text = "Checking GitHub for a newer llama.cpp build...";
        ManaLlamaBuildCheck check;
        try
        {
            check = await backendClient.CheckLlamaBuildUpdateAsync();
        }
        catch (Exception ex)
        {
            check = new ManaLlamaBuildCheck { Error = ex.Message };
        }
        if (IsDisposed)
        {
            return;
        }
        llamaUpdateAvailable = check.UpdateAvailable;
        llamaCheckNote = check.Error is not null
            ? $"Check failed: {check.Error}"
            : check.UpdateAvailable
                ? $"{check.LatestTag} is available." + (check.DigestAvailable ? "" : " It has no published checksum.")
                : $"Up to date (newest is {check.LatestTag}).";
        await RefreshLlamaBuildAsync();
    }

    private async Task UpdateLlamaBuildAsync(bool allowMissingDigest)
    {
        // Against a double click while the request is in flight; restored
        // below whenever this doesn't end up starting an update.
        llamaUpdateButton.Enabled = false;
        ManaLlamaBuildActionResult result;
        try
        {
            result = await backendClient.StartLlamaBuildUpdateAsync(allowMissingDigest);
        }
        catch (Exception ex)
        {
            result = new ManaLlamaBuildActionResult { Error = ex.Message };
        }
        if (IsDisposed)
        {
            return;
        }
        if (!result.Ok)
        {
            llamaUpdateButton.Enabled = llamaUpdateAvailable;
            if (result.Code == "digest_missing" && !allowMissingDigest)
            {
                var answer = MessageBox.Show(this, $"{result.Error}\n\nInstall it anyway, without checksum verification?", "llama.cpp update", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (answer == DialogResult.Yes && !IsDisposed)
                {
                    await UpdateLlamaBuildAsync(allowMissingDigest: true);
                }
                return;
            }
            MessageBox.Show(this, $"Update failed: {result.Error}", "llama.cpp update", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        llamaUpdateAvailable = false;
        llamaCheckNote = null;
        // The download/install runs in node-bot's background; poll its job
        // until it settles.
        ManaLlamaBuildStatus? status;
        do
        {
            status = await RefreshLlamaBuildAsync();
            if (status?.JobState != "running")
            {
                break;
            }
            await Task.Delay(1500);
        } while (!IsDisposed);
    }

    private async Task RollBackLlamaBuildAsync()
    {
        var answer = MessageBox.Show(this, "Switch back to the previous llama.cpp build? llama-server restarts on it with the next reply.", "llama.cpp", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (answer != DialogResult.Yes)
        {
            return;
        }
        ManaLlamaBuildActionResult result;
        try
        {
            result = await backendClient.RollBackLlamaBuildAsync();
        }
        catch (Exception ex)
        {
            result = new ManaLlamaBuildActionResult { Error = ex.Message };
        }
        if (IsDisposed)
        {
            return;
        }
        if (!result.Ok)
        {
            MessageBox.Show(this, $"Roll back failed: {result.Error}", "llama.cpp", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        await RefreshLlamaBuildAsync();
    }

    private async Task RefreshModelTabAsync()
    {
        ManaModelStatus status;
        System.Collections.Generic.IReadOnlyList<ManaBrainProviderPreset> presets;
        try
        {
            status = await backendClient.GetModelStatusAsync();
            presets = await backendClient.GetBrainProvidersAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load model status. {ex.Message}");
            if (!IsDisposed)
            {
                selectedModelLabel.Text = $"Failed to load: {ex.Message}";
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        modelProfileCombo.Items.Clear();
        foreach (var key in status.Profiles.Keys)
        {
            modelProfileCombo.Items.Add(key);
        }
        if (status.ActiveProfile is not null && modelProfileCombo.Items.Contains(status.ActiveProfile))
        {
            modelProfileCombo.SelectedItem = status.ActiveProfile;
        }
        // #625: surfaces /models/status's `recommendation` (hardware-based).
        recommendationLabel.Text = status.RecommendedProfile is null ? "" : $"Recommended for this PC: {status.RecommendedProfile}";

        selectedModelLabel.Text = string.IsNullOrEmpty(status.SelectedModelPath)
            ? "No local model file selected (auto-detecting)."
            : $"Selected: {status.SelectedModelPath}";

        brainPresets = presets;
        brainPresetCombo.Items.Clear();
        foreach (var preset in presets)
        {
            brainPresetCombo.Items.Add(preset);
        }
        brainPresetCombo.DisplayMember = nameof(ManaBrainProviderPreset.Label);

        useRemoteAiCheckBox.Checked = status.BrainType == "openai_compatible";
        brainBaseUrlBox.Text = status.BrainBaseUrl;
        brainModelBox.Text = status.BrainModel;
        // Never pre-fills the real key (node-bot never echoes it) --
        // just hints that one is already saved, so Save's "blank means
        // leave it alone" behavior above doesn't look like a data-loss bug.
        brainApiKeyBox.Text = "";
        brainApiKeyBox.PlaceholderText = status.BrainHasApiKey ? "(configured -- leave blank to keep it)" : "";
        brainStatusLabel.Text = "";

        visionModelPathBox.Text = status.VisionModelPath;
        visionMmprojPathBox.Text = status.VisionMmprojPath;
        loadIntoVramCheckBox.Checked = status.LoadIntoVram;
    }

    // #569: TOTP secret enrollment has no API endpoint at all
    // (mobile-routes.js reads MOBILE_TOTP_SECRET straight from the
    // environment) -- this tab covers pairing-code generation and device
    // management only, matching what the backend actually exposes.
    private TabPage BuildMobileDevicesTab()
    {
        mobileDevicesList.Dock = DockStyle.Fill;
        mobileDevicesList.View = View.Details;
        mobileDevicesList.FullRowSelect = true;
        mobileDevicesList.Columns.Add("Name", 140);
        mobileDevicesList.Columns.Add("Created", 140);
        mobileDevicesList.Columns.Add("Last seen", 140);
        mobileDevicesList.Columns.Add("Status", 70);
        DarkTheme.ApplyListView(mobileDevicesList);

        var pairButton = new Button { Text = "Generate Pairing Code" };
        var rotateButton = new Button { Text = "Rotate Token" };
        var revokeButton = new Button { Text = "Revoke" };
        DarkTheme.ApplyButton(pairButton);
        DarkTheme.ApplyButton(rotateButton);
        DarkTheme.ApplyButton(revokeButton);
        pairButton.Click += async (_, _) => await GeneratePairingCodeAsync();
        rotateButton.Click += async (_, _) => await RotateSelectedDeviceTokenAsync();
        revokeButton.Click += async (_, _) => await RevokeSelectedDeviceAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(pairButton);
        buttonRow.Controls.Add(rotateButton);
        buttonRow.Controls.Add(revokeButton);

        var page = new TabPage("Mobile Devices");
        page.Controls.Add(mobileDevicesList);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async Task GeneratePairingCodeAsync()
    {
        (string Code, long ExpiresAtMs) result;
        try
        {
            result = await backendClient.RequestPairingCodeAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to generate a pairing code: {ex.Message}", "Generate Pairing Code", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        var expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(result.ExpiresAtMs).ToLocalTime();
        MessageBox.Show(
            this,
            $"Pairing code: {result.Code}\n\nEnter this in the Mana mobile app. Expires at {expiresAt:T}.",
            "Generate Pairing Code",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private async Task RotateSelectedDeviceTokenAsync()
    {
        if (mobileDevicesList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)mobileDevicesList.SelectedItems[0].Tag!;
        var name = mobileDevicesList.SelectedItems[0].Text;
        var confirmed = MessageBox.Show(
            this,
            $"Rotate the token for \"{name}\"? The device will need to be re-paired with the new token.",
            "Rotate Token",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        string? token;
        try
        {
            token = await backendClient.RotateMobileDeviceTokenAsync(id);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to rotate token: {ex.Message}", "Rotate Token", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed || token is null)
        {
            return;
        }
        using (var reveal = new MobileTokenRevealDialog(name, token))
        {
            reveal.ShowDialog(this);
        }
        if (!IsDisposed)
        {
            await RefreshMobileDevicesAsync();
        }
    }

    private async Task RevokeSelectedDeviceAsync()
    {
        if (mobileDevicesList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)mobileDevicesList.SelectedItems[0].Tag!;
        var name = mobileDevicesList.SelectedItems[0].Text;
        var confirmed = MessageBox.Show(
            this,
            $"Revoke \"{name}\"? It will no longer be able to reach Mana.",
            "Revoke Device",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        try
        {
            await backendClient.RevokeMobileDeviceAsync(id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to revoke mobile device '{id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMobileDevicesAsync();
        }
    }

    private async Task RefreshMobileDevicesAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaMobileDevice> devices;
        try
        {
            devices = await backendClient.GetMobileDevicesAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load mobile devices. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(mobileDevicesList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        mobileDevicesList.Items.Clear();
        foreach (var device in devices)
        {
            var item = new ListViewItem(device.Name) { Tag = device.Id };
            item.SubItems.Add(device.CreatedAt ?? "");
            item.SubItems.Add(device.LastSeenAt ?? "never");
            item.SubItems.Add(device.Revoked ? "revoked" : "active");
            mobileDevicesList.Items.Add(item);
        }
    }

    // #568: requires an admin-role API key entered as the Connection
    // tab's admin token (server.js's authMiddleware + requireAdmin) --
    // distinct from the MANA_ADMIN_SECRET value the memory-facts/skills/
    // approvals tabs above check for, since /admin/accounts uses a
    // different gate. A missing/wrong token surfaces the same
    // ShowLoadFailure placeholder those tabs already use.
    private TabPage BuildAccountsTab()
    {
        accountsList.Dock = DockStyle.Fill;
        accountsList.View = View.Details;
        accountsList.FullRowSelect = true;
        accountsList.Columns.Add("Email", 220);
        accountsList.Columns.Add("Role", 80);
        DarkTheme.ApplyListView(accountsList);

        var createButton = new Button { Text = "Create..." };
        var deleteButton = new Button { Text = "Revoke" };
        DarkTheme.ApplyButton(createButton);
        DarkTheme.ApplyButton(deleteButton);
        createButton.Click += async (_, _) => await CreateAccountAsync();
        deleteButton.Click += async (_, _) => await DeleteSelectedAccountAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(createButton);
        buttonRow.Controls.Add(deleteButton);

        var page = new TabPage("Accounts");
        page.Controls.Add(accountsList);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async Task CreateAccountAsync()
    {
        using var dialog = new CreateAccountDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        string apiKey;
        try
        {
            apiKey = await backendClient.CreateAccountAsync(dialog.Email, dialog.Role);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to create account: {ex.Message}", "Create Account", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        using (var reveal = new ApiKeyRevealDialog(dialog.Email, apiKey))
        {
            reveal.ShowDialog(this);
        }
        if (!IsDisposed)
        {
            await RefreshAccountsAsync();
        }
    }

    private async Task DeleteSelectedAccountAsync()
    {
        if (accountsList.SelectedItems.Count == 0)
        {
            return;
        }
        var userId = (string)accountsList.SelectedItems[0].Tag!;
        var email = accountsList.SelectedItems[0].Text;
        var confirmed = MessageBox.Show(
            this,
            $"Revoke account \"{email}\"? This cannot be undone.",
            "Revoke Account",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        try
        {
            await backendClient.DeleteAccountAsync(userId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to revoke account '{userId}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshAccountsAsync();
        }
    }

    private async Task RefreshAccountsAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaAccount> accounts;
        try
        {
            accounts = await backendClient.GetAccountsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load accounts. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(accountsList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        accountsList.Items.Clear();
        foreach (var account in accounts)
        {
            var item = new ListViewItem(account.Email) { Tag = account.UserId };
            item.SubItems.Add(account.Role);
            accountsList.Items.Add(item);
        }
    }

    // #950 (#906): the email and calendar accounts Mana reads, through
    // node-bot's /mail-calendar. I type my own app passwords here; node-bot
    // saves them DPAPI-encrypted and never sends them back, so a blank
    // password or calendar address keeps the saved one.
    // docs/mail_calendar_setup.md has the steps per provider.
    private readonly TextBox mailHostBox = new() { Width = 260, PlaceholderText = "imap.gmail.com" };
    private readonly TextBox mailPortBox = new() { Width = 60 };
    private readonly TextBox mailUserBox = new() { Width = 260 };
    private readonly TextBox mailPasswordBox = new() { Width = 260, UseSystemPasswordChar = true };
    private readonly TextBox mailMailboxBox = new() { Width = 260 };
    private readonly Label mailStatusLabel = new() { AutoSize = true, MaximumSize = new Size(520, 0) };
    private readonly TextBox calendarUrlBox = new() { Width = 420 };
    private readonly TextBox calendarUserBox = new() { Width = 260, PlaceholderText = "blank for an iCal feed" };
    private readonly TextBox calendarPasswordBox = new() { Width = 260, UseSystemPasswordChar = true };
    private readonly Label calendarStatusLabel = new() { AutoSize = true, MaximumSize = new Size(520, 0) };

    private TabPage BuildMailCalendarTab()
    {
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, BackColor = DarkTheme.Background };
        layout.Controls.Add(BuildMailCalendarGroup(
            "Email (IMAP, read-only)",
            "email",
            new (string, TextBox)[] { ("Server", mailHostBox), ("Port", mailPortBox), ("Username", mailUserBox), ("App password", mailPasswordBox), ("Mailbox", mailMailboxBox) },
            mailStatusLabel,
            () => new { kind = "email", host = mailHostBox.Text.Trim(), port = mailPortBox.Text.Trim(), user = mailUserBox.Text.Trim(), password = mailPasswordBox.Text, mailbox = mailMailboxBox.Text.Trim() }));
        layout.Controls.Add(BuildMailCalendarGroup(
            "Calendar (CalDAV, or a Google/Outlook iCal feed)",
            "calendar",
            new (string, TextBox)[] { ("Address", calendarUrlBox), ("Username", calendarUserBox), ("App password", calendarPasswordBox) },
            calendarStatusLabel,
            () => new { kind = "calendar", url = calendarUrlBox.Text.Trim(), user = calendarUserBox.Text.Trim(), password = calendarPasswordBox.Text }));
        layout.Controls.Add(new Label
        {
            Text = "Mana reads these only when I ask, and adds a calendar event only after I approve it. An iCal feed (Google's secret address, Outlook's published calendar) is read-only: leave its Username blank. Steps per provider: docs/mail_calendar_setup.md.",
            AutoSize = true,
            MaximumSize = new Size(520, 0),
            ForeColor = DarkTheme.Muted,
            Margin = new Padding(8),
        });
        return new TabPage("Calendar & Email") { Controls = { layout } };
    }

    private GroupBox BuildMailCalendarGroup(string title, string kind, (string Label, TextBox Box)[] rows, Label status, Func<object> change)
    {
        var group = NewGroup(title);
        var table = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, BackColor = DarkTheme.Background };
        foreach (var (label, box) in rows)
        {
            StyleTextBox(box);
            box.AccessibleName = label;
            table.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(3, 6, 3, 3) });
            table.Controls.Add(box);
        }
        var saveButton = new Button { Text = "Save and test", AutoSize = true };
        var removeButton = new Button { Text = "Remove", AutoSize = true };
        DarkTheme.ApplyButton(saveButton);
        DarkTheme.ApplyButton(removeButton);
        saveButton.Click += async (_, _) => await SaveMailCalendarAsync(kind, change(), status, test: true);
        removeButton.Click += async (_, _) => await SaveMailCalendarAsync(kind, new { kind, clear = true }, status, test: false);
        var buttonRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(saveButton);
        buttonRow.Controls.Add(removeButton);
        status.ForeColor = DarkTheme.Muted;
        var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = DarkTheme.Background };
        stack.Controls.Add(table);
        stack.Controls.Add(buttonRow);
        stack.Controls.Add(status);
        group.Controls.Add(stack);
        return group;
    }

    private async Task SaveMailCalendarAsync(string kind, object change, Label status, bool test)
    {
        try
        {
            ShowMailCalendar(await backendClient.UpdateMailCalendarAsync(change));
            if (!test || IsDisposed)
            {
                return;
            }
            status.ForeColor = DarkTheme.Muted;
            status.Text = "Saved. Testing...";
            var (ok, error) = await backendClient.TestMailCalendarAsync(kind);
            if (!IsDisposed)
            {
                status.ForeColor = ok ? DarkTheme.Green : Color.Firebrick;
                status.Text = ok ? "Saved and connected." : $"Saved, but the test failed: {error}";
            }
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                status.ForeColor = Color.Firebrick;
                status.Text = $"Failed: {ex.Message}";
            }
        }
    }

    private async Task RefreshMailCalendarAsync()
    {
        try
        {
            ShowMailCalendar(await backendClient.GetMailCalendarAsync());
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                mailStatusLabel.Text = calendarStatusLabel.Text = $"Failed to load: {ex.Message}";
            }
        }
    }

    // Fills in what node-bot sends back (never a password or feed address)
    // and says what's set up.
    private void ShowMailCalendar(ManaMailCalendar state)
    {
        if (IsDisposed)
        {
            return;
        }
        const string unreadable = "The saved settings can't be read on this Windows account: enter them again.";
        var email = state.Email;
        mailHostBox.Text = email?.Host ?? "";
        mailPortBox.Text = email is { Port: > 0 } ? email.Port.ToString() : "993";
        mailUserBox.Text = email?.User ?? "";
        mailMailboxBox.Text = email?.Mailbox ?? "INBOX";
        mailPasswordBox.Clear();
        mailPasswordBox.PlaceholderText = email?.PasswordSet == true ? "saved (blank keeps it)" : "";
        mailStatusLabel.ForeColor = DarkTheme.Muted;
        mailStatusLabel.Text = email is null ? "Not set up." : email.Unreadable ? unreadable : $"Set up: {email.User} on {email.Host}.";

        var calendar = state.Calendar;
        calendarUserBox.Text = calendar?.User ?? "";
        calendarUrlBox.Clear();
        calendarUrlBox.PlaceholderText = calendar is { Unreadable: false } ? "saved (blank keeps it)" : "https://...";
        calendarPasswordBox.Clear();
        calendarPasswordBox.PlaceholderText = calendar?.PasswordSet == true ? "saved (blank keeps it)" : "";
        calendarStatusLabel.ForeColor = DarkTheme.Muted;
        calendarStatusLabel.Text = calendar is null
            ? "Not set up."
            : calendar.Unreadable
                ? unreadable
                : calendar.ReadOnly
                    ? $"Set up: iCal feed from {calendar.Host} (read-only)."
                    : $"Set up: {calendar.User} on {calendar.Host}.";
    }

    // #567: registration goes through the approval gate server-side, not
    // an immediate write (see RegisterMcpServerAsync's own comment) --
    // this tab has no toggle/edit action, only Add and Delete, matching
    // that: there's nothing here to PATCH, and a pending registration is
    // decided from the existing Approvals tab, not this one.
    private TabPage BuildMcpServersTab()
    {
        mcpServersList.Dock = DockStyle.Fill;
        mcpServersList.View = View.Details;
        mcpServersList.FullRowSelect = true;
        mcpServersList.Columns.Add("Name", 120);
        mcpServersList.Columns.Add("Transport", 200);
        mcpServersList.Columns.Add("Allowed tools", 200);
        DarkTheme.ApplyListView(mcpServersList);

        var addButton = new Button { Text = "Register..." };
        var deleteButton = new Button { Text = "Remove" };
        DarkTheme.ApplyButton(addButton);
        DarkTheme.ApplyButton(deleteButton);
        addButton.Click += async (_, _) => await RegisterMcpServerAsync();
        deleteButton.Click += async (_, _) => await DeleteSelectedMcpServerAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(addButton);
        buttonRow.Controls.Add(deleteButton);

        var page = new TabPage("MCP Clients");
        page.Controls.Add(mcpServersList);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async Task RegisterMcpServerAsync()
    {
        using var dialog = new McpServerDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        string status;
        try
        {
            status = await backendClient.RegisterMcpServerAsync(dialog.ServerName, dialog.TransportKind, dialog.Command, dialog.Args, dialog.EnvAllowlist, dialog.Url, dialog.AllowedTools);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to register MCP server: {ex.Message}", "Register MCP Server", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            MessageBox.Show(
                this,
                status == "pending" ? "Registration submitted -- approve it from the Approvals tab." : $"Registration status: {status}",
                "Register MCP Server",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            await RefreshMcpServersAsync();
        }
    }

    private async Task DeleteSelectedMcpServerAsync()
    {
        if (mcpServersList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)mcpServersList.SelectedItems[0].Tag!;
        try
        {
            await backendClient.DeleteMcpServerAsync(id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to remove MCP server '{id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMcpServersAsync();
        }
    }

    private async Task RefreshMcpServersAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaMcpServer> servers;
        try
        {
            servers = await backendClient.GetMcpServersAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load MCP servers. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(mcpServersList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        mcpServersList.Items.Clear();
        foreach (var server in servers)
        {
            var item = new ListViewItem(server.Name) { Tag = server.Id };
            item.SubItems.Add(server.TransportSummary);
            item.SubItems.Add(server.AllowedTools);
            mcpServersList.Items.Add(item);
        }
    }

    // #566: PATCH /hooks/:id only settles `enabled` (pause/resume) --
    // matches node-bot's own narrow scope for that route (hooks-store.js's
    // setRuleEnabled), so this tab's checkbox is the one edit action, same
    // shape as the Plugins tab's own enable/disable toggle above.
    private TabPage BuildHooksTab()
    {
        hooksList.Dock = DockStyle.Fill;
        hooksList.View = View.Details;
        hooksList.CheckBoxes = true;
        hooksList.FullRowSelect = true;
        hooksList.Columns.Add("Tool", 150);
        hooksList.Columns.Add("Phase", 60);
        hooksList.Columns.Add("Action", 100);
        hooksList.Columns.Add("Path filter", 140);
        hooksList.Columns.Add("Last run", 70);
        hooksList.ItemChecked += OnHookChecked;
        DarkTheme.ApplyListView(hooksList);

        var addButton = new Button { Text = "Add..." };
        var deleteButton = new Button { Text = "Delete" };
        DarkTheme.ApplyButton(addButton);
        DarkTheme.ApplyButton(deleteButton);
        addButton.Click += async (_, _) => await AddHookAsync();
        deleteButton.Click += async (_, _) => await DeleteSelectedHookAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(addButton);
        buttonRow.Controls.Add(deleteButton);

        var page = new TabPage("Hooks");
        page.Controls.Add(hooksList);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async void OnHookChecked(object? sender, ItemCheckedEventArgs e)
    {
        // Same reentrancy guard as OnPluginChecked above -- suppressed
        // while RefreshHooksAsync is setting each item's initial Checked
        // state from the server's own value.
        if (populatingHooks)
        {
            return;
        }
        var id = (string)e.Item.Tag!;
        try
        {
            await backendClient.SetHookEnabledAsync(id, e.Item.Checked);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to toggle hook '{id}'. {ex.Message}");
        }
    }

    private async Task AddHookAsync()
    {
        using var dialog = new HookRuleDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.CreateHookAsync(dialog.Phase, dialog.Action, dialog.ToolName, dialog.PathContains, dialog.Command, dialog.Args, dialog.Reason);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to add hook rule: {ex.Message}", "Add Hook Rule", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshHooksAsync();
        }
    }

    private async Task DeleteSelectedHookAsync()
    {
        if (hooksList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)hooksList.SelectedItems[0].Tag!;
        try
        {
            await backendClient.DeleteHookAsync(id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to delete hook '{id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshHooksAsync();
        }
    }

    private async Task RefreshHooksAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaHookRule> hooks;
        try
        {
            hooks = await backendClient.GetHooksAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load hooks. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(hooksList, ex.Message);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        populatingHooks = true;
        try
        {
            hooksList.Items.Clear();
            foreach (var hook in hooks)
            {
                var item = new ListViewItem(hook.ToolName) { Tag = hook.Id, Checked = hook.Enabled };
                item.SubItems.Add(hook.Phase);
                item.SubItems.Add(hook.Action);
                item.SubItems.Add(hook.PathContains ?? "");
                item.SubItems.Add(hook.LastRunOk switch { true => "ok", false => "failed", null => "" });
                hooksList.Items.Add(item);
            }
        }
        finally
        {
            populatingHooks = false;
        }
    }
}

using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #529: a lean settings surface -- plugins (enable/disable), memory
// facts (view/archive), skills (view/delete), and the approval-gate
// queue (approve/deny). Explicitly the lowest-priority piece of the
// native-launcher-parity batch, per this issue's own scope note, so
// each tab is a plain ListView with the one or two actions that matter
// most, not a full editor. Skill creation/editing (a large form for a
// skill's full body) and a live backend log tail (would need
// ManaProcessManager to start redirecting/buffering node-bot's stdout,
// a distinct feature of its own) are both left out -- see this issue's
// PR description for the full reasoning.
internal sealed class SettingsPanel : UserControl
{
    private readonly ManaBackendClient backendClient;
    private readonly ListView pluginsList = new();
    private readonly ListView factsList = new();
    private readonly ListView skillsList = new();
    private readonly ListView approvalsList = new();
    private bool populatingPlugins;

    // #572: Model tab controls -- kept as fields (unlike most other tabs'
    // plain local variables in their Build*Tab methods) because Refresh
    // needs to repopulate them from a fresh GetModelStatusAsync call, the
    // same reason pluginsList/factsList/etc. above are fields too.
    private readonly ComboBox modelProfileCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private readonly Label selectedModelLabel = new() { AutoSize = true };
    private readonly ListBox scanResultsList = new() { Height = 100, Width = 400 };
    private readonly CheckBox useRemoteAiCheckBox = new() { Text = "Use Remote AI (OpenAI-compatible endpoint)" };
    private readonly ComboBox brainPresetCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private readonly TextBox brainBaseUrlBox = new() { Width = 300 };
    private readonly TextBox brainApiKeyBox = new() { Width = 300, UseSystemPasswordChar = true };
    private readonly TextBox brainModelBox = new() { Width = 300 };
    private readonly Label brainStatusLabel = new() { AutoSize = true };
    private readonly TextBox visionModelPathBox = new() { Width = 300 };
    private readonly TextBox visionMmprojPathBox = new() { Width = 300 };
    private System.Collections.Generic.IReadOnlyList<ManaBrainProviderPreset> brainPresets = System.Array.Empty<ManaBrainProviderPreset>();

    public SettingsPanel(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;
        Dock = DockStyle.Fill;
        BackColor = DarkTheme.Background;
        ForeColor = DarkTheme.Text;

        var tabs = new TabControl { Dock = DockStyle.Fill };
        DarkTheme.ApplyTabControl(tabs);
        tabs.TabPages.Add(BuildPluginsTab());
        tabs.TabPages.Add(BuildMemoryFactsTab());
        tabs.TabPages.Add(BuildSkillsTab());
        tabs.TabPages.Add(BuildApprovalsTab());
        tabs.TabPages.Add(BuildModelTab());
        foreach (TabPage page in tabs.TabPages)
        {
            page.BackColor = DarkTheme.Background;
        }
        Controls.Add(tabs);
    }

    public async Task RefreshAllAsync()
    {
        await RefreshPluginsAsync();
        await RefreshMemoryFactsAsync();
        await RefreshSkillsAsync();
        await RefreshApprovalsAsync();
        await RefreshModelTabAsync();
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
        return new TabPage("Plugins") { Controls = { pluginsList } };
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
        System.Collections.Generic.IReadOnlyList<ManaPlugin> plugins;
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

        populatingPlugins = true;
        try
        {
            pluginsList.Items.Clear();
            foreach (var plugin in plugins)
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
        DarkTheme.ApplyListView(factsList);

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

        var page = new TabPage("Memory Facts");
        page.Controls.Add(factsList);
        page.Controls.Add(archiveButton);
        return page;
    }

    private async Task ArchiveSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0)
        {
            return;
        }
        var key = (string)factsList.SelectedItems[0].Tag!;
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
        System.Collections.Generic.IReadOnlyList<ManaMemoryFact> facts;
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

        factsList.Items.Clear();
        foreach (var fact in facts)
        {
            var item = new ListViewItem(fact.Key) { Tag = fact.Key };
            item.SubItems.Add(fact.Text);
            item.SubItems.Add(fact.Status);
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

        var deleteButton = new Button { Text = "Delete", Dock = DockStyle.Bottom, Height = 28 };
        DarkTheme.ApplyButton(deleteButton);
        deleteButton.Click += async (_, _) => await DeleteSelectedSkillAsync();

        var page = new TabPage("Skills");
        page.Controls.Add(skillsList);
        page.Controls.Add(deleteButton);
        return page;
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
        var alwaysAllowButton = new Button { Text = "Always allow" };
        var denyButton = new Button { Text = "Deny" };
        DarkTheme.ApplyButton(allowButton);
        DarkTheme.ApplyButton(alwaysAllowButton);
        DarkTheme.ApplyButton(denyButton);

        // All three share one guard -- a decision resolves the request
        // server-side, so a second click (this button or a different
        // one) while the first is still in flight would just 404 there
        // instead of doing anything useful.
        async Task DecideAsync(string decision)
        {
            allowButton.Enabled = false;
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
                    alwaysAllowButton.Enabled = true;
                    denyButton.Enabled = true;
                }
            }
        }
        allowButton.Click += async (_, _) => await DecideAsync("allow-once");
        alwaysAllowButton.Click += async (_, _) => await DecideAsync("always-allow");
        denyButton.Click += async (_, _) => await DecideAsync("deny");
        buttonRow.Controls.Add(allowButton);
        buttonRow.Controls.Add(alwaysAllowButton);
        buttonRow.Controls.Add(denyButton);

        var page = new TabPage("Approvals");
        page.Controls.Add(approvalsList);
        page.Controls.Add(buttonRow);
        return page;
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
            await backendClient.DecideApprovalAsync(id, decision);
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

        approvalsList.Items.Clear();
        foreach (var approval in pending)
        {
            var item = new ListViewItem(approval.ActionType) { Tag = approval.Id };
            item.SubItems.Add(approval.Summary);
            approvalsList.Items.Add(item);
        }
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
        group.Controls.Add(row);
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

        scanResultsList.BackColor = DarkTheme.Panel2;
        scanResultsList.ForeColor = DarkTheme.Text;
        // ManaGgufFile doesn't override ToString() -- without this, the
        // list would show "Mana.NativeLauncher.ManaGgufFile" for every
        // row instead of a usable path.
        scanResultsList.DisplayMember = nameof(ManaGgufFile.Path);

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
        group.Controls.Add(stack);
        return group;
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
    }
}

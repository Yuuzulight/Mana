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
    private readonly ListView presetsList = new();
    private bool populatingPlugins;

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
        tabs.TabPages.Add(BuildPresetsTab());
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
        await RefreshPresetsAsync();
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

        var page = new TabPage("Presets");
        page.Controls.Add(presetsList);
        page.Controls.Add(buttonRow);
        return page;
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
    }
}

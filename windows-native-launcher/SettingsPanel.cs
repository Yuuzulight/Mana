using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #529/#565: a lean settings surface -- connection (backend URL + admin
// token), plugins (enable/disable), memory facts (view/archive), skills
// (view/delete), and the approval-gate queue (approve/deny). Explicitly
// the lowest-priority piece of the
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
    private readonly ListView mobileDevicesList = new();
    private readonly ListView accountsList = new();
    private readonly ListView mcpServersList = new();
    private readonly ListView hooksList = new();
    private bool populatingPlugins;
    private bool populatingHooks;

    public SettingsPanel(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;
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
        tabs.TabPages.Add(BuildMobileDevicesTab());
        tabs.TabPages.Add(BuildAccountsTab());
        tabs.TabPages.Add(BuildMcpServersTab());
        tabs.TabPages.Add(BuildHooksTab());
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
        await RefreshMobileDevicesAsync();
        await RefreshAccountsAsync();
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

            settings.BackendBaseUrl = url;
            settings.AdminToken = string.IsNullOrWhiteSpace(tokenBox.Text) ? null : tokenBox.Text.Trim();
            settings.Save();
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

        return new TabPage("Connection") { Controls = { layout } };
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

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #699: Settings > Heartbeat -- heartbeat.md's checks (GET/PUT
// /heartbeat/items). Each change saves the whole list; node-bot checks it
// and refuses a bad one (nothing is written then). A new or edited check
// still does its dry run and waits in Approvals before it runs for real.
internal sealed class HeartbeatPanel : FlowLayoutPanel
{
    private readonly ManaBackendClient backendClient;
    private List<ManaHeartbeatItem> items = [];
    private readonly Label status = new() { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };

    internal ListBox Checks { get; } = new() { Width = 560, Height = 200, AccessibleName = "Heartbeat checks", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal TextBox EditText { get; } = new() { Width = 560, PlaceholderText = "warn me if D: drops below 50 GB", AccessibleName = "Check", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal TextBox EditSchedule { get; } = new() { Width = 120, PlaceholderText = "every 30m", AccessibleName = "How often (every 30m, every 2h, daily 09:00)", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal CheckBox Write { get; } = NewCheckBox("Write");
    internal CheckBox Network { get; } = NewCheckBox("Network");
    internal CheckBox Urgent { get; } = NewCheckBox("Urgent");
    internal CheckBox On { get; } = NewCheckBox("On");
    internal string StatusText => status.Text;

    // loadNow: false in tests, which call ReloadAsync themselves.
    public HeartbeatPanel(ManaBackendClient backendClient, bool loadNow = true)
    {
        this.backendClient = backendClient;
        Dock = DockStyle.Fill;
        FlowDirection = FlowDirection.TopDown;
        WrapContents = false;
        AutoScroll = true;
        BackColor = DarkTheme.Background;
        On.Checked = true;

        Button NewButton(string text, Func<Task> click)
        {
            var button = new Button { Text = text, AutoSize = true };
            DarkTheme.ApplyButton(button);
            button.Click += async (_, _) => await click();
            return button;
        }
        FlowLayoutPanel Row(params Control[] controls)
        {
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
            row.Controls.AddRange(controls);
            return row;
        }

        Checks.SelectedIndexChanged += (_, _) => ShowSelected();
        Controls.Add(new Label
        {
            Text = "Checks Mana runs quietly in the background; she only speaks up when one needs you. Read is always allowed; Write and Network only reach the folders and sites a check names. Urgent skips the daily budget.",
            AutoSize = true,
            MaximumSize = new System.Drawing.Size(560, 0),
            ForeColor = DarkTheme.Text,
        });
        Controls.Add(Row(NewButton("Refresh", ReloadAsync)));
        Controls.Add(Checks);
        Controls.Add(EditText);
        Controls.Add(Row(EditSchedule, Write, Network, Urgent, On));
        Controls.Add(Row(NewButton("Add", AddAsync), NewButton("Save", SaveSelectedAsync), NewButton("Remove", RemoveSelectedAsync), status));
        if (loadNow)
        {
            _ = ReloadAsync();
        }
    }

    private static CheckBox NewCheckBox(string text) => new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Text, Margin = new Padding(6, 4, 3, 3) };

    private int SelectedIndex => Checks.SelectedIndex >= 0 && Checks.SelectedIndex < items.Count ? Checks.SelectedIndex : -1;

    internal static string Display(ManaHeartbeatItem item)
    {
        var tags = item.Permissions.Concat(item.Urgent ? new[] { "urgent" } : Array.Empty<string>()).ToList();
        return $"{(item.Enabled ? "" : "(off) ")}{item.Schedule}{(tags.Count > 0 ? $" [{string.Join(", ", tags)}]" : "")}: {item.Text}";
    }

    internal async Task ReloadAsync()
    {
        try
        {
            ShowItems(await backendClient.GetHeartbeatItemsAsync());
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't load: {BackendError.Describe(ex)}";
        }
    }

    private void ShowItems(IReadOnlyList<ManaHeartbeatItem> list)
    {
        items = list.ToList();
        Checks.Items.Clear();
        Checks.Items.AddRange(items.Select(i => (object)Display(i)).ToArray());
        ShowSelected();
    }

    private void ShowSelected()
    {
        var item = SelectedIndex >= 0 ? items[SelectedIndex] : null;
        EditText.Text = item?.Text ?? "";
        EditSchedule.Text = item?.Schedule ?? "";
        Write.Checked = item?.Permissions.Contains("write") ?? false;
        Network.Checked = item?.Permissions.Contains("network") ?? false;
        Urgent.Checked = item?.Urgent ?? false;
        On.Checked = item?.Enabled ?? true;
    }

    private ManaHeartbeatItem FromEditor() => new()
    {
        Text = EditText.Text.Trim(),
        Schedule = EditSchedule.Text.Trim(),
        Permissions = [.. new[] { Write.Checked ? "write" : null, Network.Checked ? "network" : null }.OfType<string>()],
        Urgent = Urgent.Checked,
        Enabled = On.Checked,
    };

    internal Task AddAsync() => SaveAsync([.. items, FromEditor()], "Added. It does a dry run and waits in Approvals first.");

    internal Task SaveSelectedAsync()
    {
        var index = SelectedIndex;
        if (index < 0)
        {
            return Task.CompletedTask;
        }
        var next = items.ToList();
        next[index] = FromEditor();
        return SaveAsync(next, "Saved.");
    }

    internal Task RemoveSelectedAsync()
    {
        var index = SelectedIndex;
        if (index < 0)
        {
            return Task.CompletedTask;
        }
        var next = items.ToList();
        next.RemoveAt(index);
        return SaveAsync(next, "Removed.");
    }

    private async Task SaveAsync(List<ManaHeartbeatItem> next, string done)
    {
        try
        {
            ShowItems(await backendClient.SaveHeartbeatItemsAsync(next));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't save: {ex.Message}";
            return;
        }
        status.Text = done;
    }
}

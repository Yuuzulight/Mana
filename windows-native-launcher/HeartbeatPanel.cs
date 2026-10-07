using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #699: Settings > Check-ins' background checks -- heartbeat.md's checks (GET/PUT
// /heartbeat/items). Each change saves the whole list; node-bot checks it
// and refuses a bad one (nothing is written then). A new or edited check
// still does its dry run and waits in Approvals before it runs for real.
internal sealed class HeartbeatPanel : System.ComponentModel.Component
{
    private readonly ManaBackendClient backendClient;
    private List<ManaHeartbeatItem> items = [];
    private readonly Label status = SettingsRows.Status();

    internal ListBox Checks { get; } = SettingsRows.List("Heartbeat checks", 120);
    internal TextBox EditText { get; } = SettingsRows.Box("Check", 340, "warn me if D: drops below 50 GB");
    internal TextBox EditSchedule { get; } = SettingsRows.Box("How often (every 30m, every 2h, daily 09:00)", 90, "every 30m");
    internal CheckBox Write { get; } = NewCheckBox("Write");
    internal CheckBox Network { get; } = NewCheckBox("Network");
    internal CheckBox Urgent { get; } = NewCheckBox("Urgent");
    internal CheckBox On { get; } = NewCheckBox("On");
    internal string StatusText => status.Text;

    // #1426: its row on the Check-ins page, and a line on what the boxes mean.
    internal Control[] Rows { get; }

    // loadNow: false in tests and Settings, which call ReloadAsync themselves.
    public HeartbeatPanel(ManaBackendClient backendClient, bool loadNow = true)
    {
        this.backendClient = backendClient;
        On.Checked = true;
        Button NewButton(string text, Func<Task> click) => SettingsRows.Action(text, () => _ = click());

        Checks.SelectedIndexChanged += (_, _) => ShowSelected();
        Rows = new Control[]
        {
            new SettingsRow("Background checks", "Things she keeps an eye on quietly, speaking up only when one needs you. A new or changed check does a dry run and waits for your OK first", "heartbeat background checks monitor watch",
                SettingsRows.Stack(
                    Checks,
                    SettingsRows.Line(EditText),
                    SettingsRows.Line(EditSchedule, Write, Network, Urgent, On),
                    SettingsRows.Line(NewButton("Add", AddAsync), NewButton("Save", SaveSelectedAsync), NewButton("Remove", RemoveSelectedAsync), status))),
            SettingsRows.Note("Write and Network let a check change only the folders and reach only the sites it names. Urgent ones skip the daily limit on remarks."),
        };
        if (loadNow)
        {
            _ = ReloadAsync();
        }
    }

    private static CheckBox NewCheckBox(string text) => new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Text, BackColor = System.Drawing.Color.Transparent, Margin = new Padding(6, 4, 3, 3) };

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

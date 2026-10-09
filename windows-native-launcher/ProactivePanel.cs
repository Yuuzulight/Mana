using System;
using System.ComponentModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #697: Settings > Check-ins' "Speaking up" rows -- call/media audio
// awareness, quiet hours, snoozing ("not now"), what Mana has learned and
// muted kinds ("never"). #1426: rows on the Check-ins page, saved as
// they're changed; changed reports each one for Undo.
internal sealed class ProactivePanel : Component
{
    private readonly ManaBackendClient backendClient;
    private readonly Action<string, Action>? changed;
    private ManaProactiveSettings? currentSettings;
    private bool populating;
    private readonly Label status = SettingsRows.Status();
    private readonly SettingsRow snoozeRow;

    internal SettingsSwitch HoldSpeechCheck { get; } = new() { AccessibleName = "Hold speech during calls" };
    internal SettingsSwitch QuietHoursCheck { get; } = new() { AccessibleName = "Quiet hours" };
    internal TextBox QuietStartBox { get; } = SettingsRows.Box("Quiet hours start", 60, "01:00");
    internal TextBox QuietEndBox { get; } = SettingsRows.Box("Quiet hours end", 60, "09:00");
    internal Label QuietStatusLabel { get; } = SettingsRows.Status();
    internal Label SnoozeStatusLabel => snoozeRow.Explanation!;
    internal RowList LearnedList { get; } = new() { MaxVisibleRows = 5, NameWidth = 160, AccessibleName = "What Mana has learned" };
    internal RowList MutedList { get; } = new() { MaxVisibleRows = 4, NameWidth = 160, AccessibleName = "Muted remark kinds" };

    internal string StatusText => status.Text;

    internal Control[] Rows { get; }

    public ProactivePanel(ManaBackendClient backendClient, bool loadNow = true, Action<string, Action>? changed = null)
    {
        this.backendClient = backendClient;
        this.changed = changed;

        HoldSpeechCheck.Checked = ManaSettingsStore.Load().HoldSpeechDuringAudio;
        HoldSpeechCheck.CheckedChanged += (_, _) =>
        {
            var store = ManaSettingsStore.Load();
            store.HoldSpeechDuringAudio = HoldSpeechCheck.Checked;
            store.Save();
            changed?.Invoke($"Hold speech during calls {(HoldSpeechCheck.Checked ? "on" : "off")}", () => HoldSpeechCheck.Checked = !HoldSpeechCheck.Checked);
        };

        // Quiet hours save as the switch flips or a time box is left changed.
        QuietHoursCheck.CheckedChanged += (_, _) =>
        {
            if (populating)
            {
                return;
            }
            _ = SaveQuietHoursAsync();
            changed?.Invoke($"Quiet hours {(QuietHoursCheck.Checked ? "on" : "off")}", () => QuietHoursCheck.Checked = !QuietHoursCheck.Checked);
        };
        foreach (var box in new[] { QuietStartBox, QuietEndBox })
        {
            box.Leave += (_, _) =>
            {
                if (currentSettings is { } now && (QuietStartBox.Text.Trim() != now.QuietHours.Start || QuietEndBox.Text.Trim() != now.QuietHours.End))
                {
                    _ = SaveQuietHoursAsync();
                }
            };
        }

        Button NewButton(string text, Func<Task> click) => SettingsRows.Action(text, () => _ = click());
        snoozeRow = new SettingsRow("Snooze", "Pause her remarks for a while", "snooze not now pause quiet",
            NewButton("1 hour", () => SnoozeAsync(60)),
            NewButton("2 hours", () => SnoozeAsync(120)),
            NewButton("4 hours", () => SnoozeAsync(240)),
            NewButton("Resume", () => SnoozeAsync(0)));

        LearnedList.ActionsFor = value => value is string reason
            ? [new("\uE72C", "Reset", () => UpdateAsync(new { resetReason = reason }, $"Reset what she learned about {reason}"))]
            : [];
        MutedList.ActionsFor = value => value is string kind ? [new("\uE767", "Unmute", () => UpdateAsync(new { unmute = kind }, $"Unmuted {kind}"))] : [];

        Rows = new Control[]
        {
            new SettingsRow("Hold speech during calls", "While another app uses the mic or plays audio, remarks come as quiet toasts and she speaks once it's free", "call media audio meeting",
                HoldSpeechCheck),
            new SettingsRow("Quiet hours", "She keeps remarks to herself between these times", "quiet hours night sleep do not disturb",
                QuietStatusLabel, SettingsRows.Words("From"), QuietStartBox, SettingsRows.Words("to"), QuietEndBox, QuietHoursCheck),
            snoozeRow,
            new SettingsRow("What she's learned", "How each kind of remark went down. Disliked ones wait for a better moment. Pick one to reset it", "learned reactions scores",
                below: true, SettingsRows.RoundPanel(LearnedList), SettingsRows.Line(NewButton("Reset all", ResetAllLearnedAsync))),
            new SettingsRow("Muted remarks", "Kinds you told her not to bring up again. Pick one to unmute it", "muted never",
                below: true, SettingsRows.RoundPanel(MutedList)),
            status,
        };

        if (loadNow)
        {
            _ = ReloadAsync();
        }
    }

    internal async Task ReloadAsync()
    {
        try
        {
            currentSettings = await backendClient.GetProactiveSettingsAsync();
            PopulateUi(currentSettings);
            status.Text = "";
        }
        catch (Exception ex)
        {
            status.Text = $"Couldn't load these: {BackendError.Describe(ex)}";
        }
    }

    internal void PopulateUi(ManaProactiveSettings settings)
    {
        currentSettings = settings;
        populating = true;
        try
        {
            QuietHoursCheck.Checked = settings.QuietHours.Enabled;
        }
        finally
        {
            populating = false;
        }
        QuietStartBox.Text = settings.QuietHours.Start;
        QuietEndBox.Text = settings.QuietHours.End;
        QuietStatusLabel.Text = settings.InQuietHours ? "Quiet now" : "";

        SnoozeStatusLabel.Text = settings.SnoozedUntil is { } until && until > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            ? $"Snoozed until {DateTimeOffset.FromUnixTimeMilliseconds(until).ToLocalTime():HH:mm, d MMM}"
            : "Pause her remarks for a while";

        LearnedList.ShowEntries(settings.Learned.OrderBy(kv => kv.Key).Select(kv => new RowList.Entry(kv.Key, kv.Key,
                kv.Value.Score > 0.1 ? "Welcomed" : kv.Value.Score < -0.1 ? "Disliked" : "Neutral", $"{kv.Value.Score:+0.00;-0.00;0.00}")),
            null, "Nothing learned yet");
        MutedList.ShowEntries(settings.Muted.OrderBy(m => m).Select(m => new RowList.Entry(m, m, "")), null, "None muted");
    }

    // One change to the backend, then what it says now.
    private async Task UpdateAsync(object change, string done)
    {
        try
        {
            PopulateUi(await backendClient.UpdateProactiveSettingsAsync(change));
            status.Text = done;
        }
        catch (Exception ex)
        {
            status.Text = $"Couldn't save: {BackendError.Describe(ex)}";
        }
    }

    private Task SaveQuietHoursAsync() => UpdateAsync(new
    {
        quietHours = new
        {
            enabled = QuietHoursCheck.Checked,
            start = QuietStartBox.Text.Trim(),
            end = QuietEndBox.Text.Trim(),
        },
    }, "");

    private Task SnoozeAsync(int minutes) => UpdateAsync(new { snoozeMinutes = minutes }, minutes > 0 ? $"Snoozed for {minutes / 60} hour{(minutes == 60 ? "" : "s")}" : "Remarks back on");

    private Task ResetAllLearnedAsync() => UpdateAsync(new { resetAllLearned = true }, "Reset everything she learned");
}

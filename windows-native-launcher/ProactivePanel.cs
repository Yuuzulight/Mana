using System;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #697: Settings > Proactive -- reasons to speak up, call/media audio awareness,
// quiet hours, snoozing ("not now"), muted kinds ("never"), and what Mana has learned.
internal sealed class ProactivePanel : FlowLayoutPanel
{
    private readonly ManaBackendClient backendClient;
    private ManaProactiveSettings? currentSettings;
    private readonly Label status = new() { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };

    internal CheckBox HoldSpeechCheck { get; } = NewCheckBox("Hold speech during calls or media playback");
    internal CheckBox QuietHoursCheck { get; } = NewCheckBox("Enable quiet hours window");
    internal TextBox QuietStartBox { get; } = new() { Width = 80, PlaceholderText = "01:00", AccessibleName = "Quiet hours start", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal TextBox QuietEndBox { get; } = new() { Width = 80, PlaceholderText = "09:00", AccessibleName = "Quiet hours end", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal Label QuietStatusLabel { get; } = new() { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
    internal Label SnoozeStatusLabel { get; } = new() { AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left };
    internal ListBox LearnedList { get; } = new() { Width = 560, Height = 140, AccessibleName = "What Mana has learned", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal ListBox MutedList { get; } = new() { Width = 560, Height = 80, AccessibleName = "Muted remark kinds", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };

    internal string StatusText => status.Text;

    public ProactivePanel(ManaBackendClient backendClient, bool loadNow = true)
    {
        this.backendClient = backendClient;
        Dock = DockStyle.Fill;
        FlowDirection = FlowDirection.TopDown;
        WrapContents = false;
        AutoScroll = true;
        BackColor = DarkTheme.Background;
        ForeColor = DarkTheme.Text;

        Button NewButton(string text, Func<Task> click)
        {
            var button = new Button { Text = text, AutoSize = true };
            DarkTheme.ApplyButton(button);
            button.Click += async (_, _) => await click();
            return button;
        }

        FlowLayoutPanel Row(params Control[] controls)
        {
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background, Margin = new Padding(0, 2, 0, 4) };
            row.Controls.AddRange(controls);
            return row;
        }

        Label SectionHeader(string title) => new()
        {
            Text = title,
            Font = new Font(Font, FontStyle.Bold),
            ForeColor = DarkTheme.Text,
            AutoSize = true,
            Margin = new Padding(0, 10, 0, 4)
        };

        // Header
        Controls.Add(new Label
        {
            Text = "Mana speaks up unprompted as a companion. Remarks wait for a good moment, adapt to your reactions, and respect games, calls, and quiet hours.",
            AutoSize = true,
            MaximumSize = new Size(560, 0),
            ForeColor = DarkTheme.Muted,
            Margin = new Padding(0, 0, 0, 8)
        });

        // 1. Audio & media awareness
        Controls.Add(SectionHeader("Call and Media Awareness"));
        HoldSpeechCheck.Checked = ManaSettingsStore.Load().HoldSpeechDuringAudio;
        HoldSpeechCheck.CheckedChanged += (_, _) =>
        {
            var store = ManaSettingsStore.Load();
            store.HoldSpeechDuringAudio = HoldSpeechCheck.Checked;
            store.Save();
        };
        Controls.Add(HoldSpeechCheck);
        Controls.Add(new Label
        {
            Text = "When another app is using the microphone or playing audio, remarks arrive as quiet toasts and spoken voice waits until audio is free.",
            AutoSize = true,
            MaximumSize = new Size(560, 0),
            ForeColor = DarkTheme.Muted,
            Margin = new Padding(22, 0, 0, 8)
        });

        // 2. Quiet hours
        Controls.Add(SectionHeader("Quiet Hours"));
        Controls.Add(Row(QuietHoursCheck, new Label { Text = "From:", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(12, 6, 4, 0) }, QuietStartBox, new Label { Text = "To:", AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(8, 6, 4, 0) }, QuietEndBox, NewButton("Save window", SaveQuietHoursAsync), QuietStatusLabel));

        // 3. Snooze ("Not now")
        Controls.Add(SectionHeader("Snooze ('Not now')"));
        Controls.Add(Row(SnoozeStatusLabel));
        Controls.Add(Row(
            NewButton("Snooze 1h", () => SnoozeAsync(60)),
            NewButton("Snooze 2h", () => SnoozeAsync(120)),
            NewButton("Snooze 4h", () => SnoozeAsync(240)),
            NewButton("Resume now", () => SnoozeAsync(0))
        ));

        // 4. What Mana has learned
        Controls.Add(SectionHeader("What Mana Has Learned"));
        Controls.Add(new Label
        {
            Text = "Each remark kind adapts its score (-1 disliked to +1 liked). Lower scores raise the threshold (up to 2x) before speaking:",
            AutoSize = true,
            MaximumSize = new Size(560, 0),
            ForeColor = DarkTheme.Muted,
            Margin = new Padding(0, 0, 0, 4)
        });
        Controls.Add(LearnedList);
        Controls.Add(Row(
            NewButton("Reset selected kind", ResetSelectedLearnedAsync),
            NewButton("Reset all learned", ResetAllLearnedAsync)
        ));

        // 5. Muted kinds ("Never for this kind")
        Controls.Add(SectionHeader("Muted Remarks ('Don't bring this up again')"));
        Controls.Add(MutedList);
        Controls.Add(Row(NewButton("Unmute selected kind", UnmuteSelectedAsync)));

        // 6. Refresh and status
        Controls.Add(Row(NewButton("Refresh", ReloadAsync), status));

        if (loadNow)
        {
            _ = ReloadAsync();
        }
    }

    private static CheckBox NewCheckBox(string text) => new()
    {
        Text = text,
        AutoSize = true,
        ForeColor = DarkTheme.Text,
        Margin = new Padding(0, 4, 0, 4)
    };

    internal async Task ReloadAsync()
    {
        try
        {
            status.Text = "Loading...";
            currentSettings = await backendClient.GetProactiveSettingsAsync();
            PopulateUi(currentSettings);
            status.Text = "";
        }
        catch (Exception ex)
        {
            status.Text = $"Couldn't load proactive settings: {ex.Message}";
        }
    }

    internal void PopulateUi(ManaProactiveSettings settings)
    {
        currentSettings = settings;

        // Quiet hours
        QuietHoursCheck.Checked = settings.QuietHours.Enabled;
        QuietStartBox.Text = settings.QuietHours.Start;
        QuietEndBox.Text = settings.QuietHours.End;
        QuietStatusLabel.Text = settings.InQuietHours ? "(quiet hours active right now)" : "";

        // Snooze
        if (settings.SnoozedUntil is { } until && until > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
        {
            var remaining = DateTimeOffset.FromUnixTimeMilliseconds(until).ToLocalTime();
            SnoozeStatusLabel.Text = $"Remarks snoozed until {remaining:HH:mm} ({remaining:d MMM})";
        }
        else
        {
            SnoozeStatusLabel.Text = "Remarks are active (not snoozed).";
        }

        // Learned
        LearnedList.Items.Clear();
        if (settings.Learned.Count == 0)
        {
            LearnedList.Items.Add("(No learned reactions yet)");
        }
        else
        {
            foreach (var (reason, info) in settings.Learned.OrderBy(kv => kv.Key))
            {
                var sentiment = info.Score > 0.1 ? "Welcomed" : info.Score < -0.1 ? "Disliked" : "Neutral";
                LearnedList.Items.Add($"{reason}: score {info.Score:+0.00;-0.00;0.00} ({info.Multiplier:0.00}x bar) - {sentiment}");
            }
        }

        // Muted
        MutedList.Items.Clear();
        if (settings.Muted.Count == 0)
        {
            MutedList.Items.Add("(No muted kinds)");
        }
        else
        {
            foreach (var muted in settings.Muted.OrderBy(m => m))
            {
                MutedList.Items.Add(muted);
            }
        }
    }

    private async Task SaveQuietHoursAsync()
    {
        try
        {
            status.Text = "Saving quiet hours...";
            var updated = await backendClient.UpdateProactiveSettingsAsync(new
            {
                quietHours = new
                {
                    enabled = QuietHoursCheck.Checked,
                    start = QuietStartBox.Text.Trim(),
                    end = QuietEndBox.Text.Trim()
                }
            });
            PopulateUi(updated);
            status.Text = "Quiet hours saved.";
        }
        catch (Exception ex)
        {
            status.Text = $"Couldn't save quiet hours: {ex.Message}";
        }
    }

    private async Task SnoozeAsync(int minutes)
    {
        try
        {
            status.Text = minutes > 0 ? $"Snoozing for {minutes}m..." : "Resuming remarks...";
            var updated = await backendClient.UpdateProactiveSettingsAsync(new { snoozeMinutes = minutes });
            PopulateUi(updated);
            status.Text = minutes > 0 ? $"Snoozed for {minutes} minutes." : "Remarks resumed.";
        }
        catch (Exception ex)
        {
            status.Text = $"Couldn't update snooze: {ex.Message}";
        }
    }

    private async Task ResetSelectedLearnedAsync()
    {
        var item = LearnedList.SelectedItem as string;
        if (string.IsNullOrWhiteSpace(item) || item.StartsWith("("))
        {
            status.Text = "Select a learned kind to reset.";
            return;
        }

        var reason = item.Split(':')[0].Trim();
        try
        {
            status.Text = $"Resetting {reason}...";
            var updated = await backendClient.UpdateProactiveSettingsAsync(new { resetReason = reason });
            PopulateUi(updated);
            status.Text = $"Reset learned score for '{reason}'.";
        }
        catch (Exception ex)
        {
            status.Text = $"Couldn't reset '{reason}': {ex.Message}";
        }
    }

    private async Task ResetAllLearnedAsync()
    {
        try
        {
            status.Text = "Resetting all learned reactions...";
            var updated = await backendClient.UpdateProactiveSettingsAsync(new { resetAllLearned = true });
            PopulateUi(updated);
            status.Text = "Reset all learned reactions.";
        }
        catch (Exception ex)
        {
            status.Text = $"Couldn't reset learned reactions: {ex.Message}";
        }
    }

    private async Task UnmuteSelectedAsync()
    {
        var item = MutedList.SelectedItem as string;
        if (string.IsNullOrWhiteSpace(item) || item.StartsWith("("))
        {
            status.Text = "Select a muted kind to unmute.";
            return;
        }

        try
        {
            status.Text = $"Unmuting {item}...";
            var updated = await backendClient.UpdateProactiveSettingsAsync(new { unmute = item });
            PopulateUi(updated);
            status.Text = $"Unmuted '{item}'.";
        }
        catch (Exception ex)
        {
            status.Text = $"Couldn't unmute '{item}': {ex.Message}";
        }
    }
}

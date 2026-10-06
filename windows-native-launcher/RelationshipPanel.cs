using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #914: Settings > Characters -- each character's own relationship notes
// and milestones (GET /characters/relationships), edited or removed one at
// a time. She adds them herself in chat (each shows there with an Undo);
// this is where I look them over later.
internal sealed class RelationshipPanel : FlowLayoutPanel
{
    private readonly ManaBackendClient backendClient;
    private IReadOnlyList<ManaCharacterRelationship> relationships = [];
    private readonly List<ManaRelationshipItem> shown = [];
    private readonly Label status = new() { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };

    internal ComboBox Characters { get; } = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 240, AccessibleName = "Character", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text };
    internal ListBox Items { get; } = new() { Width = 560, Height = 200, AccessibleName = "Notes and milestones", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal TextBox EditText { get; } = new() { Width = 420, PlaceholderText = "Note or milestone", AccessibleName = "Text", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal TextBox EditDate { get; } = new() { Width = 110, PlaceholderText = "YYYY-MM-DD", AccessibleName = "Milestone date", BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
    internal string StatusText => status.Text;
    // Part of #700: the active character's mood, in words only.
    private readonly Label mood = new() { AutoSize = true, ForeColor = DarkTheme.Muted };
    internal string MoodText => mood.Text;

    // loadNow: false in tests, which call ReloadAsync themselves.
    public RelationshipPanel(ManaBackendClient backendClient, bool loadNow = true)
    {
        this.backendClient = backendClient;
        Dock = DockStyle.Fill;
        FlowDirection = FlowDirection.TopDown;
        WrapContents = false;
        AutoScroll = true;
        BackColor = DarkTheme.Background;

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

        Characters.SelectedIndexChanged += (_, _) => ShowItems();
        Items.SelectedIndexChanged += (_, _) =>
        {
            var item = Selected;
            EditText.Text = item?.Text ?? "";
            EditDate.Text = item?.Date ?? "";
            EditDate.Enabled = item?.Kind == "milestones";
        };
        Controls.Add(new Label
        {
            Text = "What each character remembers about the two of you: her notes, and dated milestones she brings up now and then. Facts about you are shared and live under Memory Facts.",
            AutoSize = true,
            MaximumSize = new System.Drawing.Size(560, 0),
            ForeColor = DarkTheme.Text,
        });
        Controls.Add(mood);
        Controls.Add(Row(Characters, NewButton("Refresh", ReloadAsync)));
        Controls.Add(Items);
        Controls.Add(Row(EditText, EditDate));
        Controls.Add(Row(NewButton("Save", SaveSelectedAsync), NewButton("Remove", RemoveSelectedAsync), status));
        if (loadNow)
        {
            _ = ReloadAsync();
        }
    }

    private ManaRelationshipItem? Selected => Items.SelectedIndex >= 0 && Items.SelectedIndex < shown.Count ? shown[Items.SelectedIndex] : null;
    private ManaCharacterRelationship? Character => Characters.SelectedIndex >= 0 && Characters.SelectedIndex < relationships.Count ? relationships[Characters.SelectedIndex] : null;

    internal static string Display(ManaRelationshipItem item) =>
        item.Kind == "milestones" ? $"Milestone {item.Date}: {item.Text}" : $"Note: {item.Text}";

    internal async Task ReloadAsync()
    {
        var keep = Character?.Id;
        try
        {
            relationships = await backendClient.GetRelationshipsAsync();
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't load: {BackendError.Describe(ex)}";
            return;
        }
        Characters.Items.Clear();
        Characters.Items.AddRange(relationships.Select(r => (object)r.Name).ToArray());
        var index = relationships.ToList().FindIndex(r => r.Id == keep);
        Characters.SelectedIndex = relationships.Count == 0 ? -1 : Math.Max(index, 0);
        ShowItems();
        try
        {
            mood.Text = $"Right now she's feeling {(await backendClient.GetMoodAsync()).Summary}.";
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            mood.Text = ""; // an older node-bot without /mood: just no line
        }
    }

    private void ShowItems()
    {
        shown.Clear();
        Items.Items.Clear();
        if (Character is { } character)
        {
            shown.AddRange(character.Notes.Concat(character.Milestones));
            Items.Items.AddRange(shown.Select(i => (object)Display(i)).ToArray());
        }
        EditText.Text = "";
        EditDate.Text = "";
    }

    internal async Task SaveSelectedAsync()
    {
        if (Character is not { } character || Selected is not { } item)
        {
            return;
        }
        await Change(() => backendClient.UpdateRelationshipItemAsync(character.Id, item.Kind, item.Id, EditText.Text.Trim(), item.Kind == "milestones" ? EditDate.Text.Trim() : null), "Saved.");
    }

    internal async Task RemoveSelectedAsync()
    {
        if (Character is not { } character || Selected is not { } item)
        {
            return;
        }
        await Change(() => backendClient.RemoveRelationshipItemAsync(character.Id, item.Kind, item.Id), "Removed.");
    }

    private async Task Change(Func<Task> change, string done)
    {
        try
        {
            await change();
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't save: {ex.Message}";
            return;
        }
        await ReloadAsync();
        status.Text = done;
    }
}

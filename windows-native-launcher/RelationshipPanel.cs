using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #914: Settings > Memory's notes and milestones -- each character's own relationship notes
// and milestones (GET /characters/relationships), edited or removed one at
// a time. She adds them herself in chat (each shows there with an Undo);
// this is where I look them over later.
internal sealed class RelationshipPanel : System.ComponentModel.Component
{
    private readonly ManaBackendClient backendClient;
    private IReadOnlyList<ManaCharacterRelationship> relationships = [];
    private readonly Label status = SettingsRows.Status();

    internal ComboBox Characters { get; } = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200, AccessibleName = "Character", BackColor = DarkTheme.Panel, ForeColor = DarkTheme.Text };
    internal RowList Items { get; } = new() { Height = 130, NameWidth = 90, AccessibleName = "Notes and milestones" };
    internal TextBox EditText { get; } = SettingsRows.Box("Text", 340, "Note or milestone");
    internal TextBox EditDate { get; } = SettingsRows.Box("Milestone date", 100, "YYYY-MM-DD");
    internal string StatusText => status.Text;
    // Part of #700: the active character's mood, in words only.
    private readonly Label mood = SettingsRows.Words("");
    internal string MoodText => mood.Text;

    // #1426: its row on the Memory page.
    internal Control[] Rows { get; }

    // loadNow: false in tests and Settings, which call ReloadAsync themselves.
    public RelationshipPanel(ManaBackendClient backendClient, bool loadNow = true)
    {
        this.backendClient = backendClient;
        Button NewButton(string text, Func<Task> click) => SettingsRows.Action(text, () => _ = click());

        Characters.SelectedIndexChanged += (_, _) => ShowItems();
        Items.ActionsFor = _ => [new("", "Remove", RemoveSelectedAsync)];
        Items.SelectedIndexChanged += (_, _) =>
        {
            var item = Selected;
            EditText.Text = item?.Text ?? "";
            EditDate.Text = item?.Date ?? "";
            EditDate.Enabled = item?.Kind == "milestones";
        };
        Rows = new Control[]
        {
            new SettingsRow("Notes and milestones", "What each character remembers about the two of you, and dates she brings up now and then", "relationship notes milestones persona evil mana mood",
                below: true,
                SettingsRows.Line(Characters, mood),
                SettingsRows.RoundPanel(Items),
                SettingsRows.Line(EditText, EditDate, NewButton("Save", SaveSelectedAsync), status)),
        };
        if (loadNow)
        {
            _ = ReloadAsync();
        }
    }

    private ManaRelationshipItem? Selected => Items.SelectedItems.Count > 0 ? Items.SelectedItems[0].Tag as ManaRelationshipItem : null;
    private ManaCharacterRelationship? Character => Characters.SelectedIndex >= 0 && Characters.SelectedIndex < relationships.Count ? relationships[Characters.SelectedIndex] : null;


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
        var shown = Character is { } character ? character.Notes.Concat(character.Milestones) : [];
        Items.ShowEntries(shown.Select(i => i.Kind == "milestones"
            ? new RowList.Entry(i, "Milestone", i.Text, i.Date ?? "")
            : new RowList.Entry(i, "Note", i.Text)), null, "Nothing yet");
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

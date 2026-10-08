using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1426: Settings > Memory's characters, laid out like Hermes Desktop's
// profiles. A card per character: a letter avatar, her name, whether she's
// talking now, built in or yours, the start of her prompt, her voice and how
// many notes she keeps about you. Every card has an edit pencil; the others
// have "Switch to her", which plays her handoff line. "+ Add character" and
// the pencil open her editor in place of the cards.
internal sealed class CharactersPanel : Component
{
    internal const int MaxPromptChars = 4000; // node-bot's MAX_PERSONA_CHARS

    private readonly ManaBackendClient backendClient;
    private readonly Func<string, Task>? switchTo;
    private readonly TableLayoutPanel host = new() { ColumnCount = 1, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, BackColor = Color.Transparent, Margin = Padding.Empty };
    private readonly Label status = SettingsRows.Status();
    private IReadOnlyList<ManaCharacterProfile> profiles = [];
    private string active = "mana";
    private Dictionary<string, int> noteCounts = new();

    // Something about the characters changed: who's active, or who exists.
    public event Action? Changed;

    internal Control[] Rows { get; }
    internal CharacterEditor? Editor { get; private set; } // tests
    internal IEnumerable<CharacterCard> Cards => host.Controls.OfType<TableLayoutPanel>().SelectMany(t => t.Controls.OfType<CharacterCard>()); // tests
    internal string StatusText => status.Text;

    // switchTo: the launcher's switch, which also speaks her handoff line.
    public CharactersPanel(ManaBackendClient backendClient, Func<string, Task>? switchTo = null)
    {
        this.backendClient = backendClient;
        this.switchTo = switchTo;
        host.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Rows = new Control[]
        {
            new SettingsRow("Profiles", "Facts about you are shared; each character keeps her own notes, mood, voice and milestones", "character persona prompt evil mana add new voice avatar live2d",
                below: true, host, status),
        };
        ShowCards();
    }

    internal async Task ReloadAsync()
    {
        try
        {
            (active, profiles) = await backendClient.GetCharacterProfilesAsync();
            status.Text = "";
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't load the characters: {BackendError.Describe(ex)}";
            return;
        }
        try
        {
            noteCounts = (await backendClient.GetRelationshipsAsync()).ToDictionary(r => r.Id, r => r.Notes.Count + r.Milestones.Count);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            noteCounts = new(); // the cards just leave the count out
        }
        if (Editor is null)
        {
            ShowCards();
        }
    }

    private void Show(Control content)
    {
        host.SuspendLayout();
        foreach (var old in host.Controls.Cast<Control>().ToList())
        {
            old.Dispose();
        }
        content.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        host.Controls.Add(content, 0, 0);
        host.ResumeLayout();
    }

    // Two cards a row, then "+ Add character".
    private void ShowCards()
    {
        Editor = null;
        var grid = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, BackColor = Color.Transparent, Margin = Padding.Empty };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        foreach (var profile in profiles.OrderByDescending(p => p.Id == active))
        {
            var card = new CharacterCard(profile, profile.Id == active, noteCounts.GetValueOrDefault(profile.Id, -1)) { Anchor = AnchorStyles.Left | AnchorStyles.Right };
            card.EditClicked += () => ShowEditor(profile);
            card.SwitchClicked += () => _ = SwitchAsync(profile.Id);
            grid.Controls.Add(card);
        }
        var add = (SettingsButton)SettingsRows.Action("+ Add character", () => ShowEditor(null));
        add.Dashed = true;
        add.AutoSize = false;
        add.Height = CharacterCard.CardHeight;
        add.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        add.Margin = new Padding(0, 0, 8, 8);
        grid.Controls.Add(add);
        Show(grid);
    }

    private void ShowEditor(ManaCharacterProfile? profile)
    {
        Editor = new CharacterEditor(profile);
        Editor.Back += () =>
        {
            ShowCards();
            status.Text = "";
        };
        Editor.SaveRequested += SaveAsync;
        Editor.ResetRequested += ResetAsync;
        Editor.DeleteRequested += DeleteAsync;
        Show(Editor);
        status.Text = "";
    }

    private async Task SwitchAsync(string id)
    {
        try
        {
            if (switchTo is not null)
            {
                await switchTo(id);
            }
            else
            {
                await backendClient.SetCharacterAsync(id);
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't switch: {BackendError.Describe(ex)}";
            return;
        }
        await ReloadAsync();
        Changed?.Invoke();
    }

    // Back to the cards once the backend has it; the editor stays, with the
    // reason, when it refuses.
    private async Task Done(Func<Task> change, string done)
    {
        try
        {
            await change();
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't save: {BackendError.Describe(ex)}";
            return;
        }
        Editor = null;
        await ReloadAsync();
        ShowCards();
        status.Text = done;
        Changed?.Invoke();
    }

    private Task SaveAsync(CharacterEditor editor) =>
        Done(() => backendClient.SaveCharacterAsync(editor.Profile?.Id, editor.NameText, editor.PromptText, editor.HandoffText, editor.Voice, editor.Model),
            editor.Profile is null ? $"Added {editor.NameText}" : $"Saved {editor.NameText}");

    private Task ResetAsync(CharacterEditor editor) =>
        Done(() => backendClient.ResetCharacterPromptAsync(editor.Profile!.Id), $"{editor.Profile!.Name}'s prompt is back to the original");

    private Task DeleteAsync(CharacterEditor editor)
    {
        var profile = editor.Profile!;
        if (MessageBox.Show(editor.FindForm(), $"Delete {profile.Name}, with her notes and milestones? This can't be undone.", "Delete character", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
        {
            return Task.CompletedTask;
        }
        return Done(() => backendClient.DeleteCharacterAsync(profile.Id), $"Deleted {profile.Name}");
    }
}

// One character's card.
internal sealed class CharacterCard : Panel
{
    internal const int CardHeight = 156;

    private readonly ManaCharacterProfile profile;
    private readonly bool talking;
    private readonly int notes;
    private readonly Font nameFont = new("Segoe UI Semibold", 10.5f);
    private readonly Font letterFont = new("Segoe UI Semibold", 13f);
    private readonly Font smallFont = new("Segoe UI", 8.25f);

    public event Action? EditClicked;
    public event Action? SwitchClicked;

    internal ManaCharacterProfile Profile => profile; // tests
    internal Button? SwitchButton { get; } // tests

    // notes: -1 when unknown.
    public CharacterCard(ManaCharacterProfile profile, bool talking, int notes)
    {
        this.profile = profile;
        this.talking = talking;
        this.notes = notes;
        Height = CardHeight;
        Margin = new Padding(0, 0, 8, 8);
        DoubleBuffered = true;
        BackColor = Color.Transparent;
        AccessibleName = $"{profile.Name}, {(talking ? "talking now" : profile.BuiltIn ? "built in" : "yours")}";
        AccessibleRole = AccessibleRole.Grouping;

        var edit = new Button { Text = "", Font = new Font("Segoe MDL2 Assets", 9.75f), Size = new Size(28, 26), AccessibleName = $"Edit {profile.Name}", Cursor = Cursors.Hand, Anchor = AnchorStyles.Top | AnchorStyles.Right };
        DarkTheme.ApplyButton(edit);
        edit.FlatAppearance.BorderSize = 0;
        edit.BackColor = DarkTheme.Panel;
        edit.Click += (_, _) => EditClicked?.Invoke();
        Controls.Add(edit);
        Layout += (_, _) => edit.Location = new Point(Width - edit.Width - 10, 10);

        if (!talking)
        {
            SwitchButton = SettingsRows.Action("Switch to her", () => SwitchClicked?.Invoke());
            SwitchButton.AccessibleName = $"Switch to {profile.Name}";
            SwitchButton.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            Controls.Add(SwitchButton);
            Layout += (_, _) => SwitchButton.Location = new Point(Width - SwitchButton.Width - 12, Height - SwitchButton.Height - 10);
        }
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        base.OnPaintBackground(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var box = new RectangleF(1, 1, Width - 3, Height - 3);
        using (var shape = SettingsRows.Rounded(box, 10))
        using (var fill = new SolidBrush(DarkTheme.Panel))
        using (var edge = new Pen(talking ? DarkTheme.Green : DarkTheme.Border, talking ? 2f : 1f))
        {
            g.FillPath(fill, shape);
            g.DrawPath(edge, shape);
        }

        // The letter avatar.
        var circle = new Rectangle(14, 14, 38, 38);
        using (var avatar = new SolidBrush(DarkTheme.Accent))
        {
            g.FillEllipse(avatar, circle);
        }
        var letter = profile.Name.Length > 0 ? profile.Name[..1].ToUpperInvariant() : "?";
        TextRenderer.DrawText(g, letter, letterFont, circle, DarkTheme.OnAccent, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);

        const TextFormatFlags line = TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
        TextRenderer.DrawText(g, profile.Name, nameFont, new Rectangle(62, 13, Width - 62 - 48, nameFont.Height), DarkTheme.Text, line);
        var (tag, tagColor) = talking ? ("Talking now", DarkTheme.Green) : profile.BuiltIn ? ("Built in", DarkTheme.Muted) : ("Yours", DarkTheme.Accent);
        var size = TextRenderer.MeasureText(tag, smallFont);
        var pill = new Rectangle(62, 36, size.Width + 10, size.Height + 2);
        using (var tint = new SolidBrush(Color.FromArgb(40, tagColor)))
        using (var shape = SettingsRows.Rounded(pill, pill.Height / 2f))
        {
            g.FillPath(tint, shape);
        }
        TextRenderer.DrawText(g, tag, smallFont, pill, tagColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);

        // The start of her prompt, three lines at most.
        var prompt = profile.Persona.ReplaceLineEndings(" ");
        TextRenderer.DrawText(g, prompt, Font, new Rectangle(14, 62, Width - 28, Font.Height * 3), DarkTheme.Muted,
            TextFormatFlags.Left | TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl);

        var voice = profile.VoiceFile is null ? "Mana's voice" : "Her own voice";
        var footer = notes < 0 ? voice : $"{voice} · {notes} note{(notes == 1 ? "" : "s")}";
        TextRenderer.DrawText(g, footer, smallFont, new Rectangle(14, Height - 32, Width - 28 - (SwitchButton?.Width + 8 ?? 0), 20), DarkTheme.Muted, line | TextFormatFlags.VerticalCenter);
    }

    protected override void OnResize(EventArgs eventargs)
    {
        base.OnResize(eventargs);
        Invalidate();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            nameFont.Dispose();
            letterFont.Dispose();
            smallFont.Dispose();
        }
        base.Dispose(disposing);
    }
}

// A character's editor, in place of the cards, like Hermes' persona editor:
// her name, prompt (with a live count against the limit), handoff line,
// voice and avatar. It saves with Save -- a document, so not autosaved.
internal sealed class CharacterEditor : TableLayoutPanel
{
    private static readonly (string Id, string Label)[] VoiceChoices = [("mana", "Mana's voice"), ("keep", "Her own voice"), ("clip", "A new clip…")];

    private readonly TextBox name = SettingsRows.Box("Name", 260);
    private readonly TextBox prompt = new SettingsField() { Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical, Height = 220, Font = new Font("Consolas", 9.75f), AccessibleName = "Character prompt" };
    private readonly Label count = SettingsRows.Words("");
    private readonly TextBox handoff = SettingsRows.Box("Handoff line", 420, "{previous} is taking a break, so it's me~");
    private readonly ComboBox voice;
    private readonly TextBox clip = SettingsRows.Box("Voice clip", 300, "A .wav, .mp3, .flac or .ogg file");
    private readonly TextBox words = SettingsRows.Box("Exact words spoken in the clip", 420, "Exactly what's said in the clip");
    private readonly FlowLayoutPanel clipLine;
    private readonly ComboBox avatar;
    private readonly TextBox model = SettingsRows.Box("Live2D model", 300, "A .model3.json file");
    private readonly FlowLayoutPanel modelLine;
    private readonly Button save;

    public event Action? Back;
    public event Func<CharacterEditor, Task>? SaveRequested;
    public event Func<CharacterEditor, Task>? ResetRequested;
    public event Func<CharacterEditor, Task>? DeleteRequested;

    // Null for a new character.
    internal ManaCharacterProfile? Profile { get; }

    internal TextBox NameBox => name; // tests
    internal TextBox PromptBox => prompt; // tests
    internal Label Count => count; // tests
    internal Button SaveButton => save; // tests
    internal string NameText => name.Text.Trim();
    internal string PromptText => prompt.Text.Trim();
    internal string HandoffText => handoff.Text.Trim();

    // What the backend takes: null leaves it, "mana" for Mana's, or her new clip.
    internal object? Voice => SelectedVoice switch
    {
        "mana" => "mana",
        "clip" => new { clip = clip.Text.Trim(), refText = words.Text.Trim() },
        _ => null,
    };

    // null leaves it, "" for Mana's model, else her own.
    internal string? Model => avatar.SelectedIndex == 0 ? (Profile?.Live2dModel is null ? null : "") : model.Text.Trim();

    public CharacterEditor(ManaCharacterProfile? profile)
    {
        Profile = profile;
        ColumnCount = 2;
        AutoSize = true;
        BackColor = Color.Transparent;
        Margin = Padding.Empty;
        ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        var back = new LinkLabel { Text = "← All characters", AutoSize = true, LinkColor = DarkTheme.Accent, ActiveLinkColor = DarkTheme.Accent, LinkBehavior = LinkBehavior.HoverUnderline, BackColor = Color.Transparent, Margin = new Padding(0, 0, 0, 8) };
        back.LinkClicked += (_, _) => Back?.Invoke();
        var title = new Label { Text = profile is null ? "New character" : $"Edit {profile.Name}", AutoSize = true, Font = new Font("Segoe UI Semibold", 10.5f), ForeColor = DarkTheme.Text, BackColor = Color.Transparent, Margin = new Padding(0, 0, 0, 8), UseMnemonic = false };
        Add(back, title);

        name.Text = profile?.Name ?? "";
        Add(Caption("Name"), name);

        prompt.Text = profile?.Persona ?? "";
        prompt.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        prompt.TextChanged += (_, _) => ShowCount();
        // The box as wide as the editor; its count on the line under it.
        Add(Caption("Character prompt"), prompt);
        prompt.Margin = Padding.Empty;
        Add(new Label { AutoSize = true, BackColor = Color.Transparent }, count);

        handoff.Text = profile?.Handoff ?? "";
        Add(Caption("Handoff line"), SettingsRows.Stack(handoff, SettingsRows.Words("What she says when she takes over; {previous} becomes whoever stepped away")));

        var voices = profile?.VoiceFile is not null ? VoiceChoices : VoiceChoices.Where(v => v.Id != "keep").ToArray();
        var voiceLabels = voices.Select(v => v.Id == "keep" ? $"Her own voice ({profile!.VoiceFile})" : v.Label).ToArray();
        voice = SettingsRows.Choice("Voice", voiceLabels, profile?.VoiceFile is null ? 0 : 1);
        voice.Tag = voices;
        var browseClip = SettingsRows.Action("Browse…", () =>
        {
            using var dialog = new OpenFileDialog { Title = "Her voice clip", Filter = "Audio (*.wav;*.mp3;*.flac;*.ogg)|*.wav;*.mp3;*.flac;*.ogg" };
            if (dialog.ShowDialog(FindForm()) == DialogResult.OK)
            {
                clip.Text = dialog.FileName;
            }
        });
        clipLine = SettingsRows.Stack(SettingsRows.Line(clip, browseClip), words, SettingsRows.Words("A few seconds of her speaking clearly, and exactly what she says in it"));
        voice.SelectedIndexChanged += (_, _) => clipLine.Visible = SelectedVoice == "clip";
        Add(Caption("Voice"), SettingsRows.Stack(voice, clipLine));

        avatar = SettingsRows.Choice("Avatar", ["Mana's model", "Her own Live2D model"], profile?.Live2dModel is null ? 0 : 1);
        model.Text = profile?.Live2dModel ?? "";
        var browseModel = SettingsRows.Action("Browse…", () =>
        {
            using var dialog = new OpenFileDialog { Title = "Her Live2D model", Filter = "Live2D model (*.model3.json)|*.model3.json" };
            if (dialog.ShowDialog(FindForm()) == DialogResult.OK)
            {
                model.Text = dialog.FileName;
            }
        });
        modelLine = SettingsRows.Line(model, browseModel);
        avatar.SelectedIndexChanged += (_, _) => modelLine.Visible = avatar.SelectedIndex == 1;
        Add(Caption("Avatar"), SettingsRows.Stack(avatar, modelLine));

        save = SettingsRows.Action(profile is null ? "Add character" : "Save", () => _ = TrySaveAsync());
        SettingsRows.MakePrimary(save);
        var actions = SettingsRows.Line(save, SettingsRows.Action("Cancel", () => Back?.Invoke()));
        if (profile is { BuiltIn: true, PromptEdited: true })
        {
            actions.Controls.Add(SettingsRows.Action("Reset prompt", () => _ = ResetRequested?.Invoke(this)));
        }
        if (profile is { BuiltIn: false })
        {
            var delete = SettingsRows.Action("Delete…", () => _ = DeleteRequested?.Invoke(this));
            delete.ForeColor = Color.IndianRed;
            actions.Controls.Add(delete);
        }
        Add(new Label { AutoSize = true, BackColor = Color.Transparent }, actions);

        clipLine.Visible = false;
        modelLine.Visible = avatar.SelectedIndex == 1;
        ShowCount();
    }

    // The picked voice's id, whichever of VoiceChoices are listed.
    private string SelectedVoice
    {
        get
        {
            var listed = ((string Id, string Label)[])voice.Tag!;
            return voice.SelectedIndex >= 0 ? listed[voice.SelectedIndex].Id : "mana";
        }
    }

    private static Label Caption(string text) => new() { Text = text, AutoSize = true, ForeColor = DarkTheme.Text, BackColor = Color.Transparent, Margin = new Padding(0, 4, 8, 8), UseMnemonic = false };

    private void Add(Control label, Control field)
    {
        field.Margin = new Padding(0, 0, 0, 10);
        Controls.Add(label);
        Controls.Add(field);
    }

    // "1,234 / 4,000", red and Save off once it's over.
    private void ShowCount()
    {
        var length = prompt.Text.Trim().Length;
        count.Text = $"{length:N0} / {CharactersPanel.MaxPromptChars:N0}";
        count.ForeColor = length > CharactersPanel.MaxPromptChars ? Color.IndianRed : DarkTheme.Muted;
        save.Enabled = length <= CharactersPanel.MaxPromptChars;
    }

    // Name and prompt are needed, and a new clip needs its words.
    internal string? Problem() =>
        NameText.Length == 0 ? "Give her a name"
        : PromptText.Length == 0 ? "Write her character prompt"
        : PromptText.Length > CharactersPanel.MaxPromptChars ? $"The prompt is over {CharactersPanel.MaxPromptChars:N0} characters"
        : SelectedVoice == "clip" && (clip.Text.Trim().Length == 0 || words.Text.Trim().Length == 0) ? "Pick her voice clip and type exactly what's said in it"
        : avatar.SelectedIndex == 1 && model.Text.Trim().Length == 0 ? "Pick her Live2D model"
        : null;

    private async Task TrySaveAsync()
    {
        if (Problem() is { } problem)
        {
            count.ForeColor = Color.IndianRed;
            count.Text = problem;
            return;
        }
        if (SaveRequested is { } requested)
        {
            await requested(this);
        }
    }
}

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1426: Settings > Models' providers -- each API account added once, its
// key protected and never shown again (only its last four characters). Closed,
// the row lists them with a light: green when the last check reached it,
// orange "not reachable" when it didn't. Open, each shows its key, when it
// was checked, and Check again, New key and Remove; under them, adding one:
// pick it, paste its key, Save and test.
internal sealed class ProvidersPanel : Component
{
    private readonly ManaBackendClient backendClient;
    private readonly FlowLayoutPanel summary = SettingsRows.Line();
    private readonly FlowLayoutPanel details = SettingsRows.Stack();
    private readonly LinkLabel toggle = new() { AutoSize = true };
    private readonly Label status = SettingsRows.Status();
    private readonly ComboBox addPreset = new SettingsCombo() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 170, AccessibleName = "Provider to add", BackColor = DarkTheme.Panel, ForeColor = DarkTheme.Text };
    private readonly TextBox addAddress = SettingsRows.Box("Address", 220, "http://127.0.0.1:11434/v1");
    private readonly TextBox addKey = SettingsRows.Box("API key", 220, "Paste its API key");
    private readonly Button addButton = SettingsRows.Action("Save and test", () => { });
    private IReadOnlyList<ManaProviderPreset> presets = [];

    // The providers Settings offers to add for now; the backend knows all
    // twelve presets, and the rest come later.
    internal static readonly string[] OfferedPresets = ["deepseek"];
    private bool open;

    // The list changed: added, removed, or checked.
    public event Action? Changed;

    internal Control[] Rows { get; }
    internal IReadOnlyList<ManaProvider> Providers { get; private set; } = [];
    internal FlowLayoutPanel Summary => summary; // tests
    internal FlowLayoutPanel Details => details; // tests
    internal ComboBox AddPreset => addPreset; // tests
    internal TextBox AddKey => addKey; // tests
    internal string StatusText => status.Text;

    public ProvidersPanel(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;
        addKey.UseSystemPasswordChar = true;
        SettingsRows.MakePrimary(addButton);
        addButton.Click += async (_, _) => await AddAsync();
        addPreset.SelectedIndexChanged += (_, _) => ShowAddFields();
        toggle.LinkColor = toggle.ActiveLinkColor = DarkTheme.Accent;
        toggle.LinkBehavior = LinkBehavior.HoverUnderline;
        toggle.BackColor = Color.Transparent;
        toggle.Margin = new Padding(8, 5, 0, 0);
        toggle.LinkClicked += (_, _) => SetOpen(!open);
        summary.Margin = Padding.Empty;
        Rows = new Control[]
        {
            new SettingsRow("Providers", "API accounts Mana can use. Add each once; the uses below pick from them", "provider providers api key deepseek openai anthropic gemini openrouter groq ollama lm studio xai mistral",
                below: true, summary, details, status),
        };
        Show();
        SetOpen(false);
    }

    internal async Task ReloadAsync()
    {
        try
        {
            (presets, var providers) = await backendClient.GetProvidersAsync();
            Providers = providers;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't load the providers: {BackendError.Describe(ex)}";
            return;
        }
        Show();
    }

    internal void SetOpen(bool value)
    {
        open = value;
        details.Visible = open;
        toggle.Text = open ? "Done" : Providers.Count == 0 ? "Add one" : "Manage";
    }

    // The closed line, and the open list under it.
    private void Show()
    {
        summary.SuspendLayout();
        foreach (var old in summary.Controls.Cast<Control>().Where(c => c != toggle).ToList())
        {
            old.Dispose();
        }
        summary.Controls.Clear();
        if (Providers.Count == 0)
        {
            summary.Controls.Add(SettingsRows.Words("None yet"));
        }
        foreach (var provider in Providers)
        {
            summary.Controls.Add(new ProviderChip(provider));
        }
        summary.Controls.Add(toggle);
        summary.ResumeLayout();

        details.SuspendLayout();
        foreach (var old in details.Controls.Cast<Control>().ToList())
        {
            old.Dispose();
        }
        foreach (var provider in Providers)
        {
            details.Controls.Add(ProviderLine(provider));
        }
        details.Controls.Add(AddLine());
        details.ResumeLayout();
        SetOpen(open);
    }

    // One provider, open: its light, name, key and last check, and what to do.
    private Control ProviderLine(ManaProvider provider)
    {
        var (light, said) = Light(provider, DateTimeOffset.Now);
        var line = SettingsRows.Line(new VaultDot { Color = light });
        line.Margin = new Padding(0, 6, 0, 0);
        line.Controls.Add(new Label { Text = provider.Label, AutoSize = true, Font = new Font("Segoe UI Semibold", 9f), ForeColor = DarkTheme.Text, BackColor = Color.Transparent, Margin = new Padding(0, 4, 6, 0), UseMnemonic = false });
        var key = provider.HasKey ? $"key {provider.KeyHint}" : "no key";
        line.Controls.Add(new Label { Text = $"{key} · {said}", AutoSize = true, ForeColor = light == DarkTheme.Warn ? DarkTheme.Warn : DarkTheme.Muted, BackColor = Color.Transparent, Margin = new Padding(0, 4, 10, 0), UseMnemonic = false });
        line.Controls.Add(SettingsRows.Action("Check again", () => _ = Run(() => backendClient.CheckProviderAsync(provider.Id), null)));
        var newKey = SettingsRows.Box($"New key for {provider.Label}", 180, "Paste the new key");
        newKey.UseSystemPasswordChar = true;
        newKey.Visible = false;
        var saveKey = SettingsRows.Action("Save key", () => _ = Run(async () =>
        {
            await backendClient.UpdateProviderKeyAsync(provider.Id, newKey.Text.Trim());
            await backendClient.CheckProviderAsync(provider.Id);
        }, $"Saved {provider.Label}'s new key"));
        saveKey.Visible = false;
        line.Controls.Add(SettingsRows.Action("New key", () =>
        {
            newKey.Visible = saveKey.Visible = true;
            newKey.Focus();
        }));
        line.Controls.Add(newKey);
        line.Controls.Add(saveKey);
        var remove = SettingsRows.Action("Remove", () => _ = Run(() => backendClient.RemoveProviderAsync(provider.Id), $"Removed {provider.Label}"));
        remove.ForeColor = Color.IndianRed;
        line.Controls.Add(remove);
        return line;
    }

    // Adding one: a provider not added yet, then its address (local and
    // custom ones) and its key (the ones that need one).
    private Control AddLine()
    {
        var addable = presets.Where(p => OfferedPresets.Contains(p.Id) && (p.Id == "custom" || !Providers.Any(added => added.Preset == p.Id))).ToList();
        var keep = (addPreset.SelectedItem as ManaProviderPreset)?.Id;
        addPreset.Items.Clear();
        addPreset.Items.AddRange(addable.ToArray<object>());
        addPreset.SelectedIndex = addable.Count == 0 ? -1 : Math.Max(0, addable.FindIndex(p => p.Id == keep));
        addKey.Clear();
        var line = SettingsRows.Line(SettingsRows.Words("Add"), addPreset, addAddress, addKey, addButton);
        line.Margin = new Padding(0, 10, 0, 0);
        line.Visible = addable.Count > 0; // nothing left to add
        ShowAddFields();
        return line;
    }

    private void ShowAddFields()
    {
        if (addPreset.SelectedItem is not ManaProviderPreset preset)
        {
            addAddress.Visible = addKey.Visible = false;
            return;
        }
        addAddress.Visible = preset.Local || preset.Id == "custom";
        addAddress.Text = preset.BaseUrl;
        addKey.Visible = preset.NeedsKey || preset.Id == "custom";
        addKey.PlaceholderText = preset.NeedsKey ? $"Paste your {preset.Label} API key" : "API key, if it needs one";
    }

    internal async Task AddAsync()
    {
        if (addPreset.SelectedItem is not ManaProviderPreset preset)
        {
            return;
        }
        if (preset.NeedsKey && addKey.Text.Trim().Length == 0)
        {
            status.Text = $"Paste your {preset.Label} API key first";
            return;
        }
        status.Text = $"Adding {preset.Label} and checking it…";
        await Run(async () =>
        {
            var added = await backendClient.AddProviderAsync(preset.Id, addAddress.Visible ? addAddress.Text : null, addKey.Text);
            status.Text = added.LastCheck is { Ok: false } failed
                ? $"Added {added.Label}, but it didn't answer: {failed.Error}"
                : $"Added {added.Label}; it answered";
        }, null);
        addKey.Clear();
    }

    // done: what to say once it's through, or null to keep what was said.
    private async Task Run(Func<Task> change, string? done)
    {
        try
        {
            await change();
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = BackendError.Describe(ex);
            return;
        }
        if (done is not null)
        {
            status.Text = done;
        }
        await ReloadAsync();
        Changed?.Invoke();
    }

    // Green when the last check reached it, orange when it didn't, grey
    // before any check; and those words.
    internal static (Color Light, string Said) Light(ManaProvider provider, DateTimeOffset now) => provider.LastCheck switch
    {
        null => (DarkTheme.Muted, "not checked yet"),
        { Ok: true } check => (DarkTheme.Green, $"checked {Ago(now - check.At)}"),
        { } check => (DarkTheme.Warn, $"not reachable: {check.Error}"),
    };

    private static string Ago(TimeSpan span) =>
        span.TotalMinutes < 1 ? "just now"
        : span.TotalHours < 1 ? $"{(int)span.TotalMinutes} min ago"
        : span.TotalDays < 1 ? $"{(int)span.TotalHours} h ago"
        : $"{(int)span.TotalDays} d ago";
}

// A provider on the closed line: its light, name and a tick or "!".
internal sealed class ProviderChip : Control
{
    private readonly ManaProvider provider;
    private readonly Color light;

    public ProviderChip(ManaProvider provider)
    {
        this.provider = provider;
        light = ProvidersPanel.Light(provider, DateTimeOffset.Now).Light;
        Text = provider.Label;
        AccessibleName = $"{provider.Label}, {ProvidersPanel.Light(provider, DateTimeOffset.Now).Said}";
        AccessibleRole = AccessibleRole.StaticText;
        SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        BackColor = Color.Transparent;
        Margin = new Padding(0, 0, 6, 0);
        Size = new Size(TextRenderer.MeasureText(Text, Font).Width + 48, 26);
    }

    internal string Mark => provider.LastCheck is { Ok: false } ? "!" : provider.LastCheck is null ? "" : "✓";

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var pill = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
        using (var shape = SettingsRows.Rounded(pill, pill.Height / 2))
        using (var fill = new SolidBrush(DarkTheme.Panel))
        using (var edge = new Pen(light == DarkTheme.Warn ? DarkTheme.Warn : DarkTheme.Border))
        {
            g.FillPath(fill, shape);
            g.DrawPath(edge, shape);
        }
        using (var dot = new SolidBrush(light))
        {
            g.FillEllipse(dot, 10, (Height - 8) / 2f, 8, 8);
        }
        TextRenderer.DrawText(g, Text, Font, new Rectangle(24, 0, Width - 44, Height), DarkTheme.Text, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        TextRenderer.DrawText(g, Mark, Font, new Rectangle(Width - 20, 0, 12, Height), light, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
    }
}

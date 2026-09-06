using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// Shared dark chrome for the "opened" window (SessionListForm, ChatLogPanel,
// SettingsPanel) -- ports the color palette and look PR #538's MainForm/
// SettingsForm scaffold used (itself matching windows-launcher's own
// theme-tokens.css), applied here to the real, backend-wired controls that
// actually shipped instead of #538's placeholder ones. Deliberately keeps
// every control's real Win32 type (ListView, TabControl, Button, Form) --
// no FormBorderStyle.None/custom-drawn chrome, so window drag/resize/snap,
// keyboard navigation and screen readers all keep working exactly as the
// OS provides them; #538's own custom chrome needed a stateful AllowExit
// escape hatch for exactly this reason (see PR #538's own review).
internal static class DarkTheme
{
    // #576: mutable (not readonly) so ApplyPreset can swap the whole
    // palette -- still only ever called once, at startup before any Form
    // exists (see Program.cs), not a live-switching mechanism.
    public static Color Background = ColorTranslator.FromHtml("#1c1a18");
    public static Color Panel = ColorTranslator.FromHtml("#242220");
    public static Color Panel2 = ColorTranslator.FromHtml("#2c2a27");
    public static Color Border = ColorTranslator.FromHtml("#3a3733");
    public static Color Text = ColorTranslator.FromHtml("#e8e4de");
    public static Color Muted = ColorTranslator.FromHtml("#948d84");
    public static Color Accent = ColorTranslator.FromHtml("#9d8ce0");
    public static Color UserBubble = ColorTranslator.FromHtml("#3a3560");
    public static Color ManaBubble = ColorTranslator.FromHtml("#2a2725");

    // windows-launcher/renderer/theme-tokens.css's --green/--warn -- not
    // previously needed here since DoctorPanelForm's pass/warn/fail colors
    // are dark-tinted row backgrounds, not this bright a status-text/fill
    // color. Not part of any preset (windows-launcher/renderer/theme.js
    // doesn't touch these either) -- fixed regardless of the chosen theme.
    public static readonly Color Green = ColorTranslator.FromHtml("#3fb96a");
    public static readonly Color Warn = ColorTranslator.FromHtml("#d99a2b");

    // #538's own code-span color (DarkSlateGray) assumed a light background
    // -- unreadable on this one, so this is a new pick, not a port.
    public static readonly Color CodeText = ColorTranslator.FromHtml("#e0b975");

    // Cached once and reused across every TabControl this app themes --
    // GDI+ leak discipline this project enforces everywhere else (see
    // ChatMarkdown's own FontCache). ApplyPreset below keeps these in
    // sync with Panel/Panel2/Text/Muted -- a SolidBrush built from a
    // Color doesn't track later reassignment of the variable it was
    // built from, so switching presets after these are constructed would
    // silently leave stale tab colors behind without that.
    private static readonly SolidBrush TabPanelBrush = new(Panel);
    private static readonly SolidBrush TabPanel2Brush = new(Panel2);
    private static readonly SolidBrush TabTextBrush = new(Text);
    private static readonly SolidBrush TabMutedBrush = new(Muted);
    private static readonly StringFormat TabTextFormat = new() { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };

    // #576: ports windows-launcher/renderer/theme.js's THEME_PRESETS
    // verbatim (same hex values) -- "violet" matches this class's own
    // original hardcoded default exactly, so leaving the theme
    // unconfigured is a no-op.
    public static readonly IReadOnlyList<ThemePresetInfo> Presets = new[]
    {
        new ThemePresetInfo("violet", "Violet"),
        new ThemePresetInfo("neutral", "Neutral dark"),
        new ThemePresetInfo("light", "Light"),
        new ThemePresetInfo("highContrast", "High contrast"),
    };

    private static readonly Dictionary<string, ThemeColors> PresetColors = new()
    {
        ["violet"] = new ThemeColors("#1c1a18", "#242220", "#2c2a27", "#3a3733", "#e8e4de", "#948d84", "#9d8ce0", "#3a3560", "#2a2725"),
        ["neutral"] = new ThemeColors("#18191b", "#202225", "#2a2d31", "#383c41", "#e8e9eb", "#9a9ea5", "#4fb3a8", "#283838", "#212427"),
        ["light"] = new ThemeColors("#f5f5f7", "#ffffff", "#eceef3", "#d9dce3", "#1c1c24", "#6a6e78", "#7a5fe0", "#e4e1fb", "#eef0f5"),
        // Issue #458 upstream: an accessibility theme, not an aesthetic
        // one -- pure black/white plus the conventional "high contrast
        // mode" yellow accent, so it reads immediately as the
        // accessibility option it is.
        ["highContrast"] = new ThemeColors("#000000", "#000000", "#111111", "#ffffff", "#ffffff", "#dcdcdc", "#ffff00", "#262626", "#000000"),
    };

    // #576: applied once, at startup (Program.cs, before any Form is
    // constructed) from the persisted ManaThemeSettings -- an unknown
    // presetId falls back to "violet" (this class's own original
    // default) rather than throwing, same defensive-default reasoning
    // ManaSettingsStore/ManaThemeSettings use for a missing/corrupt file.
    public static void ApplyPreset(string presetId, string? accentHex)
    {
        var colors = PresetColors.TryGetValue(presetId, out var found) ? found : PresetColors["violet"];
        Background = colors.Background;
        Panel = colors.Panel;
        Panel2 = colors.Panel2;
        Border = colors.Border;
        Text = colors.Text;
        Muted = colors.Muted;
        Accent = TryParseHexColor(accentHex) ?? colors.Accent;
        UserBubble = colors.UserBubble;
        ManaBubble = colors.ManaBubble;

        TabPanelBrush.Color = Panel;
        TabPanel2Brush.Color = Panel2;
        TabTextBrush.Color = Text;
        TabMutedBrush.Color = Muted;
    }

    private static Color? TryParseHexColor(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex))
        {
            return null;
        }
        try
        {
            return ColorTranslator.FromHtml(hex);
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException)
        {
            return null;
        }
    }

    public static void ApplyForm(Form form)
    {
        form.BackColor = Background;
        form.ForeColor = Text;
        ApplyDarkTitleBar(form);
    }

    // Best-effort: the DWM immersive-dark-mode attribute only exists on
    // Windows 10 1809+ (and the attribute id changed once, 1903+). A
    // failed call just leaves the native titlebar light -- not worth a
    // version check for a purely cosmetic degrade.
    private static void ApplyDarkTitleBar(Form form)
    {
        var handle = form.Handle; // forces creation now, not on first Show
        int useDark = 1;
        if (DwmSetWindowAttribute(handle, DwmwaUseImmersiveDarkMode, ref useDark, sizeof(int)) != 0)
        {
            DwmSetWindowAttribute(handle, DwmwaUseImmersiveDarkModeLegacy, ref useDark, sizeof(int));
        }
    }

    public static void ApplyListView(ListView list)
    {
        list.BackColor = Panel;
        list.ForeColor = Text;
        list.BorderStyle = BorderStyle.FixedSingle;
        void ThemeHeader() { if (list.IsHandleCreated) { SetWindowTheme(list.Handle, "DarkMode_Explorer", null); } }
        if (list.IsHandleCreated)
        {
            ThemeHeader();
        }
        else
        {
            list.HandleCreated += (_, _) => ThemeHeader();
        }
    }

    public static void ApplyButton(Button button)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.BackColor = Panel2;
        button.ForeColor = Text;
        button.FlatAppearance.BorderColor = Border;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.MouseOverBackColor = Border;
    }

    public static void ApplyTabControl(TabControl tabs)
    {
        tabs.DrawMode = TabDrawMode.OwnerDrawFixed;
        tabs.DrawItem += (_, e) =>
        {
            var page = tabs.TabPages[e.Index];
            var selected = e.Index == tabs.SelectedIndex;
            e.Graphics.FillRectangle(selected ? TabPanel2Brush : TabPanelBrush, e.Bounds);
            e.Graphics.DrawString(page.Text, tabs.Font, selected ? TabTextBrush : TabMutedBrush, e.Bounds, TabTextFormat);
        };
    }

    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeLegacy = 19;

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int valueSize);

    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    private static extern int SetWindowTheme(IntPtr hWnd, string subAppName, string? subIdList);
}

// #576: id is the persisted key (ManaThemeSettings.Preset); label is what
// the Theme settings tab's dropdown shows.
internal sealed class ThemePresetInfo
{
    public string Id { get; }
    public string Label { get; }

    public ThemePresetInfo(string id, string label)
    {
        Id = id;
        Label = label;
    }

    public override string ToString() => Label;
}

// #576: one preset's full palette, ported verbatim (same hex values) from
// windows-launcher/renderer/theme.js's THEME_PRESETS.
internal sealed class ThemeColors
{
    public Color Background { get; }
    public Color Panel { get; }
    public Color Panel2 { get; }
    public Color Border { get; }
    public Color Text { get; }
    public Color Muted { get; }
    public Color Accent { get; }
    public Color UserBubble { get; }
    public Color ManaBubble { get; }

    public ThemeColors(string background, string panel, string panel2, string border, string text, string muted, string accent, string userBubble, string manaBubble)
    {
        Background = ColorTranslator.FromHtml(background);
        Panel = ColorTranslator.FromHtml(panel);
        Panel2 = ColorTranslator.FromHtml(panel2);
        Border = ColorTranslator.FromHtml(border);
        Text = ColorTranslator.FromHtml(text);
        Muted = ColorTranslator.FromHtml(muted);
        Accent = ColorTranslator.FromHtml(accent);
        UserBubble = ColorTranslator.FromHtml(userBubble);
        ManaBubble = ColorTranslator.FromHtml(manaBubble);
    }
}

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// Shared dark chrome for the "opened" window (SessionListForm, ChatView,
// SettingsPanel) -- ports the color palette and look PR #538's MainForm/
// SettingsForm scaffold used (itself matching windows-launcher's own
// theme-tokens.css), applied here to the real, backend-wired controls that
// actually shipped instead of #538's placeholder ones. Deliberately keeps
// every control's real Win32 type (ListView, TabControl, Button, Form) --
// no FormBorderStyle.None chrome, so window drag/resize/snap, keyboard
// navigation and screen readers all keep working exactly as the OS provides
// them; #538's own custom chrome needed a stateful AllowExit escape hatch
// for exactly this reason (see PR #538's own review). The chat window's
// Mana-preset title strip keeps the native frame (SessionListForm.Caption.cs).
internal static class DarkTheme
{
    // #576: mutable (not readonly) so ApplyPreset can swap the whole
    // palette -- at startup (Program.cs), and since #688 live from Settings
    // (ApplyPresetLive).
    public static Color Background = ColorTranslator.FromHtml("#1c1a18");
    public static Color Panel = ColorTranslator.FromHtml("#242220");
    public static Color Panel2 = ColorTranslator.FromHtml("#2c2a27");
    public static Color Border = ColorTranslator.FromHtml("#3a3733");
    public static Color Text = ColorTranslator.FromHtml("#e8e4de");
    public static Color Muted = ColorTranslator.FromHtml("#948d84");
    public static Color Accent = ColorTranslator.FromHtml("#9d8ce0");
    public static Color UserBubble = ColorTranslator.FromHtml("#3a3560");
    public static Color ManaBubble = ColorTranslator.FromHtml("#2a2725");

    // windows-launcher/renderer/theme-tokens.css's --green/--warn, and a
    // code-span color picked for the dark presets. Per preset (see
    // ThemeColors) because these bright versions are unreadable on the
    // light ones.
    public static Color Green = ColorTranslator.FromHtml("#3fb96a");
    public static Color Warn = ColorTranslator.FromHtml("#d99a2b");
    public static Color CodeText = ColorTranslator.FromHtml("#e0b975");

    // Light presets get the light title bar and list styling; text on an
    // accent fill is whichever of white/near-black reads on that accent.
    public static bool IsLight => Luminance(Background) > 0.5;

    // #652: the Mana preset's frosted-glass look (see GlassSurface).
    public static bool IsGlass { get; private set; }

    // #688: bumped on every palette change, for anything that caches a
    // rendering of the theme (ChatView's glow).
    public static int Version { get; private set; }

    // #1141: raised after a live switch (ApplyPresetLive), for what draws
    // the theme into content of its own (ArtifactView's code pages).
    public static event Action? Changed;

    public static Color OnAccent
    {
        get
        {
            var dark = ColorTranslator.FromHtml("#171513");
            var accent = Luminance(Accent);
            var onWhite = 1.05 / (accent + 0.05);
            var onDark = (accent + 0.05) / (Luminance(dark) + 0.05);
            return onDark >= onWhite ? dark : Color.White;
        }
    }

    // Cached once and reused across every TabControl this app themes --
    // GDI+ leak discipline this project enforces everywhere else (see
    // ChatView's own cached fonts). ApplyPreset below keeps these in
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
    // verbatim (same hex values); "violet" matches this class's original
    // hardcoded palette. #652 added "mana", now the default (see
    // ManaThemeSettings).
    public static readonly IReadOnlyList<ThemePresetInfo> Presets = new[]
    {
        new ThemePresetInfo("violet", "Violet"),
        new ThemePresetInfo("neutral", "Neutral dark"),
        new ThemePresetInfo("light", "Light"),
        new ThemePresetInfo("highContrast", "High contrast"),
        new ThemePresetInfo("mana", "Mana"),
    };

    private static readonly Dictionary<string, ThemeColors> PresetColors = new()
    {
        ["violet"] = new ThemeColors("#1c1a18", "#242220", "#2c2a27", "#3a3733", "#e8e4de", "#948d84", "#9d8ce0", "#3a3560", "#2a2725"),
        ["neutral"] = new ThemeColors("#18191b", "#202225", "#2a2d31", "#383c41", "#e8e9eb", "#9a9ea5", "#4fb3a8", "#283838", "#212427"),
        ["light"] = new ThemeColors("#f5f5f7", "#ffffff", "#eceef3", "#d9dce3", "#1c1c24", "#6a6e78", "#7a5fe0", "#e4e1fb", "#eef0f5",
            codeText: "#5b48c2", green: "#23874a", warn: "#a86b0c"),
        // Issue #458 upstream: an accessibility theme, not an aesthetic
        // one -- pure black/white plus the conventional "high contrast
        // mode" yellow accent, so it reads immediately as the
        // accessibility option it is.
        ["highContrast"] = new ThemeColors("#000000", "#000000", "#111111", "#ffffff", "#ffffff", "#dcdcdc", "#ffff00", "#262626", "#000000"),
        // Mana's own casual reference sheet (marketing/concept/DESIGN_NOTES.md):
        // its lavender-white page, hoodie lavender panels, headphone-navy text,
        // periwinkle accent (deepened for contrast), hoodie-lavender user
        // bubble and sky-blue (her glowing hair ends) Mana bubble.
        ["mana"] = new ThemeColors("#f5f3fa", "#ffffff", "#eee7f8", "#d9d0ec", "#1b1e3f", "#67628a", "#6a5fb8", "#e7defa", "#e3f1fd",
            codeText: "#4f4596", green: "#23874a", warn: "#a86b0c"),
    };

    // #576: applied once, at startup (Program.cs, before any Form is
    // constructed) from the persisted ManaThemeSettings -- an unknown
    // presetId falls back to "mana" (the default preset) rather than
    // throwing, same defensive-default reasoning
    // ManaSettingsStore/ManaThemeSettings use for a missing/corrupt file.
    public static void ApplyPreset(string presetId, string? accentHex)
    {
        var colors = PresetColors.TryGetValue(presetId, out var found) ? found : PresetColors["mana"];
        IsGlass = colors == PresetColors["mana"]; // including the fallback for an unknown id
        Background = colors.Background;
        Panel = colors.Panel;
        Panel2 = colors.Panel2;
        Border = colors.Border;
        Text = colors.Text;
        Muted = colors.Muted;
        Accent = TryParseHexColor(accentHex) ?? colors.Accent;
        UserBubble = colors.UserBubble;
        ManaBubble = colors.ManaBubble;
        CodeText = colors.CodeText;
        Green = colors.Green;
        Warn = colors.Warn;

        TabPanelBrush.Color = Panel;
        TabPanel2Brush.Color = Panel2;
        TabTextBrush.Color = Text;
        TabMutedBrush.Color = Muted;
        Version++;
    }

    // #688: the palette in a fixed order, for remapping a control's colours
    // from one preset to the next.
    internal static Color[] Tokens() =>
        new[] { Background, Panel, Panel2, Border, Text, Muted, Accent, OnAccent, UserBubble, ManaBubble, CodeText, Green, Warn };

    // Windows a live theme switch reaches, visible or hidden: Tracked ones
    // are recoloured; Themed ones (through ApplyForm) also get or lose the
    // glass look and follow the title bar's light/dark mode.
    private static readonly List<WeakReference<Form>> TrackedForms = new();
    private static readonly List<WeakReference<Form>> ThemedForms = new();

    private static void Remember(List<WeakReference<Form>> list, Form form)
    {
        list.RemoveAll(w => !w.TryGetTarget(out var f) || f.IsDisposed);
        list.Add(new WeakReference<Form>(form));
    }

    private static List<Form> Alive(List<WeakReference<Form>> list) =>
        list.Select(w => w.TryGetTarget(out var f) ? f : null).OfType<Form>().Where(f => !f.IsDisposed).ToList();

    // #688: a window that uses the palette without ApplyForm (an overlay,
    // Quick entry) still gets recoloured on a live switch.
    public static void Track(Form form) => Remember(TrackedForms, form);

    // #688: switches the palette with every window open. The glass look
    // comes off first (restoring what the theme gave each control), every
    // colour that came from the old palette moves to the same colour of the
    // new one, then glass goes back on if the new preset has it. Each
    // window's drawing is held off meanwhile and repainted once, so there's
    // no flicker.
    public static void ApplyPresetLive(string presetId, string? accentHex)
    {
        // Only this thread's windows: a window another thread owns can be
        // closed under us mid-switch (the tests run one window per thread in
        // parallel), and touching it from here is cross-thread anyway.
        var themed = Alive(ThemedForms).Where(f => !f.InvokeRequired).ToHashSet();
        var forms = themed.Concat(Alive(TrackedForms)).Concat(Application.OpenForms.Cast<Form>())
            .Where(f => !f.IsDisposed && !f.InvokeRequired).Distinct().ToList();
        // Only visible windows: WM_SETREDRAW on would also show a hidden one.
        var frozen = forms.Where(f => f.IsHandleCreated && f.Visible).ToList();
        foreach (var form in frozen)
        {
            SetRedraw(form, false);
        }
        try
        {
            foreach (var form in forms)
            {
                GlassSurface.Detach(form);
            }
            var before = Tokens();
            ApplyPreset(presetId, accentHex);
            var after = Tokens();
            foreach (var form in forms)
            {
                Recolor(form, before, after);
                if (themed.Contains(form))
                {
                    ApplyTitleBarMode(form);
                    if (IsGlass)
                    {
                        GlassSurface.Attach(form, live: true);
                    }
                }
            }
            Changed?.Invoke();
        }
        finally
        {
            foreach (var form in frozen)
            {
                SetRedraw(form, true);
            }
        }
    }

    // Per control, which palette slot each colour property came from, so a
    // preset with two equal colours (High contrast's background and panel)
    // maps them apart next time. Re-derived when the app set a new colour since.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Control, int[]> ColorSlots = new();

    internal static Color Remap(Color current, Color[] before, Color[] after, ref int slot)
    {
        if (current.IsEmpty || current.A == 0)
        {
            return current;
        }
        if (slot < 0 || slot >= before.Length || before[slot].ToArgb() != current.ToArgb())
        {
            slot = Array.FindIndex(before, c => c.ToArgb() == current.ToArgb());
        }
        return slot >= 0 ? after[slot] : current;
    }

    private static void Recolor(Control control, Color[] before, Color[] after)
    {
        var slots = ColorSlots.GetValue(control, _ => new[] { -1, -1, -1, -1, -1, -1 });
        control.BackColor = Remap(control.BackColor, before, after, ref slots[0]);
        control.ForeColor = Remap(control.ForeColor, before, after, ref slots[1]);
        if (control is ButtonBase { FlatStyle: FlatStyle.Flat } button)
        {
            var look = button.FlatAppearance;
            look.BorderColor = Remap(look.BorderColor, before, after, ref slots[2]);
            look.MouseOverBackColor = Remap(look.MouseOverBackColor, before, after, ref slots[3]);
            look.MouseDownBackColor = Remap(look.MouseDownBackColor, before, after, ref slots[4]);
            look.CheckedBackColor = Remap(look.CheckedBackColor, before, after, ref slots[5]);
        }
        if (control is ListView list)
        {
            foreach (ListViewItem item in list.Items)
            {
                var none = -1;
                item.ForeColor = Remap(item.ForeColor, before, after, ref none);
                none = -1;
                item.BackColor = Remap(item.BackColor, before, after, ref none);
            }
            if (list.IsHandleCreated)
            {
                SetWindowTheme(list.Handle, IsLight ? "Explorer" : "DarkMode_Explorer", null);
            }
        }
        foreach (Control child in control.Controls)
        {
            Recolor(child, before, after);
        }
    }

    private const int WmSetRedraw = 0x000B;

    private static void SetRedraw(Form form, bool on)
    {
        SendMessage(form.Handle, WmSetRedraw, on ? 1 : 0, 0);
        if (on)
        {
            // Frame too: the title bar follows the new light/dark mode.
            RedrawWindow(form.Handle, IntPtr.Zero, IntPtr.Zero, RdwErase | RdwFrame | RdwInvalidate | RdwAllChildren);
        }
    }

    private const uint RdwInvalidate = 0x1;
    private const uint RdwErase = 0x4;
    private const uint RdwAllChildren = 0x80;
    private const uint RdwFrame = 0x400;

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    [DllImport("user32.dll")]
    private static extern bool RedrawWindow(IntPtr hWnd, IntPtr updateRect, IntPtr updateRegion, uint flags);

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
        Remember(ThemedForms, form);
        form.BackColor = Background;
        form.ForeColor = Text;
        ApplyTitleBarMode(form);
        if (IsGlass)
        {
            GlassSurface.Attach(form);
        }
    }

    // Best-effort: the DWM immersive-dark-mode attribute only exists on
    // Windows 10 1809+ (and the attribute id changed once, 1903+). A
    // failed call just leaves the native titlebar light -- not worth a
    // version check for a purely cosmetic degrade.
    private static void ApplyTitleBarMode(Form form)
    {
        var handle = form.Handle; // forces creation now, not on first Show
        int useDark = IsLight ? 0 : 1;
        if (DwmSetWindowAttribute(handle, DwmwaUseImmersiveDarkMode, ref useDark, sizeof(int)) != 0)
        {
            DwmSetWindowAttribute(handle, DwmwaUseImmersiveDarkModeLegacy, ref useDark, sizeof(int));
        }
        // Re-asks the window for its frame: the chat window draws its own
        // title strip in the Mana preset only (SessionListForm.Caption.cs).
        SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, SwpNoSize | SwpNoMove | SwpNoZOrder | SwpNoActivate | SwpFrameChanged);
    }

    private const uint SwpNoSize = 0x1;
    private const uint SwpNoMove = 0x2;
    private const uint SwpNoZOrder = 0x4;
    private const uint SwpNoActivate = 0x10;
    private const uint SwpFrameChanged = 0x20;

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    public static void ApplyListView(ListView list)
    {
        list.BackColor = Panel;
        list.ForeColor = Text;
        list.BorderStyle = BorderStyle.FixedSingle;
        void ThemeHeader() { if (list.IsHandleCreated) { SetWindowTheme(list.Handle, IsLight ? "Explorer" : "DarkMode_Explorer", null); } }
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

    // Relative luminance (WCAG), 0 = black, 1 = white.
    internal static double Luminance(Color c)
    {
        static double Channel(int v)
        {
            var s = v / 255.0;
            return s <= 0.03928 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * Channel(c.R) + 0.7152 * Channel(c.G) + 0.0722 * Channel(c.B);
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
    public Color CodeText { get; }
    public Color Green { get; }
    public Color Warn { get; }

    // codeText/green/warn default to the dark presets' values; light
    // presets pass darker ones.
    public ThemeColors(string background, string panel, string panel2, string border, string text, string muted, string accent, string userBubble, string manaBubble,
        string codeText = "#e0b975", string green = "#3fb96a", string warn = "#d99a2b")
    {
        CodeText = ColorTranslator.FromHtml(codeText);
        Green = ColorTranslator.FromHtml(green);
        Warn = ColorTranslator.FromHtml(warn);
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

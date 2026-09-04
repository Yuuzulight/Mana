using System;
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
    public static readonly Color Background = ColorTranslator.FromHtml("#1c1a18");
    public static readonly Color Panel = ColorTranslator.FromHtml("#242220");
    public static readonly Color Panel2 = ColorTranslator.FromHtml("#2c2a27");
    public static readonly Color Border = ColorTranslator.FromHtml("#3a3733");
    public static readonly Color Text = ColorTranslator.FromHtml("#e8e4de");
    public static readonly Color Muted = ColorTranslator.FromHtml("#948d84");
    public static readonly Color Accent = ColorTranslator.FromHtml("#9d8ce0");
    public static readonly Color UserBubble = ColorTranslator.FromHtml("#3a3560");
    public static readonly Color ManaBubble = ColorTranslator.FromHtml("#2a2725");

    // windows-launcher/renderer/theme-tokens.css's --green/--warn -- not
    // previously needed here since DoctorPanelForm's pass/warn/fail colors
    // are dark-tinted row backgrounds, not this bright a status-text/fill
    // color.
    public static readonly Color Green = ColorTranslator.FromHtml("#3fb96a");
    public static readonly Color Warn = ColorTranslator.FromHtml("#d99a2b");

    // #538's own code-span color (DarkSlateGray) assumed a light background
    // -- unreadable on this one, so this is a new pick, not a port.
    public static readonly Color CodeText = ColorTranslator.FromHtml("#e0b975");

    // Cached once and reused across every TabControl this app themes --
    // GDI+ leak discipline this project enforces everywhere else (see
    // ChatMarkdown's own FontCache).
    private static readonly SolidBrush TabPanelBrush = new(Panel);
    private static readonly SolidBrush TabPanel2Brush = new(Panel2);
    private static readonly SolidBrush TabTextBrush = new(Text);
    private static readonly SolidBrush TabMutedBrush = new(Muted);
    private static readonly StringFormat TabTextFormat = new() { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };

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

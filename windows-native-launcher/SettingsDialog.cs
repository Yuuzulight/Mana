using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #538's own MainForm reached Settings as a modal dialog off a tool-rail
// icon, not a tab -- this is that shape, but a thin wrapper around the
// real, already-wired SettingsPanel (#529) instead of #538's own
// SettingsForm, whose Theme/Plugins sections were static placeholder text
// and whose only working control (Idle-Pester) wasn't part of #529's
// scope at all. A fresh dialog per open (not reused like SessionListForm)
// -- matches #538's own choice here, and settings data is cheap enough to
// refetch every time it's opened that caching it between opens isn't worth
// the staleness risk.
internal sealed class SettingsDialog : Form
{
    // #1426: Settings is its own window, opened from the rail's cog and the
    // tray. It comes back where it was, at the size it was, on the group
    // last open.
    public SettingsDialog(SettingsPanel panel, string? group = null, string? settingsPath = null)
    {
        Text = "Settings";
        MinimumSize = new Size(760, 520);
        var saved = ManaSettingsStore.Load(settingsPath);
        if (RestoredBounds(saved.SettingsWindowBounds, Screen.AllScreens.Select(s => s.WorkingArea).ToArray()) is { } bounds)
        {
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
        }
        else
        {
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(960, 680);
        }
        DarkTheme.ApplyForm(this);

        Panel = panel;
        Controls.Add(panel);
        panel.ShowGroup(group ?? saved.SettingsGroup ?? "general");
        Shown += async (_, _) => await panel.RefreshAllAsync();
        this.settingsPath = settingsPath;
        FormClosing += (_, _) => SaveState();
    }

    private readonly string? settingsPath;

    internal void SaveState()
    {
        var latest = ManaSettingsStore.Load(settingsPath);
        var normal = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        latest.SettingsWindowBounds = $"{normal.X},{normal.Y},{normal.Width},{normal.Height}";
        latest.SettingsGroup = Panel.CurrentGroup;
        latest.Save(settingsPath);
    }

    internal SettingsPanel Panel { get; }

    // "x,y,width,height" as saved, if it still lands on a screen; null puts
    // the window in the middle at its default size.
    internal static Rectangle? RestoredBounds(string? saved, Rectangle[] screens)
    {
        var parts = saved?.Split(',');
        if (parts is not { Length: 4 } || !parts.All(p => int.TryParse(p, out _)))
        {
            return null;
        }
        var r = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
        // Enough of its title bar on some screen to grab it again.
        var titleBar = new Rectangle(r.X, r.Y, r.Width, 30);
        return r.Width >= 760 && r.Height >= 520 && screens.Any(s => Rectangle.Intersect(s, titleBar) is { Width: >= 100, Height: >= 20 }) ? r : null;
    }
}

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
    public SettingsDialog(ManaBackendClient backendClient)
    {
        var panel = new SettingsPanel(backendClient);

        Text = "Settings";
        Width = 640;
        Height = 480;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        Controls.Add(panel);
        Shown += async (_, _) => await panel.RefreshAllAsync();
    }
}

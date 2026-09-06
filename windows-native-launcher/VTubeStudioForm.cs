using System;
using System.Drawing;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #570: a standalone dialog, same shape as DoctorPanelForm/CompareModeForm
// (reached from the tray menu, not nested in Settings) -- status display
// plus hotkey trigger, matching what node-bot's vtube-routes.js actually
// exposes. No settings/config UI: VTube Studio's own token handshake and
// the VTUBE_STUDIO_URL/ENABLED env vars are both handled server-side.
internal sealed class VTubeStudioForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly Label statusLabel = new();
    private readonly Button authenticateButton = new() { Text = "Authenticate" };
    private readonly Button triggerButton = new() { Text = "Trigger" };
    private readonly ListView hotkeysList = new();

    public VTubeStudioForm(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        Text = "VTube Studio";
        Width = 480;
        Height = 420;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        statusLabel.Dock = DockStyle.Top;
        statusLabel.Height = 48;
        statusLabel.Padding = new Padding(8);
        statusLabel.ForeColor = DarkTheme.Text;

        DarkTheme.ApplyButton(authenticateButton);
        DarkTheme.ApplyButton(triggerButton);
        authenticateButton.Click += async (_, _) => await AuthenticateAsync();
        triggerButton.Click += async (_, _) => await TriggerSelectedHotkeyAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 36, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(authenticateButton);
        buttonRow.Controls.Add(triggerButton);

        hotkeysList.Dock = DockStyle.Fill;
        hotkeysList.View = View.Details;
        hotkeysList.FullRowSelect = true;
        hotkeysList.Columns.Add("Hotkey", 300);
        DarkTheme.ApplyListView(hotkeysList);

        Controls.Add(hotkeysList);
        Controls.Add(buttonRow);
        Controls.Add(statusLabel);

        Load += async (_, _) => await RefreshAsync();
    }

    private async System.Threading.Tasks.Task RefreshAsync()
    {
        ManaVTubeStatus status;
        try
        {
            status = await backendClient.GetVTubeStatusAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                statusLabel.Text = $"Could not reach the backend: {ex.Message}";
                SetControlsEnabled(false);
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        if (!status.Enabled)
        {
            statusLabel.Text = "VTube Studio integration is disabled.";
            SetControlsEnabled(false);
            return;
        }

        statusLabel.Text = status.Connected
            ? $"Connected to {status.Url}. Authenticated: {status.Authenticated}."
            : $"Enabled, but not connected: {status.Error ?? "unknown error"}";
        SetControlsEnabled(status.Connected);

        if (!status.Connected)
        {
            return;
        }

        await RefreshHotkeysAsync();
    }

    private void SetControlsEnabled(bool enabled)
    {
        authenticateButton.Enabled = enabled;
        triggerButton.Enabled = enabled;
        hotkeysList.Enabled = enabled;
    }

    private async System.Threading.Tasks.Task AuthenticateAsync()
    {
        try
        {
            await backendClient.AuthenticateVTubeStudioAsync();
        }
        catch (Exception ex)
        {
            // The user can close this dialog while the call above is
            // still in flight -- showing a MessageBox against an already-
            // disposed Form throws ObjectDisposedException, same reasoning
            // as DoctorPanelForm.RefreshAsync's own IsDisposed guard.
            if (!IsDisposed)
            {
                MessageBox.Show(this, $"Authentication failed: {ex.Message}", "VTube Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return;
        }
        if (!IsDisposed)
        {
            await RefreshAsync();
        }
    }

    private async System.Threading.Tasks.Task RefreshHotkeysAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaVTubeHotkey> hotkeys;
        try
        {
            hotkeys = await backendClient.GetVTubeHotkeysAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                hotkeysList.Items.Clear();
                hotkeysList.Items.Add(new ListViewItem($"Failed to load hotkeys: {ex.Message}") { ForeColor = Color.Firebrick });
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        hotkeysList.Items.Clear();
        foreach (var hotkey in hotkeys)
        {
            hotkeysList.Items.Add(new ListViewItem(hotkey.Name) { Tag = hotkey.Id });
        }
    }

    private async System.Threading.Tasks.Task TriggerSelectedHotkeyAsync()
    {
        if (hotkeysList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)hotkeysList.SelectedItems[0].Tag!;
        try
        {
            await backendClient.TriggerVTubeHotkeyAsync(id);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                MessageBox.Show(this, $"Failed to trigger hotkey: {ex.Message}", "VTube Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}

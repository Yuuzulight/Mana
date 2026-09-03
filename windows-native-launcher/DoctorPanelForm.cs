using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #526: a standalone dialog for now -- windows-launcher's own Doctor
// panel lives inside its main chat/session window's settings nav
// (sidebar-nav.js), which doesn't exist here yet (tracked in #520/#521).
// Once it does, this becomes a panel within it instead of its own Form.
internal sealed class DoctorPanelForm : Form
{
    // Dark-theme-appropriate status tints (see DarkTheme.cs) -- the
    // original light pastel greens/yellows/reds were sized for a white
    // ListView background and would look like a stray light-mode leftover
    // against DarkTheme.Panel.
    private static readonly Color PassColor = Color.FromArgb(30, 46, 32);
    private static readonly Color WarnColor = Color.FromArgb(48, 42, 24);
    private static readonly Color FailColor = Color.FromArgb(50, 30, 30);

    private readonly ManaBackendClient backendClient;
    private readonly Label headingLabel = new();
    private readonly Label summaryLabel = new();
    private readonly ListView list = new();

    public DoctorPanelForm(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        Text = "Mana Doctor";
        Width = 640;
        Height = 480;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        headingLabel.Dock = DockStyle.Top;
        headingLabel.Height = 28;
        headingLabel.Font = new Font(Font, FontStyle.Bold);
        headingLabel.Padding = new Padding(8, 8, 8, 0);
        headingLabel.ForeColor = DarkTheme.Text;

        summaryLabel.Dock = DockStyle.Top;
        summaryLabel.Height = 24;
        summaryLabel.Padding = new Padding(8, 0, 8, 0);
        summaryLabel.ForeColor = DarkTheme.Muted;

        list.Dock = DockStyle.Fill;
        list.View = View.Details;
        list.FullRowSelect = true;
        list.GridLines = true;
        list.Columns.Add("Status", 80);
        list.Columns.Add("Check", 200);
        list.Columns.Add("Message", 400);
        DarkTheme.ApplyListView(list);

        Controls.Add(list);
        Controls.Add(summaryLabel);
        Controls.Add(headingLabel);

        Load += async (_, _) => await RefreshAsync();
    }

    private async System.Threading.Tasks.Task RefreshAsync()
    {
        DoctorPanelView view;
        try
        {
            var result = await backendClient.GetDoctorResultAsync();
            // The user can close this dialog (X/Escape) while the await
            // above is still in flight -- ShowDialog() pumps messages
            // during it, so Close() (and the Dispose it triggers) can run
            // before this continuation resumes. Writing to a disposed
            // ListView/Label after that throws ObjectDisposedException,
            // and since this runs as an event handler's continuation,
            // nothing else would catch it.
            if (IsDisposed)
            {
                return;
            }
            view = DoctorPanelFormatter.Format(result);
        }
        catch (Exception ex)
        {
            if (IsDisposed)
            {
                return;
            }
            headingLabel.Text = "Doctor: unavailable";
            summaryLabel.Text = $"Could not reach the backend: {ex.Message}";
            return;
        }

        headingLabel.Text = view.Heading;
        summaryLabel.Text = view.Summary;

        list.Items.Clear();
        // Needs-attention checks (warn/fail) first, then the rest --
        // matches doctor-panel.js's own needs-attention/all-good split
        // without a separate collapsible section, since a native list
        // has room to show every row's message inline (no click-to-reveal
        // bubble needed the way the Electron sidebar's compact chip UI
        // does).
        foreach (var row in view.Rows.OrderBy(r => r.Status == "pass" ? 1 : 0))
        {
            var item = new ListViewItem(row.Status.ToUpperInvariant());
            item.SubItems.Add(row.Label);
            item.SubItems.Add(row.Message);
            item.BackColor = row.Status switch
            {
                "fail" => FailColor,
                "warn" => WarnColor,
                _ => PassColor,
            };
            list.Items.Add(item);
        }
    }
}

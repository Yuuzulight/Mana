using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #569: a rotated device token, like a newly-created account's API key
// (see #568's own accounts tab), is shown exactly once -- node-bot only
// persists a hash of it (mobile-device-store.js). A dedicated read-only
// textbox plus an explicit Copy button beats relying on a MessageBox's
// less-obvious selectable text for something this easy to lose for good.
internal sealed class MobileTokenRevealDialog : Form
{
    public MobileTokenRevealDialog(string deviceName, string token)
    {
        Text = "Device Token";
        Width = 460;
        Height = 200;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        var messageLabel = new Label
        {
            Text = $"New token for \"{deviceName}\" -- save it now, it will not be shown again:",
            AutoSize = true,
            ForeColor = DarkTheme.Text,
            Margin = new Padding(12, 12, 12, 6),
        };
        var tokenBox = new TextBox
        {
            Text = token,
            ReadOnly = true,
            Width = 400,
            BackColor = DarkTheme.Panel2,
            ForeColor = DarkTheme.Text,
            Margin = new Padding(12, 0, 12, 6),
        };

        var copyButton = new Button { Text = "Copy to Clipboard" };
        var closeButton = new Button { Text = "Close", DialogResult = DialogResult.OK };
        DarkTheme.ApplyButton(copyButton);
        DarkTheme.ApplyButton(closeButton);
        copyButton.Click += (_, _) => Clipboard.SetText(token);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 40, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(closeButton);
        buttonRow.Controls.Add(copyButton);

        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false };
        layout.Controls.Add(messageLabel);
        layout.Controls.Add(tokenBox);

        Controls.Add(layout);
        Controls.Add(buttonRow);
        AcceptButton = closeButton;
    }
}

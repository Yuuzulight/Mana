using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #568: node-bot returns a new account's API key exactly once at
// creation time and never re-serves it (auth-store.js only persists a
// hash) -- a plain MessageBox would technically let the text be
// selected, but a dedicated read-only textbox plus an explicit Copy
// button makes "you will not see this again" harder to fumble than
// relying on the user to know a MessageBox's text is selectable at all.
internal sealed class ApiKeyRevealDialog : Form
{
    public ApiKeyRevealDialog(string email, string apiKey)
    {
        Text = "Account Created";
        Width = 460;
        Height = 200;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        var messageLabel = new Label
        {
            Text = $"API key for {email} -- save it now, it will not be shown again:",
            AutoSize = true,
            ForeColor = DarkTheme.Text,
            Margin = new Padding(12, 12, 12, 6),
        };
        var keyBox = new TextBox
        {
            Text = apiKey,
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
        copyButton.Click += (_, _) => Clipboard.SetText(apiKey);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 40, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(closeButton);
        buttonRow.Controls.Add(copyButton);

        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false };
        layout.Controls.Add(messageLabel);
        layout.Controls.Add(keyBox);

        Controls.Add(layout);
        Controls.Add(buttonRow);
        AcceptButton = closeButton;
    }
}

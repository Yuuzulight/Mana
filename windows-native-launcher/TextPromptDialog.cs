using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #586: SessionListForm's own "Rename" reuses the ListView's built-in
// inline label edit, but that only edits one row's Name column -- goal
// editing needs its own place to type a line of text. No general-purpose
// input box exists yet in this app, so this is a small, reusable one
// rather than a one-off wired directly into SessionListForm.
internal sealed class TextPromptDialog : Form
{
    private readonly TextBox textBox = new();

    public string Value => textBox.Text;

    public TextPromptDialog(string title, string label, string initialValue)
    {
        Text = title;
        Width = 420;
        Height = 160;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        var promptLabel = new Label
        {
            Text = label,
            Dock = DockStyle.Top,
            Height = 24,
            Padding = new Padding(12, 12, 0, 0),
            ForeColor = DarkTheme.Text,
        };

        textBox.Text = initialValue;
        textBox.BackColor = DarkTheme.Panel2;
        textBox.ForeColor = DarkTheme.Text;
        textBox.BorderStyle = BorderStyle.FixedSingle;
        textBox.Dock = DockStyle.Fill;
        var textBoxHost = new Panel { Dock = DockStyle.Top, Height = 32, Padding = new Padding(12, 0, 12, 0), BackColor = DarkTheme.Background };
        textBoxHost.Controls.Add(textBox);

        var buttonRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            Height = 44,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(12),
            BackColor = DarkTheme.Background,
        };
        var okButton = new Button { Text = "OK", DialogResult = DialogResult.OK, Width = 80 };
        var cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Width = 80 };
        DarkTheme.ApplyButton(okButton);
        DarkTheme.ApplyButton(cancelButton);
        buttonRow.Controls.Add(okButton);
        buttonRow.Controls.Add(cancelButton);

        Controls.Add(promptLabel);
        Controls.Add(textBoxHost);
        Controls.Add(buttonRow);
        AcceptButton = okButton;
        CancelButton = cancelButton;
    }
}

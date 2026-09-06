using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #573: shared by both New and Edit -- constructed with existing values
// pre-filled for Edit, blank for New (see SettingsPanel's own call sites).
internal sealed class PresetDialog : Form
{
    private readonly TextBox nameBox = new() { Width = 320 };
    private readonly TextBox instructionsBox = new() { Width = 320, Height = 160, Multiline = true, ScrollBars = ScrollBars.Vertical };

    public string PresetName => nameBox.Text.Trim();
    public string Instructions => instructionsBox.Text.Trim();

    public PresetDialog(string title, string name = "", string instructions = "")
    {
        Text = title;
        Width = 420;
        Height = 380;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        nameBox.Text = name;
        instructionsBox.Text = instructions;
        nameBox.BackColor = DarkTheme.Panel2;
        nameBox.ForeColor = DarkTheme.Text;
        instructionsBox.BackColor = DarkTheme.Panel2;
        instructionsBox.ForeColor = DarkTheme.Text;

        var okButton = new Button { Text = "Save", DialogResult = DialogResult.OK };
        var cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel };
        DarkTheme.ApplyButton(okButton);
        DarkTheme.ApplyButton(cancelButton);
        okButton.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(PresetName) || string.IsNullOrWhiteSpace(Instructions))
            {
                MessageBox.Show(this, "Name and instructions are both required.", title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                DialogResult = DialogResult.None;
            }
        };

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), AutoSize = true };
        void AddRow(string label, Control control)
        {
            layout.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left | AnchorStyles.Top, Margin = new Padding(3, 8, 3, 3) });
            layout.Controls.Add(control);
        }
        AddRow("Name", nameBox);
        AddRow("Instructions", instructionsBox);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 40, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(okButton);
        buttonRow.Controls.Add(cancelButton);

        Controls.Add(layout);
        Controls.Add(buttonRow);
        AcceptButton = okButton;
        CancelButton = cancelButton;
    }
}

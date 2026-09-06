using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #568: a small modal for creating an account -- email + role, matching
// POST /admin/accounts's own two required fields (server.js validates
// role is "admin"/"user" itself, so this dialog doesn't duplicate that).
internal sealed class CreateAccountDialog : Form
{
    private readonly TextBox emailBox = new() { Width = 240 };
    private readonly ComboBox roleBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 240 };

    public string Email => emailBox.Text.Trim();
    public string Role => (string)roleBox.SelectedItem!;

    public CreateAccountDialog()
    {
        Text = "Create Account";
        Width = 360;
        Height = 180;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        emailBox.BackColor = DarkTheme.Panel2;
        emailBox.ForeColor = DarkTheme.Text;
        roleBox.BackColor = DarkTheme.Panel2;
        roleBox.ForeColor = DarkTheme.Text;
        roleBox.Items.AddRange(new object[] { "user", "admin" });
        roleBox.SelectedIndex = 0;

        var okButton = new Button { Text = "Create", DialogResult = DialogResult.OK };
        var cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel };
        DarkTheme.ApplyButton(okButton);
        DarkTheme.ApplyButton(cancelButton);
        okButton.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(Email))
            {
                MessageBox.Show(this, "Email is required.", "Create Account", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                DialogResult = DialogResult.None;
            }
        };

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), AutoSize = true };
        void AddRow(string label, Control control)
        {
            layout.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(3, 8, 3, 3) });
            layout.Controls.Add(control);
        }
        AddRow("Email", emailBox);
        AddRow("Role", roleBox);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 40, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(okButton);
        buttonRow.Controls.Add(cancelButton);

        Controls.Add(layout);
        Controls.Add(buttonRow);
        AcceptButton = okButton;
        CancelButton = cancelButton;
    }
}

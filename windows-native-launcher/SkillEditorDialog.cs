using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #581: shared by both New and Edit. Name is only editable for New --
// node-bot's PATCH /skills/:name has no rename support (only
// description/body/category), so Edit shows it read-only rather than
// silently discarding a typed change.
internal sealed class SkillEditorDialog : Form
{
    private readonly TextBox nameBox = new() { Width = 320 };
    private readonly TextBox descriptionBox = new() { Width = 320 };
    private readonly TextBox bodyBox = new() { Width = 320, Height = 220, Multiline = true, ScrollBars = ScrollBars.Vertical, Font = new System.Drawing.Font(System.Drawing.FontFamily.GenericMonospace, 9) };
    private readonly TextBox categoryBox = new() { Width = 320 };

    public string SkillName => nameBox.Text.Trim();
    public string Description => descriptionBox.Text.Trim();
    public string Body => bodyBox.Text.Trim();
    public string? Category => string.IsNullOrWhiteSpace(categoryBox.Text) ? null : categoryBox.Text.Trim();

    public SkillEditorDialog(string title, bool isNew, string name = "", string description = "", string body = "", string? category = null)
    {
        Text = title;
        Width = 460;
        Height = 460;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        nameBox.Text = name;
        nameBox.ReadOnly = !isNew;
        descriptionBox.Text = description;
        bodyBox.Text = body;
        categoryBox.Text = category ?? "";

        foreach (var box in new[] { nameBox, descriptionBox, bodyBox, categoryBox })
        {
            box.BackColor = DarkTheme.Panel2;
            box.ForeColor = DarkTheme.Text;
        }

        var okButton = new Button { Text = "Save", DialogResult = DialogResult.OK };
        var cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel };
        DarkTheme.ApplyButton(okButton);
        DarkTheme.ApplyButton(cancelButton);
        okButton.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(SkillName) || string.IsNullOrWhiteSpace(Description) || string.IsNullOrWhiteSpace(Body))
            {
                MessageBox.Show(this, "Name, description, and body are all required.", title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                DialogResult = DialogResult.None;
            }
        };

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), AutoSize = true, BackColor = DarkTheme.Background };
        void AddRow(string label, Control control)
        {
            layout.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left | AnchorStyles.Top, Margin = new Padding(3, 8, 3, 3) });
            layout.Controls.Add(control);
        }
        AddRow("Name", nameBox);
        AddRow("Description", descriptionBox);
        AddRow("Body", bodyBox);
        AddRow("Category (optional)", categoryBox);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 40, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(okButton);
        buttonRow.Controls.Add(cancelButton);

        Controls.Add(layout);
        Controls.Add(buttonRow);
        AcceptButton = okButton;
        CancelButton = cancelButton;
    }
}

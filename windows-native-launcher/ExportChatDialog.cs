using System;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1323: export options dialog offering Markdown, HTML (drawn with Folio)
// and JSONL, with checkboxes to include tool calls and hidden reasoning.
internal sealed class ExportChatDialog : Form
{
    private readonly ComboBox formatPicker = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 240 };
    private readonly CheckBox toolsCheckBox = new() { Text = "Include tool calls", AutoSize = true };
    private readonly CheckBox thoughtsCheckBox = new() { Text = "Include reasoning / thought process", AutoSize = true };

    public string SelectedFormat => formatPicker.SelectedIndex switch
    {
        1 => "html",
        2 => "jsonl",
        _ => "markdown",
    };

    public bool IncludeTools => toolsCheckBox.Checked;
    public bool IncludeThoughts => thoughtsCheckBox.Checked;

    public ExportChatDialog()
    {
        Text = "Export Chat";
        Width = 400;
        Height = 250;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        formatPicker.Items.AddRange(new object[] { "Markdown (.md)", "HTML page (.html)", "JSON Lines (.jsonl)" });
        formatPicker.SelectedIndex = 0;
        formatPicker.BackColor = DarkTheme.Panel2;
        formatPicker.ForeColor = DarkTheme.Text;

        toolsCheckBox.ForeColor = DarkTheme.Text;
        thoughtsCheckBox.ForeColor = DarkTheme.Text;

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            Padding = new Padding(16),
            AutoSize = true,
            BackColor = DarkTheme.Background,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        var formatLabel = new Label
        {
            Text = "Format:",
            AutoSize = true,
            ForeColor = DarkTheme.Text,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 0, 12, 12),
        };
        layout.Controls.Add(formatLabel, 0, 0);
        layout.Controls.Add(formatPicker, 1, 0);

        var optionsPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            AutoSize = true,
            BackColor = DarkTheme.Background,
            Margin = new Padding(0, 6, 0, 0),
        };
        optionsPanel.Controls.Add(toolsCheckBox);
        optionsPanel.Controls.Add(thoughtsCheckBox);
        layout.SetColumnSpan(optionsPanel, 2);
        layout.Controls.Add(optionsPanel, 0, 1);

        var okButton = new Button { Text = "Export...", DialogResult = DialogResult.OK, Width = 90 };
        var cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Width = 80 };
        DarkTheme.ApplyButton(okButton);
        DarkTheme.ApplyButton(cancelButton);

        var buttonRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            Height = 44,
            Padding = new Padding(12),
            BackColor = DarkTheme.Background,
        };
        buttonRow.Controls.Add(cancelButton);
        buttonRow.Controls.Add(okButton);

        Controls.Add(layout);
        Controls.Add(buttonRow);
        AcceptButton = okButton;
        CancelButton = cancelButton;
    }
}

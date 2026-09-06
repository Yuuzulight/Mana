using System;
using System.Collections.Generic;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #566: a small modal for creating a hook rule. Action options are
// phase-dependent (hooks-store.js's ACTIONS_BY_PHASE: pre -> deny/ask,
// post -> run-command/rollback-on-failure) -- the Action dropdown
// repopulates whenever Phase changes rather than offering every action
// regardless of phase and letting the server 400 on a bad combination.
internal sealed class HookRuleDialog : Form
{
    private readonly ComboBox phaseBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly ComboBox actionBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 220 };
    private readonly TextBox toolNameBox = new() { Width = 220 };
    private readonly TextBox pathContainsBox = new() { Width = 220 };
    private readonly TextBox commandBox = new() { Width = 220 };
    private readonly TextBox argsBox = new() { Width = 220 };
    private readonly TextBox reasonBox = new() { Width = 220 };

    public string Phase => (string)phaseBox.SelectedItem!;
    public string Action => (string)actionBox.SelectedItem!;
    public string ToolName => toolNameBox.Text.Trim();
    public string? PathContains => string.IsNullOrWhiteSpace(pathContainsBox.Text) ? null : pathContainsBox.Text.Trim();
    public string? Command => string.IsNullOrWhiteSpace(commandBox.Text) ? null : commandBox.Text.Trim();

    public IReadOnlyList<string>? Args => string.IsNullOrWhiteSpace(argsBox.Text)
        ? null
        : argsBox.Text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public string? Reason => string.IsNullOrWhiteSpace(reasonBox.Text) ? null : reasonBox.Text.Trim();

    public HookRuleDialog()
    {
        Text = "Add Hook Rule";
        Width = 440;
        Height = 400;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        foreach (var box in new[] { toolNameBox, pathContainsBox, commandBox, argsBox, reasonBox })
        {
            box.BackColor = DarkTheme.Panel2;
            box.ForeColor = DarkTheme.Text;
        }
        foreach (var box in new ComboBox[] { phaseBox, actionBox })
        {
            box.BackColor = DarkTheme.Panel2;
            box.ForeColor = DarkTheme.Text;
        }

        phaseBox.Items.AddRange(new object[] { "pre", "post" });
        phaseBox.SelectedIndexChanged += (_, _) => RepopulateActions();
        phaseBox.SelectedIndex = 0;

        var okButton = new Button { Text = "Add", DialogResult = DialogResult.OK };
        var cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel };
        DarkTheme.ApplyButton(okButton);
        DarkTheme.ApplyButton(cancelButton);
        okButton.Click += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(ToolName))
            {
                MessageBox.Show(this, "Tool name is required.", "Add Hook Rule", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                DialogResult = DialogResult.None;
            }
        };

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), AutoSize = true };
        void AddRow(string label, Control control)
        {
            layout.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(3, 8, 3, 3) });
            layout.Controls.Add(control);
        }
        AddRow("Phase", phaseBox);
        AddRow("Action", actionBox);
        AddRow("Tool name", toolNameBox);
        AddRow("Path contains (optional)", pathContainsBox);
        AddRow("Command (optional)", commandBox);
        AddRow("Args, comma-separated (optional)", argsBox);
        AddRow("Reason (optional)", reasonBox);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 40, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(okButton);
        buttonRow.Controls.Add(cancelButton);

        Controls.Add(layout);
        Controls.Add(buttonRow);
        AcceptButton = okButton;
        CancelButton = cancelButton;
    }

    private void RepopulateActions()
    {
        actionBox.Items.Clear();
        actionBox.Items.AddRange(Phase == "pre" ? new object[] { "deny", "ask" } : new object[] { "run-command", "rollback-on-failure" });
        actionBox.SelectedIndex = 0;
    }
}

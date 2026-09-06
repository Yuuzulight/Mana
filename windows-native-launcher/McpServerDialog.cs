using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #567: a small modal for registering an MCP server. Transport is a
// union server-side (mcp-client-registry.js's validateTransport: stdio
// needs command/args/envAllowlist, http needs a url) -- the relevant
// field group is shown/hidden as the Kind dropdown changes, rather than
// showing every field always and letting the server 400 on an
// irrelevant one being set.
internal sealed class McpServerDialog : Form
{
    private readonly TextBox nameBox = new() { Width = 260 };
    private readonly ComboBox kindBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 260 };
    private readonly TextBox commandBox = new() { Width = 260 };
    private readonly TextBox argsBox = new() { Width = 260 };
    private readonly TextBox envAllowlistBox = new() { Width = 260 };
    private readonly TextBox urlBox = new() { Width = 260 };
    private readonly TextBox allowedToolsBox = new() { Width = 260 };
    private readonly Label commandLabel;
    private readonly Label argsLabel;
    private readonly Label envAllowlistLabel;
    private readonly Label urlLabel;

    public string ServerName => nameBox.Text.Trim();
    public string TransportKind => (string)kindBox.SelectedItem!;
    public string? Command => string.IsNullOrWhiteSpace(commandBox.Text) ? null : commandBox.Text.Trim();
    public IReadOnlyList<string>? Args => SplitOrNull(argsBox.Text);
    public IReadOnlyList<string>? EnvAllowlist => SplitOrNull(envAllowlistBox.Text);
    public string? Url => string.IsNullOrWhiteSpace(urlBox.Text) ? null : urlBox.Text.Trim();
    public IReadOnlyList<string> AllowedTools => SplitOrNull(allowedToolsBox.Text) ?? Array.Empty<string>();

    public McpServerDialog()
    {
        Text = "Register MCP Server";
        Width = 420;
        Height = 400;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);

        foreach (var box in new[] { nameBox, commandBox, argsBox, envAllowlistBox, urlBox, allowedToolsBox })
        {
            box.BackColor = DarkTheme.Panel2;
            box.ForeColor = DarkTheme.Text;
        }
        kindBox.BackColor = DarkTheme.Panel2;
        kindBox.ForeColor = DarkTheme.Text;

        kindBox.Items.AddRange(new object[] { "stdio", "http" });
        kindBox.SelectedIndexChanged += (_, _) => UpdateFieldVisibility();

        var okButton = new Button { Text = "Register", DialogResult = DialogResult.OK };
        var cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel };
        DarkTheme.ApplyButton(okButton);
        DarkTheme.ApplyButton(cancelButton);
        okButton.Click += (_, _) =>
        {
            var error = GetValidationError();
            if (error is not null)
            {
                MessageBox.Show(this, error, "Register MCP Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                DialogResult = DialogResult.None;
            }
        };

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), AutoSize = true, BackColor = DarkTheme.Background };
        void AddRow(Label label, Control control)
        {
            label.AutoSize = true;
            label.ForeColor = DarkTheme.Text;
            label.Anchor = AnchorStyles.Left;
            label.Margin = new Padding(3, 8, 3, 3);
            layout.Controls.Add(label);
            layout.Controls.Add(control);
        }
        AddRow(new Label { Text = "Name" }, nameBox);
        AddRow(new Label { Text = "Transport" }, kindBox);
        commandLabel = new Label { Text = "Command" };
        argsLabel = new Label { Text = "Args, comma-separated" };
        envAllowlistLabel = new Label { Text = "Env vars to pass through (optional)" };
        urlLabel = new Label { Text = "URL" };
        AddRow(commandLabel, commandBox);
        AddRow(argsLabel, argsBox);
        AddRow(envAllowlistLabel, envAllowlistBox);
        AddRow(urlLabel, urlBox);
        AddRow(new Label { Text = "Allowed tools, comma-separated" }, allowedToolsBox);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 40, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(okButton);
        buttonRow.Controls.Add(cancelButton);

        Controls.Add(layout);
        Controls.Add(buttonRow);
        AcceptButton = okButton;
        CancelButton = cancelButton;

        kindBox.SelectedIndex = 0;
    }

    private void UpdateFieldVisibility()
    {
        var isStdio = TransportKind == "stdio";
        commandLabel.Visible = commandBox.Visible = isStdio;
        argsLabel.Visible = argsBox.Visible = isStdio;
        envAllowlistLabel.Visible = envAllowlistBox.Visible = isStdio;
        urlLabel.Visible = urlBox.Visible = !isStdio;
    }

    private string? GetValidationError()
    {
        if (string.IsNullOrWhiteSpace(ServerName))
        {
            return "Name is required.";
        }
        if (TransportKind == "stdio" && string.IsNullOrWhiteSpace(Command))
        {
            return "Command is required for a stdio server.";
        }
        if (TransportKind == "http" && string.IsNullOrWhiteSpace(Url))
        {
            return "URL is required for an http server.";
        }
        if (AllowedTools.Count == 0)
        {
            return "At least one allowed tool is required.";
        }
        return null;
    }

    private static IReadOnlyList<string>? SplitOrNull(string text)
    {
        return string.IsNullOrWhiteSpace(text)
            ? null
            : text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }
}

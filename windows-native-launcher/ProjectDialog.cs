using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal sealed class ProjectDialog : Form
{
    private readonly ManaBackendClient client;
    private ManaProject? project;
    private readonly TextBox nameBox = new() { Dock = DockStyle.Fill, MaxLength = 120, AccessibleName = "Project name" };
    private readonly TextBox instructionsBox = new() { Dock = DockStyle.Fill, Multiline = true, ScrollBars = ScrollBars.Vertical, MaxLength = 8000, AccessibleName = "Standing instructions" };
    private readonly ListBox references = new() { Dock = DockStyle.Fill, HorizontalScrollbar = true, AccessibleName = "Live references" };
    private readonly FlowLayoutPanel actions = new() { Dock = DockStyle.Fill, AutoSize = true };
    internal string? SavedProjectId => project?.Id;

    public ProjectDialog(ManaBackendClient client, ManaProject? project = null)
    {
        this.client = client;
        this.project = project;
        Text = project is null ? "New project" : "Edit project";
        ClientSize = new System.Drawing.Size(600, 520);
        MinimumSize = new System.Drawing.Size(480, 440);
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        DarkTheme.ApplyForm(this);
        nameBox.Text = project?.Name ?? "";
        instructionsBox.Text = project?.Instructions ?? "";
        foreach (var box in new Control[] { nameBox, instructionsBox, references }) { box.BackColor = DarkTheme.Panel2; box.ForeColor = DarkTheme.Text; }
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 7, Padding = new Padding(12) };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 60));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        layout.Controls.Add(Label("Name"), 0, 0);
        layout.Controls.Add(nameBox, 0, 1);
        layout.Controls.Add(Label("Standing instructions"), 0, 2);
        layout.Controls.Add(instructionsBox, 0, 3);
        layout.Controls.Add(Label("Live references"), 0, 4);
        layout.Controls.Add(references, 0, 5);
        layout.Controls.Add(actions, 0, 6);
        AddAction("Link files...", LinkFilesAsync);
        AddAction("Link folder...", LinkFolderAsync);
        AddAction("Remove link", RemoveLinkAsync);
        AddAction("Save", async () => { await SaveAsync(); DialogResult = DialogResult.OK; Close(); });
        Controls.Add(layout);
        ShowReferences();
    }

    private static Label Label(string text) => new() { Text = text, Dock = DockStyle.Fill, ForeColor = DarkTheme.Text, TextAlign = System.Drawing.ContentAlignment.MiddleLeft };

    private void AddAction(string text, Func<Task> action)
    {
        var button = new Button { Text = text, AutoSize = true };
        DarkTheme.ApplyButton(button);
        button.Click += async (_, _) =>
        {
            actions.Enabled = false;
            nameBox.Enabled = instructionsBox.Enabled = references.Enabled = false;
            try { await action(); }
            catch (Exception ex) { if (!IsDisposed) { ShowReferences(); MessageBox.Show(this, ex.Message, "Projects", MessageBoxButtons.OK, MessageBoxIcon.Error); } }
            finally { if (!IsDisposed) { actions.Enabled = true; nameBox.Enabled = instructionsBox.Enabled = references.Enabled = true; } }
        };
        actions.Controls.Add(button);
    }

    private async Task SaveAsync()
    {
        if (string.IsNullOrWhiteSpace(nameBox.Text)) throw new InvalidOperationException("Project name is required.");
        project = await client.SaveProjectAsync(project?.Id, nameBox.Text.Trim(), instructionsBox.Text);
        if (!IsDisposed) { Text = "Edit project"; ShowReferences(); }
    }

    private void ShowReferences()
    {
        references.Items.Clear();
        foreach (var reference in project?.References ?? new()) references.Items.Add(reference);
    }

    private async Task LinkFilesAsync()
    {
        using var picker = new OpenFileDialog { Multiselect = true, Title = "Link live project files" };
        if (picker.ShowDialog(this) != DialogResult.OK) return;
        await SaveAsync();
        foreach (var file in picker.FileNames) project = await client.LinkProjectReferenceAsync(project!.Id, file);
        if (!IsDisposed) ShowReferences();
    }

    private async Task LinkFolderAsync()
    {
        using var picker = new FolderBrowserDialog { Description = "Link a live project folder", UseDescriptionForTitle = true };
        if (picker.ShowDialog(this) != DialogResult.OK) return;
        await SaveAsync();
        project = await client.LinkProjectReferenceAsync(project!.Id, picker.SelectedPath);
        if (!IsDisposed) ShowReferences();
    }

    private async Task RemoveLinkAsync()
    {
        if (project is null || references.SelectedItem is not ManaProjectReference reference) return;
        project = await client.RemoveProjectReferenceAsync(project.Id, reference.Id);
        if (!IsDisposed) ShowReferences();
    }
}

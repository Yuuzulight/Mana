using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal sealed partial class SessionListForm
{
    private readonly ComboBox projectPicker = new() { Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = "Project filter" };
    private IReadOnlyList<ManaProject> projects = Array.Empty<ManaProject>();
    private bool loadingProjects;
    private ManaProject? SelectedProject => projectPicker.SelectedItem as ManaProject;

    private Control BuildProjectControls()
    {
        var panel = new Panel { Dock = DockStyle.Top, Height = 66, Padding = new Padding(0, 3, 0, 3) };
        var commands = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 30, WrapContents = false };
        var menu = new ContextMenuStrip();
        var manage = new Button { Text = "Projects...", AutoSize = true, Margin = new Padding(0) };
        DarkTheme.ApplyButton(manage);
        manage.Click += (_, _) => menu.Show(manage, new System.Drawing.Point(0, manage.Height));
        manage.Disposed += (_, _) => menu.Dispose();
        commands.Controls.Add(manage);
        foreach (var (text, action) in new (string, Func<Task>)[] {
            ("New project", () => EditProjectAsync(null)),
            ("Edit", () => SelectedProject is { } project ? EditProjectAsync(project) : Task.CompletedTask),
            ("Delete", DeleteProjectAsync),
        })
        {
            var item = new ToolStripMenuItem(text);
            item.Click += async (_, _) =>
            {
                commands.Enabled = false;
                try { await action(); }
                catch (Exception ex) { if (!IsDisposed) SetListError(ex.Message); }
                finally { if (!IsDisposed) commands.Enabled = true; }
            };
            menu.Items.Add(item);
        }
        projectPicker.Items.Add("All projects");
        projectPicker.Items.Add("Ungrouped");
        projectPicker.SelectedIndex = 0;
        projectPicker.SelectedIndexChanged += (_, _) => { if (!loadingProjects) ShowSessions(); };
        panel.Controls.Add(projectPicker);
        panel.Controls.Add(commands);
        return panel;
    }

    private void UpdateProjects(IReadOnlyList<ManaProject> loaded)
    {
        var selectedId = SelectedProject?.Id;
        var ungrouped = projectPicker.SelectedIndex == 1;
        projects = loaded;
        loadingProjects = true;
        try
        {
            projectPicker.Items.Clear();
            projectPicker.Items.Add("All projects");
            projectPicker.Items.Add("Ungrouped");
            foreach (var project in loaded) projectPicker.Items.Add(project);
            projectPicker.SelectedItem = loaded.FirstOrDefault(project => project.Id == selectedId);
            if (projectPicker.SelectedIndex < 0) projectPicker.SelectedIndex = ungrouped ? 1 : 0;
        }
        finally { loadingProjects = false; }
    }

    private bool MatchesProject(ManaSession session) => SelectedProject is { } project ? session.ProjectId == project.Id : projectPicker.SelectedIndex != 1 || session.ProjectId is null;

    private async Task EditProjectAsync(ManaProject? project)
    {
        using var dialog = new ProjectDialog(backendClient, project);
        dialog.ShowDialog(this);
        await RefreshAsync();
        if (!IsDisposed && dialog.SavedProjectId is { } id) projectPicker.SelectedItem = projects.FirstOrDefault(candidate => candidate.Id == id);
    }

    private async Task DeleteProjectAsync()
    {
        if (SelectedProject is not { } project) return;
        if (MessageBox.Show(this, $"Delete project '{project.Name}'? Chats and original reference files will be kept.", "Delete project", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        await backendClient.DeleteProjectAsync(project.Id);
        await RefreshAsync();
    }

    private void AddMoveToProjectMenu(ContextMenuStrip menu)
    {
        var move = new ToolStripMenuItem("Move to project");
        menu.Items.Add(move);
        move.DropDownOpening += (_, _) =>
        {
            foreach (ToolStripItem item in move.DropDownItems.Cast<ToolStripItem>().ToArray()) item.Dispose();
            move.DropDownItems.Clear();
            Add("Ungrouped", null);
            foreach (var project in projects) Add(project.Name, project.Id);
        };
        void Add(string name, string? id)
        {
            move.DropDownItems.Add(name, null, async (_, _) =>
            {
                if (list.SelectedItems.Count == 0 || list.SelectedItems[0].Tag is not string sessionId) return;
                try { await backendClient.SetSessionProjectAsync(sessionId, id); await RefreshAsync(); }
                catch (Exception ex) { if (!IsDisposed) SetListError(ex.Message); }
            });
        }
    }
}

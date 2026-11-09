using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal sealed partial class SessionListForm
{
    private readonly ComboBox projectPicker = new() { Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = "Project filter" };
    private IReadOnlyList<ManaProject> projects = Array.Empty<ManaProject>();
    private bool loadingProjects;
    private ManaProject? SelectedProject => projectPicker.SelectedItem as ManaProject;

    // The mockups have no project heading over the list, so the filter is a small funnel at the end of the search
    // pill: muted while every chat shows, in the accent while it's narrowed to a project (the search's placeholder
    // names it too). It opens the projects to pick from and the project commands. (projectPicker stays the state,
    // hidden.) Sized and placed by the caller.
    private Control BuildProjectControls()
    {
        var heading = new Button
        {
            FlatStyle = FlatStyle.Flat,
            BackColor = DarkTheme.Background,
            AccessibleName = "Project filter: All projects",
            Cursor = Cursors.Hand,
            UseMnemonic = false,
            TabStop = true,
        };
        heading.FlatAppearance.BorderSize = 0;
        var hovered = false;
        heading.MouseEnter += (_, _) => { hovered = true; heading.Invalidate(); };
        heading.MouseLeave += (_, _) => { hovered = false; heading.Invalidate(); };
        heading.Paint += (_, e) =>
        {
            var g = e.Graphics;
            using (var clear = new System.Drawing.SolidBrush(searchBox.BackColor)) // the pill's own fill
            {
                g.FillRectangle(clear, heading.ClientRectangle);
            }
            var filtered = projectPicker.SelectedIndex > 0;
            var color = filtered ? DarkTheme.Accent : hovered ? DarkTheme.Text : DarkTheme.Muted;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using var pen = new System.Drawing.Pen(color, 1.4f) { LineJoin = System.Drawing.Drawing2D.LineJoin.Round, StartCap = System.Drawing.Drawing2D.LineCap.Round, EndCap = System.Drawing.Drawing2D.LineCap.Round };
            float cx = heading.Width / 2f, cy = heading.Height / 2f;
            // A funnel: a wide top narrowing to a short spout.
            g.DrawLines(pen, new System.Drawing.PointF[] { new(cx - 6, cy - 5), new(cx + 6, cy - 5), new(cx + 1.5f, cy + 0.5f), new(cx + 1.5f, cy + 5), new(cx - 1.5f, cy + 3.5f), new(cx - 1.5f, cy + 0.5f), new(cx - 6, cy - 5) });
            if (heading.Focused && GlassSurface.ShowsFocusCues(heading))
            {
                ControlPaint.DrawFocusRectangle(g, heading.ClientRectangle);
            }
        };
        var menu = new ContextMenuStrip();
        heading.Disposed += (_, _) => menu.Dispose();
        heading.Click += (_, _) =>
        {
            menu.Items.Clear();
            for (var i = 0; i < projectPicker.Items.Count; i++)
            {
                var index = i;
                var pick = new ToolStripMenuItem(projectPicker.GetItemText(projectPicker.Items[i])) { Checked = projectPicker.SelectedIndex == i };
                pick.Click += (_, _) => projectPicker.SelectedIndex = index;
                menu.Items.Add(pick);
            }
            menu.Items.Add(new ToolStripSeparator());
            foreach (var (text, action, enabled) in new (string, Func<Task>, bool)[] {
                ("New project…", () => EditProjectAsync(null), true),
                ("Edit project…", () => SelectedProject is { } project ? EditProjectAsync(project) : Task.CompletedTask, SelectedProject is not null),
                ("Delete project…", DeleteProjectAsync, SelectedProject is not null),
            })
            {
                var item = new ToolStripMenuItem(text) { Enabled = enabled };
                item.Click += async (_, _) =>
                {
                    try { await action(); }
                    catch (Exception ex) { if (!IsDisposed) SetListError(ex.Message); }
                };
                menu.Items.Add(item);
            }
            menu.Show(heading, new System.Drawing.Point(0, heading.Height));
        };
        projectPicker.Items.Add("All projects");
        projectPicker.Items.Add("Ungrouped");
        projectPicker.SelectedIndex = 0;
        projectPicker.SelectedIndexChanged += (_, _) =>
        {
            heading.Invalidate();
            var name = projectPicker.Text;
            heading.AccessibleName = $"Project filter: {name}";
            railToolTip.SetToolTip(heading, $"Showing {(projectPicker.SelectedIndex == 0 ? "all projects" : name)}: click to pick a project");
            searchBox.PlaceholderText = projectPicker.SelectedIndex switch { 0 => "Search chats", 1 => "Search ungrouped chats", _ => $"Search {name}" };
            if (!loadingProjects) ShowSessions();
        };
        railToolTip.SetToolTip(heading, "Showing all projects: click to pick a project");
        projectPicker.Visible = false;
        heading.Controls.Add(projectPicker);
        return heading;
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

using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #997 (#911): Settings > Desktop -- the folders Mana may move and rename
// files in (DesktopActions.MoveFiles), saved to DesktopActionFolders. The
// list starts as the defaults; any of them can be removed. Read again on
// every move, so a change applies at once.
internal sealed class DesktopFoldersPanel : FlowLayoutPanel
{
    private readonly string? settingsPath;
    private readonly Func<string?> pickFolder;
    private readonly Func<string, bool> confirm;
    private readonly Label status = new() { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };

    internal ListBox Folders { get; } = new()
    {
        Width = 520,
        Height = 160,
        AccessibleName = "Allowed folders",
        BackColor = DarkTheme.Panel2,
        ForeColor = DarkTheme.Text,
        BorderStyle = BorderStyle.FixedSingle,
    };

    // settingsPath/pickFolder/confirm: tests pass a temp file and fakes;
    // the real ones are the settings file, a folder picker and a Yes/No box.
    public DesktopFoldersPanel(string? settingsPath = null, Func<string?>? pickFolder = null, Func<string, bool>? confirm = null)
    {
        this.settingsPath = settingsPath;
        this.pickFolder = pickFolder ?? PickWithDialog;
        this.confirm = confirm ?? (message => MessageBox.Show(FindForm(), message, "Desktop", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes);
        Dock = DockStyle.Fill;
        FlowDirection = FlowDirection.TopDown;
        WrapContents = false;
        AutoScroll = true;
        BackColor = DarkTheme.Background;

        var add = new Button { Text = "Add...", AutoSize = true };
        var remove = new Button { Text = "Remove", AutoSize = true };
        DarkTheme.ApplyButton(add);
        DarkTheme.ApplyButton(remove);
        add.Click += (_, _) => AddFolder();
        remove.Click += (_, _) => RemoveSelected();

        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttons.Controls.AddRange(new Control[] { add, remove, status });
        Controls.Add(new Label
        {
            Text = "Folders Mana may move and rename files in when I ask (she asks before each move, never deletes, and it can be undone):",
            AutoSize = true,
            ForeColor = DarkTheme.Text,
        });
        Controls.Add(Folders);
        Controls.Add(buttons);
        Reload();
    }

    internal string StatusText => status.Text;

    internal void AddFolder()
    {
        var path = pickFolder();
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }
        var (error, warning) = DesktopActions.CheckFolder(path);
        if (error is not null)
        {
            status.Text = error;
            return;
        }
        if (warning is not null && !confirm(warning))
        {
            return;
        }
        var full = System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(path));
        Save(Current().Append(full).Distinct(StringComparer.OrdinalIgnoreCase));
    }

    internal void RemoveSelected()
    {
        if (Folders.SelectedItem is string folder)
        {
            Save(Current().Where(f => !f.Equals(folder, StringComparison.OrdinalIgnoreCase)));
        }
    }

    private IEnumerable<string> Current() => Folders.Items.Cast<string>().ToList();

    private void Save(IEnumerable<string> folders)
    {
        var settings = ManaSettingsStore.Load(settingsPath);
        settings.DesktopActionFolders = folders.ToList();
        settings.Save(settingsPath);
        Reload();
        status.Text = "Saved.";
    }

    private void Reload()
    {
        Folders.Items.Clear();
        Folders.Items.AddRange(DesktopActions.AllowedFolders(ManaSettingsStore.Load(settingsPath).DesktopActionFolders).ToArray<object>());
    }

    private string? PickWithDialog()
    {
        using var dialog = new FolderBrowserDialog { Description = "A folder Mana may move files in", UseDescriptionForTitle = true };
        return dialog.ShowDialog(FindForm()) == DialogResult.OK ? dialog.SelectedPath : null;
    }
}

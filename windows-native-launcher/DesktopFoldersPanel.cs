using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #997 (#911): the folders Mana may move and rename files in
// (DesktopActions.MoveFiles), saved to DesktopActionFolders. The list starts
// as the defaults; any of them can be removed. Read again on every move, so
// a change applies at once. #1426: a row on Settings > Permissions, each
// folder one line with Remove on it.
internal sealed class DesktopFoldersPanel : Component
{
    private readonly string? settingsPath;
    private readonly Func<string?> pickFolder;
    private readonly Func<string, bool> confirm;
    private readonly Label status = SettingsRows.Status();

    internal RowList Folders { get; } = new() { MaxVisibleRows = 6, NameWidth = 120, AccessibleName = "Allowed folders" };
    internal IReadOnlyList<string> FolderPaths { get; private set; } = [];
    internal Control[] Rows { get; }

    // settingsPath/pickFolder/confirm: tests pass a temp file and fakes;
    // the real ones are the settings file, a folder picker and a Yes/No box.
    public DesktopFoldersPanel(string? settingsPath = null, Func<string?>? pickFolder = null, Func<string, bool>? confirm = null)
    {
        this.settingsPath = settingsPath;
        this.pickFolder = pickFolder ?? PickWithDialog;
        this.confirm = confirm ?? (message => MessageBox.Show(Folders.FindForm(), message, "Desktop", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes);
        Folders.ActionsFor = value => [new("", "Remove", () =>
        {
            Remove((string)value);
            return Task.CompletedTask;
        })];
        Rows = new Control[]
        {
            new SettingsRow("Folders she may tidy", "She moves and renames files in these when you ask: she asks before each move, never deletes, and it can be undone", "desktop folders files tidy move rename",
                below: true, SettingsRows.RoundPanel(Folders), SettingsRows.Line(SettingsRows.Action("Add folder…", AddFolder), status)),
        };
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
        Save(FolderPaths.Append(full).Distinct(StringComparer.OrdinalIgnoreCase), $"Added {full}");
    }

    internal void Remove(string folder) =>
        Save(FolderPaths.Where(f => !f.Equals(folder, StringComparison.OrdinalIgnoreCase)), $"Removed {folder}");

    private void Save(IEnumerable<string> folders, string done)
    {
        var settings = ManaSettingsStore.Load(settingsPath);
        settings.DesktopActionFolders = folders.ToList();
        settings.Save(settingsPath);
        Reload();
        status.Text = done;
    }

    // Each folder by its name, its full path beside it.
    private void Reload()
    {
        FolderPaths = DesktopActions.AllowedFolders(ManaSettingsStore.Load(settingsPath).DesktopActionFolders).ToList();
        Folders.ShowEntries(FolderPaths.Select(f => new RowList.Entry(f, System.IO.Path.GetFileName(f) is { Length: > 0 } name ? name : f, f)),
            null, "No folders: she won't move files anywhere");
    }

    private string? PickWithDialog()
    {
        using var dialog = new FolderBrowserDialog { Description = "A folder Mana may move files in", UseDescriptionForTitle = true };
        return dialog.ShowDialog(Folders.FindForm()) == DialogResult.OK ? dialog.SelectedPath : null;
    }
}

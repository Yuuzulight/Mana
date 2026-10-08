using System;
using System.IO;
using System.Linq;
using System.Runtime.ExceptionServices;
using System.Threading;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #997: Settings > Desktop's allowed folders. Real controls on an STA
// thread, never shown; the settings file is a temp one and the folder
// picker and Yes/No box are fakes, so no dialog opens.
[Collection("DarkTheme palette")]
public sealed class DesktopFoldersPanelTests : IDisposable
{
    private readonly string temp = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "mana-folders-" + Guid.NewGuid().ToString("N"))).FullName;
    private string SettingsPath => Path.Combine(temp, "settings.json");

    [Fact]
    public void AddsAfterAWarningAndRemovesDefaults_SavingTheList()
    {
        var extra = Directory.CreateDirectory(Path.Combine(temp, "Screens")).FullName;
        var warnings = 0;
        RunSta(() =>
        {
            using var panel = new DesktopFoldersPanel(SettingsPath, pickFolder: () => extra, confirm: _ => ++warnings > 0);
            var defaults = DesktopActions.AllowedFolders(null);
            Assert.Equal(defaults, panel.FolderPaths);

            panel.AddFolder(); // a temp folder usually warns (AppData); either way it's added
            Assert.Equal(DesktopActions.CheckFolder(extra).Warning is null ? 0 : 1, warnings);
            Assert.Equal(defaults.Append(extra), ManaSettingsStore.Load(SettingsPath).DesktopActionFolders!);

            panel.Remove(defaults[0]);
            Assert.DoesNotContain(defaults[0], ManaSettingsStore.Load(SettingsPath).DesktopActionFolders!);

            foreach (var folder in panel.FolderPaths.ToList())
            {
                panel.Remove(folder);
            }
            // an empty list means no folders, not the defaults again
            Assert.Empty(ManaSettingsStore.Load(SettingsPath).DesktopActionFolders!);
            Assert.Empty(panel.FolderPaths);
        });
    }

    [Fact]
    public void RefusesSystemAndNonLocalFolders_AndADeclinedWarningAddsNothing()
    {
        var picks = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            @"\\server\share",
            "relative\\folder",
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        };
        var next = 0;
        RunSta(() =>
        {
            using var panel = new DesktopFoldersPanel(SettingsPath, pickFolder: () => picks[next++], confirm: _ => false);
            panel.AddFolder();
            Assert.Contains("system folder", panel.StatusText);
            panel.AddFolder();
            Assert.Contains("on this PC", panel.StatusText);
            panel.AddFolder();
            Assert.Contains("on this PC", panel.StatusText);
            panel.AddFolder(); // warned, declined
            Assert.Null(ManaSettingsStore.Load(SettingsPath).DesktopActionFolders);
        });
    }

    [Fact]
    public void CheckFolder_WarnsAboutDrivesAndAppFilesButNotDocuments()
    {
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        Assert.NotNull(DesktopActions.CheckFolder(programFiles).Error);
        Assert.NotNull(DesktopActions.CheckFolder(Path.GetPathRoot(temp)!).Warning);
        Assert.NotNull(DesktopActions.CheckFolder(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)).Warning);
        Assert.Equal((null, null), DesktopActions.CheckFolder(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)));
    }

    // Even with a whole drive allowed, Windows and Program Files stay off limits.
    [Fact]
    public void Allowed_RefusesSystemFoldersUnderAnAllowedDrive()
    {
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var drive = new[] { Path.GetPathRoot(windows)! };
        Assert.Throws<InvalidOperationException>(() => DesktopActions.Allowed(Path.Combine(windows, "notepad.exe"), drive));
        Assert.Empty(DesktopActions.AllowedFolders(new[] { @"\\server\share", "relative" }));
    }

    private static void RunSta(Action body)
    {
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                body();
            }
            catch (Exception ex)
            {
                error = ex;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (error is not null)
        {
            ExceptionDispatchInfo.Capture(error).Throw();
        }
    }

    public void Dispose() => Directory.Delete(temp, recursive: true);
}

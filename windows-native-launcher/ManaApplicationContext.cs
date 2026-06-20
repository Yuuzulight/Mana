using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal sealed class ManaApplicationContext : ApplicationContext
{
    private readonly AvatarOverlayForm avatarOverlay;
    private readonly NotifyIcon trayIcon;
    private readonly ManaProcessManager processManager;
    private readonly ManaBackendClient backendClient;
    private readonly System.Windows.Forms.Timer statusTimer;

    public ManaApplicationContext()
    {
        var rootDir = FindRootDirectory();
        processManager = new ManaProcessManager(rootDir);
        backendClient = new ManaBackendClient();
        avatarOverlay = new AvatarOverlayForm(rootDir);

        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Mana",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu(),
        };

        trayIcon.DoubleClick += (_, _) => ShowStatus();
        avatarOverlay.Show();

        // Quick rundown: start the existing local services, but keep this host native and small.
        _ = StartServicesAsync();

        statusTimer = new System.Windows.Forms.Timer
        {
            Interval = 5000,
        };
        statusTimer.Tick += async (_, _) => await RefreshTrayStatusAsync();
        statusTimer.Start();
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show status", null, (_, _) => ShowStatus());
        menu.Items.Add("Open project folder", null, (_, _) => OpenProjectFolder());
        menu.Items.Add("Set avatar idle", null, (_, _) => avatarOverlay.SetState(AvatarState.Idle));
        menu.Items.Add("Set avatar talking", null, (_, _) => avatarOverlay.SetState(AvatarState.Talking));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit Mana", null, (_, _) => ExitThread());
        return menu;
    }

    private async Task StartServicesAsync()
    {
        await processManager.StartAsync();
        await RefreshTrayStatusAsync();
    }

    private async Task RefreshTrayStatusAsync()
    {
        try
        {
            var status = await backendClient.GetPerformanceStatusAsync();
            trayIcon.Text = status.GamingAppRunning ? "Mana - game mode" : "Mana";
        }
        catch
        {
            trayIcon.Text = "Mana - backend starting";
        }
    }

    private async void ShowStatus()
    {
        try
        {
            var status = await backendClient.GetPerformanceStatusAsync();
            MessageBox.Show(
                $"Backend: running\nGame detected: {status.GamingAppRunning}\nMemory: {status.TotalMemoryMb} MB\nTTS: {status.TtsProvider}",
                "Mana Status",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Mana backend is not ready yet.\n\n{error.Message}",
                "Mana Status",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private void OpenProjectFolder()
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = processManager.RootDirectory,
            UseShellExecute = true,
        });
    }

    protected override void ExitThreadCore()
    {
        statusTimer.Stop();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        avatarOverlay.Close();
        processManager.Dispose();
        base.ExitThreadCore();
    }

    private static string FindRootDirectory()
    {
        var current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (Directory.Exists(Path.Combine(current, "node-bot")))
            {
                return current;
            }

            var parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
    }
}

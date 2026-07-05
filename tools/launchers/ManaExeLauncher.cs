using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class ManaExeLauncher
{
    [STAThread]
    private static void Main()
    {
        var rootDirectory = @"C:\ManaAI\Mana";
        var launcherDirectory = Path.Combine(rootDirectory, "windows-launcher");
        var packageJson = Path.Combine(launcherDirectory, "package.json");

        if (!File.Exists(packageJson))
        {
            MessageBox.Show(
                "Mana could not find the Windows launcher at C:\\ManaAI\\Mana\\windows-launcher.",
                "Mana Launcher",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c npm run start",
                WorkingDirectory = launcherDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Mana could not start.\n\n" + error.Message,
                "Mana Launcher",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}

using Microsoft.Win32;

namespace Mana.NativeLauncher;

// Settings > Connection's "Start Mana when I sign in", off by default: a
// "Mana" value under HKCU's Run key that starts the live launcher. An update
// swaps builds inside the same live folder (LauncherUpdate), so the path
// stays good. The registry is the only record of it.
internal static class StartWithWindows
{
    public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Mana";

    public static string LauncherExe => Path.Combine(LauncherUpdate.LiveDir, "ManaNativeLauncher.exe");

    public static bool IsOn(string runKeyPath = RunKeyPath)
    {
        using var key = Registry.CurrentUser.OpenSubKey(runKeyPath);
        return key?.GetValue(ValueName) is string;
    }

    public static void Set(bool on, string exePath, string runKeyPath = RunKeyPath)
    {
        using var key = Registry.CurrentUser.CreateSubKey(runKeyPath);
        if (on)
        {
            key.SetValue(ValueName, $"\"{exePath}\"");
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}

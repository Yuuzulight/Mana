using System;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // #995: a staged build asked to install itself -- no UI of its own.
        if (args.Length >= 2 && args[0] == LauncherUpdate.InstallArg && int.TryParse(args[1], out var oldPid))
        {
            LauncherUpdate.RunInstaller(LauncherUpdate.LiveDir, oldPid, args[2..], TimeSpan.FromMinutes(1));
            return;
        }

        // #689: a second launcher shows the first one's window and exits.
        using var instance = SingleInstance.Claim();
        if (instance is null)
        {
            return;
        }

        // #995: a build staged while Mana was closed is installed first.
        var updated = args.Contains(LauncherUpdate.UpdatedArg);
        if (!updated && LauncherUpdate.IsStaged(LauncherUpdate.LiveDir))
        {
            LauncherUpdate.StartInstaller(LauncherUpdate.LiveDir, args);
            return;
        }

        // node-bot/.env first, before anything reads its environment --
        // every env-driven setting below, and every child process, sees it.
        DotEnvFile.Load(Path.Combine(ManaApplicationContext.FindRootDirectory(), "node-bot", ".env"));

        // #576: must run before anything else touches DarkTheme -- the
        // class's own static fields (and the SolidBrush instances built
        // from them) are only ever assigned their real value once, the
        // first time any DarkTheme member is used, so this has to be the
        // first such use.
        var theme = ManaThemeSettings.Load();
        DarkTheme.ApplyPreset(theme.Preset, theme.AccentHex);

        ApplicationConfiguration.Initialize();
        using var context = new ManaApplicationContext(LauncherUpdate.ChatBoundsFrom(args));
        if (updated)
        {
            // #995: the self-check the installer waits for: this build got
            // as far as a running message loop.
            Application.Idle += WriteStartedMarker;
        }
        Application.Run(context);
    }

    private static void WriteStartedMarker(object? sender, EventArgs e)
    {
        Application.Idle -= WriteStartedMarker;
        File.WriteAllText(Path.Combine(LauncherUpdate.LiveDir, LauncherUpdate.StartedMarker), "");
    }
}

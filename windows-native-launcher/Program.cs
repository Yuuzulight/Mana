using System;
using System.IO;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // #689: a second launcher shows the first one's window and exits.
        using var instance = SingleInstance.Claim();
        if (instance is null)
        {
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
        using var context = new ManaApplicationContext();
        Application.Run(context);
    }
}

using System;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
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

using System;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var context = new ManaApplicationContext();
        Application.Run(context);
    }
}

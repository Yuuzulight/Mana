using System;
using System.Linq;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Microsoft.Win32;
using Xunit;

namespace ManaNativeLauncher.Tests;

// Against a throwaway key under HKCU\Software, never the real Run key.
[Collection("DarkTheme palette")]
public class StartWithWindowsTests
{
    [Fact]
    public void Checkbox_WritesAndRemovesTheRunValueForTheLiveLauncher()
    {
        var keyPath = @"Software\ManaNativeLauncherTests\" + Guid.NewGuid().ToString("N");
        try
        {
            ToolPanelHostTests.RunSta(() =>
            {
                using var row = SettingsPanel.BuildStartWithWindowsRow(keyPath);
                var check = row.Controls.Cast<Control>().SelectMany(c => c.Controls.Cast<Control>()).OfType<CheckBox>().Single();
                Assert.False(check.Checked); // off by default

                check.Checked = true;
                using (var key = Registry.CurrentUser.OpenSubKey(keyPath))
                {
                    Assert.Equal($"\"{StartWithWindows.LauncherExe}\"", key?.GetValue("Mana"));
                }
                Assert.True(StartWithWindows.IsOn(keyPath));

                check.Checked = false;
                Assert.False(StartWithWindows.IsOn(keyPath));
            });
        }
        finally
        {
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\ManaNativeLauncherTests", throwOnMissingSubKey: false);
        }
    }
}

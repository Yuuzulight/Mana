using System.Linq;
using System.Net;
using System.Net.Http;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1119: Settings in the chat window's narrow tool panel. STA, never shown.
// Every class that builds a SettingsPanel shares one collection: built in
// parallel, WinForms' KeysConverter fills its static key-name table twice.
[Collection("DarkTheme palette")]
public class SettingsPanelLayoutTests
{
    [Fact]
    public void Narrow_SwapsTheTabStripForADropdown()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Width = 800 };
            var tabs = panel.Controls.OfType<TabControl>().Single();
            _ = tabs.Handle; // as on screen: TabControl measures its strip and raises SelectedIndexChanged only with one
            var strip = tabs.ItemSize;
            var rects = Enumerable.Range(0, tabs.TabCount).Select(tabs.GetTabRect).ToList();
            Assert.Equal(TabSizeMode.Normal, tabs.SizeMode);

            panel.Width = 320;
            Assert.Equal(TabSizeMode.Fixed, tabs.SizeMode);
            Assert.Equal(1, tabs.ItemSize.Height);
            Assert.Equal(tabs.TabPages.Count, panel.PagePicker.Items.Count);
            panel.PagePicker.SelectedIndex = 3;
            Assert.Equal(3, tabs.SelectedIndex);
            tabs.SelectedIndex = 5;
            Assert.Equal(5, panel.PagePicker.SelectedIndex);

            panel.Width = 800;
            Assert.Equal(TabSizeMode.Normal, tabs.SizeMode);
            Assert.Equal(strip, tabs.ItemSize);
            Assert.Equal(rects, Enumerable.Range(0, tabs.TabCount).Select(tabs.GetTabRect).ToList());
        });
    }
}

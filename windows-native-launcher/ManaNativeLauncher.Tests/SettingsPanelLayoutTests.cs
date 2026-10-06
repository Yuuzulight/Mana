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

    // #1336: Settings > Privacy tab verification
    [Fact]
    public void PrivacyTab_IsRegisteredWithExportAndDeleteControls()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Width = 800 };
            var tabs = panel.Controls.OfType<TabControl>().Single();
            var privacyTab = tabs.TabPages.Cast<TabPage>().FirstOrDefault(p => p.Text == "Privacy");
            Assert.NotNull(privacyTab);

            var buttons = GetAllDescendants(privacyTab)
                .OfType<Button>()
                .ToList();

            Assert.Contains(buttons, b => b.AccessibleName == "Export everything");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete everything");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Voice Data");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Chat History");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Memory Facts");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Vault Sync State");
            Assert.Contains(buttons, b => b.AccessibleName == "Delete Caches & Logs");
        });
    }

    [Fact]
    public void CloudFallback_HasOptInAndAllTimingOptions_OffByDefault()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));
            using var panel = new SettingsPanel(client, new BackendLogBuffer()) { Dock = DockStyle.None, Size = new System.Drawing.Size(800, 900) };
            var group = GetAllDescendants(panel).OfType<GroupBox>().Single(g => g.Text == "Chat Cloud Fallback");
            var toggle = GetAllDescendants(group).OfType<CheckBox>().Single();
            Assert.False(toggle.Checked);
            var timing = GetAllDescendants(group).OfType<ComboBox>().Single();
            Assert.Equal(new[] { "30 seconds", "60 seconds", "No timeout" }, timing.Items.Cast<string>());
            Assert.Equal("No timeout", timing.SelectedItem);
            Assert.Contains(GetAllDescendants(group).OfType<TextBox>(), box => box.UseSystemPasswordChar);
            if (Environment.GetEnvironmentVariable("MANA_CHAT_MODEL_SNAPSHOT_DIR") is { } output)
            {
                using var host = new Panel { Size = new System.Drawing.Size(500, 300), BackColor = DarkTheme.Background };
                host.Controls.Add(group);
                group.Location = System.Drawing.Point.Empty;
                host.CreateControl();
                group.CreateControl();
                foreach (var child in GetAllDescendants(group)) { child.CreateControl(); _ = child.Handle; }
                group.PerformLayout();
                foreach (var box in GetAllDescendants(group).OfType<TextBox>())
                {
                    Assert.True(box.Visible);
                    Assert.True(box.Width >= 180 && box.Height >= 20);
                    box.Text = box.UseSystemPasswordChar ? "test-key" : "configured-endpoint-model";
                }
                using var bitmap = new System.Drawing.Bitmap(group.Width, group.Height);
                group.DrawToBitmap(bitmap, group.ClientRectangle);
                Directory.CreateDirectory(output);
                bitmap.Save(Path.Combine(output, "cloud-fallback-settings.png"));
            }
        });
    }

    private static System.Collections.Generic.IEnumerable<Control> GetAllDescendants(Control control)
    {
        yield return control;
        foreach (Control child in control.Controls)
        {
            foreach (var descendant in GetAllDescendants(child))
            {
                yield return descendant;
            }
        }
    }
}


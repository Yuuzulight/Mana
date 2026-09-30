using System;
using System.IO;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1118: the chat window's tool panel host. Real controls on an STA thread,
// never shown; the panel's state goes to a temp settings file.
public class ToolPanelHostTests : IDisposable
{
    private readonly string settings = Path.Combine(Path.GetTempPath(), $"mana-toolpanel-{Guid.NewGuid():N}.json");

    [Fact]
    public void RailIcons_OpenLazily_ToggleAndSwap()
    {
        RunSta(() =>
        {
            using var toolTip = new ToolTip();
            using var host = new ToolPanelHost(toolTip, settings);
            var created = 0;
            var a = new Button();
            var b = new Button();
            host.Add("a", "Alpha", a, () => { created++; return new Label(); });
            host.Add("b", "Beta", b, () => new Label());
            Assert.Equal(0, created);
            Assert.Equal("Alpha", a.AccessibleName);

            Click(a);
            Assert.True(host.IsOpen("a"));
            Click(b);
            Assert.Equal("b", host.OpenId);
            Click(a);
            Assert.Equal(1, created); // kept, not rebuilt
            Click(a); // the open one's icon closes it
            Assert.Null(host.OpenId);
            Assert.Null(ManaSettingsStore.Load(settings).RailTool);
        });
    }

    [Fact]
    public void Unpinned_ClosesOnChat_Pinned_StaysAndIsRestored()
    {
        RunSta(() =>
        {
            using var toolTip = new ToolTip();
            using (var host = new ToolPanelHost(toolTip, settings))
            {
                host.Add("a", "Alpha", new Button(), () => new Label());
                host.Open("a");
                Assert.True(host.CloseUnlessPinned());
                Assert.Null(host.OpenId);

                host.Pinned = true;
                host.Open("a");
                Assert.False(host.CloseUnlessPinned());
                Assert.Equal("a", host.OpenId);
            }

            var saved = ManaSettingsStore.Load(settings);
            Assert.Equal("a", saved.RailTool);
            Assert.True(saved.RailToolPinned);
            using var relaunched = new ToolPanelHost(toolTip, settings);
            Assert.True(relaunched.Pinned);
            relaunched.Add("a", "Alpha", new Button(), () => new Label());
            Assert.Equal("a", relaunched.OpenId);
        });
    }

    [Fact]
    public void UnpinnedTool_IsNotReopenedOnLaunch_AndWidthIsRemembered()
    {
        new ManaSettingsStore { RailTool = "a", RailToolWidth = 5000 }.Save(settings);
        RunSta(() =>
        {
            using var toolTip = new ToolTip();
            using var host = new ToolPanelHost(toolTip, settings);
            host.Add("a", "Alpha", new Button(), () => new Label());
            Assert.Null(host.OpenId);
            Assert.Equal(600, host.Width); // clamped
        });
    }

    [Fact]
    public void CtrlDigits_FollowRailOrder()
    {
        RunSta(() =>
        {
            using var toolTip = new ToolTip();
            using var host = new ToolPanelHost(toolTip, settings);
            using var rail = new Panel { Width = 44, Height = 400 };
            var settingsIcon = new Button { Dock = DockStyle.Bottom, Height = 44 };
            var top = new Button { Dock = DockStyle.Top, Height = 44 };
            var second = new Button { Dock = DockStyle.Top, Height = 44 };
            rail.Controls.Add(settingsIcon);
            rail.Controls.Add(top);
            rail.Controls.Add(second);
            second.BringToFront(); // as RegisterRailTool does
            host.Add("settings", "Settings", settingsIcon, () => new Label());
            host.Add("top", "Top", top, () => new Label());
            host.Add("second", "Second", second, () => new Label());

            Assert.True(host.HandleShortcut(Keys.Control | Keys.D1));
            Assert.Equal("top", host.OpenId);
            Assert.True(host.HandleShortcut(Keys.Control | Keys.D3));
            Assert.Equal("settings", host.OpenId);
            Assert.False(host.HandleShortcut(Keys.Control | Keys.D4)); // no fourth tool
            Assert.False(host.HandleShortcut(Keys.D1));
            Assert.False(host.HandleShortcut(Keys.Control | Keys.Shift | Keys.D1));
        });
    }

    [Fact]
    public void FailingTool_ShowsErrorWithRetry()
    {
        RunSta(() =>
        {
            using var toolTip = new ToolTip();
            using var host = new ToolPanelHost(toolTip, settings);
            var fail = true;
            host.Add("a", "Alpha", new Button(), () => fail ? throw new InvalidOperationException("backend down") : new Label { Text = "ok" });
            host.Open("a");

            var retry = Find<Button>(host, b => b.Text == "Retry");
            Assert.Contains("Couldn't open Alpha: backend down", Find<Label>(host, l => l.Text.StartsWith("Couldn't")).Text);
            fail = false;
            Click(retry);
            Assert.Equal("a", host.OpenId);
            Find<Label>(host, l => l.Text == "ok");
        });
    }

    [Fact]
    public void PanelButtons_HaveScreenReaderNames()
    {
        RunSta(() =>
        {
            using var toolTip = new ToolTip();
            using var host = new ToolPanelHost(toolTip, settings);
            var pin = Find<Button>(host, b => b.Text == "Pin");
            Assert.Equal("Pin panel open", pin.AccessibleName);
            Assert.Equal("Close panel", Find<Button>(host, b => b.Text == "×").AccessibleName);
            Click(pin);
            Assert.Equal("Unpin panel", pin.AccessibleName);
            Assert.True(ManaSettingsStore.Load(settings).RailToolPinned);
        });
    }

    // PerformClick does nothing on a control that isn't on screen.
    private static void Click(Button button) =>
        typeof(Control).GetMethod("OnClick", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(button, new object[] { EventArgs.Empty });

    private static T Find<T>(Control root, Func<T, bool> match) where T : Control
    {
        foreach (Control child in root.Controls)
        {
            if (child is T hit && match(hit))
            {
                return hit;
            }
            try
            {
                return Find(child, match);
            }
            catch (InvalidOperationException)
            {
            }
        }
        throw new InvalidOperationException($"No matching {typeof(T).Name}.");
    }

    internal static void RunSta(Action body)
    {
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                body();
            }
            catch (Exception ex)
            {
                error = ex;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (error is not null)
        {
            ExceptionDispatchInfo.Capture(error).Throw();
        }
    }

    public void Dispose() => File.Delete(settings);
}

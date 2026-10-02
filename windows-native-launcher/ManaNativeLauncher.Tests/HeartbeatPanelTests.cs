using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Threading;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #699: Settings > Heartbeat. Real controls on an STA thread, never shown;
// the backend is a fake handler, so nothing is saved.
[Collection("DarkTheme palette")]
public sealed class HeartbeatPanelTests
{
    private const string Listing =
        "{\"items\":[" +
        "{\"id\":\"a1\",\"text\":\"check github.com notifications\",\"schedule\":\"every 2h\",\"permissions\":[\"network\"],\"urgent\":false,\"enabled\":true}," +
        "{\"id\":\"b2\",\"text\":\"warn me if D: is low\",\"schedule\":\"every 30m\",\"permissions\":[],\"urgent\":true,\"enabled\":false}]}";

    [Fact]
    public void ListsChecks_SwitchesOneOff_AddsAndRemoves_SavingTheWholeList()
    {
        var puts = new List<string>();
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
        {
            if (request.Method == HttpMethod.Put)
            {
                Assert.Equal("/heartbeat/items", request.RequestUri!.AbsolutePath);
                puts.Add(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Listing, Encoding.UTF8, "application/json") };
        }));
        RunSta(() =>
        {
            using var panel = new HeartbeatPanel(client, loadNow: false);
            panel.ReloadAsync().GetAwaiter().GetResult();
            Assert.Equal(
                new[] { "every 2h [network]: check github.com notifications", "(off) every 30m [urgent]: warn me if D: is low" },
                panel.Checks.Items.Cast<string>());

            panel.Checks.SelectedIndex = 0;
            Assert.True(panel.Network.Checked);
            Assert.Equal("every 2h", panel.EditSchedule.Text);
            panel.On.Checked = false;
            panel.SaveSelectedAsync().GetAwaiter().GetResult();
            Assert.Contains("\"text\":\"check github.com notifications\",\"schedule\":\"every 2h\",\"permissions\":[\"network\"],\"urgent\":false,\"enabled\":false}", puts[0]);
            Assert.Equal("Saved.", panel.StatusText);

            panel.Checks.SelectedIndex = -1;
            panel.EditText.Text = "new check";
            panel.Write.Checked = true;
            panel.AddAsync().GetAwaiter().GetResult();
            Assert.Contains("\"text\":\"new check\",\"schedule\":\"\",\"permissions\":[\"write\"],\"urgent\":false,\"enabled\":true}]}", puts[1]);

            panel.Checks.SelectedIndex = 1;
            panel.RemoveSelectedAsync().GetAwaiter().GetResult();
            Assert.DoesNotContain("warn me if D: is low", puts[2]);
            Assert.Contains("check github.com notifications", puts[2]);
        });
    }

    [Fact]
    public void ARefusedSaveShowsNodeBotsReason()
    {
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request => request.Method == HttpMethod.Put
            ? new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("{\"error\":\"check 1: the shortest interval is every 5m\"}", Encoding.UTF8, "application/json") }
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"items\":[]}", Encoding.UTF8, "application/json") }));
        RunSta(() =>
        {
            using var panel = new HeartbeatPanel(client, loadNow: false);
            panel.ReloadAsync().GetAwaiter().GetResult();
            panel.EditText.Text = "too often";
            panel.EditSchedule.Text = "every 1m";
            panel.AddAsync().GetAwaiter().GetResult();
            Assert.Equal("Couldn't save: check 1: the shortest interval is every 5m", panel.StatusText);
        });
    }

    private static void RunSta(Action body)
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
}

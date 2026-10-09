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

// #697: Settings > Proactive tests. Real controls on an STA thread, never shown.
[Collection("DarkTheme palette")]
public sealed class ProactivePanelTests
{
    private const string InitialSettingsJson =
        "{\"ok\":true," +
        "\"quietHours\":{\"enabled\":false,\"start\":\"01:00\",\"end\":\"09:00\"}," +
        "\"inQuietHours\":false," +
        "\"snoozedUntil\":null," +
        "\"muted\":[\"briefing\"]," +
        "\"away\":false," +
        "\"lastRemark\":null," +
        "\"learned\":{\"trivia\":{\"score\":-0.25,\"multiplier\":1.19},\"weather\":{\"score\":0.5,\"multiplier\":0.71}}" +
        "}";

    [Fact]
    public void LoadsSettings_PopulatesControls_AndHandlesUpdates()
    {
        var postedBodies = new List<string>();
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
        {
            if (request.Method == HttpMethod.Get && request.RequestUri!.AbsolutePath == "/proactive/settings")
            {
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(InitialSettingsJson, Encoding.UTF8, "application/json") };
            }
            if (request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/proactive/settings")
            {
                var body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
                postedBodies.Add(body);
                // Return updated response reflecting changes
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(InitialSettingsJson, Encoding.UTF8, "application/json") };
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }));

        RunSta(() =>
        {
            using var panel = new ProactivePanel(client, loadNow: false);
            panel.ReloadAsync().GetAwaiter().GetResult();

            // Quiet hours controls
            Assert.False(panel.QuietHoursCheck.Checked);
            Assert.Equal("01:00", panel.QuietStartBox.Text);
            Assert.Equal("09:00", panel.QuietEndBox.Text);

            // Learned list
            Assert.Equal(2, panel.LearnedList.Items.Count);
            Assert.Contains("trivia", panel.LearnedList.Items[0].ToString()!);
            Assert.Contains("weather", panel.LearnedList.Items[1].ToString()!);

            // Muted list
            Assert.Single(panel.MutedList.Items);
            Assert.Equal("briefing", panel.MutedList.Items[0].Text);

            // Audio awareness checkbox
            var originalState = ManaSettingsStore.Load().HoldSpeechDuringAudio;
            try
            {
                panel.HoldSpeechCheck.Checked = !originalState;
                Assert.Equal(!originalState, ManaSettingsStore.Load().HoldSpeechDuringAudio);
            }
            finally
            {
                var store = ManaSettingsStore.Load();
                store.HoldSpeechDuringAudio = originalState;
                store.Save();
            }
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

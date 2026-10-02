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

// #914: Settings > Characters. Real controls on an STA thread, never shown;
// the backend is a fake handler, so nothing is saved and no dialog opens.
[Collection("DarkTheme palette")]
public sealed class RelationshipPanelTests
{
    private const string Listing =
        "{\"characters\":[" +
        "{\"id\":\"mana\",\"name\":\"Mana\",\"notes\":[{\"id\":\"n1\",\"text\":\"They call me a gremlin.\"}],\"milestones\":[{\"id\":\"m1\",\"text\":\"The first time we talked\",\"date\":\"2025-06-03\"}]}," +
        "{\"id\":\"evil-mana\",\"name\":\"Evil Mana\",\"notes\":[],\"milestones\":[]}]}";

    [Fact]
    public void ListsEachCharactersItems_EditsAMilestonesDate_AndRemovesANote()
    {
        var requests = new List<string>();
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
        {
            requests.Add($"{request.Method} {request.RequestUri!.AbsolutePath} {request.Content?.ReadAsStringAsync().GetAwaiter().GetResult()}".TrimEnd());
            var json = request.RequestUri!.AbsolutePath == "/mood" ? "{\"summary\":\"tired, chatty\",\"emotion\":\"thinking\",\"energy\":0.2}"
                : request.Method == HttpMethod.Get ? Listing : "{}";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }));
        RunSta(() =>
        {
            using var panel = new RelationshipPanel(client, loadNow: false);
            panel.ReloadAsync().GetAwaiter().GetResult();
            Assert.Equal(new[] { "Mana", "Evil Mana" }, panel.Characters.Items.Cast<string>());
            Assert.Equal("Right now she's feeling tired, chatty.", panel.MoodText); // #700: words, never numbers
            Assert.Equal(new[] { "Note: They call me a gremlin.", "Milestone 2025-06-03: The first time we talked" }, panel.Items.Items.Cast<string>());

            panel.Items.SelectedIndex = 1;
            Assert.Equal("2025-06-03", panel.EditDate.Text);
            panel.EditDate.Text = "2025-06-04";
            panel.SaveSelectedAsync().GetAwaiter().GetResult();
            Assert.Contains("PUT /characters/mana/relationship/milestones/m1 {\"text\":\"The first time we talked\",\"date\":\"2025-06-04\"}", requests);
            Assert.Equal("Saved.", panel.StatusText);

            panel.Items.SelectedIndex = 0;
            Assert.False(panel.EditDate.Enabled, "a note has no date");
            panel.RemoveSelectedAsync().GetAwaiter().GetResult();
            Assert.Contains("DELETE /characters/mana/relationship/notes/n1", requests);

            panel.Characters.SelectedIndex = 1;
            Assert.Empty(panel.Items.Items);
        });
    }

    [Fact]
    public void AFailedLoadSaysSo()
    {
        var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));
        RunSta(() =>
        {
            using var panel = new RelationshipPanel(client, loadNow: false);
            panel.ReloadAsync().GetAwaiter().GetResult();
            Assert.StartsWith("Couldn't load:", panel.StatusText);
        });
    }

    [Theory]
    [InlineData("note", "They like my teasing.", null, "Noted: \"They like my teasing.\"")]
    [InlineData("milestone", "Our first duet.", "2026-09-20", "I'll remember this: \"Our first duet.\" (2026-09-20)")]
    public void NotedLine_SaysWhatSheNoted(string kind, string text, string? date, string line) =>
        Assert.Equal(line, VoiceLoop.NotedLine(kind, text, date));

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

using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1426: Settings > Memory's character cards and their editor.
[Collection("DarkTheme palette")]
public class CharactersPanelTests
{
    private const string Profiles = "{\"active\":\"mana\",\"characters\":[" +
        "{\"id\":\"mana\",\"name\":\"Mana\",\"persona\":\"You are Mana.\",\"handoff\":\"Mana's back~\",\"builtIn\":true,\"promptEdited\":false,\"voice\":null,\"live2dModel\":null}," +
        "{\"id\":\"evil-mana\",\"name\":\"Evil Mana\",\"persona\":\"You are Evil Mana.\",\"handoff\":\"\",\"builtIn\":true,\"promptEdited\":true,\"voice\":null,\"live2dModel\":null}," +
        "{\"id\":\"aoi\",\"name\":\"Aoi\",\"persona\":\"You are Aoi.\",\"handoff\":\"Aoi here.\",\"builtIn\":false,\"promptEdited\":false,\"voice\":{\"file\":\"aoi.wav\",\"refText\":\"hello\"},\"live2dModel\":null}]}";

    [Fact]
    public void Cards_ShowEachCharacter_AndTheEditorSavesHer()
    {
        var requests = new List<string>();
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
        {
            var body = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult() ?? "";
            requests.Add($"{request.Method} {request.RequestUri!.AbsolutePath} {body}".TrimEnd());
            var json = request.RequestUri!.AbsolutePath switch
            {
                "/admin/characters" when request.Method == HttpMethod.Get => Profiles,
                "/characters/relationships" => "{\"characters\":[{\"id\":\"aoi\",\"name\":\"Aoi\",\"notes\":[{\"id\":\"n1\",\"text\":\"likes tea\"}],\"milestones\":[]}]}",
                _ => "{}",
            };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }));
        ToolPanelHostTests.RunSta(() =>
        {
            var switched = new List<string>();
            using var panel = new CharactersPanel(client, id => { switched.Add(id); return Task.CompletedTask; });
            panel.ReloadAsync().GetAwaiter().GetResult();
            var cards = panel.Cards.ToList();
            Assert.Equal(new[] { "Mana", "Evil Mana", "Aoi" }, cards.Select(c => c.Profile.Name)); // the active one first
            Assert.Null(cards[0].SwitchButton); // she's talking now
            cards[2].SwitchButton!.PerformClick();
            Assert.Equal(new[] { "aoi" }, switched);

            panel.Cards.Last().Controls.OfType<Button>().Single(b => b.AccessibleName == "Edit Aoi").PerformClick();
            var editor = panel.Editor!;
            Assert.Equal("Aoi", editor.NameBox.Text);
            Assert.Null(editor.Voice); // her own clip stays
            editor.PromptBox.Text = new string('x', 4001);
            Assert.False(editor.SaveButton.Enabled);
            Assert.Equal("4,001 / 4,000", editor.Count.Text);
            editor.PromptBox.Text = "You are Aoi, kinder.";
            Assert.True(editor.SaveButton.Enabled);
            editor.SaveButton.PerformClick();
            for (var i = 0; i < 50 && panel.Editor is not null; i++)
            {
                Application.DoEvents();
                System.Threading.Thread.Sleep(20);
            }
            Assert.Null(panel.Editor); // back to the cards
            Assert.Equal("Saved Aoi", panel.StatusText);
            Assert.Contains(requests, r => r.StartsWith("PUT /admin/characters/aoi") && r.Contains("\"persona\":\"You are Aoi, kinder.\"") && !r.Contains("\"voice\""));
        });
    }

    [Fact]
    public void AnEmptyNameOrPromptIsNotSent()
    {
        var sent = 0;
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
        {
            if (request.Method != HttpMethod.Get)
            {
                sent++;
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Profiles, Encoding.UTF8, "application/json") };
        }));
        ToolPanelHostTests.RunSta(() =>
        {
            using var editor = new CharacterEditor(null);
            Assert.Equal("Give her a name", editor.Problem());
            editor.NameBox.Text = "Rin";
            Assert.Equal("Write her character prompt", editor.Problem());
            editor.PromptBox.Text = "You are Rin.";
            Assert.Null(editor.Problem());
            Assert.Equal("mana", editor.Voice);
            Assert.Null(editor.Model); // a new character with Mana's model: nothing to change
            Assert.Equal(0, sent);
        });
    }
}

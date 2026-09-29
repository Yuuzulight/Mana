using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #680 part 1: text actions on the selection in any app.
public class TextActionsTests
{
    private static string TempFile(string? content)
    {
        var path = Path.Combine(Path.GetTempPath(), $"text-actions-{Guid.NewGuid():N}.json");
        if (content is not null)
        {
            File.WriteAllText(path, content);
        }
        return path;
    }

    [Theory]
    [InlineData(null)]           // no file
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{\"name\":\"x\"}")]
    public void Load_FallsBackToTheDefaults(string? content)
    {
        Assert.Same(TextAction.Defaults, TextAction.Load(TempFile(content)));
    }

    [Fact]
    public void Load_ReadsCustomActionsAndSkipsIncompleteOnes()
    {
        var actions = TextAction.Load(TempFile("""
            [
              { "name": "Translate to Japanese", "prompt": "Translate into Japanese." },
              { "name": "No prompt" },
              { "name": " ", "prompt": "blank name" }
            ]
            """));
        Assert.Equal([new TextAction("Translate to Japanese", "Translate into Japanese.")], actions);
    }

    [Fact]
    public void ClipboardSnapshot_KeepsEveryFormat()
    {
        var original = new DataObject();
        original.SetData(DataFormats.UnicodeText, false, "what I had copied");
        original.SetData("Mana.Custom", false, "custom payload");

        var restored = ClipboardSnapshot.From(original).ToDataObject();

        Assert.NotNull(restored);
        Assert.Equal(original.GetFormats(false).OrderBy(f => f), restored!.GetFormats(false).OrderBy(f => f));
        Assert.Equal("what I had copied", restored.GetData(DataFormats.UnicodeText, false));
        Assert.Equal("custom payload", restored.GetData("Mana.Custom", false));
    }

    [Fact]
    public void ClipboardSnapshot_OfAnEmptyClipboardRestoresToEmpty()
    {
        Assert.Null(ClipboardSnapshot.From(null).ToDataObject());
        Assert.Null(ClipboardSnapshot.From(new DataObject()).ToDataObject());
    }

    [Fact]
    public async Task RunTextActionAsync_SendsThePromptAndTextAndReturnsTheAnswer()
    {
        string? path = null;
        string? body = null;
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"<think>hmm</think>\\n Their going. \"}}]}",
                    Encoding.UTF8, "application/json"),
            };
        }));

        var answer = await client.RunTextActionAsync("Fix the grammar.", "there going");

        Assert.Equal("/v1/chat/completions", path);
        Assert.Contains("\"role\":\"system\",\"content\":\"Fix the grammar.\"", body);
        Assert.Contains("\"role\":\"user\",\"content\":\"there going\"", body);
        Assert.Equal("Their going.", answer);
    }
}

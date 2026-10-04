using System.Drawing;
using System.Net;
using System.Text;
using System.Text.Json;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

[Collection("DarkTheme palette")]
public class ChatModelTests
{
    [Fact]
    public async Task BackendPicker_ParsesOptionsAndPostsTheSessionChoice()
    {
        var handler = new FakeHttpMessageHandler(request =>
        {
            if (request.Method == HttpMethod.Get)
            {
                Assert.Contains("sessionId=one%20two", request.RequestUri!.OriginalString);
                return Json("""{"selected":"local:fast","models":[{"id":"local:fast","label":"Local: fast"}]}""");
            }
            using var document = JsonDocument.Parse(request.Content!.ReadAsStringAsync().Result);
            Assert.Equal("one two", document.RootElement.GetProperty("sessionId").GetString());
            Assert.Equal("local:fast", document.RootElement.GetProperty("model").GetString());
            return Json("{}");
        });
        var client = new ManaBackendClient(handler);
        var choices = await client.GetChatModelsAsync("one two");
        Assert.Equal("local:fast", choices.Selected);
        Assert.Equal("Local: fast", Assert.Single(choices.Models).ToString());
        await client.SetChatModelAsync("one two", "local:fast");
    }

    [Fact]
    public async Task SavingFallback_OmitsBlankUnchangedKey_AndCarriesAllThreeTimingChoices()
    {
        int? sentSeconds = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            Assert.Equal("/models/cloud-fallback", request.RequestUri!.AbsolutePath);
            using var document = JsonDocument.Parse(request.Content!.ReadAsStringAsync().Result);
            var root = document.RootElement;
            Assert.True(root.GetProperty("enabled").GetBoolean());
            Assert.False(root.TryGetProperty("apiKey", out _));
            sentSeconds = root.GetProperty("timeoutSeconds").GetInt32();
            return Json("{}");
        });
        var client = new ManaBackendClient(handler);
        foreach (var seconds in new[] { 30, 60, 0 })
        {
            await client.SetCloudFallbackAsync(true, seconds, "https://endpoint.example/v1", null, "configured-model");
            Assert.Equal(seconds, sentSeconds);
        }
    }

    [Fact]
    public async Task ModelStatus_ParsesLocalOnlyAndFallbackWithoutAKey()
    {
        var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => Json("""{"profiles":{},"localOnly":true,"fallback":{"enabled":true,"active":false,"timeoutSeconds":60,"model":"configured-model","hasApiKey":true}}""")));
        var status = await client.GetModelStatusAsync();
        Assert.True(status.LocalOnly);
        Assert.True(status.Fallback.Enabled);
        Assert.False(status.Fallback.Active);
        Assert.Equal(60, status.Fallback.TimeoutSeconds);
        Assert.True(status.Fallback.HasApiKey);
    }

    [Theory]
    [InlineData(420)]
    [InlineData(900)]
    public void ModelLabel_IsSavedInHistoryAndDoesNotOverlapMessageActions(int width)
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var view = new ChatView { Dock = DockStyle.None, Size = new Size(width, 400) };
            view.CreateControl();
            var model = "configured-model-with-a-very-long-provider-name";
            view.ShowHistory(new[] { new ManaSessionTurn { User = "Hello", Assistant = "A verified response.", AnswerModel = model, CloudFallback = true } });
            var message = view.Messages.Last();
            Assert.Contains(model, message.Speaker);
            Assert.Contains("(fallback)", message.Speaker);
            Assert.True(message.LabelBounds.Right < message.RegenerateBtnBounds.Left);
            Assert.True(message.BranchBtnBounds.Right <= view.ClientSize.Width);
            using var bitmap = new Bitmap(width, 400);
            view.DrawToBitmap(bitmap, view.ClientRectangle);
            if (Environment.GetEnvironmentVariable("MANA_CHAT_MODEL_SNAPSHOT_DIR") is { } output)
            {
                Directory.CreateDirectory(output);
                bitmap.Save(Path.Combine(output, $"chat-model-{width}.png"));
            }
        });
    }

    private static HttpResponseMessage Json(string text) => new(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8, "application/json") };
}

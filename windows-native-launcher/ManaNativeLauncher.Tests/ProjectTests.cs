using System.Drawing;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ProjectTests
{
    [Fact]
    public async Task ProjectClientParsesGroupingAndUsesPickerRouteOnlyForUserLinks()
    {
        var calls = new List<string>();
        var handler = new FakeHttpMessageHandler(request =>
        {
            calls.Add($"{request.Method} {request.RequestUri!.AbsolutePath}");
            var project = "{\"id\":\"alpha\",\"name\":\"Alpha\",\"instructions\":\"Test first\",\"references\":[{\"id\":\"ref\",\"label\":\"Notes\",\"path\":\"C:\\\\Notes\",\"kind\":\"folder\",\"authorized\":true}]}";
            var json = request.RequestUri.AbsolutePath switch {
                "/projects" when request.Method == HttpMethod.Get => $"{{\"projects\":[{project}]}}",
                "/sessions" => "{\"sessions\":[{\"sessionId\":\"chat\",\"projectId\":\"alpha\",\"projectName\":\"Alpha\"}]}",
                _ => project,
            };
            if (request.Method == HttpMethod.Post && request.RequestUri.AbsolutePath == "/projects")
            {
                using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                Assert.False(body.RootElement.TryGetProperty("references", out _));
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        });
        var client = new ManaBackendClient(handler, launcherKey: "test-key");
        var projects = await client.GetProjectsAsync();
        Assert.Equal("Test first", projects[0].Instructions);
        Assert.True(projects[0].References[0].Authorized);
        Assert.Equal("alpha", (await client.GetSessionsAsync())[0].ProjectId);
        await client.SaveProjectAsync(null, "Alpha", "Test first");
        await client.SetSessionProjectAsync("chat", "alpha");
        await client.LinkProjectReferenceAsync("alpha", "C:\\Notes");
        await client.RemoveProjectReferenceAsync("alpha", "ref");
        await client.DeleteProjectAsync("alpha");
        Assert.Contains("POST /projects/alpha/references/picker", calls);
        Assert.Contains("PUT /sessions/chat/project", calls);
        Assert.Contains("DELETE /projects/alpha/references/ref", calls);
    }

    [Fact]
    public async Task ProjectClientShowsBackendValidationErrors()
    {
        var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest) {
            Content = new StringContent("{\"error\":\"Reference target changed\"}", Encoding.UTF8, "application/json"),
        }));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => client.LinkProjectReferenceAsync("alpha", "C:\\Notes"));
        Assert.Equal("Reference target changed", error.Message);
    }

    [Theory]
    [InlineData(600, 520)]
    [InlineData(480, 440)]
    public void ProjectEditorFitsAndRendersAtSupportedSizes(int width, int height)
    {
        ToolPanelHostTests.RunSta(() => {
            var client = new ManaBackendClient(new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)));
            using var dialog = new ProjectDialog(client, new ManaProject { Name = "Mana", Instructions = "Run tests", References = new() { new() { Label = "Notes", Path = "C:\\Notes" } } });
            dialog.Size = new Size(width, height);
            dialog.CreateControl();
            dialog.PerformLayout();
            var layout = Assert.IsType<TableLayoutPanel>(dialog.Controls[0]);
            var textBoxes = layout.Controls.OfType<TextBox>().ToArray();
            Assert.Equal(2, textBoxes.Length);
            Assert.Equal("Mana", textBoxes[0].Text);
            Assert.All(textBoxes, box => Assert.True(box.Width > 300 && box.Height > 15));
            var actions = layout.Controls.OfType<FlowLayoutPanel>().Single();
            Assert.All(actions.Controls.Cast<Control>(), button => Assert.True(button.Right <= actions.ClientSize.Width));
            using var bitmap = new Bitmap(dialog.Width, dialog.Height);
            dialog.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            Assert.NotEqual(bitmap.GetPixel(0, 0), bitmap.GetPixel(30, 100));
        });
    }
}

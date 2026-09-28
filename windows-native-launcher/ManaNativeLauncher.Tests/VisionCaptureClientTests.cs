using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #681: the native /ws/vision-capture client.
public class VisionCaptureClientTests
{
    private static byte[] Json(string json) => Encoding.UTF8.GetBytes(json);

    [Fact]
    public void TryParseCaptureRequestId_ReadsTheRequestId()
    {
        Assert.Equal("abc-123", VisionCaptureClient.TryParseCaptureRequestId(
            Json("""{"type":"capture-request","requestId":"abc-123"}""")));
    }

    [Theory]
    [InlineData("""{"type":"caption","requestId":"abc"}""")]
    [InlineData("""{"type":"capture-request"}""")]
    [InlineData("""{"type":"capture-request","requestId":""}""")]
    [InlineData("""{"type":"capture-request","requestId":5}""")]
    [InlineData("not json")]
    public void TryParseCaptureRequestId_IgnoresAnythingElse(string json)
    {
        Assert.Null(VisionCaptureClient.TryParseCaptureRequestId(Json(json)));
    }

    [Fact]
    public async Task RespondAsync_PostsTheCapturedImage()
    {
        var (client, getRequest) = BuildClient(() => "data:image/jpeg;base64,AAAA");

        await client.RespondAsync("abc-123");

        var (path, body) = getRequest();
        Assert.Equal("/vision/capture-result", path);
        Assert.Equal("""{"requestId":"abc-123","image":"data:image/jpeg;base64,AAAA"}""", body);
    }

    [Fact]
    public async Task RespondAsync_PostsTheErrorWhenCaptureFails()
    {
        var (client, getRequest) = BuildClient(() => throw new InvalidOperationException("no display"));

        await client.RespondAsync("abc-123");

        Assert.Equal("""{"requestId":"abc-123","error":"no display"}""", getRequest().Body);
    }

    [Fact]
    public async Task RespondAsync_DoesNotThrowWhenTheBackendRejectsThePost()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest));
        using var client = new VisionCaptureClient(new ManaBackendClient(handler), captureScreen: () => "img");

        await client.RespondAsync("abc-123");
    }

    private static (VisionCaptureClient Client, Func<(string? Path, string? Body)> GetRequest) BuildClient(Func<string> capture)
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true}") };
        });
        return (new VisionCaptureClient(new ManaBackendClient(handler), captureScreen: capture), () => (path, body));
    }
}

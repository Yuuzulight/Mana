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
    public void TryParseCaptureRequest_ReadsTheRequestIdAndSource()
    {
        Assert.Equal(("abc-123", false), VisionCaptureClient.TryParseCaptureRequest(
            Json("""{"type":"capture-request","requestId":"abc-123"}""")));
        Assert.Equal(("abc-123", true), VisionCaptureClient.TryParseCaptureRequest(
            Json("""{"type":"capture-request","requestId":"abc-123","source":"camera"}""")));
    }

    [Theory]
    [InlineData("""{"type":"caption","requestId":"abc"}""")]
    [InlineData("""{"type":"capture-request"}""")]
    [InlineData("""{"type":"capture-request","requestId":""}""")]
    [InlineData("""{"type":"capture-request","requestId":5}""")]
    [InlineData("not json")]
    public void TryParseCaptureRequest_IgnoresAnythingElse(string json)
    {
        Assert.Null(VisionCaptureClient.TryParseCaptureRequest(Json(json)));
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

    // #912: a camera request takes the camera snapshot, never the screen,
    // and only a client with a camera says so when it connects.
    [Fact]
    public async Task RespondAsync_UsesTheCameraForACameraRequest()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true}") };
        });
        using var client = new VisionCaptureClient(new ManaBackendClient(handler),
            captureScreen: () => "screen", captureCamera: () => Task.FromResult("camera"));

        await client.RespondAsync("abc-123", camera: true);

        Assert.Equal("""{"requestId":"abc-123","image":"camera"}""", body);
        Assert.Equal("?camera=1", VisionCaptureClient.BuildSocketUri(null, camera: true).Query);
        Assert.Equal("", VisionCaptureClient.BuildSocketUri(null, camera: false).Query);
    }

    [Fact]
    public async Task RespondAsync_DoesNotThrowWhenTheBackendRejectsThePost()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest));
        using var client = new VisionCaptureClient(new ManaBackendClient(handler), captureScreen: () => "img");

        await client.RespondAsync("abc-123");
    }

    // #911: a desktop request runs the (fake) action and posts its result
    // or its error; only a client with desktop actions says so.
    [Fact]
    public async Task RespondDesktopAsync_PostsTheActionsResultOrError()
    {
        var parsed = VisionCaptureClient.TryParseDesktopRequest(
            Json("""{"type":"desktop-request","requestId":"r1","action":"media","args":{"key":"next"}}"""));
        Assert.NotNull(parsed);
        var (id, action, args) = parsed.Value;
        Assert.Equal(("r1", "media", "next"), (id, action, args.GetProperty("key").GetString()));
        Assert.Null(VisionCaptureClient.TryParseDesktopRequest(Json("""{"type":"capture-request","requestId":"r1"}""")));

        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true}") };
        });
        using var client = new VisionCaptureClient(new ManaBackendClient(handler), captureScreen: () => "screen",
            desktopAction: (name, a) => name == "media" ? new { key = a.GetProperty("key").GetString() } : throw new InvalidOperationException("nope"));

        await client.RespondDesktopAsync("r1", action, args);
        Assert.Equal("""{"requestId":"r1","result":{"key":"next"}}""", body);
        await client.RespondDesktopAsync("r2", "focus_app", args);
        Assert.Equal("""{"requestId":"r2","error":"nope"}""", body);
        Assert.Equal("?desktop=1", VisionCaptureClient.BuildSocketUri(null, camera: false, desktop: true).Query);
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

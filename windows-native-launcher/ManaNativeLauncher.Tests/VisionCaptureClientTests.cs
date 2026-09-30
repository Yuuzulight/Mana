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
        Assert.Equal(("abc-123", "screen"), VisionCaptureClient.TryParseCaptureRequest(
            Json("""{"type":"capture-request","requestId":"abc-123"}""")));
        Assert.Equal(("abc-123", "camera"), VisionCaptureClient.TryParseCaptureRequest(
            Json("""{"type":"capture-request","requestId":"abc-123","source":"camera"}""")));
        Assert.Equal(("abc-123", "camera-save"), VisionCaptureClient.TryParseCaptureRequest(
            Json("""{"type":"capture-request","requestId":"abc-123","source":"camera-save"}""")));
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

        await client.RespondAsync("abc-123", "camera");

        Assert.Equal("""{"requestId":"abc-123","image":"camera"}""", body);
        Assert.Equal("?camera=1", VisionCaptureClient.BuildSocketUri(null, camera: true).Query);
        Assert.Equal("", VisionCaptureClient.BuildSocketUri(null, camera: false).Query);
    }

    // #962: a save request answers with the saved file's path, and a
    // launcher that can't save says so instead of sending the screen.
    [Fact]
    public async Task RespondAsync_SavesTheSnapshotForASaveRequest()
    {
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true}") };
        });
        using var saving = new VisionCaptureClient(new ManaBackendClient(handler),
            captureScreen: () => "screen", captureCamera: () => Task.FromResult("camera"), saveCameraSnapshot: () => Task.FromResult("snap.jpg"));
        await saving.RespondAsync("abc-123", "camera-save");
        Assert.Equal("""{"requestId":"abc-123","image":"snap.jpg"}""", body);

        using var notSaving = new VisionCaptureClient(new ManaBackendClient(handler), captureScreen: () => "screen");
        await notSaving.RespondAsync("abc-123", "camera-save");
        Assert.Contains("\"error\":\"this launcher can", body);
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

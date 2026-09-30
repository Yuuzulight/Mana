using System;
using System.IO;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

// #681: native client for node-bot's /ws/vision-capture (#417) -- when the
// model asks for a screenshot mid-reply (vision__look), node-bot pushes
// {type:"capture-request",requestId} here; this captures the primary screen
// and POSTs it (or the capture error) to /vision/capture-result, so the
// pending requestCapture() resolves. windows-launcher equivalent:
// main.js connectVisionCaptureBridge + renderer.js "vision:capture-request".
// Reconnect loop copied from TrayNotificationClient.
internal sealed class VisionCaptureClient : IDisposable
{
    private const int ReconnectDelayMs = 3000;

    private readonly Uri socketUri;
    private readonly ManaBackendClient backendClient;
    private readonly Func<string> captureScreen;
    private readonly Func<Task<string>>? captureCamera;
    private readonly Func<Task<string>>? saveCameraSnapshot;
    private readonly CancellationTokenSource cts = new();

    // captureScreen: null (the real call site) uses ScreenCapture's
    // primary-screen JPEG; tests pass a fake. #912: captureCamera answers
    // vision__camera; with it the socket tells node-bot (?camera=1) this
    // client can take camera snapshots. #962: saveCameraSnapshot answers
    // vision__save_snapshot with the saved file's path.
    public VisionCaptureClient(ManaBackendClient backendClient, string? backendBaseUrl = null, Func<string>? captureScreen = null, Func<Task<string>>? captureCamera = null, Func<Task<string>>? saveCameraSnapshot = null)
    {
        this.backendClient = backendClient;
        this.captureScreen = captureScreen ?? ScreenCapture.CaptureAsJpegDataUrl;
        this.captureCamera = captureCamera;
        this.saveCameraSnapshot = saveCameraSnapshot;
        socketUri = BuildSocketUri(backendBaseUrl, captureCamera is not null);
    }

    internal static Uri BuildSocketUri(string? backendBaseUrl, bool camera)
    {
        var httpUri = new Uri(string.IsNullOrWhiteSpace(backendBaseUrl) ? "http://127.0.0.1:5005" : backendBaseUrl);
        return new UriBuilder(httpUri)
        {
            Scheme = httpUri.Scheme == "https" ? "wss" : "ws",
            Path = "/ws/vision-capture",
            Query = camera ? "camera=1" : "",
        }.Uri;
    }

    public void Start()
    {
        _ = RunAsync(cts.Token);
    }

    private async Task RunAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                using var socket = new ClientWebSocket();
                await socket.ConnectAsync(socketUri, token);
                await ReceiveLoopAsync(socket, token);
            }
            catch
            {
                // Connection failed or dropped -- fall through to the
                // delay-and-retry below, same as a normal close.
            }

            try
            {
                await Task.Delay(ReconnectDelayMs, token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken token)
    {
        var buffer = new byte[8192];
        while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
        {
            using var stream = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return;
                }
                stream.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            if (TryParseCaptureRequest(stream.ToArray()) is var (requestId, source))
            {
                // Not awaited: the reply is blocked on this answer, and the
                // socket should keep reading meanwhile.
                _ = RespondAsync(requestId, source);
            }
        }
    }

    // {type:"capture-request", requestId:"<uuid>"}, plus source:"camera"
    // for #912's snapshot or "camera-save" for #962's; anything else (or a
    // malformed frame) is ignored, like TrayNotificationClient's parser.
    // Source is "screen" when none is given.
    internal static (string RequestId, string Source)? TryParseCaptureRequest(byte[] json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var type) || type.GetString() != "capture-request")
            {
                return null;
            }
            var requestId = root.TryGetProperty("requestId", out var id) ? id.GetString() : null;
            var source = root.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.String ? sourceElement.GetString()! : "screen";
            return string.IsNullOrEmpty(requestId) ? null : (requestId, source);
        }
        catch (Exception)
        {
            return null;
        }
    }

    // A failed capture is reported as {requestId, error} so node-bot rejects
    // the pending request at once instead of waiting out its timeout (same
    // as renderer.js). Never throws -- it runs unobserved.
    internal async Task RespondAsync(string requestId, string source = "screen")
    {
        string? image = null;
        string? error = null;
        try
        {
            // Off the socket's thread: CopyFromScreen + JPEG encoding of a
            // full screen isn't free.
            image = source switch
            {
                "camera" => await Task.Run(captureCamera ?? throw new InvalidOperationException("this launcher has no camera")),
                "camera-save" => await Task.Run(saveCameraSnapshot ?? throw new InvalidOperationException("this launcher can't save snapshots")),
                _ => await Task.Run(captureScreen),
            };
        }
        catch (Exception ex)
        {
            error = string.IsNullOrWhiteSpace(ex.Message) ? $"{source} capture failed" : ex.Message;
        }

        try
        {
            await backendClient.PostVisionCaptureResultAsync(requestId, image, error);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VisionCaptureClient: posting the capture result failed. {ex.Message}");
        }
    }

    public void Dispose()
    {
        cts.Cancel();
        cts.Dispose();
    }
}

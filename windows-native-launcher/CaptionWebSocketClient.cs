using System;
using System.IO;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

// #571: ports windows-launcher's issue #362 (renderer/caption-client.js) --
// listens on node-bot's /ws/captions feed and forwards each caption's text
// to CaptionOverlayForm. Reconnect-loop shape copied directly from
// TrayNotificationClient.cs: retry forever on a fixed delay, since the
// backend may not be up yet and this is a purely additive display feed
// (losing it must never surface as an error or affect the conversation).
internal sealed class CaptionWebSocketClient : IDisposable
{
    private const int ReconnectDelayMs = 3000;
    private static readonly Uri CaptionsWebSocketUri = new("ws://127.0.0.1:5005/ws/captions");

    private readonly Action<string> onCaption;
    private readonly CancellationTokenSource cts = new();

    public CaptionWebSocketClient(Action<string> onCaption)
    {
        this.onCaption = onCaption;
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
                await socket.ConnectAsync(CaptionsWebSocketUri, token);
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

            HandleMessage(stream.ToArray());
        }
    }

    private void HandleMessage(byte[] json)
    {
        var text = TryParseCaptionText(json);
        if (!string.IsNullOrEmpty(text))
        {
            onCaption(text);
        }
    }

    // Mirrors caption-client.js's parseCaptionMessage: a caption frame is
    // { type: "caption", ts, payload: { text, words[], ... } }. Anything
    // else on the socket (or malformed JSON) is ignored rather than
    // thrown on -- this is a display feed, a bad frame should cost a
    // caption, not the connection. Catches Exception broadly (not just
    // JsonException): unlike the dynamically-typed JS original, a
    // well-formed-but-wrong-shaped frame (e.g. "payload" or "type" not
    // the expected kind) makes JsonElement.TryGetProperty/GetString throw
    // InvalidOperationException here, and that must be swallowed the same
    // way a JSON parse failure is.
    internal static string? TryParseCaptionText(byte[] json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeProp) || typeProp.GetString() != "caption")
            {
                return null;
            }
            if (!root.TryGetProperty("payload", out var payload) || !payload.TryGetProperty("text", out var textProp))
            {
                return null;
            }
            var text = textProp.GetString()?.Trim();
            return string.IsNullOrEmpty(text) ? null : text;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public void Dispose()
    {
        cts.Cancel();
        cts.Dispose();
    }
}

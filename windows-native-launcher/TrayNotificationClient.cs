using System;
using System.IO;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Toolkit.Uwp.Notifications;

namespace Mana.NativeLauncher;

// #524: ports windows-launcher's issue #423 -- listens on the same
// tray-notifier WebSocket feed (node-bot's /ws/tray, already broadcasting
// dream/cron/research/doctor/audit payloads to every connected client) and
// shows a native Windows toast, with "Open Chat"/"Dismiss" actions, for
// the proactive types (ProactiveToastFilter). Reconnects on any connect
// failure or drop, same fixed delay and "retry forever" shape as the
// Electron reference -- the backend may not be up yet.
internal sealed class TrayNotificationClient : IDisposable
{
    private const int ReconnectDelayMs = 15000;
    private static readonly Uri TrayWebSocketUri = new("ws://127.0.0.1:5005/ws/tray");

    private readonly Action openChat;
    private readonly CancellationTokenSource cts = new();

    public TrayNotificationClient(Action openChat)
    {
        this.openChat = openChat;
        ToastNotificationManagerCompat.OnActivated += OnToastActivated;
    }

    public void Start()
    {
        // Matches windows-launcher's own MANA_PROACTIVE_TOASTS_ENABLED gate
        // -- "0" opts out, anything else (including unset) is enabled.
        if (Environment.GetEnvironmentVariable("MANA_PROACTIVE_TOASTS_ENABLED") == "0")
        {
            return;
        }
        _ = RunAsync(cts.Token);
    }

    private async Task RunAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                using var socket = new ClientWebSocket();
                await socket.ConnectAsync(TrayWebSocketUri, token);
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

    private static void HandleMessage(byte[] json)
    {
        var payload = TrayNotificationPayload.TryParse(json);
        if (payload is null || !ProactiveToastFilter.IsProactiveToast(payload.Type))
        {
            return;
        }

        new ToastContentBuilder()
            .AddText(payload.Title)
            .AddText(payload.Text)
            .AddButton(new ToastButton().SetContent("Open Chat").AddArgument("action", "openChat"))
            .AddButton(new ToastButton().SetContent("Dismiss").SetDismissActivation())
            .Show();
    }

    private void OnToastActivated(ToastNotificationActivatedEventArgsCompat e)
    {
        var args = ToastArguments.Parse(e.Argument);
        if (args.Contains("action") && args["action"] == "openChat")
        {
            openChat();
        }
    }

    public void Dispose()
    {
        ToastNotificationManagerCompat.OnActivated -= OnToastActivated;
        cts.Cancel();
        cts.Dispose();
    }
}

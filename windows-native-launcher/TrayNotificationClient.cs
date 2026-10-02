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
    // #1169: the toast button that takes over her browser.
    internal const string BrowserTakeOverAction = "browserTakeOver";

    private readonly Uri trayWebSocketUri;
    private readonly ManaBackendClient? backendClient;
    private readonly Action openChat;
    private readonly Action<TrayNotificationPayload>? onDoctor;
    private readonly Action<TrayNotificationPayload>? onSpeak;
    private readonly Action<TrayNotificationPayload>? onCharacter;
    private readonly Action<TrayNotificationPayload>? onSelfWork;
    private readonly Action<TrayNotificationPayload>? onBrowserDownload;
    private readonly bool proactiveToasts;
    private readonly CancellationTokenSource cts = new();

    // #565: backendBaseUrl derives this client's ws(s):// endpoint from
    // the same configured backend address ManaBackendClient uses for
    // http(s) -- null (every existing call site) keeps the original
    // hardcoded local address.
    // #689: onDoctor gets Doctor's warn/fail transitions (on a thread-pool
    // thread) -- Electron's tray tooltip + balloon, not a proactive toast.
    // #905: onSpeak gets a payload with a spoken line (a reminder), on a
    // thread-pool thread, whether or not proactive toasts are on.
    // #914: onCharacter gets each switch of character (from chat or the
    // tray), and each change of group mode's partner ("group"), on a
    // thread-pool thread.
    // #1008: onSelfWork gets the starts and ends of Mana's work on her own
    // code, on a thread-pool thread.
    public TrayNotificationClient(Action openChat, string? backendBaseUrl = null, Action<TrayNotificationPayload>? onDoctor = null, Action<TrayNotificationPayload>? onSpeak = null, Action<TrayNotificationPayload>? onCharacter = null, Action<TrayNotificationPayload>? onSelfWork = null, ManaBackendClient? backendClient = null, Action<TrayNotificationPayload>? onBrowserDownload = null)
    {
        this.onBrowserDownload = onBrowserDownload;
        this.backendClient = backendClient;
        this.onSelfWork = onSelfWork;
        this.openChat = openChat;
        this.onDoctor = onDoctor;
        this.onSpeak = onSpeak;
        this.onCharacter = onCharacter;
        // Matches windows-launcher's own MANA_PROACTIVE_TOASTS_ENABLED gate
        // -- "0" opts out, anything else (including unset) is enabled. Like
        // there, it doesn't silence Doctor alerts.
        proactiveToasts = Environment.GetEnvironmentVariable("MANA_PROACTIVE_TOASTS_ENABLED") != "0";
        trayWebSocketUri = BuildTrayWebSocketUri(backendBaseUrl);
        ToastNotificationManagerCompat.OnActivated += OnToastActivated;
    }

    private static Uri BuildTrayWebSocketUri(string? backendBaseUrl)
    {
        if (string.IsNullOrWhiteSpace(backendBaseUrl))
        {
            return new Uri("ws://127.0.0.1:5005/ws/tray");
        }
        var httpUri = new Uri(backendBaseUrl);
        var builder = new UriBuilder(httpUri)
        {
            Scheme = httpUri.Scheme == "https" ? "wss" : "ws",
            Path = "/ws/tray",
        };
        return builder.Uri;
    }

    public void Start()
    {
        if (!proactiveToasts && onDoctor is null && onCharacter is null)
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
                backendClient?.Authorize(socket);
                await socket.ConnectAsync(trayWebSocketUri, token);
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
        var payload = TrayNotificationPayload.TryParse(json);
        if (payload?.Type == "doctor")
        {
            onDoctor?.Invoke(payload);
            return;
        }
        if (payload?.Type is "character" or "group")
        {
            onCharacter?.Invoke(payload);
            return;
        }
        if (payload?.Type == "self-work")
        {
            onSelfWork?.Invoke(payload);
            return;
        }
        // #1158: a download I approved, shown in the chat.
        if (payload?.Type == "browser-download")
        {
            onBrowserDownload?.Invoke(payload);
            return;
        }
        // #1169: she asks me to take over her browser. node-bot doesn't
        // send this while a game runs; the request waits in the panel.
        if (payload?.Type == "browser-hand-over")
        {
            if (proactiveToasts)
            {
                new ToastContentBuilder()
                    .AddText(payload.Title)
                    .AddText(payload.Text)
                    .AddButton(new ToastButton().SetContent("Take over").AddArgument("action", BrowserTakeOverAction))
                    .AddButton(new ToastButton().SetContent("Dismiss").SetDismissActivation())
                    .Show();
            }
            return;
        }
        if (!string.IsNullOrWhiteSpace(payload?.Speak))
        {
            onSpeak?.Invoke(payload);
        }
        if (!proactiveToasts || payload is null || !ProactiveToastFilter.IsProactiveToast(payload.Type))
        {
            return;
        }

        // #697: clicking the toast (or Open Chat) is engaged, closing it is dismissed;
        // the backend learns per remark kind from those (POST /proactive/settings).
        new ToastContentBuilder()
            .AddArgument("action", "openChat")
            .AddArgument(ProactiveArgument, payload.Kind ?? payload.Type)
            .AddText(payload.Title)
            .AddText(payload.Text)
            .AddButton(new ToastButton().SetContent("Open Chat").AddArgument("action", "openChat").AddArgument(ProactiveArgument, payload.Kind ?? payload.Type))
            .AddButton(new ToastButton().SetContent("Dismiss").SetDismissActivation())
            .Show(toast =>
            {
                toast.Dismissed += (sender, e) =>
                {
                    if (IsUserDismissal(e.Reason) && backendClient is not null)
                    {
                        _ = ReportReactionAsync(backendClient, "dismissed", payload.Kind ?? payload.Type, payload.Id);
                    }
                };
            });
    }

    internal const string ProactiveArgument = "proactive";

    // Timing out or being hidden by the app isn't her being waved away.
    internal static bool IsUserDismissal(Windows.UI.Notifications.ToastDismissalReason reason) =>
        reason == Windows.UI.Notifications.ToastDismissalReason.UserCanceled;

    private static async Task ReportReactionAsync(ManaBackendClient backendClient, string reaction, string? kind, string? id)
    {
        try
        {
            await backendClient.ReportProactiveReactionAsync(reaction, kind, id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"TrayNotificationClient: couldn't report the {reaction} reaction. {ex.Message}");
        }
    }

    private void OnToastActivated(ToastNotificationActivatedEventArgsCompat e) =>
        _ = HandleActivationAsync(e.Argument, openChat, backendClient);

    // #1169: Take over does what the Browser panel's button does.
    internal static async Task HandleActivationAsync(string argument, Action openChat, ManaBackendClient? backendClient)
    {
        var args = ToastArguments.Parse(argument);
        if (!args.Contains("action"))
        {
            return;
        }
        if (args["action"] == "openChat")
        {
            openChat();
            if (backendClient is not null && args.TryGetValue(ProactiveArgument, out string? kind))
            {
                await ReportReactionAsync(backendClient, "engaged", kind, null);
            }
        }
        else if (args["action"] == BrowserTakeOverAction && backendClient is not null)
        {
            try
            {
                await backendClient.TakeOverBrowserAsync(null);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"TrayNotificationClient: couldn't take over her browser. {ex.Message}");
            }
        }
    }

    public void Dispose()
    {
        ToastNotificationManagerCompat.OnActivated -= OnToastActivated;
        cts.Cancel();
        cts.Dispose();
    }
}

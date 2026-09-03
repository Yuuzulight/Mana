using System.Text.Json;

namespace Mana.NativeLauncher;

// #524: a parsed /ws/tray payload, kept as pure parsing logic (no
// WebSocket/toast dependency) so its shape and defaulting behavior are
// testable directly -- same split ProactiveToastFilter uses.
internal sealed record TrayNotificationPayload(string? Type, string Title, string Text)
{
    // Returns null for anything that isn't a well-formed JSON object --
    // a malformed or unexpectedly-shaped message (e.g. "type" present but
    // not a string, or the root not an object at all) should be skipped,
    // not tear down the whole connection. JsonDocument.Parse/GetProperty/
    // GetString can throw either JsonException (malformed JSON text) or
    // InvalidOperationException (well-formed JSON, wrong shape) -- both
    // are caught the same way here, since neither is this method's caller's
    // problem to distinguish.
    public static TrayNotificationPayload? TryParse(byte[] json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var type = root.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : null;
            var title = root.TryGetProperty("title", out var titleElement) ? titleElement.GetString() ?? "Mana" : "Mana";
            var text = root.TryGetProperty("text", out var textElement) ? textElement.GetString() ?? "" : "";
            return new TrayNotificationPayload(type, title, text);
        }
        catch
        {
            return null;
        }
    }
}

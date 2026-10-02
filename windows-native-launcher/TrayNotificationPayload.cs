using System.Text.Json;

namespace Mana.NativeLauncher;

// #524: a parsed /ws/tray payload, kept as pure parsing logic (no
// WebSocket/toast dependency) so its shape and defaulting behavior are
// testable directly -- same split ProactiveToastFilter uses.
// #905: Speak, when set, is a line Mana says out loud too (a reminder).
// #914: Model, on a "character" payload, is her Live2D model (null: the default).
// #1008: Url, on a "self-work" payload, is her PR once it's ready.
// #1024: Kind and Emotion pick how Speak is said (AnnouncementEmotion).
// #914: Id, on a "group" payload, is the partner replying alongside the
// active character (null: nobody, so her avatar goes away).
// #1337: SessionId, TaskId and Status, on "background_task_done", say which
// chat's task ended and how.
internal sealed record TrayNotificationPayload(string? Type, string Title, string Text, string? Speak = null, string? Model = null, string? Url = null, string? Kind = null, string? Emotion = null, string? Id = null, string? SessionId = null, string? TaskId = null, string? Status = null)
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
            var speak = root.TryGetProperty("speak", out var speakElement) ? speakElement.GetString() : null;
            var model = root.TryGetProperty("model", out var modelElement) ? modelElement.GetString() : null;
            var url = root.TryGetProperty("url", out var urlElement) ? urlElement.GetString() : null;
            var kind = root.TryGetProperty("kind", out var kindElement) ? kindElement.GetString() : null;
            var emotion = root.TryGetProperty("emotion", out var emotionElement) ? emotionElement.GetString() : null;
            var id = root.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.String ? idElement.GetString() : null;
            string? Str(string name) => root.TryGetProperty(name, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            return new TrayNotificationPayload(type, title, text, speak, model, url, kind, emotion, id, Str("sessionId"), Str("taskId"), Str("status"));
        }
        catch
        {
            return null;
        }
    }
}

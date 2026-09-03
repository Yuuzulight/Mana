namespace Mana.NativeLauncher;

// #523: ports windows-launcher/renderer/vision-hotkey.js's pure pieces --
// DEFAULT_VISION_HOTKEY_PROMPT and describeVisionHotkeyError. The
// clip-review hotkey variant (buildClipHotkeyPrompt, multi-frame buffered
// span) is explicitly out of scope for this issue.
internal static class VisionHotkeyMessages
{
    public const string DefaultPrompt = "Take a look at my screen and tell me what you see. Answer briefly.";

    // error is the raw backend error string (what SpeakReplyAsync's
    // exception Message ends up being) -- "no local vision model
    // available" is the one literal string node-bot's /reply/stream
    // handler uses for this specific case, matched exactly, same as the
    // reference's own HTTP-503 special case (this port has no separate
    // status code to check against, since the native launcher's
    // StreamReplyAndPlayAsync always surfaces errors as an exception
    // message, not an HTTP status).
    public static string DescribeError(string? error)
    {
        if (error == "no local vision model available")
        {
            return "Mana has no vision model installed. See docs/vision_setup.md.";
        }

        var trimmed = (error ?? "").Trim();
        return trimmed.Length > 0 ? $"Mana couldn't look at the screen: {trimmed}" : "Mana couldn't look at the screen.";
    }
}

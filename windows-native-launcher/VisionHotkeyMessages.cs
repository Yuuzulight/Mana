using System;

namespace Mana.NativeLauncher;

// #523/#585: ports windows-launcher/renderer/vision-hotkey.js's pure
// pieces -- DEFAULT_VISION_HOTKEY_PROMPT, describeVisionHotkeyError, and
// (added by #585) buildClipHotkeyPrompt for the clip-review hotkey
// variant, which #523 explicitly left out of scope.
internal static class VisionHotkeyMessages
{
    public const string DefaultPrompt = "Take a look at my screen and tell me what you see. Answer briefly.";

    // #585: the span is stated explicitly and computed from the buffer's
    // real timestamps rather than hardcoding the target ~15s window --
    // claiming a longer span than what's actually captured (e.g. right
    // after app start, before the buffer has filled) would give the
    // vision model a false premise to reason from. Matches the
    // reference's own buildClipHotkeyPrompt exactly, including its
    // rounding and singular/plural "second(s)" wording.
    public static string BuildClipHotkeyPrompt(double spanSeconds)
    {
        var rounded = (int)Math.Round(spanSeconds);
        if (rounded < 1)
        {
            return "Look back at what just happened and tell me. Answer briefly.";
        }
        return $"Look back over the last {rounded} second{(rounded == 1 ? "" : "s")} and tell me what just happened. Answer briefly.";
    }

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

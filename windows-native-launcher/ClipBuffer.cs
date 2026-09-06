using System.Collections.Generic;
using System.Linq;

namespace Mana.NativeLauncher;

// #585: ports windows-launcher/renderer/clip-buffer.js -- a small rolling
// buffer of screen captures for the "what just happened?" clip hotkey.
// Kept capture-call-free (like the reference) so it's testable directly:
// something else (ManaApplicationContext's own capture timer) owns
// actually calling ScreenCapture and pushing the result in.
internal sealed class ClipBuffer
{
    public const int MaxFrames = 5;

    private readonly List<(string Image, long TimestampMs)> frames = new();

    public void PushFrame(string image, long timestampMs)
    {
        frames.Add((image, timestampMs));
        if (frames.Count > MaxFrames)
        {
            frames.RemoveAt(0);
        }
    }

    // Span between the oldest and newest buffered frame, in seconds -- the
    // real lookback window, not the target ~15s (which only holds once the
    // buffer's full). 0 for an empty or single-frame buffer, matching the
    // reference's own getSpanSeconds exactly (there's no span yet).
    public double GetSpanSeconds()
    {
        if (frames.Count < 2)
        {
            return 0;
        }
        return (frames[^1].TimestampMs - frames[0].TimestampMs) / 1000.0;
    }

    public IReadOnlyList<string> GetImages() => frames.Select(f => f.Image).ToList();
}

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

// #671: OCR is the expensive half of a screen read, and most reads inside
// a conversation see the same screen as the last one. Reuses the previous
// OCR text while the foreground window and a perceptual hash of its
// capture are unchanged, so an identical screen is OCR'd once.
internal sealed class ScreenOcrGate
{
    // 65x64 grayscale thumbnail -> 64x64 = 4096 difference bits, i.e.
    // cells of roughly 30x17 px on a 1080p window. Far finer than the
    // usual 8x8 dHash on purpose: a new line of text, a scroll or a
    // changed number needs to change the hash, or the gate would serve
    // stale text; a blinking caret occasionally does too, which only
    // costs an extra OCR.
    private const int HashSize = 64;

    private IntPtr lastWindow;
    private ulong[]? lastHash;
    private string lastText = "";

    // runOcr only runs (and is only cached) when the window or hash
    // changed; a failed OCR throws through and leaves the cache as it was.
    public async Task<string> ReadAsync(IntPtr window, ulong[] hash, Func<Task<string>> runOcr)
    {
        if (lastHash is not null && window == lastWindow && hash.AsSpan().SequenceEqual(lastHash))
        {
            return lastText;
        }

        var text = await runOcr();
        (lastWindow, lastHash, lastText) = (window, hash, text);
        return text;
    }

    // Difference hash: downscale to grayscale, one bit per pixel for
    // "brighter than its right-hand neighbour". Deterministic for an
    // identical capture; any visible change in layout or text flips bits.
    public static ulong[] DifferenceHash(Bitmap image)
    {
        using var small = new Bitmap(HashSize + 1, HashSize);
        using (var g = Graphics.FromImage(small))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBilinear;
            g.DrawImage(image, 0, 0, HashSize + 1, HashSize);
        }

        var hash = new ulong[HashSize * HashSize / 64];
        for (var y = 0; y < HashSize; y++)
        {
            for (var x = 0; x < HashSize; x++)
            {
                if (small.GetPixel(x, y).GetBrightness() > small.GetPixel(x + 1, y).GetBrightness())
                {
                    var bit = y * HashSize + x;
                    hash[bit / 64] |= 1UL << (bit % 64);
                }
            }
        }
        return hash;
    }
}

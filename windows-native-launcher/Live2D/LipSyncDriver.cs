namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: accumulates the raw PCM samples AudioPlayer taps
// during playback into fixed-size analysis windows, running each through
// SimpleFft + LipSyncAnalyzer to produce a live (mouthOpen, mouthForm)
// signal -- the bridge between "AudioPlayer is playing some bytes right
// now" and "the avatar's mouth parameters should be this, right now".
//
// OnSamplesPlayed runs on NAudio's playback thread; Current is polled from
// AvatarOverlayForm's UI-thread render timer. Deliberately NOT touching
// CubismModel directly from the audio thread -- CubismModel/CubismRenderer
// have no internal locking of their own, so all access to them stays
// confined to the UI thread (the render timer), and the only things
// crossing threads here are two plain `volatile float` fields (safe,
// non-tearing reads/writes for a 32-bit type -- no lock needed for those
// specifically) plus a short-lived lock purely around the sample-
// accumulation buffer.
internal sealed class LipSyncDriver
{
    private const int WindowSize = 512; // must be a power of two (SimpleFft's requirement)

    private readonly List<float> pending = [];
    private readonly object bufferLock = new();

    private volatile float mouthOpen;
    private volatile float mouthForm;

    public (float MouthOpen, float MouthForm) Current => (mouthOpen, mouthForm);

    // Matches SamplesReadHandler's shape -- pass this directly as
    // AudioPlayer's onSamplesPlayed.
    public void OnSamplesPlayed(ReadOnlySpan<float> samples, int sampleRate)
    {
        List<float[]>? windows = null;
        lock (bufferLock)
        {
            foreach (var sample in samples)
            {
                pending.Add(sample);
            }
            while (pending.Count >= WindowSize)
            {
                windows ??= [];
                windows.Add(pending.GetRange(0, WindowSize).ToArray());
                pending.RemoveRange(0, WindowSize);
            }
        }

        if (windows is null)
        {
            return;
        }

        // Only the LAST window in this batch matters for "what's the
        // current mouth state" -- a single Read() call can deliver many
        // samples at once (the playback pipeline buffering ahead of
        // real-time), and only the most recent window reflects what's
        // audibly playing right now.
        AnalyzeWindow(windows[^1], sampleRate);
    }

    private void AnalyzeWindow(float[] window, int sampleRate)
    {
        double sumSquares = 0;
        foreach (var sample in window)
        {
            sumSquares += (double)sample * sample;
        }
        var rms = (float)Math.Sqrt(sumSquares / window.Length);

        var magnitudesDb = SimpleFft.MagnitudesDb(window);
        var mfcc = LipSyncAnalyzer.ComputeMelEnergies(magnitudesDb, sampleRate, WindowSize);
        var viseme = LipSyncAnalyzer.ClassifyViseme(mfcc);

        mouthOpen = LipSyncAnalyzer.RmsToMouth(rms);
        mouthForm = LipSyncAnalyzer.VisemeToMouthForm(viseme);
    }

    // Called when playback stops/is interrupted -- clears accumulated
    // samples (so a new clip doesn't pick up stale leftover audio from a
    // previous one) and reports "mouth closed" immediately, rather than
    // leaving the last-known-open value sitting there until decay catches
    // up on its own.
    public void Reset()
    {
        lock (bufferLock)
        {
            pending.Clear();
        }
        mouthOpen = 0f;
        mouthForm = 0f;
    }
}

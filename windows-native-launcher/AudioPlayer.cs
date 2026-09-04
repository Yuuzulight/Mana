using System;
using System.IO;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Mana.NativeLauncher;

// Plays one synthesized WAV clip start-to-finish. PlayAsync (below) lets a
// caller sequence several clips back-to-back (sub-project 2) and tells them
// apart from an external interruption (sub-project 3's barge-in); still no
// lip-sync analysis tap (sub-project 4's job) -- deliberately the thinnest
// wrapper that covers all three.
internal sealed class AudioPlayer : IDisposable
{
    // #479 sub-project 4: when set, every Play() taps the actual PCM
    // samples as they're read for playback (not the source WAV bytes
    // up front -- this fires in real time, roughly in sync with what's
    // audibly playing) for lip-sync analysis. Null by default (every
    // pre-existing caller/test) -- no tap, no behavior change.
    private readonly SamplesReadHandler? onSamplesPlayed;

    public AudioPlayer(SamplesReadHandler? onSamplesPlayed = null)
    {
        this.onSamplesPlayed = onSamplesPlayed;
    }

    public event Action? PlaybackCompleted;

    // #479 sub-project 3: fired by Stop() specifically when it cuts off a
    // clip that hadn't finished playing yet -- distinct from
    // PlaybackCompleted, which only ever means "reached the end of the
    // file naturally". Needed so a caller (VoiceLoop's barge-in trigger)
    // can tell PlayAsync's awaiter "you were interrupted, not completed"
    // instead of that Task just hanging forever (Stop() used to suppress
    // PlaybackCompleted entirely for the clip it cut off -- see the
    // currentClipCompletedNaturally comment below for why "stale clip,
    // suppress" and "genuinely interrupted, signal it" are different cases
    // Stop() must distinguish, not just an event rename).
    public event Action? PlaybackInterrupted;

    // Guards output/reader/stream/currentClipCompletedNaturally against
    // concurrent Play()/Stop() calls (e.g. VoiceLoop's capture thread
    // calling Stop() to interrupt while the streaming reply pipeline is
    // mid-Play() on a different thread).
    private readonly object syncRoot = new();

    // Bumped on every Stop() (including the one Play() does internally)
    // so a PlaybackStopped callback that belongs to a clip we've already
    // moved on from can tell it's stale and skip firing PlaybackCompleted.
    // NAudio's WasapiOut.Stop() calls playThread.Join(), and can raise
    // PlaybackStopped synchronously from that thread before returning --
    // so field mutation happens under the lock, but Stop()/Dispose() calls
    // on NAudio objects always happen AFTER releasing it, to avoid the
    // handler deadlocking against a lock its own triggering call is holding.
    private int generation;

    // Tracks whether the CURRENT generation's clip has already reached its
    // own natural PlaybackStopped (end of file) before Stop() is called on
    // it. Without this, Stop() couldn't tell "genuinely cutting off a clip
    // that was still playing" (a real interruption) from "cleaning up a
    // clip that already finished naturally and just hasn't been nulled out
    // yet" (e.g. Play() being called again for the next chunk in a
    // sequence -- its internal Stop() call would otherwise misreport the
    // PREVIOUS, already-finished chunk as "interrupted").
    private bool currentClipCompletedNaturally;

    private WasapiOut? output;
    private WaveFileReader? reader;
    private MemoryStream? stream;

    public void Play(byte[] wavBytes)
    {
        Stop();

        lock (syncRoot)
        {
            stream = new MemoryStream(wavBytes);
            reader = new WaveFileReader(stream);
            IWaveProvider playbackSource = reader;
            if (onSamplesPlayed is not null)
            {
                playbackSource = new TappingSampleProvider(reader.ToSampleProvider(), onSamplesPlayed).ToWaveProvider();
            }
            var newOutput = new WasapiOut(AudioClientShareMode.Shared, latency: 100);
            newOutput.Init(playbackSource);

            var myGeneration = ++generation;
            currentClipCompletedNaturally = false;
            newOutput.PlaybackStopped += (_, _) =>
            {
                lock (syncRoot)
                {
                    if (generation != myGeneration) return; // stale clip -- Stop()/Play() already moved on
                    currentClipCompletedNaturally = true;
                }
                PlaybackCompleted?.Invoke();
            };

            output = newOutput;
            newOutput.Play();
        }
    }

    // Issue #331 (#479 sub-project 2): the streaming reply pipeline plays a
    // sequence of TTS chunks back-to-back, awaiting each one's completion
    // before starting the next (so one-ahead synthesis pipelining never
    // overlaps two Play() calls). Wraps the existing event-based
    // Play()/PlaybackCompleted pair in a Task instead of making every
    // caller hand-roll its own one-shot subscribe/unsubscribe.
    //
    // Returns true if the clip reached its natural end, false if Stop() cut
    // it off first (#479 sub-project 3: a barge-in interruption) -- callers
    // that need to react differently to "finished" vs "cut off mid-clip"
    // (e.g. stop queuing further chunks) check this instead of just
    // awaiting completion.
    public Task<bool> PlayAsync(byte[] wavBytes)
    {
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        void OnCompleted()
        {
            PlaybackCompleted -= OnCompleted;
            PlaybackInterrupted -= OnInterrupted;
            tcs.TrySetResult(true);
        }

        void OnInterrupted()
        {
            PlaybackCompleted -= OnCompleted;
            PlaybackInterrupted -= OnInterrupted;
            tcs.TrySetResult(false);
        }

        PlaybackCompleted += OnCompleted;
        PlaybackInterrupted += OnInterrupted;
        try
        {
            Play(wavBytes);
        }
        catch
        {
            PlaybackCompleted -= OnCompleted;
            PlaybackInterrupted -= OnInterrupted;
            throw;
        }

        return tcs.Task;
    }

    public void Stop()
    {
        WasapiOut? toStop;
        WaveFileReader? toDisposeReader;
        MemoryStream? toDisposeStream;
        bool wasInterrupted;

        lock (syncRoot)
        {
            generation++; // invalidate any in-flight PlaybackStopped callback for the current clip
            wasInterrupted = output is not null && !currentClipCompletedNaturally;
            toStop = output;
            toDisposeReader = reader;
            toDisposeStream = stream;
            output = null;
            reader = null;
            stream = null;
        }

        toStop?.Stop();
        toStop?.Dispose();
        toDisposeReader?.Dispose();
        toDisposeStream?.Dispose();

        if (wasInterrupted)
        {
            PlaybackInterrupted?.Invoke();
        }
    }

    public void Dispose() => Stop();
}

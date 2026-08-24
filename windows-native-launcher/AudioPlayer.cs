using System;
using System.IO;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Mana.NativeLauncher;

// Plays one synthesized WAV clip start-to-finish. No queueing/streaming
// (sub-project 2's job) and no lip-sync analysis tap (sub-project 4's
// job) -- deliberately the thinnest possible wrapper.
internal sealed class AudioPlayer : IDisposable
{
    public event Action? PlaybackCompleted;

    // Guards output/reader/stream against concurrent Play()/Stop() calls
    // (e.g. VoiceLoop and a future barge-in detector touching this class
    // from different threads).
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
            var newOutput = new WasapiOut(AudioClientShareMode.Shared, latency: 100);
            newOutput.Init(reader);

            var myGeneration = ++generation;
            newOutput.PlaybackStopped += (_, _) =>
            {
                lock (syncRoot)
                {
                    if (generation != myGeneration) return; // stale clip -- Stop()/Play() already moved on
                }
                PlaybackCompleted?.Invoke();
            };

            output = newOutput;
            newOutput.Play();
        }
    }

    public void Stop()
    {
        WasapiOut? toStop;
        WaveFileReader? toDisposeReader;
        MemoryStream? toDisposeStream;

        lock (syncRoot)
        {
            generation++; // invalidate any in-flight PlaybackStopped callback for the current clip
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
    }

    public void Dispose() => Stop();
}

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
    public event Action? PlaybackStarted;
    public event Action? PlaybackCompleted;

    private WasapiOut? output;
    private WaveFileReader? reader;
    private MemoryStream? stream;

    public void Play(byte[] wavBytes)
    {
        Stop();

        stream = new MemoryStream(wavBytes);
        reader = new WaveFileReader(stream);
        output = new WasapiOut(AudioClientShareMode.Shared, latency: 100);
        output.Init(reader);
        output.PlaybackStopped += (_, _) => PlaybackCompleted?.Invoke();

        PlaybackStarted?.Invoke();
        output.Play();
    }

    public void Stop()
    {
        output?.Stop();
        output?.Dispose();
        output = null;
        reader?.Dispose();
        reader = null;
        stream?.Dispose();
        stream = null;
    }

    public void Dispose() => Stop();
}

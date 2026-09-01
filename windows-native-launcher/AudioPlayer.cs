using System;
using NAudio.Wave;

namespace Mana.NativeLauncher;

/// <summary>
/// Native audio playback wrapper using NAudio WasapiOut.
/// Plays synthesized TTS WAV bytes directly to the default output device.
/// </summary>
internal sealed class AudioPlayer : IDisposable
{
    private WaveOutEvent? waveOut;
    private readonly object playbackLock = new();

    /// <summary>
    /// Event fired when audio playback completes successfully.
    /// Used by VoiceLoop to reset avatar state and resume listening.
    /// </summary>
    public event EventHandler<EventArgs> OnPlaybackCompletedOnce;

    /// <summary>
    /// Plays synthesized TTS audio bytes using WasapiOut for low-latency direct output.
/// </summary>
    /// <param name="wavBytes">WAV-encoded audio data (16kHz mono, 16-bit).</param>
    public void Play(byte[] wavBytes)
    {
        lock (playbackLock)
        {
            // Stop and dispose previous player if active
            try
            {
                waveOut?.Stop();
                waveOut?.Dispose();
            }
            catch { /* Ignore disposal errors */ }

            using var memoryStream = new MemoryStream(wavBytes);
            using var waveReader = new WaveFileReader(memoryStream);

            // Create WasapiOut with direct sample provider input (no intermediate buffer)
            waveOut = new WaveOutEvent();
            waveOut.Init(waveReader);

            // Wire up completion event for state machine synchronization
            waveOut.PlaybackStopped += (s, e) =>
            {
                lock (playbackLock)
                {
                    OnPlaybackCompletedOnce?.Invoke(this, EventArgs.Empty);
                }
            };

            waveOut.Play();
        }
    }

    /// <summary>
    /// Cleans up audio playback resources.
    /// Should be called when the application shuts down or VoiceLoop stops.
    /// </summary>
    public void Dispose()
    {
        lock (playbackLock)
        {
            try
            {
                waveOut?.Stop();
                waveOut?.Dispose();
            }
            catch { /* Ignore disposal errors */ }
        }
    }
}

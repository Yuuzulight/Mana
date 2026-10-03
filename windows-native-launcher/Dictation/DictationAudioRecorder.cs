using System;
using System.IO;
using NAudio.Wave;
using NAudio.CoreAudioApi;

namespace Mana.NativeLauncher.Dictation;

// #849: lightweight audio recorder for dictation turns.
// Captures 16kHz mono PCM from the default capture endpoint and returns WAV bytes.
public sealed class DictationAudioRecorder : IDisposable
{
    public const int TargetSampleRate = 16000;

    private WasapiCapture? capture;
    private BufferedWaveProvider? captureBuffer;
    private ISampleProvider? resampled;
    private readonly MemoryStream audioStream = new();
    private readonly object lockObj = new();
    private bool isRecording;
    private bool disposed;

    public bool IsRecording => isRecording;

    public void Start()
    {
        lock (lockObj)
        {
            if (isRecording || disposed)
            {
                return;
            }

            audioStream.SetLength(0);

            try
            {
                capture = new WasapiCapture();
                captureBuffer = new BufferedWaveProvider(capture.WaveFormat)
                {
                    ReadFully = false,
                    DiscardOnBufferOverflow = true
                };

                var resampler = new MediaFoundationResampler(
                    captureBuffer,
                    new WaveFormat(TargetSampleRate, 16, 1))
                {
                    ResamplerQuality = 60
                };
                resampled = resampler.ToSampleProvider();

                capture.DataAvailable += OnDataAvailable;
                capture.RecordingStopped += (_, _) => { };
                capture.StartRecording();
                isRecording = true;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"DictationAudioRecorder: failed to start audio capture: {ex.Message}");
                CleanupCapture();
            }
        }
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (!isRecording || captureBuffer is null || resampled is null)
        {
            return;
        }

        captureBuffer.AddSamples(e.Buffer, 0, e.BytesRecorded);

        // Read resampled 16kHz float samples and convert to 16-bit PCM
        var floatBuffer = new float[1024];
        int read;
        while ((read = resampled.Read(floatBuffer, 0, floatBuffer.Length)) > 0)
        {
            var pcmBytes = new byte[read * 2];
            for (var i = 0; i < read; i++)
            {
                var sample = Math.Clamp(floatBuffer[i], -1.0f, 1.0f);
                var val = (short)(sample * 32767.0f);
                pcmBytes[i * 2] = (byte)(val & 0xFF);
                pcmBytes[i * 2 + 1] = (byte)((val >> 8) & 0xFF);
            }

            lock (lockObj)
            {
                audioStream.Write(pcmBytes, 0, pcmBytes.Length);
            }
        }
    }

    public byte[] Stop()
    {
        lock (lockObj)
        {
            if (!isRecording)
            {
                return [];
            }

            CleanupCapture();

            var pcmData = audioStream.ToArray();
            audioStream.SetLength(0);

            if (pcmData.Length == 0)
            {
                return [];
            }

            // Encode to standard RIFF WAV container
            using var wavStream = new MemoryStream();
            using (var writer = new WaveFileWriter(wavStream, new WaveFormat(TargetSampleRate, 16, 1)))
            {
                writer.Write(pcmData, 0, pcmData.Length);
                writer.Flush();
            }

            return wavStream.ToArray();
        }
    }

    private void CleanupCapture()
    {
        isRecording = false;
        if (capture is not null)
        {
            capture.DataAvailable -= OnDataAvailable;
            try
            {
                capture.StopRecording();
            }
            catch
            {
                // ignored on shutdown
            }
            capture.Dispose();
            capture = null;
        }
        captureBuffer = null;
        resampled = null;
    }

    public void Dispose()
    {
        if (!disposed)
        {
            CleanupCapture();
            audioStream.Dispose();
            disposed = true;
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Mana.NativeLauncher;

// Owns the always-on capture -> VAD -> segment -> transcribe -> wake-word
// -> reply -> synthesize -> play loop. Runs continuously from Start() to
// Stop()/Dispose() -- never restarted around individual conversation
// turns, so sub-project 3 (barge-in) can reuse this same running VAD
// instance to detect speech during playback without restructuring this
// class.
internal sealed class VoiceLoop : IDisposable
{
    private readonly SileroVadRunner vad;
    private readonly ManaBackendClient backendClient;
    private readonly AudioPlayer audioPlayer;
    private readonly AvatarOverlayForm avatarOverlay;

    private WasapiCapture? capture;
    private ISampleProvider? resampled;
    private readonly List<float> frameBuffer = new();
    private readonly List<short> segmentSamples = new();

    // Guards frameBuffer, segmentSamples, hasHeardSpeechInSegment,
    // segmentElapsedMs, msSinceLastSpeech, lastFrameAt, segmentInFlight, and
    // the vad instance itself (SileroVadRunner mutates its own internal
    // state per ProcessFrame/Reset call, so it isn't thread-safe either).
    // OnDataAvailable fires on NAudio's WASAPI capture thread;
    // OnPlaybackCompletedOnce fires on NAudio's WasapiOut playback thread;
    // HandleSegmentClosedAsync's post-await continuation resumes on a
    // thread-pool thread -- three different threads that can all reach
    // this state. Ownership model: each of those entry points acquires
    // this lock itself before touching guarded state; ProcessBufferedFrames
    // and ResetSegment assume the caller already holds it and never lock
    // internally, so they're safe to call from any entry point without
    // double-locking or deadlocking. Never hold this lock across an await
    // or across the fire-and-forget HandleSegmentClosedAsync() dispatch.
    private readonly object stateLock = new();

    private bool awake;
    private bool hasHeardSpeechInSegment;
    private long segmentElapsedMs;
    private long msSinceLastSpeech;
    private DateTime lastFrameAt;
    private bool segmentInFlight;

    public VoiceLoop(
        SileroVadRunner vad,
        ManaBackendClient backendClient,
        AudioPlayer audioPlayer,
        AvatarOverlayForm avatarOverlay)
    {
        this.vad = vad;
        this.backendClient = backendClient;
        this.audioPlayer = audioPlayer;
        this.avatarOverlay = avatarOverlay;
    }

    public void Start()
    {
        capture = new WasapiCapture();
        var waveInProvider = new WaveInProvider(capture);
        // WASAPI shared-mode capture returns the device's own mix format
        // (typically 44.1kHz or 48kHz), not an arbitrarily requested rate
        // -- resample to 16kHz mono here so both the VAD frames below and
        // the WAV eventually sent to /transcribe-only match Silero VAD's
        // fixed contract and Whisper's tested input format.
        var resampler = new MediaFoundationResampler(
            waveInProvider,
            new WaveFormat(SileroVadRunner.SampleRate, 16, 1))
        {
            ResamplerQuality = 60,
        };
        resampled = resampler.ToSampleProvider();

        lastFrameAt = DateTime.UtcNow;
        capture.DataAvailable += OnDataAvailable;
        capture.StartRecording();
    }

    public void Stop()
    {
        if (capture is null)
        {
            return;
        }

        capture.DataAvailable -= OnDataAvailable;
        capture.StopRecording();
        capture.Dispose();
        capture = null;
        resampled = null;
    }

    public void Dispose() => Stop();

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (resampled is null)
        {
            return;
        }

        lock (stateLock)
        {
            var scratch = new float[4096];
            int samplesRead;
            while ((samplesRead = resampled.Read(scratch, 0, scratch.Length)) > 0)
            {
                for (var i = 0; i < samplesRead; i++)
                {
                    frameBuffer.Add(scratch[i]);
                }
            }

            ProcessBufferedFrames();
        }
    }

    // Caller must already hold stateLock.
    private void ProcessBufferedFrames()
    {
        // One segment (one conversation turn) in flight at a time -- keep
        // buffering raw samples while a turn is being handled, but don't
        // run VAD/segment logic against them until it's done, so a reply
        // arriving mid-buffer can't interleave with the next segment's
        // state.
        if (segmentInFlight)
        {
            return;
        }

        while (frameBuffer.Count >= SileroVadRunner.FrameSamples)
        {
            var frame = frameBuffer.GetRange(0, SileroVadRunner.FrameSamples).ToArray();
            frameBuffer.RemoveRange(0, SileroVadRunner.FrameSamples);

            var probability = vad.ProcessFrame(frame);
            var isSpeech = vad.IsSpeech(probability);

            var now = DateTime.UtcNow;
            var frameMs = (long)(now - lastFrameAt).TotalMilliseconds;
            lastFrameAt = now;
            segmentElapsedMs += frameMs;

            foreach (var sample in frame)
            {
                var clamped = Math.Clamp(sample, -1f, 1f);
                segmentSamples.Add((short)(clamped * short.MaxValue));
            }

            if (isSpeech)
            {
                hasHeardSpeechInSegment = true;
                msSinceLastSpeech = 0;
            }
            else
            {
                msSinceLastSpeech += frameMs;
            }

            var stopReason = RecordingSegmenter.ShouldStopRecording(
                hasHeardSpeechInSegment,
                segmentElapsedMs,
                msSinceLastSpeech);

            if (stopReason == RecordingStopReason.SilenceAfterSpeech)
            {
                segmentInFlight = true;
                _ = HandleSegmentClosedAsync();
                return;
            }

            if (stopReason is RecordingStopReason.MaxDuration or RecordingStopReason.NoSpeechTimeout)
            {
                ResetSegment();
            }
        }
    }

    // Caller must already hold stateLock.
    private void ResetSegment()
    {
        segmentSamples.Clear();
        hasHeardSpeechInSegment = false;
        segmentElapsedMs = 0;
        msSinceLastSpeech = 0;
        vad.Reset();
    }

    private async Task HandleSegmentClosedAsync()
    {
        // Only ever invoked synchronously from ProcessBufferedFrames, which
        // is only ever invoked under stateLock -- so this runs under the
        // caller's lock too (C#'s lock is reentrant on the owning thread).
        byte[] wavBytes;
        lock (stateLock)
        {
            wavBytes = BuildWavBytes(segmentSamples);
            ResetSegment();
        }

        var playbackStarted = false;
        try
        {
            playbackStarted = await RunTurnAsync(wavBytes);
        }
        finally
        {
            // Playback of the reply is asynchronous (WasapiOut.Play returns
            // immediately) -- if it started, keep segmentInFlight true until
            // OnPlaybackCompletedOnce fires, so relistening only resumes
            // once the reply has actually finished playing (spec order:
            // ... -> playback -> loop back to step 1). Otherwise (empty
            // transcript, no wake word, or any failure) there's nothing to
            // wait for -- resume listening immediately.
            //
            // This continuation resumes on a thread-pool thread after the
            // await above -- the lock taken earlier in this method was
            // released long before this point, so it must be reacquired
            // here rather than relied upon.
            if (!playbackStarted)
            {
                lock (stateLock)
                {
                    segmentInFlight = false;
                    // Frames captured while the turn was in flight are still
                    // sitting in frameBuffer -- process them now instead of
                    // waiting for the next DataAvailable callback.
                    ProcessBufferedFrames();
                }
            }
        }
    }

    // Returns true only if playback of a reply was successfully started
    // (i.e. relistening must wait for OnPlaybackCompletedOnce). Returns
    // false for every early-return path -- empty transcript, no wake-word
    // match, an HTTP call failure, or a playback-start failure -- all of
    // which are safe to resume listening from immediately.
    private async Task<bool> RunTurnAsync(byte[] wavBytes)
    {
        string transcript;
        try
        {
            transcript = await backendClient.TranscribeAsync(wavBytes);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: transcription failed, resuming listening. {ex.Message}");
            return false;
        }

        if (string.IsNullOrWhiteSpace(transcript))
        {
            return false;
        }

        string commandText;
        if (!awake)
        {
            var command = WakeWordMatcher.ExtractWakeCommand(transcript);
            if (command is null)
            {
                return false;
            }

            awake = true;
            commandText = command;
        }
        else
        {
            commandText = transcript;
        }

        if (string.IsNullOrWhiteSpace(commandText))
        {
            return false;
        }

        string reply;
        try
        {
            reply = await backendClient.ReplyAsync(commandText);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: reply failed, resuming listening. {ex.Message}");
            return false;
        }

        byte[] replyWav;
        try
        {
            replyWav = await backendClient.SynthesizeAsync(reply);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: synthesis failed, resuming listening. {ex.Message}");
            return false;
        }

        try
        {
            avatarOverlay.SetState(AvatarState.Talking);
            audioPlayer.PlaybackCompleted += OnPlaybackCompletedOnce;
            audioPlayer.Play(replyWav);
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: playback failed to start, resuming listening. {ex.Message}");
            audioPlayer.PlaybackCompleted -= OnPlaybackCompletedOnce;
            avatarOverlay.SetState(AvatarState.Idle);
            return false;
        }
    }

    private void OnPlaybackCompletedOnce()
    {
        audioPlayer.PlaybackCompleted -= OnPlaybackCompletedOnce;
        avatarOverlay.SetState(AvatarState.Idle);
        lock (stateLock)
        {
            segmentInFlight = false;
            // Frames captured while the reply was playing are still sitting
            // in frameBuffer -- process them now instead of waiting for the
            // next DataAvailable callback.
            ProcessBufferedFrames();
        }
    }

    private static byte[] BuildWavBytes(List<short> samples)
    {
        using var stream = new MemoryStream();
        var writer = new WaveFileWriter(stream, new WaveFormat(SileroVadRunner.SampleRate, 16, 1));
        var bytes = new byte[samples.Count * 2];
        Buffer.BlockCopy(samples.ToArray(), 0, bytes, 0, bytes.Length);
        writer.Write(bytes, 0, bytes.Length);
        writer.Flush();
        var result = stream.ToArray();
        writer.Dispose();
        return result;
    }
}

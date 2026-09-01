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
    private BufferedWaveProvider? captureBuffer;
    private ISampleProvider? resampled;
    private readonly List<float> frameBuffer = new();
    private readonly List<short> segmentSamples = new();

    // A 512-sample frame at 16kHz is always exactly this many ms of audio
    // -- a fixed property of the frame size, not something to measure via
    // wall-clock deltas between frame-processing calls (which would be
    // wrong: those calls aren't evenly spaced, especially around a turn
    // in flight).
    private const long FrameMs = SileroVadRunner.FrameSamples * 1000 / SileroVadRunner.SampleRate;

    // Guards frameBuffer, segmentSamples, hasHeardSpeechInSegment,
    // segmentElapsedMs, msSinceLastSpeech, segmentInFlight, and
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
    // double-locking or deadlocking. The real invariant: this lock is
    // never held across an await suspension. It IS correctly held across
    // the synchronous prefix of the fire-and-forget HandleSegmentClosedAsync()
    // dispatch -- that prefix runs on the same thread as the caller, and
    // C#'s lock is reentrant on the owning thread, so calling into it
    // while already holding the lock is fine. It's only the actual await
    // suspension inside that method that must (and does) happen outside
    // the lock.
    private readonly object stateLock = new();

    private bool awake;
    private bool hasHeardSpeechInSegment;
    private long segmentElapsedMs;
    private long msSinceLastSpeech;
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
        // WaveInProvider's underlying BufferedWaveProvider defaults to
        // ReadFully = true ("always read the amount of data requested,
        // padding with zeroes if necessary"), which would make the read
        // loop in OnDataAvailable below spin forever instead of draining
        // only what's actually been captured. Build our own
        // BufferedWaveProvider with ReadFully = false instead, fed
        // manually from OnDataAvailable.
        captureBuffer = new BufferedWaveProvider(capture.WaveFormat)
        {
            ReadFully = false,
            DiscardOnBufferOverflow = true,
        };
        // WASAPI shared-mode capture returns the device's own mix format
        // (typically 44.1kHz or 48kHz), not an arbitrarily requested rate
        // -- resample to 16kHz mono here so both the VAD frames below and
        // the WAV eventually sent to /transcribe-only match Silero VAD's
        // fixed contract and Whisper's tested input format.
        var resampler = new MediaFoundationResampler(
            captureBuffer,
            new WaveFormat(SileroVadRunner.SampleRate, 16, 1))
        {
            ResamplerQuality = 60,
        };
        resampled = resampler.ToSampleProvider();

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
        captureBuffer = null;
    }

    public void Dispose() => Stop();

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (resampled is null || captureBuffer is null)
        {
            return;
        }

        lock (stateLock)
        {
            captureBuffer.AddSamples(e.Buffer, 0, e.BytesRecorded);

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

            segmentElapsedMs += FrameMs;

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
                msSinceLastSpeech += FrameMs;
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
                    // Deliberately discard audio buffered during the turn
                    // rather than replaying it as a fresh segment -- a
                    // transcribe+reply+synthesize round trip can take
                    // 10-20s, and playing that backlog back through VAD
                    // would risk the mic picking up Mana's own TTS output
                    // as if it were new speech (self-triggered reply
                    // loop). This matches the Electron app, which isn't
                    // recording at all during playback. Sub-project 3
                    // (barge-in, not part of this plan) will need to
                    // replace this with real handling of turn-time audio
                    // -- don't assume this clear is accidental.
                    frameBuffer.Clear();
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
            audioPlayer.OnPlaybackCompletedOnce += OnPlaybackCompletedOnce;
            audioPlayer.Play(replyWav);
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: playback failed to start, resuming listening. {ex.Message}");
            audioPlayer.OnPlaybackCompletedOnce -= OnPlaybackCompletedOnce;
            avatarOverlay.SetState(AvatarState.Idle);
            return false;
        }
    }

    private void OnPlaybackCompletedOnce()
    {
        audioPlayer.OnPlaybackCompletedOnce -= OnPlaybackCompletedOnce;
        avatarOverlay.SetState(AvatarState.Idle);
        lock (stateLock)
        {
            segmentInFlight = false;
            // Deliberately discard audio buffered while the reply was
            // playing rather than replaying it as a fresh segment -- see
            // the matching comment in HandleSegmentClosedAsync's finally
            // block for why (mic picking up Mana's own TTS output).
            // Sub-project 3 (barge-in) will need different handling here.
            frameBuffer.Clear();
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

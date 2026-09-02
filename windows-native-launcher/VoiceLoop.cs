using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Mana.NativeLauncher;

// #479 sub-project 3: VoiceLoop's listening behavior at any moment.
internal enum ListenMode
{
    // Normal segment recording: buffer speech, close the segment on
    // silence-after-speech, hand it off for transcription.
    Idle,

    // A turn is in flight (transcribe/reply network calls, before playback
    // starts) -- nothing barge-in-relevant to watch yet. Buffered audio is
    // discarded once this ends, same reasoning sub-project 1 already
    // documented for the whole turn: these are network round trips with
    // nothing meaningful to listen to.
    Processing,

    // Mana is actually speaking (audio genuinely playing, not just "a
    // reply was requested"). VAD keeps running every frame; instead of
    // segment-recording it watches for sustained speech via BargeInGate to
    // detect the user talking over her.
    Speaking,

    // The user just triggered a barge-in -- recording their interruption
    // the same way a normal segment is recorded (silence-after-speech ends
    // it), just started fresh from the trigger point instead of from
    // silence.
    CapturingInterruption,
}

// Owns the always-on capture -> VAD -> segment -> transcribe -> wake-word
// -> reply -> synthesize -> play loop, plus (#479 sub-project 3) watching
// for the user talking over Mana while she's speaking and reacting to it.
// Runs continuously from Start() to Stop()/Dispose() -- never restarted
// around individual conversation turns, so the same running VAD instance
// serves both normal segment recording and barge-in detection.
internal sealed class VoiceLoop : IDisposable
{
    private readonly SileroVadRunner vad;
    private readonly ManaBackendClient backendClient;
    private readonly AudioPlayer audioPlayer;
    private readonly AvatarOverlayForm avatarOverlay;
    private readonly StreamingReplyPlayer streamingReplyPlayer;

    private WasapiCapture? capture;
    private BufferedWaveProvider? captureBuffer;
    private ISampleProvider? resampled;
    private readonly List<float> frameBuffer = new();
    private readonly List<short> segmentSamples = new();

    // A 512-sample frame at 16kHz is always exactly this many ms of audio
    // -- a fixed property of the frame size, not something to measure via
    // wall-clock deltas between frame-processing calls (which would be
    // wrong: those calls aren't evenly spaced, especially around a turn
    // in flight). BargeInGate's hold-time tracking uses this same virtual
    // clock, for the same reason.
    private const long FrameMs = SileroVadRunner.FrameSamples * 1000 / SileroVadRunner.SampleRate;

    // Guards frameBuffer, segmentSamples, hasHeardSpeechInSegment,
    // segmentElapsedMs, msSinceLastSpeech, mode, bargeInHeldMs, and the
    // vad instance itself (SileroVadRunner mutates its own internal state
    // per ProcessFrame/Reset call, so it isn't thread-safe either).
    // OnDataAvailable fires on NAudio's WASAPI capture thread; every other
    // entry point that touches this state (ReturnToIdle, OnTalkingStateChanged,
    // and ProcessTurnAsync's/SpeakReplyAsync's post-await continuations)
    // runs on a thread-pool thread, since audioPlayer.PlayAsync's Task
    // completes via TaskCreationOptions.RunContinuationsAsynchronously --
    // deliberately, so a PlaybackInterrupted callback firing synchronously
    // from inside ProcessSpeakingFrame's own audioPlayer.Stop() call (still
    // on the capture thread at that point) never runs a long continuation
    // chain (an HTTP classify call, potentially) on the capture thread
    // itself. Ownership model: each of those entry points acquires this
    // lock itself before touching guarded state; ProcessBufferedFrames and
    // its per-mode helpers assume the caller already holds it and never
    // lock internally, so they're safe to call from any entry point
    // without double-locking or deadlocking. The real invariant: this lock
    // is never held across an await suspension. It IS correctly held
    // across the synchronous prefix of the fire-and-forget
    // HandleSegmentClosedAsync() dispatch -- that prefix runs on the same
    // thread as the caller, and C#'s lock is reentrant on the owning
    // thread, so calling into it while already holding the lock is fine.
    // It's only the actual await suspension inside that method that must
    // (and does) happen outside the lock.
    private readonly object stateLock = new();

    private ListenMode mode = ListenMode.Idle;
    private bool awake;
    private bool hasHeardSpeechInSegment;
    private long segmentElapsedMs;
    private long msSinceLastSpeech;
    private long bargeInHeldMs; // only meaningful while mode == Speaking

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
        streamingReplyPlayer = new StreamingReplyPlayer(
            backendClient,
            audioPlayer.PlayAsync,
            OnTalkingStateChanged);
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
        if (mode == ListenMode.Processing)
        {
            // Turn in flight (network calls before playback starts) --
            // nothing to do with buffered audio yet.
            return;
        }

        while (frameBuffer.Count >= SileroVadRunner.FrameSamples)
        {
            var frame = frameBuffer.GetRange(0, SileroVadRunner.FrameSamples).ToArray();
            frameBuffer.RemoveRange(0, SileroVadRunner.FrameSamples);

            var probability = vad.ProcessFrame(frame);
            var isSpeech = vad.IsSpeech(probability);

            if (mode == ListenMode.Speaking)
            {
                if (ProcessSpeakingFrame(frame, isSpeech))
                {
                    return; // barge-in triggered; mode is now CapturingInterruption
                }
                continue;
            }

            // Idle (a normal fresh segment) and CapturingInterruption (a
            // barge-in's interruption segment) both accumulate samples and
            // close on silence-after-speech identically -- they differ
            // only in how hasHeardSpeechInSegment starts out (seeded true
            // for CapturingInterruption by StartCapturingInterruption, so
            // a brief pause right after the trigger can't look like
            // "never heard speech" and trip the no-speech timeout).
            if (ProcessSegmentFrame(frame, isSpeech))
            {
                return; // segment closed; HandleSegmentClosedAsync dispatched
            }
        }
    }

    // Caller must already hold stateLock. Returns true once the barge-in
    // has triggered this frame (mode has already switched to
    // CapturingInterruption by the time this returns).
    private bool ProcessSpeakingFrame(float[] frame, bool isSpeech)
    {
        var isLoudEnough = BargeInGate.DbfsFromSamples(frame) >= BargeInGate.DefaultMinDbfs;
        var (heldMs, triggered) = BargeInGate.Next(isSpeech, isLoudEnough, bargeInHeldMs, FrameMs);
        bargeInHeldMs = heldMs;

        if (!triggered)
        {
            return false;
        }

        // Cut Mana off immediately. Whichever audioPlayer.PlayAsync call is
        // currently being awaited (streaming or the non-streaming
        // fallback) sees this as a completedNaturally: false result and
        // unwinds on its own via OnTalkingStateChanged(false) -- this
        // method's only remaining job is to start recording what the user
        // is saying, from right here.
        audioPlayer.Stop();
        StartCapturingInterruption();
        return true;
    }

    // Caller must already hold stateLock.
    private void StartCapturingInterruption()
    {
        mode = ListenMode.CapturingInterruption;
        segmentSamples.Clear();
        segmentElapsedMs = 0;
        msSinceLastSpeech = 0;
        hasHeardSpeechInSegment = true; // see ProcessBufferedFrames' comment on why
        bargeInHeldMs = 0;
        vad.Reset();
    }

    // Caller must already hold stateLock. Shared by Idle and
    // CapturingInterruption (see ProcessBufferedFrames). Returns true if
    // the segment closed and HandleSegmentClosedAsync was dispatched.
    private bool ProcessSegmentFrame(float[] frame, bool isSpeech)
    {
        var wasCapturingInterruption = mode == ListenMode.CapturingInterruption;

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
            mode = ListenMode.Processing;
            _ = HandleSegmentClosedAsync(wasCapturingInterruption);
            return true;
        }

        if (stopReason is RecordingStopReason.MaxDuration or RecordingStopReason.NoSpeechTimeout)
        {
            // Matches Idle's own pre-existing behavior: reset and keep
            // listening in the same mode rather than giving up. For
            // CapturingInterruption specifically, Mana has already
            // stopped talking by this point -- there's nothing to resume
            // even if this times out, so just keep waiting for the user.
            segmentSamples.Clear();
            hasHeardSpeechInSegment = wasCapturingInterruption;
            segmentElapsedMs = 0;
            msSinceLastSpeech = 0;
            vad.Reset();
        }

        return false;
    }

    private async Task HandleSegmentClosedAsync(bool wasInterruption)
    {
        // Only ever invoked synchronously from ProcessSegmentFrame, which
        // is only ever invoked under stateLock -- so this runs under the
        // caller's lock too (C#'s lock is reentrant on the owning thread).
        byte[] wavBytes;
        lock (stateLock)
        {
            wavBytes = BuildWavBytes(segmentSamples);
            segmentSamples.Clear();
            hasHeardSpeechInSegment = false;
            segmentElapsedMs = 0;
            msSinceLastSpeech = 0;
            vad.Reset();
        }

        await ProcessTurnAsync(wavBytes, wasInterruption);
    }

    // Transcribes wavBytes and speaks a reply -- the single entry point for
    // both a normal fresh segment (Idle) and a barge-in's interruption
    // segment (CapturingInterruption); by the time an interruption can
    // happen, `awake` is already guaranteed true (Mana can only be
    // speaking, and therefore only be interrupted, after at least one
    // earlier turn already passed the wake-word gate below), so no
    // special-casing is needed between the two callers except classifying
    // the interruption itself.
    private async Task ProcessTurnAsync(byte[] wavBytes, bool wasInterruption)
    {
        string transcript;
        try
        {
            transcript = await backendClient.TranscribeAsync(wavBytes);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: transcription failed, resuming listening. {ex.Message}");
            ReturnToIdle();
            return;
        }

        if (string.IsNullOrWhiteSpace(transcript))
        {
            ReturnToIdle();
            return;
        }

        string commandText;
        if (!awake)
        {
            var command = WakeWordMatcher.ExtractWakeCommand(transcript);
            if (command is null)
            {
                ReturnToIdle();
                return;
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
            ReturnToIdle();
            return;
        }

        if (wasInterruption)
        {
            // #479 sub-project 3: classifies what the user just interrupted
            // Mana with. Only "amend" changes anything here -- the transcript
            // is wrapped so the model steers using the reply it was already
            // in the middle of (still in session history from before this
            // barge-in), rather than treating it as a standalone new
            // question. NOTE: no parentheses in the wrapper -- matches
            // windows-launcher/renderer/renderer.js's own note that
            // server-side transcript cleanup strips parenthesized text,
            // which would silently delete a "(...)"-wrapped prefix before
            // the model ever sees it.
            var category = await backendClient.ClassifyBargeInAsync(commandText);
            if (category == "amend")
            {
                commandText = $"Amending what you just said: {commandText}";
            }
        }

        await SpeakReplyAsync(commandText);
    }

    // Starts speaking commandText's reply and owns every mode transition
    // around it: OnTalkingStateChanged moves mode to Speaking exactly when
    // audio genuinely starts playing (not merely requested -- avoids a
    // false "interruption of nothing" during the network calls before the
    // first chunk is ready), and this method leaves mode either back at
    // Idle (playback finished naturally) or as CapturingInterruption (a
    // barge-in cut it off -- ProcessSpeakingFrame made that transition on
    // the capture thread; this method just has to recognize it happened
    // and not stomp on it).
    private async Task SpeakReplyAsync(string commandText)
    {
        string? reply;
        bool changed;
        bool interrupted;
        try
        {
            (reply, changed, _, interrupted) = await streamingReplyPlayer.StreamReplyAndPlayAsync(commandText);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: reply/stream failed, resuming listening. {ex.Message}");
            ReturnToIdle();
            return;
        }

        if (interrupted)
        {
            return; // mode already CapturingInterruption; nothing further to do here
        }

        if (!changed)
        {
            // Every streamed sentence finished playing naturally -- resume
            // listening immediately.
            ReturnToIdle();
            return;
        }

        // Nothing streamed (tool-calling/best-of-N/vision path) or a
        // regeneration pass rewrote the reply after streaming already
        // started -- fall back to synthesizing and playing the true final
        // reply once. This fallback playback can itself be interrupted by
        // a barge-in too (closes the "duplicated audio on regen" gap
        // sub-project 2 documented: a barge-in mid-fallback-playback cuts
        // it off instead of guaranteeing the whole thing plays out).
        byte[] replyWav;
        try
        {
            replyWav = await backendClient.SynthesizeAsync(reply ?? string.Empty);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: synthesis failed, resuming listening. {ex.Message}");
            ReturnToIdle();
            return;
        }

        bool completedNaturally;
        try
        {
            OnTalkingStateChanged(true);
            completedNaturally = await audioPlayer.PlayAsync(replyWav);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: playback failed to start, resuming listening. {ex.Message}");
            OnTalkingStateChanged(false);
            ReturnToIdle();
            return;
        }

        OnTalkingStateChanged(false);
        if (completedNaturally)
        {
            ReturnToIdle();
        }
        // else: interrupted -- mode already CapturingInterruption (set by
        // ProcessSpeakingFrame on the capture thread before PlayAsync's
        // Task resolved), nothing further to do here.
    }

    // Called by StreamingReplyPlayer exactly when the first chunk of a
    // streamed reply starts playing (talking: true) and again once the
    // last chunk stops, whether naturally or via interruption
    // (talking: false); also called directly by SpeakReplyAsync around the
    // non-streaming fallback Play(), for the same "only Speaking while
    // audio is genuinely playing" reasoning. This -- not any call site
    // that merely decided to start a reply -- is where mode actually
    // enters Speaking, so barge-in detection never runs during the network
    // calls before audio is actually flowing (which would otherwise let
    // BargeInGate "interrupt" nothing).
    private void OnTalkingStateChanged(bool talking)
    {
        avatarOverlay.SetState(talking ? AvatarState.Talking : AvatarState.Idle);
        lock (stateLock)
        {
            if (talking)
            {
                mode = ListenMode.Speaking;
                bargeInHeldMs = 0;
                vad.Reset();
            }
            else if (mode == ListenMode.Speaking)
            {
                // Only step back if nothing has already moved mode on --
                // a barge-in mid-playback already switched to
                // CapturingInterruption itself; don't stomp on that.
                mode = ListenMode.Processing;
            }
        }
    }

    private void ReturnToIdle()
    {
        lock (stateLock)
        {
            // Guard against a barge-in having already raced ahead and
            // moved mode to CapturingInterruption -- same reasoning
            // OnTalkingStateChanged already applies for the identical
            // situation (e.g. a mid-reply exception here, from an
            // unhandled failure elsewhere in the turn, landing after
            // ProcessSpeakingFrame already switched modes on the capture
            // thread). Stomping it back to Idle here would clear
            // frameBuffer and silently drop whatever interruption audio
            // is already being captured.
            if (mode == ListenMode.CapturingInterruption)
            {
                return;
            }

            mode = ListenMode.Idle;
            // Deliberately discard audio buffered during the turn/playback
            // rather than replaying it as a fresh segment -- a
            // transcribe+reply+synthesize round trip risks the mic picking
            // up stale buffered noise, and by the time playback naturally
            // finishes there's nothing left worth replaying either. A
            // genuine mid-playback interruption is handled entirely
            // differently, via CapturingInterruption -- this path is only
            // ever reached when there was nothing to interrupt into.
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

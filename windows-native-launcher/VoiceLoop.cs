using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Mana.NativeLauncher.Live2D;
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
    private readonly WakeWordClassifier? wakeWordClassifier;
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
    // segmentElapsedMs, segmentSpeechMs, msSinceLastSpeech, mode, bargeInHeldMs,
    // heldSentences, heldStackDepth, manualStopPending, the #619 partial-
    // transcript and merge-window fields below, and the vad instance itself (SileroVadRunner mutates its own internal state
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
    private long segmentSpeechMs; // #682: VAD-speech frames in the segment, for speech-debug.log
    private long msSinceLastSpeech;
    private long bargeInHeldMs; // only meaningful while mode == Speaking

    // #513: the not-yet-played sentences of a reply a barge-in cut off,
    // kept so a backchannel/unclassified interruption (or the end of an
    // inserted new_question answer) can resume them from the cut point.
    // Null when nothing is held. heldStackDepth is 1 only while an
    // inserted new_question answer is playing on top of a hold -- a
    // second interruption then discards the outer hold outright instead
    // of stacking (windows-launcher's own depth-1 cap).
    private List<string>? heldSentences;
    // Set by InterruptSpeech (the manual interrupt hotkey), consumed by
    // whichever reply continuation that stop cut off (ConsumeManualStop),
    // cleared by ReturnToIdle and by a typed/vision/clip takeover.
    private bool manualStopPending;
    private int heldStackDepth;

    // #619: adaptive end-of-turn. While a segment records, /transcribe-partial
    // is polled (RecordingSegmenter.ShouldRequestPartial decides when) and
    // the latest result picks the silence that closes the turn -- but only
    // while it's fresh, i.e. no speech arrived after its snapshot
    // (lastPartialSpeechMs == segmentSpeechMs); a stale "complete-sounding"
    // partial must never cut off words it didn't hear. segmentId tags each
    // request so a result landing after its segment closed is dropped.
    // partialInFlight is deliberately NOT per-segment: requests never
    // overlap, even across a segment boundary.
    private readonly bool partialsEnabled;
    private long segmentId;
    private bool partialInFlight;
    private bool partialsOffThisSegment;
    private long msSinceLastPartialRequest;
    private long partialRequestedAtSpeechMs;
    private string? lastPartial;
    private long lastPartialSpeechMs;
    private long partialSilenceBufferMs = RecordingSegmenter.DefaultSilenceBufferMs;
    private string partialEotReason = "default";
    private int partialCount;
    private long? lastPartialMs;

    // A partial slower than this can't help end a turn early, so polling
    // stops for the rest of that segment (Whisper is busy enough already).
    private const long SlowPartialMs = 2500;
    private static readonly TimeSpan PartialTimeout = TimeSpan.FromSeconds(5);

    // #619 addendum: the ~1s after a turn closes, when resumed speech is
    // merged into it instead of becoming a second turn -- see TurnMergeWindow.
    private readonly TurnMergeWindow mergeWindow = new();

    // #522: ScreenContextReader owns its own min-interval/keyword-gate
    // caching internally, so this is just held and called, same as
    // backendClient. isGamingModeActive is a delegate (not a captured
    // bool) so VoiceLoop always sees ManaApplicationContext's current
    // tray-status poll result, not a stale snapshot from construction time.
    private readonly ScreenContextReader? screenContextReader;
    private readonly Func<bool> isGamingModeActive;

    // #585: populated by ManaApplicationContext's own periodic capture
    // timer (gated behind MANA_SCREEN_SENSING_ENABLED, matching
    // windows-launcher's own opt-in), read here only when the clip
    // hotkey fires. Null (the default) is a no-op, same pattern as
    // screenContextReader/artifactSink/chatLog above.
    private readonly ClipBuffer? clipBuffer;

    // #528: null (no artifact viewer constructed) is a no-op everywhere
    // it's used -- see IArtifactSink's own header comment.
    private readonly IArtifactSink? artifactSink;

    // #520: which ACP memory-store session outgoing turns are appended
    // to; null (the default, and every pre-#520 turn's behavior) means
    // node-bot's implicit "default" session, not sent as an explicit
    // field. Unlike awake/heldSentences (touched only from the single-
    // threaded turn-processing chain), this is written from the session
    // list UI's own thread while a turn may be reading it on a thread-
    // pool continuation -- volatile is enough (a plain reference swap,
    // not a compound read-modify-write), no need for stateLock here.
    private volatile string? currentSessionId;

    // #681: the active prompt preset (Settings > Presets), sent with every
    // reply. Same threading story as currentSessionId above.
    private volatile string? currentPresetId;

    // #521: null (no chat window constructed) is the common case and a
    // no-op everywhere it's used -- see IChatLog's own header comment.
    private readonly IChatLog? chatLog;

    public VoiceLoop(
        SileroVadRunner vad,
        ManaBackendClient backendClient,
        AudioPlayer audioPlayer,
        AvatarOverlayForm avatarOverlay,
        IChatLog? chatLog = null,
        IArtifactSink? artifactSink = null,
        ScreenContextReader? screenContextReader = null,
        Func<bool>? isGamingModeActive = null,
        ClipBuffer? clipBuffer = null,
        WakeWordClassifier? wakeWordClassifier = null)
    {
        this.vad = vad;
        this.wakeWordClassifier = wakeWordClassifier;
        this.backendClient = backendClient;
        this.audioPlayer = audioPlayer;
        this.avatarOverlay = avatarOverlay;
        this.chatLog = chatLog;
        this.artifactSink = artifactSink;
        this.screenContextReader = screenContextReader;
        this.clipBuffer = clipBuffer;
        // Never actually invoked unless screenContextReader is also
        // non-null (see the read-site below) -- defaulted to a fixed
        // false rather than left nullable so that call site doesn't need
        // its own separate null-check for this one.
        this.isGamingModeActive = isGamingModeActive ?? (() => false);
        // #619: MANA_PARTIAL_TRANSCRIPTS=0 is the kill switch (fixed 2.2s
        // end-of-turn, no extra Whisper calls); a remote backend never polls.
        partialsEnabled = backendClient.IsLocalBackend
            && Environment.GetEnvironmentVariable("MANA_PARTIAL_TRANSCRIPTS") != "0";
        streamingReplyPlayer = new StreamingReplyPlayer(
            backendClient,
            audioPlayer.PlayAsync,
            talking => OnTalkingStateChanged(talking),
            running => avatarOverlay.SetActivity(AvatarState.Working, running));
    }

    // #681: true between Start() and Stop() -- what the tray's and chat
    // window's Start/Stop listening toggle shows.
    public bool IsListening => capture is not null;

    // #681: backs that toggle. A failed start (e.g. no microphone) is
    // logged and leaves listening off rather than throwing into the UI.
    public void ToggleListening()
    {
        if (IsListening)
        {
            Stop();
            return;
        }
        try
        {
            Start();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: couldn't start listening. {ex.Message}");
            Stop();
        }
    }

    public void Start()
    {
        if (capture is not null)
        {
            return;
        }
        // #681: (re)starting always needs the wake word again. Also reset
        // here, not just in Stop(), in case a turn that was already past
        // the wake-word gate when Stop() ran set it back to true since.
        awake = false;

        // #619: echo-cancelled capture first (EchoCancellation), falling back
        // to the plain capture this always used if Windows doesn't apply an
        // AEC or any step fails. speech-debug.log records which one runs.
        if (!EchoCancellation.IsEnabled(Environment.GetEnvironmentVariable("MANA_VOICE_AEC"), ManaSettingsStore.Load().EchoCancellation))
        {
            VoiceDebugLog.AppendNote("capture: aec=off (Settings > Voice or MANA_VOICE_AEC)" + DescribeDevices());
            StartCapture(new WasapiCapture());
            return;
        }

        string fallbackReason;
        try
        {
            capture = new WasapiCapture();
            EchoCancellation.RequestCommunicationsProcessing(capture);
            StartCapture(capture);
            var effects = EchoCancellation.GetEffects(capture);
            if (EchoCancellation.KeepCommunicationsCapture(effects))
            {
                var ducking = EchoCancellation.TryOptOutOfDucking(capture) ? "opted-out" : "unavailable";
                VoiceDebugLog.AppendNote(
                    $"capture: aec={(effects is null ? "requested" : "on")} mode=communications effects={EchoCancellation.Describe(effects)} ducking={ducking}"
                    + DescribeDevices());
                return;
            }
            fallbackReason = $"no active echo canceller (effects={EchoCancellation.Describe(effects)})";
        }
        catch (Exception ex)
        {
            fallbackReason = $"{ex.GetType().Name}: {ex.Message}";
        }

        StopCapture();
        Console.WriteLine($"VoiceLoop: echo-cancelled capture unavailable, using raw capture. {fallbackReason}");
        VoiceDebugLog.AppendNote($"capture: aec=fallback reason=\"{fallbackReason}\"" + DescribeDevices());
        StartCapture(new WasapiCapture());
    }

    // For speech-debug.log: Windows' AEC cancels what the render endpoint
    // plays, so which speakers Mana uses vs. the communications default
    // matters when judging the live result.
    private static string DescribeDevices()
    {
        try
        {
            using var devices = new MMDeviceEnumerator();
            return $" mic=\"{devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console).FriendlyName}\""
                + $" speakers=\"{devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia).FriendlyName}\""
                + $" commsSpeakers=\"{devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Communications).FriendlyName}\"";
        }
        catch (Exception ex)
        {
            return $" devices=unknown ({ex.Message})";
        }
    }

    private void StartCapture(WasapiCapture newCapture)
    {
        capture = newCapture;
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

    private void StopCapture()
    {
        if (capture is not null)
        {
            capture.DataAvailable -= OnDataAvailable;
            capture.StopRecording();
            capture.Dispose();
            capture = null;
            resampled = null;
            captureBuffer = null;
        }
    }

    public void Stop()
    {
        // #681: capture comes down first, so no late DataAvailable can
        // refill the buffers reset below.
        StopCapture();

        // #513: a held reply is only ever meaningful while this instance
        // keeps running and can resume it later -- clear it on Stop() so
        // a subsequent Start() never resumes a reply from a previous
        // listening session. Matches windows-launcher's own
        // stopListening()/interrupt-speech handlers, both of which null
        // heldReply.
        lock (stateLock)
        {
            heldSentences = null;
            heldStackDepth = 0;

            // #681: Stop listening goes back to sleep (windows-launcher's
            // stopListening() resets awake) and drops any half-recorded
            // segment, so the next Start() doesn't prepend stale audio. A
            // turn in flight (Processing/Speaking) is left to finish and
            // return to Idle on its own.
            awake = false;
            // #619: no merging a closed turn with the next listening
            // session's audio; its turn task still claims and finishes.
            mergeWindow.Close();
            if (mode is ListenMode.Idle or ListenMode.CapturingInterruption)
            {
                mode = ListenMode.Idle;
                frameBuffer.Clear();
                ResetSegment();
            }
        }
    }

    // #520: called by the session list UI on switch/new-chat. Deliberately
    // doesn't touch heldSentences/mode -- switching sessions mid-reply is
    // a user action on a separate window, not an interruption of Mana
    // herself; whatever she's currently saying keeps playing against
    // whichever session was active when that turn started.
    public void SetSessionId(string? sessionId) => currentSessionId = sessionId;

    public void SetPresetId(string? presetId) => currentPresetId = presetId;

    // #577: lets ResearchForm record a finished report into whatever
    // session is currently active, matching windows-launcher's own
    // ensureSessionId() call at its deep-research entry point.
    public string? CurrentSessionId => currentSessionId;

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
        if (mode == ListenMode.Processing && !mergeWindow.IsOpen)
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

            if (mode == ListenMode.Processing)
            {
                // #619: a turn just closed and its merge window is open --
                // keep the gap audio, and if the user resumes talking, make
                // the closed turn's audio the start of a new segment.
                if (!mergeWindow.IsOpen)
                {
                    return; // window over; back to discarding (see above)
                }
                AppendSegmentFrame(frame, isSpeech);
                if (mergeWindow.OnFrame(isSpeech, FrameMs))
                {
                    MergeIntoClosedTurn();
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
        ResetSegment(heardSpeech: true); // see ProcessBufferedFrames' comment on why
        bargeInHeldMs = 0;
    }

    // Caller must already hold stateLock. Starts a fresh segment: every
    // path that drops or hands off the current one comes through here.
    private void ResetSegment(bool heardSpeech = false)
    {
        segmentSamples.Clear();
        hasHeardSpeechInSegment = heardSpeech;
        segmentElapsedMs = 0;
        segmentSpeechMs = 0;
        msSinceLastSpeech = 0;
        vad.Reset();

        // #619: a new segment gets new partials (segmentId drops any still
        // in flight for this one) and clears the "Hearing:" line.
        segmentId++;
        if (lastPartial is not null)
        {
            chatLog?.ShowHearing(null);
        }
        lastPartial = null;
        lastPartialSpeechMs = 0;
        partialRequestedAtSpeechMs = 0;
        msSinceLastPartialRequest = 0;
        partialsOffThisSegment = false;
        partialCount = 0;
        lastPartialMs = null;
    }

    // Caller must already hold stateLock.
    private void AppendSegmentFrame(float[] frame, bool isSpeech)
    {
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
            segmentSpeechMs += FrameMs;
        }
        else
        {
            msSinceLastSpeech += FrameMs;
        }
    }

    // Caller must already hold stateLock. #619: the user resumed talking
    // inside the merge window -- the closed turn's task will now fail its
    // Claim and drop its result, and its audio (plus the gap since) becomes
    // the start of the segment now recording, in whichever mode it was
    // recorded in (an interruption stays an interruption, so the hold it
    // would have consumed is consumed by the merged turn instead).
    private void MergeIntoClosedTurn()
    {
        segmentSamples.InsertRange(0, mergeWindow.ClosedSamples);
        segmentSpeechMs += mergeWindow.ClosedSpeechMs;
        segmentElapsedMs = segmentSamples.Count * 1000L / SileroVadRunner.SampleRate;
        hasHeardSpeechInSegment = true;
        mode = mergeWindow.ClosedWasInterruption ? ListenMode.CapturingInterruption : ListenMode.Idle;
        mergeWindow.Close();
    }

    // Caller must already hold stateLock. #619: whether live partials run
    // for this segment. Asleep with the #342 acoustic pre-filter gating,
    // they'd send every overheard sentence to Whisper -- exactly what the
    // pre-filter is there to avoid -- so they wait until Mana is awake.
    private bool PartialsActive =>
        partialsEnabled && !partialsOffThisSegment && (awake || wakeWordClassifier?.Threshold is null);

    // Caller must already hold stateLock.
    private void MaybeRequestPartial()
    {
        if (!PartialsActive || !RecordingSegmenter.ShouldRequestPartial(
                partialInFlight,
                segmentSpeechMs,
                segmentSpeechMs - partialRequestedAtSpeechMs,
                msSinceLastSpeech,
                msSinceLastPartialRequest))
        {
            return;
        }
        partialInFlight = true;
        partialRequestedAtSpeechMs = segmentSpeechMs;
        msSinceLastPartialRequest = 0;
        var snapshot = segmentSamples.ToArray();
        var id = segmentId;
        var speechMs = segmentSpeechMs;
        // Off the capture thread: WAV encoding and the HTTP call both.
        _ = Task.Run(() => RequestPartialAsync(snapshot, id, speechMs));
    }

    private async Task RequestPartialAsync(short[] samples, long id, long speechMs)
    {
        var stopwatch = Stopwatch.StartNew();
        string? text = null;
        try
        {
            using var timeout = new CancellationTokenSource(PartialTimeout);
            text = (await backendClient.TranscribePartialAsync(BuildWavBytes(samples), timeout.Token)).Trim();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: partial transcript failed. {ex.Message}");
        }

        lock (stateLock)
        {
            partialInFlight = false;
            if (id != segmentId)
            {
                return; // its segment already closed or was dropped
            }
            partialCount++;
            lastPartialMs = stopwatch.ElapsedMilliseconds;
            if (lastPartialMs > SlowPartialMs)
            {
                partialsOffThisSegment = true;
            }
            if (string.IsNullOrEmpty(text))
            {
                return;
            }
            lastPartial = text;
            lastPartialSpeechMs = speechMs;
            (partialSilenceBufferMs, partialEotReason) = RecordingSegmenter.SilenceBufferMsForTranscript(text);
            chatLog?.ShowHearing(text);
        }
    }

    // Caller must already hold stateLock. Shared by Idle and
    // CapturingInterruption (see ProcessBufferedFrames). Returns true if
    // the segment closed and HandleSegmentClosedAsync was dispatched.
    private bool ProcessSegmentFrame(float[] frame, bool isSpeech)
    {
        var wasCapturingInterruption = mode == ListenMode.CapturingInterruption;

        AppendSegmentFrame(frame, isSpeech);
        if (hasHeardSpeechInSegment)
        {
            msSinceLastPartialRequest += FrameMs;
        }

        // #619: a fresh partial picks the end-of-turn silence (shorter when
        // it sounds complete, longer when it trails off); none, or a stale
        // one, keeps the old fixed 2.2s.
        var partialFresh = lastPartial is not null && lastPartialSpeechMs == segmentSpeechMs;
        var silenceBufferMs = partialFresh ? partialSilenceBufferMs : RecordingSegmenter.DefaultSilenceBufferMs;

        var stopReason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeechInSegment,
            segmentElapsedMs,
            msSinceLastSpeech,
            silenceBufferMs: silenceBufferMs);

        // #682: a segment that hit the 20s cap while the user was still
        // talking is transcribed like any other (windows-launcher's
        // recorder.stop() on "max-duration" does the same) -- it used to
        // be silently discarded, so "Mana, <long request>" never reached
        // Whisper at all.
        if (stopReason == RecordingStopReason.SilenceAfterSpeech
            || (stopReason == RecordingStopReason.MaxDuration && hasHeardSpeechInSegment))
        {
            var eotReason = partialFresh ? partialEotReason
                : !PartialsActive ? "off"
                : lastPartial is null ? "nopartial"
                : "stale";
            mode = ListenMode.Processing;
            _ = HandleSegmentClosedAsync(
                wasCapturingInterruption,
                stopReason == RecordingStopReason.MaxDuration ? "max" : "silence",
                $"{silenceBufferMs}ms/{eotReason}");
            return true;
        }

        if (stopReason is RecordingStopReason.MaxDuration or RecordingStopReason.NoSpeechTimeout)
        {
            // Nothing heard yet: reset and keep listening in the same
            // mode rather than giving up. For CapturingInterruption
            // specifically, Mana has already stopped talking by this
            // point -- there's nothing to resume even if this times out,
            // so just keep waiting for the user.
            ResetSegment(heardSpeech: wasCapturingInterruption);
            return false;
        }

        MaybeRequestPartial();
        return false;
    }

    private async Task HandleSegmentClosedAsync(bool wasInterruption, string closeReason, string eot)
    {
        // Only ever invoked synchronously from ProcessSegmentFrame, which
        // is only ever invoked under stateLock -- so this runs under the
        // caller's lock too (C#'s lock is reentrant on the owning thread).
        short[] samples;
        VoiceSegmentLogEntry logEntry;
        long? turnId;
        lock (stateLock)
        {
            samples = segmentSamples.ToArray();
            logEntry = new VoiceSegmentLogEntry
            {
                Samples = samples,
                SpeechMs = segmentSpeechMs,
                Close = closeReason,
                Eot = eot,
                Partials = partialCount,
                PartialMs = lastPartialMs,
                Partial = lastPartial,
            };
            // #619: a segment cut off by the 20s cap gets no merge window --
            // merged onto, it would only hit the cap again on the next frame.
            turnId = closeReason == "max"
                ? null
                : mergeWindow.Open(samples, segmentSpeechMs, wasInterruption, Environment.TickCount64);
            ResetSegment();
        }

        await ProcessTurnAsync(samples, wasInterruption, logEntry, turnId);
    }

    // #619: the turn task's commit point -- waits out the rest of the merge
    // window, then claims the turn. False means the user resumed talking and
    // a merge superseded this turn. Nothing before this point may touch
    // shared state (mode, awake, the hold, the chat), so a superseded turn
    // can just return.
    private async Task<bool> ClaimTurnAsync(long? turnId)
    {
        if (turnId is not long id)
        {
            return true;
        }
        long remainingMs;
        lock (stateLock)
        {
            remainingMs = mergeWindow.RemainingMs(Environment.TickCount64);
        }
        if (remainingMs > 0)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(remainingMs));
        }
        lock (stateLock)
        {
            if (!mergeWindow.Claim(id))
            {
                return false;
            }
            // Drop the gap audio the window kept in case of a merge.
            ResetSegment();
            return true;
        }
    }

    // #523: entry point for the global "look at my screen" hotkey.
    // Pressing it is an explicit request, so (like #525's typed-input
    // entry point) it skips the wake-word gate entirely and sets awake
    // unconditionally. If Mana is actively speaking, this cuts her off the
    // same way a typed interruption would: stops playback, discards rather
    // than races to read whatever was held (see the comment at the discard
    // site for why racing the interrupted reply's own async continuation
    // isn't safe here), and dispatches this as a fresh turn -- no barge-in
    // classification, since a vision request isn't a continuation of
    // whatever she was saying. Returns false only when rejected outright (a
    // turn is already in flight); true once accepted, regardless of what
    // happens after -- capture/backend failures are handled internally
    // (ReturnToIdle), same contract shape as the typed-input entry point.
    public async Task<bool> SubmitVisionHotkeyAsync()
    {
        lock (stateLock)
        {
            if (mode is ListenMode.Processing or ListenMode.CapturingInterruption)
            {
                return false;
            }

            if (mode == ListenMode.Speaking)
            {
                audioPlayer.Stop();
                // ponytail: nulling here only prevents THIS method from
                // reading a torn value -- it doesn't stop the just-
                // stopped reply's own interrupted continuation from
                // later calling HoldIfNothingHeld and repopulating
                // heldSentences with what it cut off (that write races
                // this one, same class of gap as SubmitTypedCommandAsync's
                // own discard, and for the same reason: no safe way from
                // here to wait for that continuation before touching this
                // field). A future, unrelated interruption could then
                // wrongly resume that stale hold. Upgrade path if this
                // fidelity gap matters: track the in-flight SpeakReplyAsync
                // Task on VoiceLoop so an interruption from any entry
                // point can await its real completion first.
                heldSentences = null;
                heldStackDepth = 0;
                manualStopPending = false; // this turn owns mode, not a pending hotkey stop
            }
            mode = ListenMode.Processing;
        }

        awake = true;

        string image;
        try
        {
            // Off the UI thread -- this runs on WM_HOTKEY's own thread
            // (VisionHotkeyListener's message pump), and CopyFromScreen +
            // JPEG-encoding a full screen is enough work to visibly hitch
            // the tray/avatar UI if done inline here.
            image = await Task.Run(ScreenCapture.CaptureAsJpegDataUrl);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: vision hotkey screen capture failed, resuming listening. {ex.Message}");
            ReturnToIdle();
            return true;
        }

        await SpeakReplyAsync(VisionHotkeyMessages.DefaultPrompt, image: image);
        return true;
    }

    // #585: entry point for the global "what just happened?" clip hotkey
    // -- same shape as SubmitVisionHotkeyAsync (explicit request, skips
    // the wake-word gate, cuts off active speech the same way), but reads
    // whatever ManaApplicationContext's periodic capture timer already
    // put in clipBuffer instead of capturing fresh, and sends every
    // buffered frame (not just one) so the model can actually see what
    // happened over the lookback window, not just the current screen.
    public async Task<bool> SubmitClipHotkeyAsync()
    {
        lock (stateLock)
        {
            if (mode is ListenMode.Processing or ListenMode.CapturingInterruption)
            {
                return false;
            }

            if (mode == ListenMode.Speaking)
            {
                audioPlayer.Stop();
                heldSentences = null;
                heldStackDepth = 0;
                manualStopPending = false; // this turn owns mode, not a pending hotkey stop
            }
            mode = ListenMode.Processing;
        }

        awake = true;

        // Empty buffer (screen sensing disabled, or pressed before the
        // first capture tick) -- matches windows-launcher's own "Mana
        // hasn't captured anything yet" case, at the same fidelity
        // SubmitVisionHotkeyAsync's own capture-failure branch uses (a
        // console log and a silent return to idle, no separate status UI).
        var images = clipBuffer?.GetImages() ?? Array.Empty<string>();
        if (images.Count == 0)
        {
            Console.WriteLine("VoiceLoop: clip hotkey pressed but the clip buffer is empty, resuming listening.");
            ReturnToIdle();
            return true;
        }

        var prompt = VisionHotkeyMessages.BuildClipHotkeyPrompt(clipBuffer!.GetSpanSeconds());
        await SpeakReplyAsync(prompt, images: images);
        return true;
    }

    // #525: entry point for typed input from the quick-entry popup.
    // Typing is itself the deliberate trigger -- unlike voice, no wake
    // word is required, and awake is set unconditionally. If Mana is
    // actively speaking, this cuts her off and dispatches through the
    // exact same interruption path (classification, hold/resume) a
    // spoken barge-in uses, just triggered directly instead of detected
    // via VAD: mirrors ProcessSpeakingFrame's own audioPlayer.Stop() call,
    // but steps mode to Processing rather than CapturingInterruption since
    // there's no audio segment to capture -- the text already arrived
    // complete. Returns false without dispatching if a turn is already in
    // flight (Processing) or an audio interruption is already being
    // captured (CapturingInterruption); submitting again there would race
    // two turns against the same state, so the caller (the popup) gets a
    // clear "not accepted right now" instead of this silently corrupting
    // shared state.
    public async Task<bool> SubmitTypedCommandAsync(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.Length == 0)
        {
            return false;
        }

        bool wasInterruption;
        lock (stateLock)
        {
            if (mode is ListenMode.Processing or ListenMode.CapturingInterruption)
            {
                return false;
            }

            wasInterruption = mode == ListenMode.Speaking;
            if (wasInterruption)
            {
                audioPlayer.Stop();
                // ponytail: a typed interruption has no equivalent to a
                // voice barge-in's multi-second recording window, which is
                // what actually lets the just-stopped reply's own
                // HoldIfNothingHeld call (from its await chain's
                // continuation, deferred to the thread pool by
                // AudioPlayer's RunContinuationsAsynchronously) finish
                // before anything reads heldSentences -- ProcessTurnAsync
                // only reads it once the interruption's own segment
                // finishes recording, seconds later. Reading it here
                // instead, right after Stop() with nothing in between to
                // yield on, would race that continuation and always lose.
                // So this always discards whatever's in heldSentences (a
                // stale hold, if any) rather than risk resuming the wrong
                // thing; held is passed as null below, so
                // DispatchCommandAsync still classifies the interruption
                // (amend/correction/etc.), it just never has anything to
                // resume afterward. Upgrade path if that fidelity gap
                // matters: track the in-flight SpeakReplyAsync/
                // ResumeHeldAsync Task on VoiceLoop so a typed
                // interruption can await its real completion first.
                heldSentences = null;
                heldStackDepth = 0;
                manualStopPending = false; // this turn owns mode, not a pending hotkey stop
            }
            mode = ListenMode.Processing;
        }

        awake = true;
        await DispatchCommandAsync(trimmed, wasInterruption, held: null, nested: false);
        return true;
    }

    // Transcribes wavBytes and speaks a reply -- the single entry point for
    // both a normal fresh segment (Idle) and a barge-in's interruption
    // segment (CapturingInterruption); by the time an interruption can
    // happen, `awake` is already guaranteed true (Mana can only be
    // speaking, and therefore only be interrupted, after at least one
    // earlier turn already passed the wake-word gate below), so no
    // special-casing is needed between the two callers except classifying
    // the interruption itself.
    private async Task ProcessTurnAsync(short[] samples, bool wasInterruption, VoiceSegmentLogEntry logEntry, long? turnId)
    {
        // #342: acoustic pre-filter, before the Whisper call this whole
        // project exists to reduce. Only gates the not-yet-awake path --
        // wasInterruption segments only ever happen once `awake` is
        // already true (see this method's own header comment), and once
        // awake, every segment is a real command that must still reach
        // Whisper untouched, exactly like the existing text-match gate
        // right below already only runs `if (!awake)`. A false acoustic
        // negative here just means an extra Whisper round trip is
        // skipped for a segment that wasn't the wake word anyway in the
        // overwhelming majority case; a false acoustic positive costs one
        // wasted Whisper call, never a false wake-up, since the text
        // matcher below still has final say.
        //
        // #682: scored off the capture thread (a 20s segment is ~250
        // classifier windows); a classifier failure fails open -- it used
        // to escape this fire-and-forget task and leave mode stuck in
        // Processing. Every early exit below logs one speech-debug.log
        // line first (Skip), and the success path logs before dispatch.
        //
        // #619: the pre-filter and Whisper run while the merge window is
        // still open -- they only fill in logEntry/transcript, nothing
        // shared -- and ClaimTurnAsync below decides whether this turn
        // still exists before anything acts on the result.
        logEntry.Awake = awake;
        var prefilterRejected = false;
        if (!awake && wakeWordClassifier is not null)
        {
            logEntry.Threshold = wakeWordClassifier.Threshold;
            try
            {
                logEntry.Score = await Task.Run(() => wakeWordClassifier.Score(samples));
            }
            catch (Exception ex)
            {
                logEntry.ClassifierFailed = true;
                Console.WriteLine($"VoiceLoop: wake-word classifier failed, sending to Whisper anyway. {ex.Message}");
            }

            // False whenever either side is null (off, or the classifier threw).
            prefilterRejected = logEntry.Score < logEntry.Threshold;
        }

        var transcript = "";
        if (!prefilterRejected)
        {
            try
            {
                transcript = await backendClient.TranscribeAsync(BuildWavBytes(samples));
                logEntry.Whisper = string.IsNullOrWhiteSpace(transcript) ? "empty" : "ok";
            }
            catch (Exception ex)
            {
                Console.WriteLine($"VoiceLoop: transcription failed, resuming listening. {ex.Message}");
                logEntry.Whisper = "failed";
            }
        }
        if (logEntry.Whisper == "ok")
        {
            logEntry.Transcript = transcript;
        }

        if (!await ClaimTurnAsync(turnId))
        {
            // Superseded: the merged segment re-sends this audio.
            logEntry.Merged = true;
            VoiceDebugLog.Append(logEntry);
            return;
        }

        // #513: consumed here, before any early exit -- a false barge-in
        // trigger (cough, TV noise, a word that didn't actually mean
        // anything) must still resume whatever reply it cut off rather
        // than silently dropping it. Whatever happens from here on, this
        // interruption consumes the hold: it's either resumed on an early
        // exit below, resumed after dispatch, re-held for a new_question,
        // or discarded (nested). (#619: taken only after the claim, so a
        // merged interruption leaves it for the merged turn.)
        List<string>? held = null;
        var nested = false;
        if (wasInterruption)
        {
            lock (stateLock)
            {
                held = heldSentences;
                nested = held is not null && heldStackDepth >= 1;
                heldSentences = null;
                heldStackDepth = 0;
            }
        }

        async Task Skip()
        {
            VoiceDebugLog.Append(logEntry);
            await ReturnToIdleOrResumeHeldAsync(held, nested);
        }

        // skipped (pre-filter), failed, or empty.
        if (logEntry.Whisper != "ok")
        {
            await Skip();
            return;
        }

        string commandText;
        if (!awake)
        {
            var command = WakeWordMatcher.ExtractWakeCommand(transcript);
            logEntry.WakeMatch = command is not null;
            if (command is null)
            {
                await Skip();
                return;
            }

            awake = true;
            commandText = command;
        }
        else
        {
            commandText = transcript;
        }

        VoiceDebugLog.Append(logEntry);
        await DispatchCommandAsync(commandText, wasInterruption, held, nested);
    }

    // #525: the shared tail of turn processing, once a resolved command
    // has already cleared the wake-word gate -- shared by ProcessTurnAsync
    // (a transcribed voice turn) and SubmitTypedCommandAsync (typed input
    // from the quick-entry popup), since neither the barge-in
    // classification/hold-resume dispatch below nor the final reply cares
    // whether commandText came from STT or was typed directly.
    private async Task DispatchCommandAsync(string commandText, bool wasInterruption, List<string>? held, bool nested)
    {
        if (string.IsNullOrWhiteSpace(commandText))
        {
            await ReturnToIdleOrResumeHeldAsync(held, nested);
            return;
        }

        // #522: computed once per turn (not per SpeakReplyAsync call --
        // the amend/new_question/fresh-turn branches below all still
        // describe the same single user turn) and reused across every
        // SpeakReplyAsync call site this dispatch might reach. "" (no
        // screen-context reader configured) is a no-op -- screenText is
        // always a string throughout this class/ReplyStreamAsync, never
        // null, same convention chatLog/artifactSink use nullability for
        // instead.
        var screenText = screenContextReader is null
            ? ""
            : await screenContextReader.ReadAsync(commandText, isGamingModeActive());

        // #521: logged once per turn here (not per SpeakReplyAsync call
        // site below) -- the amend/new_question/fresh-turn branches all
        // still describe the same single user turn.
        chatLog?.AppendUserMessage(commandText);

        if (wasInterruption)
        {
            if (nested)
            {
                // #513: a second interruption arrived while an inserted
                // new_question answer was playing on top of a hold -- per
                // the depth-1 cap, the outer hold is discarded outright
                // (not stacked) and this becomes a fresh top-level turn, no
                // classification needed since there's nothing left to
                // resume/discard against. Mirrors windows-launcher's
                // handleBargeInTrigger wasNested branch.
                await SpeakReplyAsync(commandText, screenText);
                return;
            }

            // #479 sub-project 3: classifies what the user just interrupted
            // Mana with. "amend" wraps the transcript so the model steers
            // using the reply it was already in the middle of (still in
            // session history from before this barge-in), rather than
            // treating it as a standalone new question. NOTE: no
            // parentheses in the wrapper -- matches windows-launcher/
            // renderer/renderer.js's own note that server-side transcript
            // cleanup strips parenthesized text, which would silently
            // delete a "(...)"-wrapped prefix before the model ever sees it.
            //
            // #513: with sentences held from the cut-off reply, the
            // category also decides their fate, same dispatch as
            // windows-launcher's handleBargeInInterruption -- amend/
            // correction discard them (the new reply replaces what was
            // being said, it doesn't supplement it); new_question answers
            // the question first, then resumes them; backchannel/
            // unclassified ("mhm", "okay") just resumes them, the
            // transcript itself isn't sent to the model at all. With
            // nothing held (she was on her last sentence), every category
            // simply becomes a fresh turn, as before #513.
            var category = await backendClient.ClassifyBargeInAsync(commandText);
            switch (category)
            {
                case "amend":
                    commandText = $"Amending what you just said: {commandText}";
                    break;

                case "correction":
                    break;

                case "new_question":
                    if (held is not null)
                    {
                        lock (stateLock)
                        {
                            heldSentences = held;
                            heldStackDepth = 1;
                        }
                        // SpeakReplyAsync's own return value -- not probing
                        // mode afterward -- says whether the inserted
                        // answer genuinely finished playing on its own. A
                        // nested interruption during it (or the answer
                        // simply failing) leaves the hold for that
                        // interruption's own ProcessTurnAsync to
                        // discard/consume (the `nested` branch above);
                        // only clear it and resume when it truly completed.
                        var answerCompleted = await SpeakReplyAsync(commandText, screenText);
                        if (answerCompleted)
                        {
                            lock (stateLock)
                            {
                                heldSentences = null;
                                heldStackDepth = 0;
                            }
                            await ResumeHeldAsync(held);
                        }
                        return;
                    }
                    break;

                default:
                    if (held is not null)
                    {
                        await ResumeHeldAsync(held);
                        return;
                    }
                    break;
            }
        }

        await SpeakReplyAsync(commandText, screenText);
    }

    // #513: the early-exit counterpart to the dispatch at the bottom of
    // ProcessTurnAsync -- a failed/empty transcript from what turned out
    // to be a false barge-in trigger must still resume whatever reply it
    // cut off, not silently drop it. `nested` (an interruption of an
    // inserted new_question answer) still discards the outer hold, same
    // as the real dispatch's own nested branch.
    private async Task ReturnToIdleOrResumeHeldAsync(List<string>? held, bool nested)
    {
        if (held is not null && !nested)
        {
            await ResumeHeldAsync(held);
        }
        else
        {
            ReturnToIdle();
        }
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
    // Returns true if the reply finished playing naturally (safe for a
    // caller to resume a held reply afterward -- #513's new_question path),
    // false if it was interrupted or failed for any reason. A failed
    // answer deliberately discards whatever was held rather than resuming
    // it (matches windows-launcher's handleBargeInTrigger, whose own catch
    // block nulls heldReply on any capture/transcribe/classify failure) --
    // failure and interruption are NOT distinguished by this return value;
    // both mean "don't resume".
    // #661: every reply goes through here, so this is where the avatar
    // shows Thinking (until she starts speaking -- speech outranks it),
    // and the short Done beat once a reply finishes naturally.
    private async Task<bool> SpeakReplyAsync(string commandText, string screenText = "", string? image = null, IReadOnlyList<string>? images = null)
    {
        avatarOverlay.SetActivity(AvatarState.Thinking, true);
        try
        {
            var completed = await SpeakReplyCoreAsync(commandText, screenText, image, images);
            if (completed)
            {
                avatarOverlay.PulseDone();
            }
            return completed;
        }
        finally
        {
            avatarOverlay.SetActivity(AvatarState.Thinking, false);
            avatarOverlay.SetActivity(AvatarState.Working, false);
        }
    }

    private async Task<bool> SpeakReplyCoreAsync(string commandText, string screenText, string? image, IReadOnlyList<string>? images)
    {
        string? reply;
        bool changed;
        string? preferredExpression;
        bool interrupted;
        IReadOnlyList<string> pending;
        try
        {
            (reply, changed, preferredExpression, interrupted, pending) = await streamingReplyPlayer.StreamReplyAndPlayAsync(commandText, currentSessionId, text => chatLog?.AppendReplySentence(text), screenText, image, images, currentPresetId);
        }
        catch (Exception ex)
        {
            // #523/#585: DescribeError's fallback phrasing ("Mana
            // couldn't look at the screen...") is vision-specific -- only
            // apply it when this call actually included an image
            // (vision-hotkey or clip-hotkey triggered), not to every
            // SpeakReplyAsync failure, which would misleadingly blame
            // vision for an unrelated reply error on a normal text turn.
            var message = image is not null || images is { Count: > 0 } ? VisionHotkeyMessages.DescribeError(ex.Message) : ex.Message;
            Console.WriteLine($"VoiceLoop: reply/stream failed, resuming listening. {message}");
            // #666: say so instead of dropping the turn silently. The raw
            // error stays in the console; vision turns keep DescribeError's
            // user-facing text in the chat.
            await SayReplyFailedAsync(image is not null || images is { Count: > 0 } ? message : ReplyFailedMessage);
            return false;
        }

        if (interrupted)
        {
            if (ConsumeManualStop())
            {
                return false;
            }
            // Mode is already CapturingInterruption (set by
            // ProcessSpeakingFrame on the capture thread). #513: hold what
            // hadn't played yet so ProcessTurnAsync can resume it once the
            // interruption is classified -- unless a hold already exists,
            // which means THIS was an inserted new_question answer being
            // interrupted on top of it (heldStackDepth 1); that nested case
            // leaves the outer hold for ProcessTurnAsync to discard, rather
            // than replacing it with the inserted answer's leftovers.
            HoldIfNothingHeld(pending);
            return false;
        }

        // #528: reported once per successful (non-interrupted) reply,
        // regardless of whether it streamed or fell back to the
        // non-streamed path below -- reply is the true final text
        // either way by this point.
        artifactSink?.ReportReply(reply ?? "");

        if (!changed)
        {
            chatLog?.ReplyFinished();
            // Every streamed sentence finished playing naturally -- resume
            // listening immediately.
            ReturnToIdle();
            return true;
        }

        // Nothing streamed (tool-calling/best-of-N/vision path) or a
        // regeneration pass rewrote the reply after streaming already
        // started -- fall back to synthesizing and playing the true final
        // reply once. This fallback playback can itself be interrupted by
        // a barge-in too (closes the "duplicated audio on regen" gap
        // sub-project 2 documented: a barge-in mid-fallback-playback cuts
        // it off instead of guaranteeing the whole thing plays out).
        //
        // #521: logged here too, since the "nothing streamed" case would
        // otherwise never show Mana's reply in the chat log at all. In
        // the rarer regeneration case, any already-streamed (and already
        // logged via onSentence) partial sentences from the abandoned
        // original stream stay in the log alongside this corrected full
        // text -- a real but narrow edge case not worth the complexity of
        // retracting already-appended chat lines to fix.
        chatLog?.AppendReplySentence(reply ?? string.Empty);
        chatLog?.ReplyFinished();

        byte[] replyWav;
        try
        {
            replyWav = await backendClient.SynthesizeAsync(reply ?? string.Empty);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: synthesis failed, resuming listening. {ex.Message}");
            ReturnToIdle();
            return false;
        }

        // Only reachable here with the FULL final reply text already known
        // (unlike the streaming path above, which only ever sees individual
        // sentences as they arrive -- per-sentence expression detection
        // isn't attempted there, a deliberate scope cut).
        var expression = ReplyEmotionDetector.DetectReplyEmotion(reply);

        bool completedNaturally;
        try
        {
            // #681: the model's own expression__set choice rides on the
            // final event. node-bot only sets it on the tool-calling path,
            // which never streams sentences -- so it always lands here, never
            // on the changed:false path above.
            OnTalkingStateChanged(true, MapReplyEmotionToAvatarState(expression), preferredExpression);
            completedNaturally = await audioPlayer.PlayAsync(replyWav);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: playback failed to start, resuming listening. {ex.Message}");
            OnTalkingStateChanged(false);
            ReturnToIdle();
            return false;
        }

        OnTalkingStateChanged(false);
        if (completedNaturally)
        {
            ReturnToIdle();
            return true;
        }
        // else: interrupted -- by a barge-in, mode is already
        // CapturingInterruption (set by ProcessSpeakingFrame on the capture
        // thread before PlayAsync's Task resolved), nothing further to do
        // here; by the interrupt hotkey, go back to Idle.
        ConsumeManualStop();
        return false;
    }

    private const string ReplyFailedMessage = "Sorry, I couldn't answer that just now. Try again in a moment.";

    // #666: a failed reply is shown in the chat and spoken once, with the
    // same mode handling as the non-streamed fallback above. If TTS is what
    // failed, the chat line is all the user gets -- still not silence.
    private async Task SayReplyFailedAsync(string chatText)
    {
        chatLog?.AppendReplySentence(chatText);
        try
        {
            var wav = await backendClient.SynthesizeAsync(ReplyFailedMessage);
            OnTalkingStateChanged(true);
            var completedNaturally = await audioPlayer.PlayAsync(wav);
            OnTalkingStateChanged(false);
            if (!completedNaturally)
            {
                // Barge-in owns mode already; the hotkey returns to Idle.
                ConsumeManualStop();
                return;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: couldn't speak the failure notice. {ex.Message}");
            OnTalkingStateChanged(false);
        }
        ReturnToIdle();
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
    //
    // talkingState: which AvatarState to show while talking=true -- the
    // streaming call site (StreamingReplyPlayer's setTalking delegate)
    // only ever passes a bool, so it uses the default Talking; the
    // non-streaming fallback call site (which has the full reply text
    // already, unlike streaming) passes ReplyEmotionDetector's result
    // instead. Ignored when talking=false (always goes to Idle).
    private void OnTalkingStateChanged(bool talking, AvatarState talkingState = AvatarState.Talking, string? preferredExpression = null)
    {
        avatarOverlay.SetState(talking ? talkingState : AvatarState.Idle, talking ? preferredExpression : null);
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

    // ReplyEmotionDetector's mood-state strings ("talking", "excited",
    // "sad", "angry", "disgusted") map directly onto AvatarState's names;
    // "talking" (its neutral/no-signal default) maps to Talking rather
    // than a separate neutral value -- there isn't one, Idle already means
    // something else (not speaking at all).
    private static AvatarState MapReplyEmotionToAvatarState(string emotion) => emotion switch
    {
        "excited" => AvatarState.Excited,
        "sad" => AvatarState.Sad,
        "angry" => AvatarState.Angry,
        "disgusted" => AvatarState.Disgusted,
        _ => AvatarState.Talking,
    };

    // #513: records a cut-off reply's unplayed sentences as the hold --
    // only if nothing is already held. A hold already existing here means
    // an inserted new_question answer (heldStackDepth 1) is what just got
    // interrupted; that nested case must leave the outer hold untouched
    // for ProcessTurnAsync's depth-cap branch to discard. An empty
    // `pending` (she was already on her last sentence) holds nothing --
    // there's nothing to resume, so the interruption is just a fresh turn.
    private void HoldIfNothingHeld(IReadOnlyList<string> pending)
    {
        if (pending.Count == 0)
        {
            return;
        }
        lock (stateLock)
        {
            if (heldSentences is null)
            {
                heldSentences = new List<string>(pending);
                heldStackDepth = 0;
            }
        }
    }

    // #513: re-speaks a held reply's remaining sentences from the cut
    // point. Owns its mode transitions the same way SpeakReplyAsync does:
    // Speaking is entered by OnTalkingStateChanged when the first chunk
    // actually plays, and this ends either back at Idle (finished
    // naturally) or leaves CapturingInterruption alone (a second barge-in
    // cut the resume off -- its own leftovers get held again, so a resume
    // can itself be resumed).
    private async Task ResumeHeldAsync(IReadOnlyList<string> held)
    {
        lock (stateLock)
        {
            // The new_question path reaches here right after the inserted
            // answer's SpeakReplyAsync returned to Idle -- listening was
            // live for the one synth round-trip until the first resumed
            // chunk plays. Step back to Processing now and drop whatever
            // partial segment that window may have started, so it can't
            // linger as a stale prefix on the next real utterance.
            mode = ListenMode.Processing;
            ResetSegment();
        }

        bool interrupted;
        IReadOnlyList<string> pending;
        try
        {
            (interrupted, pending) = await streamingReplyPlayer.ReplaySentencesAsync(held);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: resuming the held reply failed, resuming listening. {ex.Message}");
            ReturnToIdle();
            return;
        }

        if (interrupted)
        {
            if (!ConsumeManualStop())
            {
                HoldIfNothingHeld(pending);
            }
            return;
        }

        ReturnToIdle();
    }

    // The manual interrupt hotkey (Ctrl+Alt+I). A bare audioPlayer.Stop()
    // cut the reply off without ProcessSpeakingFrame's switch to
    // CapturingInterruption, so the reply's continuation (which expects
    // exactly that) left mode at Processing -- OnTalkingStateChanged(false)
    // had stepped Speaking -> Processing -- and every later voice, typed or
    // hotkey turn was ignored until restart. Matches windows-launcher's
    // interrupt-speech handler (stopReplyAudio + heldReply = null): stop,
    // drop the hold, and let the cut-off continuation return to Idle.
    // Stopping between two streamed sentences (nothing playing) is a no-op,
    // same as Electron; the flag is then cleared by ReturnToIdle when the
    // reply finishes on its own.
    public void InterruptSpeech()
    {
        lock (stateLock)
        {
            if (mode != ListenMode.Speaking)
            {
                return;
            }
            manualStopPending = true;
            heldSentences = null;
            heldStackDepth = 0;
            audioPlayer.Stop();
        }
    }

    // Called by a reply continuation that found itself interrupted. True
    // (and mode back to Idle) if the interrupt hotkey did it; false for a
    // barge-in (mode already CapturingInterruption) or a typed/vision/clip
    // takeover (which cleared the flag and owns mode for its own turn) --
    // those keep today's hold/leave-mode-alone behavior.
    private bool ConsumeManualStop()
    {
        lock (stateLock)
        {
            if (!manualStopPending || mode == ListenMode.CapturingInterruption)
            {
                return false;
            }
            manualStopPending = false;
            heldSentences = null;
            heldStackDepth = 0;
        }
        ReturnToIdle();
        return true;
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
            manualStopPending = false;
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

    private static byte[] BuildWavBytes(short[] samples)
    {
        using var stream = new MemoryStream();
        var writer = new WaveFileWriter(stream, new WaveFormat(SileroVadRunner.SampleRate, 16, 1));
        var bytes = new byte[samples.Length * 2];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        writer.Write(bytes, 0, bytes.Length);
        writer.Flush();
        var result = stream.ToArray();
        writer.Dispose();
        return result;
    }
}

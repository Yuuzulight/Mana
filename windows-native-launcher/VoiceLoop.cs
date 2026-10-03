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
    // #858: null when MANA_DISABLE_VAD=1 or the model couldn't load;
    // vadFailed once inference threw. Either way frames are judged by RMS
    // instead (IsSpeechFrame), like Electron's fallback.
    private readonly SileroVadRunner? vad;
    private volatile bool vadFailed;
    // #858: the end-of-turn silence (MANA_SILENCE_BUFFER_MS / Settings >
    // Voice), read each time listening starts.
    private long baseSilenceBufferMs = RecordingSegmenter.DefaultSilenceBufferMs;
    private readonly WakeWordClassifier? wakeWordClassifier;
    private readonly CaptionOverlayForm? captions;
    private readonly ChatBubblesForm? bubbles; // #701
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

    // #665: read each time listening starts (see BargeInPolicy).
    private BargeInMode bargeInMode = BargeInMode.MinWords;
    private int bargeInMinWords = BargeInPolicy.DefaultMinWords;
    // #682: MANA_BARGE_IN_VOICE / _HOLD_MS / _MIN_DBFS, read with the above.
    private bool bargeInVoiceEnabled = true;
    private long bargeInRequiredMs = BargeInGate.DefaultHoldMs;
    private double bargeInMinDbfs = BargeInGate.DefaultMinDbfs;

    // #678: the voiceprint gate, read each time listening starts. The model
    // is only loaded once a gate mode is on and I've enrolled.
    private SpeakerGateMode speakerGateMode;
    private float[]? voiceprint;
    private float speakerThreshold = SpeakerGate.DefaultThreshold;
    private SpeakerEmbedder? speakerEmbedder;
    private bool disposed; // #922: Settings closing after quit mustn't restart listening

    // #665 notWhileSpeaking: recording what I say while she keeps talking
    // (mode stays Speaking), and what I said, held until she finishes.
    private bool hearingOverSpeech;
    private (short[] Samples, long SpeechMs)? queuedTurn;
    // #665 minWords: she's ducked, not stopped, until the interruption turn
    // decides; replyTalking says whether her reply is still playing then,
    // and currentReply is what holds her unplayed sentences once stopped.
    private bool bargeInDucked;
    private bool duckStopRequested;
    private bool replyTalking;
    private Task currentReply = Task.CompletedTask;

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

    // #909: Smart Turn scores each pause once it reaches SmartTurnPauseMs of
    // silence (off the capture thread); like a partial, the score only counts
    // while no speech has arrived since (smartTurnSpeechMs == segmentSpeechMs).
    // smartTurnThreshold null = MANA_SMART_TURN=off; smartTurn null = off or
    // no model. Guarded by stateLock, except the runner's own Run.
    private SmartTurnRunner? smartTurn;
    private float? smartTurnThreshold;
    private bool smartTurnInFlight;
    private long smartTurnRequestedAtSpeechMs;
    private float? smartTurnP;
    private long smartTurnSpeechMs;
    private long smartTurnMs;

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
    // #697: returns true when another app is actively playing audio or using the mic.
    private readonly Func<bool>? isAudioBusy;

    // #859: Electron's gaming-mode listen pacing. Electron listens in
    // discrete rounds and, while a game runs, waits before the next round
    // after one that led nowhere; native captures continuously, so the
    // same pause means ignoring mic frames until this time (TickCount64).
    // Under stateLock.
    private long listenPausedUntilMs;
    internal const long GamingAwakePauseMs = 1800;  // GAMING_IDLE_PAUSE_MS
    internal const long GamingAsleepPauseMs = 3200; // GAMING_DEEP_IDLE_PAUSE_MS

    // How long to stop listening after a segment that led to no turn: 0
    // outside gaming mode; after a barge-in's segment never (she has a
    // reply to resume).
    internal static long GamingListenPauseMs(bool gaming, bool awake, bool wasInterruption) =>
        !gaming || wasInterruption ? 0 : awake ? GamingAwakePauseMs : GamingAsleepPauseMs;

    // #678: after this long with no turn she needs the wake word again
    // (MANA_WAKE_REARM_MS, 0 = stay awake until Stop). lastTurnAtMs is
    // when the last turn ended or she was woken (TickCount64, stateLock).
    internal const long DefaultWakeRearmMs = 60000;
    private long wakeRearmMs = DefaultWakeRearmMs;
    private long lastTurnAtMs;

    internal static long ResolveWakeRearmMs(string? env) =>
        long.TryParse(env, out var ms) && ms >= 0 ? ms : DefaultWakeRearmMs;

    // Only between segments, so a command already being spoken when the
    // quiet period runs out still counts.
    internal static bool ShouldRearm(bool awake, bool midSegment, long lastTurnAtMs, long nowMs, long rearmMs) =>
        awake && !midSegment && rearmMs > 0 && nowMs - lastTurnAtMs >= rearmMs;

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
    // to. No session is not a "default" one: node-bot saves no turn
    // without a sessionId, so every turn asks AutoSession for one (Q62).
    // Written from the session list UI's thread while a turn may read it
    // on a thread-pool continuation; AutoSession locks internally.
    private readonly AutoSession session = new();

    // #681: the active prompt preset (Settings > Presets), sent with every
    // reply. Unlike awake/heldSentences (touched only from the single-
    // threaded turn-processing chain), this is written from the UI thread
    // while a turn may be reading it on a thread-pool continuation --
    // volatile is enough (a plain reference swap), no need for stateLock.
    private volatile string? currentPresetId;

    // #675: the main window's deep-thinking toggle -- while on, every reply
    // (spoken or typed) asks node-bot to think harder. Same threading story.
    private volatile bool deepThinking;

    // #675 Q12b: Mana's own deep thinking (she turns it on when asked, for
    // the task), from each reply's final event; lights the Think button via
    // ManaDeepThinkingChanged (raised on the reply's thread). stopManaThinking:
    // the user clicked the lit button off, so the next reply sends
    // thinkHarder: false to end it on node-bot.
    private volatile bool manaDeepThinking;
    private volatile bool stopManaThinking;
    public event Action<bool>? ManaDeepThinkingChanged;

    // #521: null (no chat window constructed) is the common case and a
    // no-op everywhere it's used -- see IChatLog's own header comment.
    private readonly IChatLog? chatLog;

    public VoiceLoop(
        SileroVadRunner? vad,
        ManaBackendClient backendClient,
        AudioPlayer audioPlayer,
        AvatarOverlayForm avatarOverlay,
        IChatLog? chatLog = null,
        IArtifactSink? artifactSink = null,
        ScreenContextReader? screenContextReader = null,
        Func<bool>? isGamingModeActive = null,
        ClipBuffer? clipBuffer = null,
        WakeWordClassifier? wakeWordClassifier = null,
        CaptionOverlayForm? captions = null,
        ChatBubblesForm? bubbles = null,
        Func<bool>? isAudioBusy = null)
    {
        this.vad = vad;
        this.captions = captions;
        this.bubbles = bubbles;
        this.isAudioBusy = isAudioBusy;
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
            running => avatarOverlay.SetActivity(AvatarState.Working, running),
            (sentence, emotion, duration) =>
            {
                captions?.ShowSentence(sentence, duration);
                bubbles?.ShowSentence(sentence, duration);
                // #623: each sentence's own face as its audio starts -- the
                // model's emotion tag, else read from the sentence's text.
                avatarOverlay.SetState(MapReplyEmotionToAvatarState(ReplyEmotionDetector.DetectReplyEmotion(sentence, emotion)), null, emotion);
            },
            steps => this.chatLog?.ShowStreamSteps(steps)); // #1337
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
            lastError = null;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: couldn't start listening. {ex.Message}");
            LogCrash(ex, "start");
            lastError = $"Listening error: {ex.Message}";
            Stop();
        }
    }

    // #662: clicking Mana on the overlay counts as the wake word -- listening
    // comes on if it was off, and the next thing said is a command. Set
    // after Start(), which resets awake.
    public void Wake()
    {
        if (!IsListening)
        {
            ToggleListening();
        }
        lock (stateLock)
        {
            awake = IsListening;
            lastTurnAtMs = Environment.TickCount64; // #678
            listenPausedUntilMs = 0; // #859: she was just called on purpose
        }
    }

    // #849: pauses voice loop audio processing while dictate-anywhere records speech
    public IDisposable PauseForDictation()
    {
        lock (stateLock)
        {
            listenPausedUntilMs = long.MaxValue;
            return new DictationPauseToken(this);
        }
    }

    private sealed class DictationPauseToken(VoiceLoop loop) : IDisposable
    {
        private VoiceLoop? loop = loop;

        public void Dispose()
        {
            var l = Interlocked.Exchange(ref loop, null);
            if (l is not null)
            {
                lock (l.stateLock)
                {
                    l.listenPausedUntilMs = 0;
                }
            }
        }
    }

    public void Start()
    {
        if (capture is not null || disposed)
        {
            return;
        }
        // #681: (re)starting always needs the wake word again. Also reset
        // here, not just in Stop(), in case a turn that was already past
        // the wake-word gate when Stop() ran set it back to true since.
        awake = false;
        var settings = ManaSettingsStore.Load();
        bargeInMode = BargeInPolicy.Resolve(Environment.GetEnvironmentVariable("MANA_BARGE_IN_MODE"), settings.BargeInMode);
        bargeInMinWords = BargeInPolicy.MinWords(Environment.GetEnvironmentVariable("MANA_BARGE_IN_MIN_WORDS"));
        bargeInVoiceEnabled = BargeInGate.VoiceEnabled(Environment.GetEnvironmentVariable("MANA_BARGE_IN_VOICE"));
        bargeInRequiredMs = BargeInGate.ResolveHoldMs(Environment.GetEnvironmentVariable("MANA_BARGE_IN_HOLD_MS"));
        bargeInMinDbfs = BargeInGate.ResolveMinDbfs(Environment.GetEnvironmentVariable("MANA_BARGE_IN_MIN_DBFS"));
        wakeRearmMs = ResolveWakeRearmMs(Environment.GetEnvironmentVariable("MANA_WAKE_REARM_MS"));
        speakerGateMode = SpeakerGate.ResolveMode(Environment.GetEnvironmentVariable("MANA_SPEAKER_GATE"), settings.VoiceprintGate);
        speakerThreshold = SpeakerGate.ResolveThreshold(Environment.GetEnvironmentVariable("MANA_SPEAKER_THRESHOLD"), settings.SpeakerThreshold);
        voiceprint = speakerGateMode == SpeakerGateMode.Off ? null : settings.Voiceprint;
        if (voiceprint is not null)
        {
            speakerEmbedder ??= SpeakerEmbedder.TryLoad(ManaApplicationContext.FindRootDirectory());
        }
        VoiceDebugLog.AppendNote(string.Create(System.Globalization.CultureInfo.InvariantCulture,
            $"speaker: gate={SpeakerGate.ModeNames[(int)speakerGateMode]} enrolled={(settings.Voiceprint is not null ? "yes" : settings.VoiceprintProtected is not null ? "unreadable (teach her again)" : "no")} model={(voiceprint is null ? "unused" : speakerEmbedder is null ? "missing (passing all speech through)" : "loaded")} threshold={speakerThreshold:F2}"));

        // #858: voice tunables, env var over Settings > Voice.
        var voiceSettings = ManaSettingsStore.Load();
        baseSilenceBufferMs = RecordingSegmenter.ResolveSilenceBufferMs(Environment.GetEnvironmentVariable("MANA_SILENCE_BUFFER_MS"), voiceSettings.SilenceBufferMs);
        if (vad is not null)
        {
            vad.Threshold = SileroVadRunner.ResolveThreshold(Environment.GetEnvironmentVariable("MANA_VAD_THRESHOLD"), voiceSettings.VadThreshold);
        }
        smartTurnThreshold = SmartTurnRunner.ResolveThreshold(Environment.GetEnvironmentVariable("MANA_SMART_TURN"));
        if (smartTurnThreshold is not null)
        {
            smartTurn ??= SmartTurnRunner.TryLoad(ManaApplicationContext.FindRootDirectory());
        }
        VoiceDebugLog.AppendNote(string.Create(System.Globalization.CultureInfo.InvariantCulture,
            $"vad: {VadInUse}{(vad is not null && !vadFailed ? $" threshold={vad.Threshold:F2}/exit={vad.ExitThreshold:F2}" : $" minRms={SpeechFilters.MinSpeechRms:F3}")} silence={baseSilenceBufferMs}ms"
            + $" turn={(smartTurnThreshold is not { } turnThreshold ? "off" : smartTurn is null ? "missing" : $"{turnThreshold:F2}")}"));

        // #619: echo-cancelled capture first (EchoCancellation), falling back
        // to the plain capture this always used if Windows doesn't apply an
        // AEC or any step fails. speech-debug.log records which one runs.
        if (!EchoCancellation.IsEnabled(Environment.GetEnvironmentVariable("MANA_VOICE_AEC"), settings.EchoCancellation))
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
        capture.RecordingStopped += OnRecordingStopped;
        capture.StartRecording();
    }

    // #860: NAudio reports a capture that died (mic unplugged, device
    // error) here; a normal StopRecording has no exception.
    private void OnRecordingStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception is { } ex)
        {
            Console.WriteLine($"VoiceLoop: microphone capture stopped. {ex.Message}");
            LogCrash(ex, "capture");
            lastError = $"Listening error: {ex.Message}";
        }
    }

    // #860: an exception that got out of the voice loop, for voice-crash.log,
    // with the speech detector in use (#858).
    private void LogCrash(Exception ex, string where) =>
        VoiceCrashLog.Append(ex, where, VadInUse, CaptureDeviceName(), awake, IsListening);

    private static string? CaptureDeviceName()
    {
        try
        {
            using var devices = new MMDeviceEnumerator();
            return devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console).FriendlyName;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private void StopCapture()
    {
        if (capture is not null)
        {
            capture.DataAvailable -= OnDataAvailable;
            capture.RecordingStopped -= OnRecordingStopped;
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
            // #665: nor answering what was said over her before Stop.
            queuedTurn = null;
            hearingOverSpeech = false;
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
    public void SetSessionId(string? sessionId)
    {
        session.Set(sessionId);
        SaveLastSession();
    }

    // #687: see AutoSession.Restore.
    public void RestoreSession(string sessionId, bool auto, DateTime lastTurnAtUtc) => session.Restore(sessionId, auto, lastTurnAtUtc);

    // #687: remembered so the next launch reopens this session.
    private void SaveLastSession()
    {
        try
        {
            var settings = ManaSettingsStore.Load();
            settings.LastSessionId = session.CurrentId;
            settings.LastSessionAuto = session.IsAuto;
            settings.Save();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.WriteLine($"VoiceLoop: couldn't remember the current session. {ex.Message}");
        }
    }

    public void SetPresetId(string? presetId) => currentPresetId = presetId;

    public void SetDeepThinking(bool on)
    {
        deepThinking = on;
        if (!on && manaDeepThinking)
        {
            manaDeepThinking = false;
            stopManaThinking = true;
        }
    }

    public string? CurrentSessionId => session.CurrentId;

    // Q62: the session a turn goes out with -- every chat turn (typed,
    // spoken, vision/clip hotkeys) via SpeakReplyCoreAsync, and #577's
    // ResearchForm, matching windows-launcher's own ensureSessionId() at
    // its deep-research entry point.
    public string EnsureSessionId()
    {
        var before = session.CurrentId;
        var id = session.EnsureForTurn();
        if (id != before)
        {
            SaveLastSession();
        }
        return id;
    }

    // #687: the chat window's status line (SessionListForm polls it), like
    // Electron's: the last error until the next reply starts, else what she's
    // doing. Read without the lock -- a stale read shows for one poll.
    // #914: whose sentence is playing (group mode lip-syncs her avatar), and
    // when a reply's talking ends (her mouth closes too).
    public string? PlayingCharacter => streamingReplyPlayer.PlayingCharacter;
    public event Action? TalkingEnded;

    public string StatusText => FormatStatus(lastError, IsListening, mode, awake, streamingReplyPlayer.SynthesizingSentence);

    internal static string FormatStatus(string? error, bool listening, ListenMode mode, bool awake, int? synthesizing)
    {
        if (error is not null)
        {
            return error;
        }
        if (!listening)
        {
            return "Not listening";
        }
        var synth = synthesizing is int n ? $"synthesizing sentence {n}..." : null;
        return mode switch
        {
            ListenMode.Idle => awake ? "Mana is awake..." : "Waiting for Mana...",
            ListenMode.Speaking => synth is null ? "Speaking..." : $"Speaking, {synth}",
            ListenMode.CapturingInterruption => "Listening...",
            _ => synth is null ? "Mana is thinking..." : char.ToUpperInvariant(synth[0]) + synth[1..],
        };
    }

    private volatile string? lastError;

    // #668: no turn in flight and she isn't speaking -- when the message
    // box's queue may send its next message without cutting her off.
    public bool IsIdle
    {
        get
        {
            lock (stateLock)
            {
                return mode == ListenMode.Idle;
            }
        }
    }

    public void Dispose()
    {
        disposed = true;
        Stop();
        speakerEmbedder?.Dispose();
        smartTurn?.Dispose();
    }

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
    // #858: which speech detector is judging frames -- for the status
    // window and speech-debug.log.
    public string VadInUse => vad is null ? "rms (Silero off or unavailable)" : vadFailed ? "rms (Silero failed)" : "silero";

    // #858: Silero's speech probability, else Electron's RMS fallback
    // (isSpeechNow: frame RMS >= MANA_MIN_SPEECH_RMS). An inference error
    // switches to RMS for the rest of the session, as in Electron.
    private bool IsSpeechFrame(float[] frame)
    {
        if (vad is not null && !vadFailed)
        {
            try
            {
                return vad.IsSpeech(vad.ProcessFrame(frame));
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                vadFailed = true;
                Console.WriteLine($"VoiceLoop: Silero VAD failed, using RMS for this session. {ex.Message}");
                VoiceDebugLog.AppendNote($"vad: silero failed, using rms ({ex.GetType().Name}: {ex.Message})");
            }
        }
        return IsSpeechByRms(frame, SpeechFilters.MinSpeechRms);
    }

    internal static bool IsSpeechByRms(float[] frame, double minRms)
    {
        double sum = 0;
        foreach (var sample in frame)
        {
            sum += sample * sample;
        }
        return frame.Length > 0 && Math.Sqrt(sum / frame.Length) >= minRms;
    }

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
            if (mode == ListenMode.Idle && Environment.TickCount64 < listenPausedUntilMs)
            {
                continue; // #859: gaming-mode pause after a segment that led nowhere
            }
            if (mode == ListenMode.Idle && ShouldRearm(awake, hasHeardSpeechInSegment, lastTurnAtMs, Environment.TickCount64, wakeRearmMs))
            {
                awake = false;
                VoiceDebugLog.AppendNote($"wake: re-armed after {wakeRearmMs}ms with no turn");
            }

            var isSpeech = IsSpeechFrame(frame);

            if (mode == ListenMode.Speaking)
            {
                if (hearingOverSpeech)
                {
                    ProcessOverSpeechFrame(frame, isSpeech);
                    continue;
                }
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
        // MANA_BARGE_IN_VOICE=0: hotkey-only, talking over her does nothing.
        if (!bargeInVoiceEnabled)
        {
            return false;
        }
        var isLoudEnough = BargeInGate.DbfsFromSamples(frame) >= bargeInMinDbfs;
        var (heldMs, triggered) = BargeInGate.Next(isSpeech, isLoudEnough, bargeInHeldMs, FrameMs, bargeInRequiredMs);
        bargeInHeldMs = heldMs;

        if (!triggered)
        {
            return false;
        }

        // #665 notWhileSpeaking: she keeps talking; what I'm saying is
        // recorded and answered once she's done.
        if (bargeInMode == BargeInMode.NotWhileSpeaking)
        {
            hearingOverSpeech = true;
            ResetSegment(heardSpeech: true);
            bargeInHeldMs = 0;
            return false;
        }

        // #665 minWords: duck her (instant feedback) and record what I'm
        // saying like any interruption; ProcessTurnAsync stops her only if
        // it has enough words (DecideDuckedInterruptionAsync).
        if (bargeInMode == BargeInMode.MinWords)
        {
            bargeInDucked = true;
            duckStopRequested = false;
            audioPlayer.Volume = BargeInPolicy.DuckVolume;
            StartCapturingInterruption();
            return true;
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

    // Caller must already hold stateLock. #665 notWhileSpeaking: records
    // like a normal segment while she talks; a finished one is queued (joined
    // onto any already queued) for ReturnToIdle to dispatch.
    private void ProcessOverSpeechFrame(float[] frame, bool isSpeech)
    {
        AppendSegmentFrame(frame, isSpeech);
        var stopReason = RecordingSegmenter.ShouldStopRecording(hasHeardSpeechInSegment, segmentElapsedMs, msSinceLastSpeech);
        if (stopReason is RecordingStopReason.SilenceAfterSpeech or RecordingStopReason.MaxDuration)
        {
            var samples = segmentSamples.ToArray();
            queuedTurn = queuedTurn is { } queued
                ? ([.. queued.Samples, .. samples], queued.SpeechMs + segmentSpeechMs)
                : (samples, segmentSpeechMs);
            hearingOverSpeech = false;
            ResetSegment();
        }
        else if (stopReason == RecordingStopReason.NoSpeechTimeout)
        {
            hearingOverSpeech = false;
            ResetSegment();
        }
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
        vad?.Reset();

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
        smartTurnRequestedAtSpeechMs = 0;
        smartTurnP = null;
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
            (partialSilenceBufferMs, partialEotReason) = RecordingSegmenter.SilenceBufferMsForTranscript(text, baseSilenceBufferMs);
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
        // one, keeps the old fixed 2.2s. #909: a fresh Smart Turn score then
        // refines that (RecordingSegmenter.WithSmartTurn).
        var partialFresh = lastPartial is not null && lastPartialSpeechMs == segmentSpeechMs;
        var smartTurnFresh = smartTurnP is not null && smartTurnSpeechMs == segmentSpeechMs;
        var (silenceBufferMs, eotReason) = RecordingSegmenter.WithSmartTurn(
            partialFresh ? (partialSilenceBufferMs, partialEotReason)
                : (baseSilenceBufferMs, !PartialsActive ? "off" : lastPartial is null ? "nopartial" : "stale"),
            smartTurnFresh ? smartTurnP : null,
            smartTurnThreshold ?? SmartTurnRunner.DefaultThreshold,
            baseSilenceBufferMs);

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
            mode = ListenMode.Processing;
            _ = HandleSegmentClosedAsync(
                wasCapturingInterruption,
                stopReason == RecordingStopReason.MaxDuration ? "max" : "silence",
                $"{silenceBufferMs}ms/{eotReason}"
                    + (smartTurnFresh ? string.Create(System.Globalization.CultureInfo.InvariantCulture, $" turn={smartTurnP:F2}/{smartTurnMs}ms") : ""));
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
        MaybeScoreTurn();
        return false;
    }

    // Caller must already hold stateLock. #909: one Smart Turn run per pause,
    // never overlapping (across segments too, like partials).
    private void MaybeScoreTurn()
    {
        if (smartTurn is not { } runner || smartTurnThreshold is null || smartTurnInFlight
            || !hasHeardSpeechInSegment || msSinceLastSpeech < RecordingSegmenter.SmartTurnPauseMs
            || smartTurnRequestedAtSpeechMs == segmentSpeechMs)
        {
            return;
        }
        smartTurnInFlight = true;
        smartTurnRequestedAtSpeechMs = segmentSpeechMs;
        var take = Math.Min(segmentSamples.Count, SmartTurnRunner.MaxSamples);
        var snapshot = segmentSamples.GetRange(segmentSamples.Count - take, take).ToArray();
        var id = segmentId;
        var speechMs = segmentSpeechMs;
        _ = Task.Run(() =>
        {
            var stopwatch = Stopwatch.StartNew();
            float? p = null;
            try
            {
                p = runner.PredictComplete(snapshot);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"VoiceLoop: Smart Turn failed. {ex.Message}");
            }
            lock (stateLock)
            {
                smartTurnInFlight = false;
                if (id == segmentId && p is not null)
                {
                    smartTurnP = p;
                    smartTurnSpeechMs = speechMs;
                    smartTurnMs = stopwatch.ElapsedMilliseconds;
                }
            }
        });
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

        // #860: fire-and-forget from the capture thread, so an exception
        // here would otherwise vanish and leave the loop stuck mid-turn.
        try
        {
            await ProcessTurnAsync(samples, wasInterruption, logEntry, turnId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: turn failed, resuming listening. {ex}");
            LogCrash(ex, "turn");
            lastError = $"Listening error: {ex.Message}";
            ReturnToIdle();
        }
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
    // #912: the camera hotkey passes its own capture and prompt.
    public async Task<bool> SubmitVisionHotkeyAsync(Func<Task<string>>? capture = null, string prompt = VisionHotkeyMessages.DefaultPrompt)
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
            // (GlobalHotkeyListener's message pump), and CopyFromScreen +
            // JPEG-encoding a full screen is enough work to visibly hitch
            // the tray/avatar UI if done inline here.
            image = capture is null ? await Task.Run(ScreenCapture.CaptureAsJpegDataUrl) : await Task.Run(capture);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: vision hotkey capture failed, resuming listening. {ex.Message}");
            lastError = $"{(capture is null ? "Screen capture" : "Camera snapshot")} failed: {ex.Message}";
            ReturnToIdle();
            return true;
        }

        await SpeakReplyAsync(prompt, image: image);
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
    // #679: images pasted into the chat box go with the text (which may
    // then be empty) to the vision reply, skipping the barge-in
    // classification a text-only interruption gets.
    // #1325: documents attached to the chat box are passed for local extraction/chunking.
    public async Task<bool> SubmitTypedCommandAsync(string text, IReadOnlyList<string>? images = null, IReadOnlyList<string>? documents = null)
    {
        var trimmed = text.Trim();
        var hasImages = images is { Count: > 0 };
        var hasDocuments = documents is { Count: > 0 };
        if (trimmed.Length == 0 && !hasImages && !hasDocuments)
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
        if (hasImages || hasDocuments)
        {
            if (hasImages)
            {
                Console.WriteLine($"VoiceLoop: sending {images!.Count} image(s), {images.Sum(i => i.Length) / 1024} KB.");
            }
            if (hasDocuments)
            {
                Console.WriteLine($"VoiceLoop: sending {documents!.Count} document(s).");
            }
            chatLog?.AppendUserMessage(trimmed, images ?? Array.Empty<string>(), documents);
            await SpeakReplyAsync(trimmed, images: images, documents: documents, source: "typed");
            return true;
        }
        await DispatchCommandAsync(trimmed, wasInterruption, held: null, nested: false, typed: true);
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

        // #678: only my voice gets past here (SpeakerGate), before Whisper.
        // A rejected interruption un-ducks or resumes her like any other
        // non-interruption below; an embedder failure fails open.
        if (!prefilterRejected && speakerEmbedder is { } embedder && voiceprint is { } enrolled
            && SpeakerGate.Applies(speakerGateMode, awake, wasInterruption))
        {
            try
            {
                var stopwatch = Stopwatch.StartNew();
                var (pass, score) = await Task.Run(() => SpeakerGate.IsEnrolledSpeaker(samples, embedder.Embed, enrolled, speakerThreshold));
                logEntry.Speaker = score;
                logEntry.SpeakerMs = stopwatch.ElapsedMilliseconds;
                logEntry.Drop = pass ? null : "speaker";
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                Console.WriteLine($"VoiceLoop: voiceprint check failed, letting the segment through. {ex.Message}");
            }
        }

        // #682: Electron's speech filters (SpeechFilters) -- a quiet segment
        // is boosted before Whisper hears it, one still too quiet or
        // hiss-like never reaches Whisper, and a phantom phrase or
        // noise-only caption is dropped like an empty transcript.
        var transcript = "";
        short[]? heardSamples = null; // #1107: what Whisper heard, for a kept clip
        string? sttModel = null, sttLanguage = null;
        if (!prefilterRejected && logEntry.Drop is null)
        {
            var (boosted, gain) = SpeechFilters.ApplySpeechGain(samples, SpeechFilters.GainTargetPeak, SpeechFilters.GainMaxBoost);
            logEntry.Gain = gain;
            logEntry.Drop = SpeechFilters.GetSpeechRejectReason(boosted, SpeechFilters.MinSpeechRms, SpeechFilters.MinSpeechPeak, SpeechFilters.MaxClickyZcr);
            if (logEntry.Drop is null)
            {
                heardSamples = boosted;
                try
                {
                    (transcript, logEntry.Heard, sttModel, sttLanguage) = await backendClient.TranscribeAsync(BuildWavBytes(boosted));
                    logEntry.Whisper = string.IsNullOrWhiteSpace(transcript) ? "empty" : "ok";
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"VoiceLoop: transcription failed, resuming listening. {ex.Message}");
                    lastError = $"Transcription failed: {ex.Message}";
                    logEntry.Whisper = "failed";
                }
            }
        }
        if (logEntry.Whisper == "ok")
        {
            logEntry.Transcript = transcript;
            logEntry.Drop = SpeechFilters.IsLikelyWhisperHallucination(transcript, samples.Length / (double)SileroVadRunner.SampleRate) ? "hallucination"
                : SpeechFilters.IsNoiseOnlyTranscript(transcript) ? "noise"
                : null;
        }

        if (!await ClaimTurnAsync(turnId))
        {
            // Superseded: the merged segment re-sends this audio.
            logEntry.Merged = true;
            VoiceDebugLog.Append(logEntry);
            return;
        }

        // #665 minWords: she's been ducked while this was transcribed. Not
        // a real interruption: she carries on (or, if she finished
        // meanwhile, listening resumes). Real: she's stopped now, and this
        // continues as a normal interruption with her unplayed sentences held.
        bool ducked;
        lock (stateLock)
        {
            ducked = wasInterruption && bargeInDucked;
        }
        if (ducked)
        {
            var real = BargeInPolicy.IsRealInterruption(logEntry.Whisper == "ok", logEntry.Drop is not null,
                ScreenContextTrigger.CleanTranscriptText(transcript), bargeInMinWords);
            if (!await DecideDuckedInterruptionAsync(real))
            {
                logEntry.Drop ??= "few-words";
                VoiceDebugLog.Append(logEntry);
                return;
            }
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
            var pauseMs = GamingListenPauseMs(isGamingModeActive(), awake, wasInterruption);
            if (pauseMs > 0)
            {
                lock (stateLock)
                {
                    listenPausedUntilMs = Environment.TickCount64 + pauseMs;
                }
                VoiceDebugLog.AppendNote($"gaming: listening paused {pauseMs}ms");
            }
            await ReturnToIdleOrResumeHeldAsync(held, nested);
        }

        // skipped (pre-filter or speech gate), failed, empty, or filtered.
        if (logEntry.Whisper != "ok" || logEntry.Drop is not null)
        {
            await Skip();
            return;
        }

        // Electron's handleTranscript strips "(laughs)"/"[music]" annotations
        // before the wake match and before the text is shown or sent.
        transcript = ScreenContextTrigger.CleanTranscriptText(transcript);

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
        KeepClipIfOn(heardSamples!, logEntry, commandText, sttModel, sttLanguage);
        await DispatchCommandAsync(commandText, wasInterruption, held, nested);
    }

    // #1107: Settings > Voice's "Keep my voice clips for training" (VoiceData),
    // read at each turn so switching it off stops at once. Saved off the
    // voice path; a failure only logs.
    private static void KeepClipIfOn(short[] samples, VoiceSegmentLogEntry logEntry, string commandText, string? model, string? language)
    {
        if (!VoiceData.ShouldKeep(logEntry, commandText) || !ManaSettingsStore.Load().KeepVoiceClips)
        {
            return;
        }
        var clip = new VoiceData.TurnClip(logEntry.Heard ?? logEntry.Transcript!, logEntry.Transcript!, null, language, model,
            Math.Round(samples.Length / (double)SileroVadRunner.SampleRate, 2), DateTimeOffset.Now);
        _ = Task.Run(() =>
        {
            try
            {
                VoiceData.KeepTurn(VoiceData.TurnsFolder, samples, clip, VoiceData.MaxBytes(Environment.GetEnvironmentVariable("MANA_VOICE_DATA_MAX_MB")));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.WriteLine($"VoiceLoop: couldn't keep the voice clip. {ex.Message}");
            }
        });
    }

    // #665: ends a ducked interruption. Returns true if it was real (she's
    // stopped and her unplayed sentences are held for the caller), false if
    // she carries on (back to Speaking at full volume, or Idle if her reply
    // finished while this was decided).
    private async Task<bool> DecideDuckedInterruptionAsync(bool real)
    {
        Task reply;
        bool stopRequested;
        lock (stateLock)
        {
            bargeInDucked = false;
            stopRequested = duckStopRequested;
            if (!real && !stopRequested)
            {
                audioPlayer.Volume = 1f;
                if (replyTalking)
                {
                    mode = ListenMode.Speaking;
                    bargeInHeldMs = 0;
                    vad?.Reset();
                    return false;
                }
            }
            reply = currentReply;
        }
        if (!real && !stopRequested)
        {
            ReturnToIdle();
            return false;
        }

        // Stop her the way a barge-in always did (the stop hotkey may have
        // already), and let her reply's continuation hold what hadn't played
        // before anything reads it. Volume comes back only once she's silent.
        audioPlayer.Stop();
        await Task.WhenAny(reply, Task.Delay(3000));
        audioPlayer.Volume = 1f;
        if (stopRequested)
        {
            // The stop hotkey: nothing of that reply is resumed later.
            lock (stateLock)
            {
                heldSentences = null;
                heldStackDepth = 0;
            }
        }
        if (!real)
        {
            ReturnToIdle();
            return false;
        }
        return true;
    }

    // #525: the shared tail of turn processing, once a resolved command
    // has already cleared the wake-word gate -- shared by ProcessTurnAsync
    // (a transcribed voice turn) and SubmitTypedCommandAsync (typed input
    // from the quick-entry popup), since neither the barge-in
    // classification/hold-resume dispatch below nor the final reply cares
    // whether commandText came from STT or was typed directly.
    private async Task DispatchCommandAsync(string commandText, bool wasInterruption, List<string>? held, bool nested, bool typed = false)
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
                await SpeakReplyAsync(commandText, screenText, source: typed ? "typed" : "voice");
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
                        var answerCompleted = await SpeakReplyAsync(commandText, screenText, source: typed ? "typed" : "voice");
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

        await SpeakReplyAsync(commandText, screenText, source: typed ? "typed" : "voice");
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
    // #1325: documents are forwarded to streamingReplyPlayer.
    private async Task<bool> SpeakReplyAsync(string commandText, string screenText = "", string? image = null, IReadOnlyList<string>? images = null, string? source = null, IReadOnlyList<string>? documents = null)
    {
        lastError = null; // #687: a new reply clears the status line's error
        avatarOverlay.SetActivity(AvatarState.Thinking, true);
        try
        {
            var reply = SpeakReplyCoreAsync(commandText, screenText, image, images, source, documents);
            currentReply = reply; // #665: a ducked interruption waits on this after stopping her
            var completed = await reply;
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

    // #914: a relationship note or milestone she just made is a chat line
    // with an Undo button (no approval needed, so I see each one).
    private void ShowNoted(ReplyStreamEvent noted)
    {
        var kind = noted.Kind == "milestone" ? "milestones" : "notes";
        chatLog?.AppendNoted(noted.CharacterName, NotedLine(noted.Kind, noted.Text ?? "", noted.Date), async () =>
        {
            await backendClient.RemoveRelationshipItemAsync(noted.Character ?? "mana", kind, noted.Id ?? "");
            return "Forgotten.";
        });
    }

    internal static string NotedLine(string? kind, string text, string? date) =>
        kind == "milestone" ? $"I'll remember this: \"{text}\"{(date is null ? "" : $" ({date})")}" : $"Noted: \"{text}\"";

    private async Task<bool> SpeakReplyCoreAsync(string commandText, string screenText, string? image, IReadOnlyList<string>? images, string? source, IReadOnlyList<string>? documents = null)
    {
        string? reply;
        bool changed;
        string? preferredExpression;
        bool interrupted;
        IReadOnlyList<string> pending;
        try
        {
            var stopMana = stopManaThinking;
            bool? thinkHarder = deepThinking ? true : stopMana ? false : null;
            (reply, changed, preferredExpression, interrupted, pending) = await streamingReplyPlayer.StreamReplyAndPlayAsync(
                commandText,
                EnsureSessionId(),
                (text, speaker) => chatLog?.AppendReplySentence(text, speaker),
                screenText,
                image,
                images,
                currentPresetId,
                thinkHarder,
                source,
                ShowNoted,
                documents,
                onThought: text => chatLog?.AppendReplyThought(text));
            if (!interrupted && !string.IsNullOrEmpty(streamingReplyPlayer.FinalThought))
            {
                chatLog?.SetReplyThought(streamingReplyPlayer.FinalThought);
            }
            if (stopMana)
            {
                stopManaThinking = false;
            }
            // A click-off during this reply wins over what it reported.
            if (!interrupted && !stopManaThinking && streamingReplyPlayer.FinalDeepThinking != manaDeepThinking)
            {
                manaDeepThinking = streamingReplyPlayer.FinalDeepThinking;
                ManaDeepThinkingChanged?.Invoke(manaDeepThinking);
            }
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
            if (BackendRestart is { } restart)
            {
                await restart;
                await SayReplyFailedAsync(RestartedMidReplyMessage, RestartedMidReplyMessage);
                return false;
            }
            lastError = $"Reply failed: {message}";
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
        // either way by this point. #1329: FinalSources carries verified web sources.
        artifactSink?.ReportReply(reply ?? "", streamingReplyPlayer.FinalSources);

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

        // #861: spoken in chunks of up to 180 characters (Electron's
        // splitReplyForSpeech), each synthesized while the one before
        // plays, so a long reply starts speaking after its first chunk
        // instead of after the whole reply is synthesized.
        var chunks = SplitForSpeech(reply ?? string.Empty);
        if (chunks.Count == 0)
        {
            ReturnToIdle();
            return true;
        }

        // One face for the whole reply (#623: the reply's own emotion tag
        // when the model gave one; the streaming path above switches per
        // sentence instead). #964: the tag also paces her voice (Qwen3-TTS).
        var emotion = streamingReplyPlayer.FinalEmotion;
        var expression = ReplyEmotionDetector.DetectReplyEmotion(reply, emotion);

        var next = backendClient.SynthesizeAsync(chunks[0], emotion);
        for (var i = 0; i < chunks.Count; i++)
        {
            byte[] chunkWav;
            try
            {
                chunkWav = await next;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"VoiceLoop: synthesis failed, resuming listening. {ex.Message}");
                lastError = $"Voice failed: {ex.Message}";
                if (i > 0)
                {
                    OnTalkingStateChanged(false);
                }
                ReturnToIdle();
                return false;
            }
            next = i + 1 < chunks.Count ? backendClient.SynthesizeAsync(chunks[i + 1], emotion) : Task.FromResult(Array.Empty<byte>());

            bool completedNaturally;
            var cutOff = false;
            try
            {
                if (i == 0)
                {
                    // #681: the model's own expression__set choice rides on
                    // the final event. node-bot only sets it on the
                    // tool-calling path, which never streams sentences -- so
                    // it always lands here, never on the changed:false path
                    // above.
                    OnTalkingStateChanged(true, MapReplyEmotionToAvatarState(expression), preferredExpression, emotion);
                }
                else
                {
                    // Cut off while this chunk was being synthesized (the
                    // hotkey, a barge-in, or a typed turn taking over)?
                    lock (stateLock)
                    {
                        cutOff = manualStopPending || mode != ListenMode.Speaking;
                    }
                }
                if (cutOff)
                {
                    completedNaturally = false;
                }
                else
                {
                    captions?.ShowSpokenText(chunks[i], AudioPlayer.Duration(chunkWav));
                    bubbles?.ShowSpokenText(chunks[i], AudioPlayer.Duration(chunkWav));
                    completedNaturally = await audioPlayer.PlayAsync(chunkWav);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"VoiceLoop: playback failed to start, resuming listening. {ex.Message}");
                lastError = $"Playback failed: {ex.Message}";
                OnTalkingStateChanged(false);
                ReturnToIdle();
                return false;
            }
            if (!completedNaturally)
            {
                // Interrupted, and the rest of the reply isn't spoken (a
                // chunk being synthesized is just dropped): by a barge-in,
                // mode is already CapturingInterruption (set by
                // ProcessSpeakingFrame on the capture thread before
                // PlayAsync's Task resolved), nothing further to do here; by
                // the interrupt hotkey, go back to Idle.
                OnTalkingStateChanged(false);
                ConsumeManualStop();
                return false;
            }
        }

        OnTalkingStateChanged(false);
        ReturnToIdle();
        return true;
    }

    // #861: Electron's splitReplyForSpeech -- whole sentences packed into
    // chunks of up to MaxSpeechChunkChars; a longer sentence is a chunk of
    // its own. Sentences end at . ! ? followed by a space, so "3.5" or
    // "e.g.x" stay whole (Electron's split turns "3.5" into "3. 5").
    internal const int MaxSpeechChunkChars = 180;

    internal static IReadOnlyList<string> SplitForSpeech(string text)
    {
        var chunks = new List<string>();
        var current = "";
        var normalized = System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ").Trim();
        foreach (var sentence in System.Text.RegularExpressions.Regex.Split(normalized, @"(?<=[.!?]) "))
        {
            if (sentence.Length == 0)
            {
                continue;
            }
            var joined = current.Length > 0 ? $"{current} {sentence}" : sentence;
            if (joined.Length <= MaxSpeechChunkChars)
            {
                current = joined;
                continue;
            }
            if (current.Length > 0)
            {
                chunks.Add(current);
            }
            current = sentence;
        }
        if (current.Length > 0)
        {
            chunks.Add(current);
        }
        return chunks;
    }

    private const string ReplyFailedMessage = "Sorry, I couldn't answer that just now. Try again in a moment.";
    internal const string RestartedMidReplyMessage = "Sorry, I restarted in the middle of that. Could you ask me again?";

    // #991: set while the launcher restarts node-bot. A reply the restart
    // cut off waits for it, then says so instead of the generic failure.
    public Task? BackendRestart { get; set; }

    // #964: said a little slower and lower, like an apology.
    private const string ReplyFailedEmotion = "sad";

    // #905: a line nobody just asked for (a reminder firing), said through
    // the same player as replies, with SayReplyFailedAsync's mode handling.
    // Waits for her to be idle so it never cuts into a turn; gives up
    // (the toast still showed) if she's busy for a whole minute. #1024:
    // emotion (AnnouncementEmotion.For) paces it on Qwen3-TTS. #1148: idle
    // also means I'm not mid-sentence (IsQuietForAnnouncement).
    public async Task<bool> SpeakAnnouncementAsync(string text, string? emotion)
    {
        for (var tries = 0; ; tries++)
        {
            lock (stateLock)
            {
                if (IsQuietForAnnouncement(mode, hasHeardSpeechInSegment, isAudioBusy?.Invoke() ?? false))
                {
                    mode = ListenMode.Processing;
                    break;
                }
            }
            if (tries >= 30)
            {
                return false;
            }
            await Task.Delay(2000);
        }
        try
        {
            var wav = await backendClient.SynthesizeAsync(text, emotion);
            OnTalkingStateChanged(true);
            captions?.ShowSentence(text);
            bubbles?.ShowSentence(text);
            var completedNaturally = await audioPlayer.PlayAsync(wav);
            OnTalkingStateChanged(false);
            if (!completedNaturally)
            {
                ConsumeManualStop();
                return true;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: couldn't speak the announcement. {ex.Message}");
            OnTalkingStateChanged(false);
        }
        ReturnToIdle();
        return true;
    }

    // #1148: no reply in flight or playing, and no speech of mine buffered
    // in the segment being recorded (Idle alone still records me talking).
    // #697: also not busy with external audio/calls (when enabled).
    internal static bool IsQuietForAnnouncement(ListenMode mode, bool heardSpeechInSegment, bool audioBusy = false) =>
        mode == ListenMode.Idle && !heardSpeechInSegment && !audioBusy;

    // #666: a failed reply is shown in the chat and spoken once, with the
    // same mode handling as the non-streamed fallback above. If TTS is what
    // failed, the chat line is all the user gets -- still not silence.
    private async Task SayReplyFailedAsync(string chatText, string spoken = ReplyFailedMessage)
    {
        chatLog?.AppendReplySentence(chatText);
        try
        {
            var wav = await backendClient.SynthesizeAsync(spoken, ReplyFailedEmotion);
            OnTalkingStateChanged(true);
            captions?.ShowSentence(spoken);
            bubbles?.ShowSentence(spoken);
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
    private void OnTalkingStateChanged(bool talking, AvatarState talkingState = AvatarState.Talking, string? preferredExpression = null, string? emotion = null)
    {
        avatarOverlay.SetState(talking ? talkingState : AvatarState.Idle, talking ? preferredExpression : null, talking ? emotion : null);
        if (!talking)
        {
            captions?.SpeechEnded();
            bubbles?.SpeechEnded();
            TalkingEnded?.Invoke();
        }
        lock (stateLock)
        {
            replyTalking = talking;
            // A ducked interruption owns mode until it's decided.
            if (talking && mode != ListenMode.CapturingInterruption && !bargeInDucked)
            {
                audioPlayer.Volume = 1f;
                mode = ListenMode.Speaking;
                bargeInHeldMs = 0;
                hearingOverSpeech = false;
                vad?.Reset();
            }
            else if (!talking && mode == ListenMode.Speaking)
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
            var replay = streamingReplyPlayer.ReplaySentencesAsync(held);
            currentReply = replay; // #665: see SpeakReplyAsync
            (interrupted, pending) = await replay;
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
            // #665: while a ducked interruption is being decided, stop her
            // now and let the decision drop the rest of that reply.
            if (bargeInDucked)
            {
                duckStopRequested = true;
                heldSentences = null;
                heldStackDepth = 0;
                audioPlayer.Stop();
                return;
            }
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
            lastTurnAtMs = Environment.TickCount64; // #678: the quiet period starts now
            // #665: a ducked interruption owns what happens next (her reply
            // may finish while it's still being decided).
            if (bargeInDucked)
            {
                return;
            }

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

            // #665 notWhileSpeaking: what I said while she talked is the
            // next turn.
            if (queuedTurn is { } queued)
            {
                queuedTurn = null;
                hearingOverSpeech = false;
                manualStopPending = false;
                frameBuffer.Clear();
                segmentSamples.Clear();
                segmentSamples.AddRange(queued.Samples);
                segmentSpeechMs = queued.SpeechMs;
                mode = ListenMode.Processing;
                _ = HandleSegmentClosedAsync(false, "queued", "-");
                return;
            }
            // Still mid-sentence when she finished: keep that recording
            // going as a normal segment (and the audio buffered meanwhile).
            var stillHearing = hearingOverSpeech;
            hearingOverSpeech = false;

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
            if (!stillHearing)
            {
                frameBuffer.Clear();
            }
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

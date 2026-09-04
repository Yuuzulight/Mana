using System;
using System.Collections.Generic;
using System.IO;
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
    // segmentElapsedMs, msSinceLastSpeech, mode, bargeInHeldMs,
    // heldSentences, heldStackDepth, and the vad instance itself (SileroVadRunner mutates its own internal state
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

    // #513: the not-yet-played sentences of a reply a barge-in cut off,
    // kept so a backchannel/unclassified interruption (or the end of an
    // inserted new_question answer) can resume them from the cut point.
    // Null when nothing is held. heldStackDepth is 1 only while an
    // inserted new_question answer is playing on top of a hold -- a
    // second interruption then discards the outer hold outright instead
    // of stacking (windows-launcher's own depth-1 cap).
    private List<string>? heldSentences;
    private int heldStackDepth;

    // #522: ScreenContextReader owns its own min-interval/keyword-gate
    // caching internally, so this is just held and called, same as
    // backendClient. isGamingModeActive is a delegate (not a captured
    // bool) so VoiceLoop always sees ManaApplicationContext's current
    // tray-status poll result, not a stale snapshot from construction time.
    private readonly ScreenContextReader? screenContextReader;
    private readonly Func<bool> isGamingModeActive;

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
        Func<bool>? isGamingModeActive = null)
    {
        this.vad = vad;
        this.backendClient = backendClient;
        this.audioPlayer = audioPlayer;
        this.avatarOverlay = avatarOverlay;
        this.chatLog = chatLog;
        this.artifactSink = artifactSink;
        this.screenContextReader = screenContextReader;
        // Never actually invoked unless screenContextReader is also
        // non-null (see the read-site below) -- defaulted to a fixed
        // false rather than left nullable so that call site doesn't need
        // its own separate null-check for this one.
        this.isGamingModeActive = isGamingModeActive ?? (() => false);
        streamingReplyPlayer = new StreamingReplyPlayer(
            backendClient,
            audioPlayer.PlayAsync,
            talking => OnTalkingStateChanged(talking));
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
        }

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

    // #520: called by the session list UI on switch/new-chat. Deliberately
    // doesn't touch heldSentences/mode -- switching sessions mid-reply is
    // a user action on a separate window, not an interruption of Mana
    // herself; whatever she's currently saying keeps playing against
    // whichever session was active when that turn started.
    public void SetSessionId(string? sessionId) => currentSessionId = sessionId;

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
    private async Task ProcessTurnAsync(byte[] wavBytes, bool wasInterruption)
    {
        // #513: consumed here, before transcription can fail/come back
        // empty -- a false barge-in trigger (cough, TV noise, a word that
        // didn't actually mean anything) must still resume whatever
        // reply it cut off rather than silently dropping it. Whatever
        // happens from here on, this interruption consumes the hold: it's
        // either resumed on an early exit below, resumed after dispatch,
        // re-held for a new_question, or discarded (nested).
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

        string transcript;
        try
        {
            transcript = await backendClient.TranscribeAsync(wavBytes);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: transcription failed, resuming listening. {ex.Message}");
            await ReturnToIdleOrResumeHeldAsync(held, nested);
            return;
        }

        if (string.IsNullOrWhiteSpace(transcript))
        {
            await ReturnToIdleOrResumeHeldAsync(held, nested);
            return;
        }

        string commandText;
        if (!awake)
        {
            var command = WakeWordMatcher.ExtractWakeCommand(transcript);
            if (command is null)
            {
                await ReturnToIdleOrResumeHeldAsync(held, nested);
                return;
            }

            awake = true;
            commandText = command;
        }
        else
        {
            commandText = transcript;
        }

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
    private async Task<bool> SpeakReplyAsync(string commandText, string screenText = "")
    {
        string? reply;
        bool changed;
        bool interrupted;
        IReadOnlyList<string> pending;
        try
        {
            (reply, changed, _, interrupted, pending) = await streamingReplyPlayer.StreamReplyAndPlayAsync(commandText, currentSessionId, text => chatLog?.AppendReplySentence(text), screenText);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: reply/stream failed, resuming listening. {ex.Message}");
            ReturnToIdle();
            return false;
        }

        if (interrupted)
        {
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
            OnTalkingStateChanged(true, MapReplyEmotionToAvatarState(expression));
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
        // else: interrupted -- mode already CapturingInterruption (set by
        // ProcessSpeakingFrame on the capture thread before PlayAsync's
        // Task resolved), nothing further to do here.
        return false;
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
    private void OnTalkingStateChanged(bool talking, AvatarState talkingState = AvatarState.Talking)
    {
        avatarOverlay.SetState(talking ? talkingState : AvatarState.Idle);
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
            segmentSamples.Clear();
            hasHeardSpeechInSegment = false;
            segmentElapsedMs = 0;
            msSinceLastSpeech = 0;
            vad.Reset();
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
            HoldIfNothingHeld(pending);
            return;
        }

        ReturnToIdle();
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

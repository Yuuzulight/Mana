using System;

namespace Mana.NativeLauncher;

// #619 addendum: the shorter end-of-turn (RecordingSegmenter's ~0.8s on a
// complete-sounding partial) is only safe because of this -- if the user
// starts talking again within MergeWindowMs of a turn closing, that turn is
// superseded and the new speech is recorded onto the end of its audio, so a
// mid-thought pause still yields one turn and one reply.
//
// VoiceLoop never dispatches a turn (chat bubble, /reply) before the window
// is over: its turn task transcribes in parallel, then Claim()s. So the only
// thing a merge ever has to cancel is that in-flight Whisper result, which
// the superseded task simply drops -- nothing reaches the backend's session
// history twice.
//
// Not thread-safe: VoiceLoop calls every member under its stateLock.
internal sealed class TurnMergeWindow
{
    internal const long MergeWindowMs = 1000;

    // Speech must last this long to count as the user resuming -- one VAD
    // false positive (a click, a breath) mustn't throw away a transcription.
    internal const long MergeHoldMs = 150;

    private long turnId;
    private long openedAtMs;
    private long elapsedMs;
    private long heldMs;

    // Whether the capture thread should still watch for resumed speech.
    public bool IsOpen { get; private set; }

    // The closed turn's audio/state, handed back on a merge.
    public short[] ClosedSamples { get; private set; } = Array.Empty<short>();
    public long ClosedSpeechMs { get; private set; }
    public bool ClosedWasInterruption { get; private set; }

    // A turn just closed (not by the max-duration cap -- merging onto an
    // already-full segment would only close again at once). Returns the id
    // its turn task later passes to Claim().
    public long Open(short[] samples, long speechMs, bool wasInterruption, long nowMs)
    {
        turnId++;
        openedAtMs = nowMs;
        elapsedMs = 0;
        heldMs = 0;
        IsOpen = true;
        ClosedSamples = samples;
        ClosedSpeechMs = speechMs;
        ClosedWasInterruption = wasInterruption;
        return turnId;
    }

    // One VAD frame while open. True exactly once, when resumed speech has
    // held for MergeHoldMs: the closed turn is superseded (its Claim() now
    // fails) and the caller takes ClosedSamples as the start of a new segment.
    // Resumed speech must START within MergeWindowMs of audio; a streak
    // already under way then may finish its hold. Frame time, not wall time,
    // the same virtual clock BargeInGate uses.
    public bool OnFrame(bool isSpeech, long frameMs)
    {
        if (!IsOpen)
        {
            return false;
        }
        elapsedMs += frameMs;
        (heldMs, var triggered) = BargeInGate.Next(isSpeech, isLoudEnough: true, heldMs, frameMs, MergeHoldMs);
        if (triggered)
        {
            turnId++;
            IsOpen = false;
            return true;
        }
        if (heldMs == 0 && elapsedMs >= MergeWindowMs)
        {
            Close(); // too late to resume; the turn's Claim() still succeeds
        }
        return false;
    }

    // How much longer the turn task must wait before claiming.
    public long RemainingMs(long nowMs) => Math.Max(0, openedAtMs + MergeWindowMs - nowMs);

    // The turn task's commit point. True: nothing merged, go ahead and act
    // on the turn (and stop watching). False: a merge superseded it -- drop
    // the result without touching any shared state.
    public bool Claim(long id)
    {
        if (id != turnId)
        {
            return false;
        }
        Close();
        return true;
    }

    // Stop watching without superseding anything (listening stopped, or the
    // turn claimed). A pending Claim() for the current id still succeeds.
    public void Close()
    {
        IsOpen = false;
        heldMs = 0;
        ClosedSamples = Array.Empty<short>();
    }
}

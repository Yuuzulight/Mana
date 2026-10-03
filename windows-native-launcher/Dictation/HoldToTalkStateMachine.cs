using System;

namespace Mana.NativeLauncher.Dictation;

public enum HoldToTalkState
{
    Idle,
    PendingThreshold,
    ActiveHolding,
    Transcribing
}

public enum HoldKeyTarget
{
    RightControl,
    LeftControl,
    RightAlt,
    CapsLock,
    F8,
    F9
}

// #849: state machine for hold-to-talk dictation.
// Pure, deterministic, and 100% unit-testable.
public sealed class HoldToTalkStateMachine
{
    public const int DefaultThresholdMs = 300;

    private readonly Func<long> getTickCountMs;
    private long pressTimestampMs;

    public HoldToTalkState State { get; private set; } = HoldToTalkState.Idle;
    public HoldKeyTarget TargetKey { get; set; } = HoldKeyTarget.RightControl;
    public int ThresholdMs { get; set; } = DefaultThresholdMs;

    public event Action? HoldStarted;
    public event Action<long>? HoldReleased; // passes total hold duration in ms
    public event Action? HoldCanceled;

    public HoldToTalkStateMachine(Func<long>? getTickCountMs = null, int thresholdMs = DefaultThresholdMs)
    {
        this.getTickCountMs = getTickCountMs ?? (() => Environment.TickCount64);
        ThresholdMs = thresholdMs > 0 ? thresholdMs : DefaultThresholdMs;
    }

    public bool IsTargetKey(HoldKeyTarget key) => key == TargetKey;

    public void OnKeyDown(HoldKeyTarget key)
    {
        if (!IsTargetKey(key))
        {
            return;
        }

        switch (State)
        {
            case HoldToTalkState.Idle:
                State = HoldToTalkState.PendingThreshold;
                pressTimestampMs = getTickCountMs();
                break;

            case HoldToTalkState.PendingThreshold:
                // Check if threshold has been passed on repeated keydown events
                CheckThreshold();
                break;

            case HoldToTalkState.ActiveHolding:
            case HoldToTalkState.Transcribing:
                // Typematic repeat while already holding or transcribing; ignore
                break;
        }
    }

    public void OnTick()
    {
        if (State == HoldToTalkState.PendingThreshold)
        {
            CheckThreshold();
        }
    }

    public void OnKeyUp(HoldKeyTarget key)
    {
        if (!IsTargetKey(key))
        {
            return;
        }

        var now = getTickCountMs();
        switch (State)
        {
            case HoldToTalkState.PendingThreshold:
                // Released before reaching hold threshold; cancel hold (treated as normal keypress)
                State = HoldToTalkState.Idle;
                HoldCanceled?.Invoke();
                break;

            case HoldToTalkState.ActiveHolding:
                var duration = Math.Max(0, now - pressTimestampMs);
                State = HoldToTalkState.Transcribing;
                HoldReleased?.Invoke(duration);
                break;

            case HoldToTalkState.Transcribing:
            case HoldToTalkState.Idle:
                break;
        }
    }

    public void OnTranscriptionCompleted()
    {
        if (State == HoldToTalkState.Transcribing)
        {
            State = HoldToTalkState.Idle;
        }
    }

    public void Cancel()
    {
        if (State != HoldToTalkState.Idle)
        {
            State = HoldToTalkState.Idle;
            HoldCanceled?.Invoke();
        }
    }

    private void CheckThreshold()
    {
        var elapsed = getTickCountMs() - pressTimestampMs;
        if (elapsed >= ThresholdMs)
        {
            State = HoldToTalkState.ActiveHolding;
            HoldStarted?.Invoke();
        }
    }
}

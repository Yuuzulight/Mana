using System;
using Mana.NativeLauncher.Dictation;
using Xunit;

namespace Mana.NativeLauncher.Tests;

public sealed class HoldToTalkStateMachineTests
{
    [Fact]
    public void HoldToTalk_Tap_ReleasesBeforeThreshold_CancelsWithoutHold()
    {
        long currentTick = 1000;
        var sm = new HoldToTalkStateMachine(() => currentTick, thresholdMs: 300);

        var holdStartedCount = 0;
        var holdReleasedCount = 0;
        var holdCanceledCount = 0;

        sm.HoldStarted += () => holdStartedCount++;
        sm.HoldReleased += _ => holdReleasedCount++;
        sm.HoldCanceled += () => holdCanceledCount++;

        // Press key
        sm.OnKeyDown(HoldKeyTarget.RightControl);
        Assert.Equal(HoldToTalkState.PendingThreshold, sm.State);

        // Advance 150ms (less than 300ms threshold)
        currentTick += 150;
        sm.OnTick();
        Assert.Equal(HoldToTalkState.PendingThreshold, sm.State);
        Assert.Equal(0, holdStartedCount);

        // Release key
        sm.OnKeyUp(HoldKeyTarget.RightControl);
        Assert.Equal(HoldToTalkState.Idle, sm.State);
        Assert.Equal(0, holdStartedCount);
        Assert.Equal(0, holdReleasedCount);
        Assert.Equal(1, holdCanceledCount);
    }

    [Fact]
    public void HoldToTalk_HeldPastThreshold_TriggersHoldStarted()
    {
        long currentTick = 1000;
        var sm = new HoldToTalkStateMachine(() => currentTick, thresholdMs: 300);

        var holdStarted = false;
        sm.HoldStarted += () => holdStarted = true;

        sm.OnKeyDown(HoldKeyTarget.RightControl);
        Assert.False(holdStarted);

        // Advance 300ms exactly
        currentTick += 300;
        sm.OnTick();

        Assert.Equal(HoldToTalkState.ActiveHolding, sm.State);
        Assert.True(holdStarted);
    }

    [Fact]
    public void HoldToTalk_HeldAndReleased_TriggersHoldReleasedWithDuration()
    {
        long currentTick = 1000;
        var sm = new HoldToTalkStateMachine(() => currentTick, thresholdMs: 300);

        var started = false;
        long duration = -1;

        sm.HoldStarted += () => started = true;
        sm.HoldReleased += d => duration = d;

        sm.OnKeyDown(HoldKeyTarget.RightControl);
        currentTick += 450;
        sm.OnTick();

        Assert.True(started);
        Assert.Equal(HoldToTalkState.ActiveHolding, sm.State);

        // Hold for another 550ms, then release
        currentTick += 550;
        sm.OnKeyUp(HoldKeyTarget.RightControl);

        Assert.Equal(HoldToTalkState.Transcribing, sm.State);
        Assert.Equal(1000, duration);

        // Finish transcription
        sm.OnTranscriptionCompleted();
        Assert.Equal(HoldToTalkState.Idle, sm.State);
    }

    [Fact]
    public void HoldToTalk_NonTargetKey_Ignored()
    {
        long currentTick = 1000;
        var sm = new HoldToTalkStateMachine(() => currentTick, thresholdMs: 300)
        {
            TargetKey = HoldKeyTarget.RightControl
        };

        sm.OnKeyDown(HoldKeyTarget.LeftControl);
        Assert.Equal(HoldToTalkState.Idle, sm.State);

        sm.OnKeyDown(HoldKeyTarget.F8);
        Assert.Equal(HoldToTalkState.Idle, sm.State);
    }

    [Fact]
    public void HoldToTalk_RepeatedKeyDownWhileHolding_Ignored()
    {
        long currentTick = 1000;
        var sm = new HoldToTalkStateMachine(() => currentTick, thresholdMs: 300);

        var startCount = 0;
        sm.HoldStarted += () => startCount++;

        sm.OnKeyDown(HoldKeyTarget.RightControl);
        currentTick += 350;
        sm.OnTick();

        Assert.Equal(1, startCount);
        Assert.Equal(HoldToTalkState.ActiveHolding, sm.State);

        // Typematic repeat events from Windows
        sm.OnKeyDown(HoldKeyTarget.RightControl);
        sm.OnKeyDown(HoldKeyTarget.RightControl);
        Assert.Equal(1, startCount);
        Assert.Equal(HoldToTalkState.ActiveHolding, sm.State);
    }

    [Fact]
    public void HoldToTalk_ExplicitCancel_ResetsToIdle()
    {
        long currentTick = 1000;
        var sm = new HoldToTalkStateMachine(() => currentTick, thresholdMs: 300);

        var canceled = false;
        sm.HoldCanceled += () => canceled = true;

        sm.OnKeyDown(HoldKeyTarget.RightControl);
        currentTick += 400;
        sm.OnTick();
        Assert.Equal(HoldToTalkState.ActiveHolding, sm.State);

        sm.Cancel();
        Assert.Equal(HoldToTalkState.Idle, sm.State);
        Assert.True(canceled);
    }
}

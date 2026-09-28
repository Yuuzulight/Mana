using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #661: priority + minimum-display-time arbitration -- pure, no UI.
public class AvatarStateArbiterTests
{
    [Fact]
    public void ATurn_GoesThinking_Working_Talking_Done_Idle()
    {
        var arbiter = new AvatarStateArbiter();

        arbiter.Set(AvatarState.Thinking, true);
        Assert.True(arbiter.Resolve(0));
        Assert.Equal(AvatarState.Thinking, arbiter.Shown);

        arbiter.Set(AvatarState.Working, true);
        arbiter.Resolve(0.5);
        Assert.Equal(AvatarState.Working, arbiter.Shown); // upgrade: at once

        arbiter.Set(AvatarState.Working, false);
        arbiter.Resolve(2.0);
        Assert.Equal(AvatarState.Thinking, arbiter.Shown);

        arbiter.SetSpeech(AvatarState.Excited);
        arbiter.Resolve(2.1);
        Assert.Equal(AvatarState.Excited, arbiter.Shown); // speech wins at once, even inside Thinking's minimum

        arbiter.SetSpeech(AvatarState.Idle);
        arbiter.Set(AvatarState.Thinking, false);
        arbiter.PulseDone(5.0);
        arbiter.Resolve(5.0);
        Assert.Equal(AvatarState.Done, arbiter.Shown);

        arbiter.Resolve(5.0 + AvatarStateArbiter.DoneSeconds - 0.01);
        Assert.Equal(AvatarState.Done, arbiter.Shown);
        arbiter.Resolve(5.0 + AvatarStateArbiter.DoneSeconds);
        Assert.Equal(AvatarState.Idle, arbiter.Shown);
    }

    [Fact]
    public void QuickToolBursts_DoNotFlicker_WorkingHoldsItsMinimum()
    {
        var arbiter = new AvatarStateArbiter();
        arbiter.Set(AvatarState.Thinking, true);
        arbiter.Resolve(0);
        var changes = 0;

        // Five 50ms tools, 100ms apart.
        for (var i = 0; i < 5; i++)
        {
            var start = 0.2 + (i * 0.15);
            arbiter.Set(AvatarState.Working, true);
            changes += arbiter.Resolve(start) ? 1 : 0;
            arbiter.Set(AvatarState.Working, false);
            changes += arbiter.Resolve(start + 0.05) ? 1 : 0;
            changes += arbiter.Resolve(start + 0.1) ? 1 : 0;
        }
        Assert.Equal(AvatarState.Working, arbiter.Shown);
        Assert.Equal(1, changes); // one switch into Working, none back and forth

        // Once the burst is over and the minimum has passed, back to Thinking.
        arbiter.Resolve(0.2 + (4 * 0.15) + 1.0);
        Assert.Equal(AvatarState.Thinking, arbiter.Shown);
    }

    [Fact]
    public void Waiting_OutranksIdleAndDreaming_ButNotSpeechOrWork()
    {
        var arbiter = new AvatarStateArbiter();
        arbiter.Set(AvatarState.Dreaming, true);
        arbiter.Set(AvatarState.Waiting, true);
        arbiter.Resolve(0);
        Assert.Equal(AvatarState.Waiting, arbiter.Shown);

        arbiter.Set(AvatarState.Thinking, true);
        arbiter.Resolve(1);
        Assert.Equal(AvatarState.Thinking, arbiter.Shown);

        arbiter.SetSpeech(AvatarState.Talking);
        arbiter.Resolve(2);
        Assert.Equal(AvatarState.Talking, arbiter.Shown);

        arbiter.SetSpeech(AvatarState.Idle);
        arbiter.Set(AvatarState.Thinking, false);
        arbiter.Resolve(3);
        Assert.Equal(AvatarState.Waiting, arbiter.Shown);

        // Approval dismissed: Waiting holds its 1.5s minimum, then Dreaming.
        arbiter.Set(AvatarState.Waiting, false);
        arbiter.Resolve(3.5);
        Assert.Equal(AvatarState.Waiting, arbiter.Shown);
        arbiter.Resolve(4.6);
        Assert.Equal(AvatarState.Dreaming, arbiter.Shown);
    }

    [Fact]
    public void Done_OutranksIdleAndDreaming_WaitingOutranksDone()
    {
        var arbiter = new AvatarStateArbiter();
        arbiter.Set(AvatarState.Dreaming, true);
        arbiter.PulseDone(0);
        arbiter.Resolve(0);
        Assert.Equal(AvatarState.Done, arbiter.Shown);

        arbiter.Set(AvatarState.Waiting, true);
        arbiter.Resolve(0.1);
        Assert.Equal(AvatarState.Waiting, arbiter.Shown);
    }

    [Fact]
    public void SpeechStates_AreTalkingAndTheMoods_OnlyActivitiesCanBeSet()
    {
        Assert.True(AvatarStateArbiter.IsSpeech(AvatarState.Talking));
        Assert.True(AvatarStateArbiter.IsSpeech(AvatarState.Angry));
        Assert.False(AvatarStateArbiter.IsSpeech(AvatarState.Idle));
        Assert.False(AvatarStateArbiter.IsSpeech(AvatarState.Thinking));

        var arbiter = new AvatarStateArbiter();
        arbiter.Set(AvatarState.Talking, true); // not an activity: ignored
        arbiter.SetSpeech(AvatarState.Waiting); // not speech: treated as not speaking
        Assert.False(arbiter.Resolve(0));
        Assert.Equal(AvatarState.Idle, arbiter.Shown);
    }
}

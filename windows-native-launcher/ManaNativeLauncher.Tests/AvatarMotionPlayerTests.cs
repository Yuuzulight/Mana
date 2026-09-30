using Mana.NativeLauncher;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #683: which clip plays when -- pure scheduling, no Cubism Core needed
// (synthetic CubismMotionFile instances with no curves).
public class AvatarMotionPlayerTests
{
    private static CubismMotionFile Clip(float duration, float? fadeIn = null) =>
        new() { Duration = duration, Loop = true, FadeInTime = fadeIn };

    private static Dictionary<string, IReadOnlyList<CubismMotionFile>> Groups(params (string Name, CubismMotionFile[] Clips)[] groups) =>
        groups.ToDictionary(g => g.Name, g => (IReadOnlyList<CubismMotionFile>)g.Clips);

    [Fact]
    public void GroupForState_OverridesFirst_ThenBuiltInNames_ExactAndCaseInsensitive()
    {
        string[] groups = ["Idle", "Tap", "Flick", "tap@body", "sleepy"];
        var overrides = new Dictionary<string, IReadOnlyList<string>> { ["idle"] = ["SLEEPY"], ["angry"] = ["missing"] };

        Assert.Equal("Idle", AvatarMotionPlayer.GroupForState(AvatarState.Idle, groups));
        Assert.Equal("sleepy", AvatarMotionPlayer.GroupForState(AvatarState.Idle, groups, overrides));
        Assert.Equal("Tap", AvatarMotionPlayer.GroupForState(AvatarState.Talking, groups));
        Assert.Equal("Tap", AvatarMotionPlayer.GroupForState(AvatarState.Excited, groups));
        Assert.Null(AvatarMotionPlayer.GroupForState(AvatarState.Angry, groups, overrides)); // no Angry/Shake here
        Assert.Null(AvatarMotionPlayer.GroupForState(AvatarState.Sad, groups));
    }

    // hiyori_pro has no listening clip, so she keeps her idle loop (the pose
    // is layered procedurally); a model with a Listen group plays it.
    [Fact]
    public void Listening_UsesAListenGroupElseKeepsTheIdleLoop()
    {
        string[] hiyori = ["Idle", "Flick", "FlickDown", "FlickUp", "Tap", "Tap@Body", "Flick@Body"];
        Assert.Null(AvatarMotionPlayer.GroupForState(AvatarState.Listening, hiyori));
        Assert.Equal("listen", AvatarMotionPlayer.GroupForState(AvatarState.Listening, ["Idle", "listen"]));
    }

    [Fact]
    public void Idle_PlaysTheIdleGroup_CyclingClipsAsEachEnds_WithACrossfade()
    {
        var a = Clip(2f);
        var b = Clip(3f, fadeIn: 0.2f);
        var player = new AvatarMotionPlayer(Groups(("Idle", [a, b])), seed: 1);

        player.Update(0);
        Assert.Equal("Idle", player.CurrentGroup);
        var first = player.CurrentMotion!;

        player.Update(first.Duration + 0.01);
        Assert.Equal("Idle", player.CurrentGroup);
        Assert.Same(first, player.PreviousMotion); // fading out, not snapped away
        var second = player.CurrentMotion!;
        var fade = second.FadeInTime ?? AvatarMotionPlayer.DefaultFadeSeconds;
        Assert.InRange(player.FadeWeight(first.Duration + 0.01 + (fade / 2)), 0.4f, 0.6f);

        player.Update(first.Duration + 0.01 + fade + 0.01);
        Assert.Null(player.PreviousMotion);
        Assert.Equal(1f, player.FadeWeight(first.Duration + 0.01 + fade + 0.01));
    }

    [Fact]
    public void NonIdleMoods_CutInRightAway_IdleWaitsForTheClipToFinish()
    {
        var idle = Clip(10f);
        var tap = Clip(2f);
        var player = new AvatarMotionPlayer(Groups(("Idle", [idle]), ("Tap", [tap])), seed: 2);
        player.Update(0);

        player.SetState(AvatarState.Excited, 1.0);
        Assert.Same(tap, player.CurrentMotion); // FORCE: interrupts the idle clip
        Assert.Same(idle, player.PreviousMotion);

        player.SetState(AvatarState.Idle, 1.5);
        player.Update(1.5);
        Assert.Same(tap, player.CurrentMotion); // IDLE priority: let the reaction finish
        player.Update(3.01);
        Assert.Same(idle, player.CurrentMotion);

        // Listening (no clip of its own) returns to idle the same way.
        player.SetState(AvatarState.Excited, 4.0);
        player.SetState(AvatarState.Listening, 4.5);
        player.Update(4.5);
        Assert.Same(tap, player.CurrentMotion);
        player.Update(6.01);
        Assert.Same(idle, player.CurrentMotion);
    }

    [Fact]
    public void SameGroupAgain_DoesNotRestartTheClip_AndAMoodWithoutAGroupKeepsIdleGoing()
    {
        var idle = Clip(10f);
        var tap = Clip(2f);
        var player = new AvatarMotionPlayer(Groups(("Idle", [idle]), ("Tap", [tap])), seed: 3);
        player.Update(0);

        // Talking and Excited both map to Tap on this model: no restart.
        player.SetState(AvatarState.Talking, 1.0);
        player.SetState(AvatarState.Excited, 1.2);
        player.Update(1.2);
        Assert.Same(idle, player.PreviousMotion); // a restart would have made this the tap clip
        Assert.Same(tap, player.CurrentMotion);

        // Sad has no group: the idle loop comes back (not a freeze).
        player.SetState(AvatarState.Sad, 1.5);
        Assert.Equal("Idle", player.CurrentGroup);
    }

    [Fact]
    public void NoIdleGroup_ReportsNull_MoodClipsFadeBackToTheProceduralBase()
    {
        var tap = Clip(2f);
        var player = new AvatarMotionPlayer(Groups(("Tap", [tap])), seed: 4);
        Assert.Null(player.IdleGroup);
        player.Update(0);
        Assert.Null(player.CurrentMotion);

        player.SetState(AvatarState.Talking, 1.0);
        Assert.Same(tap, player.CurrentMotion);

        player.SetState(AvatarState.Idle, 1.5);
        player.Update(3.01);
        Assert.Null(player.CurrentMotion);
        Assert.Same(tap, player.PreviousMotion); // fading out over the procedural idle
        player.Update(3.6);
        Assert.Null(player.PreviousMotion);
    }

    [Fact]
    public void RandomMotions_FireOnlyInTheirStates_PlayOnce_ThenHandBack()
    {
        var idle = Clip(10f);
        var spirit = Clip(1f);
        var random = new AvatarConfig.RandomMotion("SPIRIT", 5000, 5000, ["idle"]);
        var player = new AvatarMotionPlayer(Groups(("Idle", [idle]), ("spirit", [spirit])), randomMotions: [random], seed: 5);

        player.Update(0); // schedules the first one at 5s
        player.Update(4.9);
        Assert.Same(idle, player.CurrentMotion);
        player.Update(5.0);
        Assert.Same(spirit, player.CurrentMotion);
        player.Update(6.01);
        Assert.Same(idle, player.CurrentMotion);

        // Listening is at rest with the mic on: "idle" ones still fire.
        player.SetState(AvatarState.Listening, 6.5);
        player.Update(10.0);
        Assert.Same(spirit, player.CurrentMotion);
        player.Update(11.01);
        Assert.Same(idle, player.CurrentMotion);

        // Not while talking (not in its states).
        player.SetState(AvatarState.Talking, 7);
        player.Update(10.0);
        Assert.Same(idle, player.CurrentMotion);
    }

    [Fact]
    public void ZeroDurationClips_AreSkipped_NotRetriggeredEveryFrame()
    {
        var player = new AvatarMotionPlayer(Groups(("Idle", [Clip(0f)])), seed: 6);

        player.Update(0);
        player.Update(0.016);

        Assert.Null(player.CurrentMotion);
        Assert.Null(player.PreviousMotion);
    }
}

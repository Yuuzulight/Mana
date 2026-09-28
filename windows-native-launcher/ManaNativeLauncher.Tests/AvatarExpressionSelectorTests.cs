using Mana.NativeLauncher;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class AvatarExpressionSelectorTests
{
    [Fact]
    public void SelectExpressionName_MatchesByKeywordCaseInsensitively()
    {
        var names = new[] { "neutral", "F03_ANGRY", "smile_01" };

        Assert.Equal("F03_ANGRY", AvatarExpressionSelector.SelectExpressionName(AvatarState.Angry, names));
        Assert.Equal("smile_01", AvatarExpressionSelector.SelectExpressionName(AvatarState.Excited, names));
    }

    // #681: the reply's model-chosen expression wins, even for Talking
    // (which has no keyword table of its own); exact name only, like
    // live2d-logic.js's pickByPreference.
    [Fact]
    public void SelectExpressionName_PrefersTheModelChosenExpressionByExactName()
    {
        var names = new[] { "F03_ANGRY", "Wink", "smile_01" };

        Assert.Equal("Wink", AvatarExpressionSelector.SelectExpressionName(AvatarState.Angry, names, "wink"));
        Assert.Equal("Wink", AvatarExpressionSelector.SelectExpressionName(AvatarState.Talking, names, " WINK "));
    }

    [Fact]
    public void SelectExpressionName_FallsBackToTheStateWhenThePreferredNameIsUnknown()
    {
        var names = new[] { "F03_ANGRY", "Wink_left" };

        Assert.Equal("F03_ANGRY", AvatarExpressionSelector.SelectExpressionName(AvatarState.Angry, names, "wink"));
        Assert.Null(AvatarExpressionSelector.SelectExpressionName(AvatarState.Talking, names, "wink"));
    }

    [Fact]
    public void SelectExpressionName_ReturnsNullWhenNothingMatches()
    {
        var names = new[] { "neutral", "blink" };

        Assert.Null(AvatarExpressionSelector.SelectExpressionName(AvatarState.Sad, names));
    }

    // AvatarState is internal, so a [Theory]/[InlineData] parameterized by
    // it directly would give the (necessarily public, for xunit discovery)
    // test method a less-accessible parameter type (CS0051) -- two plain
    // facts instead of a theory.
    [Fact]
    public void SelectExpressionName_IdleHasNoKeywordPreferenceEvenWithAPlausibleMatchAvailable()
    {
        // Matches live2d-logic.js's own idle:[] entry -- no preference
        // means no expression change, not "match anything".
        var names = new[] { "talking_face", "idle_default" };

        Assert.Null(AvatarExpressionSelector.SelectExpressionName(AvatarState.Idle, names));
    }

    [Fact]
    public void SelectExpressionName_TalkingHasNoKeywordPreferenceEvenWithAPlausibleMatchAvailable()
    {
        // Matches live2d-logic.js's own talking:[] entry.
        var names = new[] { "talking_face", "idle_default" };

        Assert.Null(AvatarExpressionSelector.SelectExpressionName(AvatarState.Talking, names));
    }

    [Fact]
    public void SelectExpressionName_FirstKeywordThenFirstNameWins()
    {
        // "excited" keywords are checked in order (happy, joy, smile,
        // excited, fun); "joy_face" should win over "fun_face" since
        // "joy" comes before "fun" in that list, regardless of name order.
        var names = new[] { "fun_face", "joy_face" };

        Assert.Equal("joy_face", AvatarExpressionSelector.SelectExpressionName(AvatarState.Excited, names));
    }

    [Fact]
    public void SelectExpressionName_WithNoExpressionsAvailableReturnsNull()
    {
        Assert.Null(AvatarExpressionSelector.SelectExpressionName(AvatarState.Angry, Array.Empty<string>()));
    }
}

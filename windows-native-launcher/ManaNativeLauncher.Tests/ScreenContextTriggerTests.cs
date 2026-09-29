using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ScreenContextTriggerTests
{
    [Theory]
    [InlineData("what does this error say")]
    [InlineData("can you read my screen")]
    [InlineData("what's in this menu")]
    public void ShouldReadScreenForCommand_TrueWhenAKeywordIsPresent(string text)
    {
        Assert.True(ScreenContextTrigger.ShouldReadScreenForCommand(text, gamingModeActive: false));
    }

    [Fact]
    public void ShouldReadScreenForCommand_FalseWhenNoKeywordAndGateEnabled()
    {
        Assert.False(ScreenContextTrigger.ShouldReadScreenForCommand("what time is it", gamingModeActive: false));
    }

    [Fact]
    public void ShouldReadScreenForCommand_AlwaysTrueWhenTheGateIsDisabledAndNotGaming()
    {
        Assert.True(ScreenContextTrigger.ShouldReadScreenForCommand("what time is it", gamingModeActive: false, keywordGateEnabled: false));
    }

    [Fact]
    public void ShouldReadScreenForCommand_KeywordGateStillAppliesWhileGamingEvenIfDisabledOutsideGaming()
    {
        // Gaming mode always applies the keyword gate, regardless of
        // keywordGateEnabled -- matches windows-launcher's own
        // !gamingModeActive && !keywordGateEnabled short-circuit.
        Assert.False(ScreenContextTrigger.ShouldReadScreenForCommand("what time is it", gamingModeActive: true, keywordGateEnabled: false));
    }

    [Theory]
    [InlineData("what does this error say", true)]
    [InlineData("read that", true)]
    [InlineData("what's in here", true)]
    [InlineData("what's on my screen", false)]
    [InlineData("is thistle a flower", false)]
    public void IsDeictic_MatchesPointingWordsOnlyAsWholeWords(string text, bool expected)
    {
        Assert.Equal(expected, ScreenContextTrigger.IsDeictic(text));
    }

    [Theory]
    [InlineData("what's this?", null, true)]
    [InlineData("what is that", 60_000L, true)]
    [InlineData("whats this", 120_000L, true)]
    [InlineData("what does this say?", null, true)]
    [InlineData("what does that mean", null, true)]
    [InlineData("read this", null, true)]
    [InlineData("explain that", null, true)]
    [InlineData("what's this?", 59_999L, false)] // a recent topic "this" could mean
    [InlineData("explain this", 5_000L, false)]
    [InlineData("what's this song called", null, false)] // not a bare deictic question
    [InlineData("is this ok", null, false)]
    public void ReadsScreenOnItsOwn_ShortDeicticQuestionsWithoutARecentTopic(string text, long? msSincePreviousTurn, bool expected)
    {
        Assert.Equal(expected, ScreenContextTrigger.ReadsScreenOnItsOwn(text, msSincePreviousTurn));
    }

    [Theory]
    [InlineData("what's that thing next to you", true)]
    [InlineData("what's behind you", true)]
    [InlineData("read what's here where you are", true)]
    [InlineData("what's here", false)]
    [InlineData("i'm behind your back", false)]
    public void MeansNearAvatar_OnlyForPhrasesAboutWhereSheIs(string text, bool expected)
    {
        Assert.Equal(expected, ScreenContextTrigger.MeansNearAvatar(text));
    }

    [Fact]
    public void CleanTranscriptText_StripsBracketedSttArtifacts()
    {
        Assert.Equal("hello there", ScreenContextTrigger.CleanTranscriptText("hello [BLANK_AUDIO] there"));
    }

    [Fact]
    public void CleanTranscriptText_StripsParentheticalSpans()
    {
        // #522 review: the whole point of this port -- a keyword sitting
        // inside a parenthetical STT artifact must not itself trigger the
        // gate once cleaned, matching windows-launcher's renderer.js.
        var cleaned = ScreenContextTrigger.CleanTranscriptText("what time is it (game audio)");

        Assert.Equal("what time is it", cleaned);
        Assert.DoesNotContain("game", cleaned);
    }

    [Fact]
    public void CleanTranscriptText_StripsTrailingPunctuation()
    {
        Assert.Equal("hello there", ScreenContextTrigger.CleanTranscriptText("hello there..."));
    }

    [Fact]
    public void CleanTranscriptText_CollapsesWhitespace()
    {
        Assert.Equal("hello there", ScreenContextTrigger.CleanTranscriptText("hello   there"));
    }
}

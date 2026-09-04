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

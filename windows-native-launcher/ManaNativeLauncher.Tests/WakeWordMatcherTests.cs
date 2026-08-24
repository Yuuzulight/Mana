using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class WakeWordMatcherTests
{
    [Theory]
    [InlineData("mana")]
    [InlineData("manah")]
    [InlineData("myna")]
    public void FuzzyMatchesWakeWord_MatchesKnownNearVariants(string candidate)
    {
        Assert.True(WakeWordMatcher.FuzzyMatchesWakeWord(candidate));
    }

    [Fact]
    public void FuzzyMatchesWakeWord_RejectsUnrelatedShortWord()
    {
        Assert.False(WakeWordMatcher.FuzzyMatchesWakeWord("banana"));
    }

    [Fact]
    public void FuzzyMatchesWakeWord_DoesNotMatchMultiWordPhrasesWordByWord()
    {
        // "wake up" is a multi-word wake phrase -- fuzzy matching only
        // applies to single mis-transcribed name variants, per the ported
        // JS behavior.
        Assert.False(WakeWordMatcher.FuzzyMatchesWakeWord("wake"));
    }

    [Fact]
    public void ExtractWakeCommand_ReturnsNullWhenNoWakeWordPresent()
    {
        Assert.Null(WakeWordMatcher.ExtractWakeCommand("what time is it"));
    }

    [Fact]
    public void ExtractWakeCommand_ReturnsTextFollowingExactWakeWord()
    {
        Assert.Equal("what time is it", WakeWordMatcher.ExtractWakeCommand("mana, what time is it"));
    }

    [Fact]
    public void ExtractWakeCommand_ReturnsFullTranscriptWhenNothingFollowsWakeWord()
    {
        Assert.Equal("mana", WakeWordMatcher.ExtractWakeCommand("mana"));
    }

    [Fact]
    public void ExtractWakeCommand_FallsBackToFuzzyMatchOnFirstThreeWords()
    {
        // "manaa" (edit distance 1 from "mana"/"manah"/"manna") is NOT a
        // literal entry in WakeWords, so it can't be caught by the exact
        // word-boundary regex -- this exercises the fuzzy fallback path.
        // ("manna" doesn't work here: it IS a literal WakeWords entry, so
        // it's always caught by the unanchored exact-match regex first,
        // regardless of word position -- verified against the ported JS's
        // identical exact-match behavior in windows-launcher/renderer/renderer.js.)
        Assert.Equal("open the door", WakeWordMatcher.ExtractWakeCommand("manaa open the door"));
    }

    [Fact]
    public void ExtractWakeCommand_IgnoresFuzzyMatchBeyondFirstThreeWords()
    {
        // "manaa" appears as the 4th word -- outside the fuzzy fallback's
        // 3-word window, and (being fuzzy-only, not a literal WakeWords
        // entry) it isn't caught by the position-unrestricted exact-match
        // regex either -- so this must return null.
        Assert.Null(WakeWordMatcher.ExtractWakeCommand("please open the manaa door"));
    }

    [Fact]
    public void ExtractWakeCommand_CorrectsKnownWhisperMisTranscriptions()
    {
        Assert.Equal("what time is it", WakeWordMatcher.ExtractWakeCommand("minor what time is it"));
    }
}

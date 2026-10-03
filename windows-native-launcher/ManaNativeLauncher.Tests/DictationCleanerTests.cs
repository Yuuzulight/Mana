using Mana.NativeLauncher.Dictation;
using Xunit;

namespace Mana.NativeLauncher.Tests;

public sealed class DictationCleanerTests
{
    [Theory]
    [InlineData("Um, hello, can you hear me?", "Hello, can you hear me?")]
    [InlineData("uh, I was thinking about this, um, feature.", "I was thinking about this, feature.")]
    [InlineData("er, ah, well, let's see.", "Well, let's see.")]
    [InlineData("Um...", "")]
    [InlineData("   ", "")]
    [InlineData(null, "")]
    public void Clean_RemovesFillersAndFixesPunctuation(string? input, string expected)
    {
        var cleaned = DictationCleaner.Clean(input);
        Assert.Equal(expected, cleaned);
    }

    [Fact]
    public void Clean_PreservesLegitimateWordsContainingFillerLetters()
    {
        var input = "The umbrella was made of aluminum.";
        var cleaned = DictationCleaner.Clean(input);
        Assert.Equal("The umbrella was made of aluminum.", cleaned);
    }

    [Fact]
    public void Clean_CapitalizesFirstLetter()
    {
        var input = "this is a test sentence without fillers.";
        var cleaned = DictationCleaner.Clean(input);
        Assert.Equal("This is a test sentence without fillers.", cleaned);
    }
}

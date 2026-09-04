using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class AccessibilityTreeOutputParserTests
{
    [Fact]
    public void Parse_ExtractsOwnerPidAndText()
    {
        var result = AccessibilityTreeOutputParser.Parse("PID:1234\n---\nMana\nWindow Title\nSome Button\n");

        Assert.Equal(1234, result.OwnerPid);
        Assert.Equal("Mana\nWindow Title\nSome Button", result.Text);
    }

    [Fact]
    public void Parse_ReturnsZeroPidAndEmptyTextWhenSeparatorIsMissing()
    {
        var result = AccessibilityTreeOutputParser.Parse("garbage output with no separator");

        Assert.Equal(0, result.OwnerPid);
        Assert.Equal("", result.Text);
    }

    [Fact]
    public void Parse_ReturnsZeroPidWhenThePidLineHasNoDigits()
    {
        var result = AccessibilityTreeOutputParser.Parse("PID:\n---\nsome text\n");

        Assert.Equal(0, result.OwnerPid);
    }

    [Theory]
    [InlineData("one\ntwo\nthree line here")]
    public void IsUsable_TrueForThreeOrMoreNonEmptyLinesAndEnoughChars(string text)
    {
        Assert.True(AccessibilityTreeOutputParser.IsUsable(text));
    }

    [Fact]
    public void IsUsable_FalseWithFewerThanThreeLines()
    {
        Assert.False(AccessibilityTreeOutputParser.IsUsable("one line\nanother line that is long enough"));
    }

    [Fact]
    public void IsUsable_FalseWhenTooShortDespiteEnoughLines()
    {
        Assert.False(AccessibilityTreeOutputParser.IsUsable("a\nb\nc"));
    }

    [Fact]
    public void IsUsable_IgnoresBlankLinesWhenCountingLines()
    {
        Assert.False(AccessibilityTreeOutputParser.IsUsable("one real line that is long enough on its own\n\n\n"));
    }

    [Fact]
    public void IsUsable_FalseForEmptyText()
    {
        Assert.False(AccessibilityTreeOutputParser.IsUsable(""));
    }
}

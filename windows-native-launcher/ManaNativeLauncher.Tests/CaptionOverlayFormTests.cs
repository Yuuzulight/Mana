using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

[Collection("DarkTheme palette")] // reads the shared static palette
public class CaptionOverlayFormTests
{
    [Fact]
    public void SetCaption_GrowsTheBarToFitEveryWrappedLine()
    {
        using var form = new CaptionOverlayForm();
        form.ShowSentence("One line.");
        var oneLine = form.Height;

        form.ShowSentence(string.Join(" ", Enumerable.Repeat("Since you mentioned your name, I'm guessing that might be your full one.", 4)));

        // ~290 chars at 608px wraps to 4 lines; 20px is the bar's padding.
        const int padding = 20;
        Assert.True(form.Height - padding >= 3 * (oneLine - padding), $"expected at least 3 lines, got a {form.Height}px bar vs {oneLine}px for one line");
    }
}

public class CaptionTimingTests
{
    [Theory]
    [InlineData("Hi!", 4000)]                                    // short: the 4s floor
    [InlineData("one two three four five six seven eight nine ten eleven twelve fifteen", 4333)] // 13 words
    public void LingerMs_IsAboutOneSecondPerThreeWords(string text, int expected) =>
        Assert.Equal(expected, CaptionOverlayForm.LingerMs(text));

    [Fact]
    public void LingerMs_CapsAtTwentySeconds() =>
        Assert.Equal(20000, CaptionOverlayForm.LingerMs(string.Join(" ", Enumerable.Repeat("word", 200))));

    [Theory]
    [InlineData(0, 26)]     // flat background: nearly clear
    [InlineData(35, 83)]    // halfway
    [InlineData(70, 140)]   // busy game: strongest wash
    [InlineData(200, 140)]  // clamped
    public void WashAlphaFor_ScalesWithHowBusyTheBackdropIs(double stdDev, int expected) =>
        Assert.Equal(expected, CaptionOverlayForm.WashAlphaFor(stdDev));

    [Fact]
    public void Steps_SplitsSentencesAndSharesTheClipByLength()
    {
        var steps = CaptionOverlayForm.Steps("Short one. A much longer second sentence here!\nThird?", TimeSpan.FromMilliseconds(5300));

        Assert.Equal(["Short one.", "A much longer second sentence here!", "Third?"], steps.Select(s => s.Text));
        Assert.True(steps[1].Ms > steps[0].Ms && steps[0].Ms > steps[2].Ms);
        Assert.InRange(steps.Sum(s => s.Ms), 5290, 5300);
    }
}

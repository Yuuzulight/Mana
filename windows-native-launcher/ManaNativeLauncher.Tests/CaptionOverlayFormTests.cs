using System;
using System.Drawing;
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

    [Fact]
    public void ALongSentence_ShrinksTheFontInsteadOfGrowingPastFourLines()
    {
        using var form = new CaptionOverlayForm();
        form.ShowSentence("One line.");
        var oneLine = form.Height - 24;

        form.ShowSentence(string.Join(" ", Enumerable.Repeat("Since you mentioned your name, I'm guessing that might be your full one.", 9)));

        Assert.True(form.Height - 24 <= (4 * oneLine) + 4, $"expected at most 4 lines, got a {form.Height}px bar vs {oneLine}px per line");
    }

    [Fact]
    public void FitFontSize_KeepsTwelvePointForShortText_AndShrinksLongText()
    {
        using var bitmap = new Bitmap(1, 1);
        using var g = Graphics.FromImage(bitmap);
        Assert.Equal(12F, CaptionOverlayForm.FitFontSize(g, "Hey Yuuzu! Welcome back.", 604));
        var fiveLines = string.Join(" ", Enumerable.Repeat("Slice two yuzu thinly, layer them with honey in a jar.", 7));
        var shrunk = CaptionOverlayForm.FitFontSize(g, fiveLines, 604);
        Assert.InRange(shrunk, 8F, 11.5F);
        Assert.Equal(8F, CaptionOverlayForm.FitFontSize(g, string.Join(" ", Enumerable.Repeat("word", 2000)), 604)); // the floor
    }
}

public class CaptionTimingTests
{
    // "abc de fghij" is 3 + 1, 2 + 1, 5 + 1 = 13 characters: the words
    // start at 0, 4/13 and 7/13 of the audio, and each shows 150ms early.
    [Theory]
    [InlineData(0, 1300, "abc")]
    [InlineData(249, 1300, "abc")]        // 399ms < 400ms
    [InlineData(250, 1300, "abc de")]     // 400ms: "de" starts
    [InlineData(550, 1300, "abc de fghij")]
    [InlineData(5000, 1300, "abc de fghij")]
    [InlineData(0, 0, "abc de fghij")]    // no audio length: the whole sentence
    public void RevealedWords_SpreadsWordsOverTheAudio_150msAhead(double elapsedMs, double durationMs, string expected) =>
        Assert.Equal(expected, CaptionOverlayForm.RevealedWords("abc  de fghij", elapsedMs, durationMs));

    [Fact]
    public void Place_CentresUnderMana_KeptOnScreen_OrBottomCentreWhenSheIsHidden()
    {
        var work = new Rectangle(0, 0, 1920, 1040);
        var bar = new Size(400, 50);
        // Hidden: bottom-centre, 48px up.
        Assert.Equal(new Point(760, 942), CaptionOverlayForm.Place(bar, null, work));
        // At the bottom of the screen (the default spot): centred on her, same height.
        Assert.Equal(new Point(699, 942), CaptionOverlayForm.Place(bar, new Rectangle(782, 752, 234, 288), work));
        // Dragged up: just below her.
        Assert.Equal(new Point(699, 408), CaptionOverlayForm.Place(bar, new Rectangle(782, 112, 234, 288), work));
        // At the right edge: pulled back on screen.
        Assert.Equal(new Point(1508, 942), CaptionOverlayForm.Place(bar, new Rectangle(1800, 752, 234, 288), work));
    }

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

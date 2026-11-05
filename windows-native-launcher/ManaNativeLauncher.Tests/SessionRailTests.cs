using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class SessionRailTests
{
    [Theory]
    [InlineData("Folio table speed", "FT")]
    [InlineData("Bonsai 2 benchmark", "B2")]
    [InlineData("Otsumana~ clip picks", "OC")]
    [InlineData("memory", "ME")]
    [InlineData("   ", "·")]
    [InlineData("~~ !!", "·")]
    public void InitialsComeFromTheFirstTwoWords(string title, string initials)
    {
        Assert.Equal(initials, SessionRail.Initials(title));
    }

    // Narrower than 700 px of window folds; the threshold scales with the window's DPI.
    [Theory]
    [InlineData(699, 96, true)]
    [InlineData(700, 96, false)]
    [InlineData(1000, 144, true)]
    [InlineData(1050, 144, false)]
    public void FoldsBelowSevenHundredPixelsAtTheWindowsDpi(int width, int dpi, bool fold)
    {
        Assert.Equal(fold, SessionRail.ShouldFold(width, dpi));
    }
}
